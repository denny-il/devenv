import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  type ComposeTarget,
  composeProjects,
  ensureDocker,
  removeProject,
  startServices,
  takeDown,
} from "./compose.ts";
import type { Command, Config } from "./config.ts";
import { createContext, createEnvironment, stringValues } from "./context.ts";
import {
  abandonedTestProjects,
  createTestProjectName,
  testProjectLauncher,
  testProjectPrefix,
} from "./names.ts";
import { reserveAppPorts } from "./ports.ts";
import {
  exitStatus,
  exited,
  onStopSignal,
  reapGroup,
  run,
  settleGroup,
  signalGroup,
  spawnCommand,
} from "./process.ts";
import type { Project } from "./project.ts";
import { readState, writeState } from "./state.ts";

/** How long interrupted tests have to end before they are killed. */
const interruptGrace = 15_000;

/** The Compose variables of a test stack: `test.compose.env` over `compose.env`. */
export function testComposeEnv(config: Config): Record<string, string> {
  // Each made strings first: one left `undefined` for tests must not unset
  // what `compose.env` gives.
  return { ...stringValues(config.compose?.env), ...stringValues(config.test?.compose?.env) };
}

/** Whether a process's command line is this launcher running `test`. */
export function isTestLauncher(commandLine: string): boolean {
  return /devenv(\.js)? test(\s|$)/.test(commandLine);
}

/**
 * The PIDs that may still belong to a `devenv test` launcher. A killed
 * launcher's PID may since belong to anything else, after a reboot too; this
 * launcher's own PID can only name a stack left by an earlier one. A probe
 * that fails, interrupted for one, counts the PID as running: a stack left
 * for the next run costs less than a live run's stack removed.
 */
async function runningTestLaunchers(pids: number[]): Promise<Set<number>> {
  const running = new Set<number>();
  for (const pid of new Set(pids)) {
    if (pid === process.pid) continue;
    // Unlimited width: procps truncates to $COLUMNS even into a pipe.
    const result = await run(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      capture: true,
      reject: false,
    });
    const gone =
      !result.signal &&
      ((result.code === 1 && !result.stdout.trim()) ||
        (result.code === 0 && !isTestLauncher(result.stdout)));
    if (!gone) running.add(pid);
  }
  return running;
}

/**
 * Removes the test stacks under `prefix` left by runs killed outright, which
 * never reached their teardown, or what is left of one, such as an image. A
 * run still going keeps its stack. By name alone: the Compose files may have
 * changed since, and removing these must not wait on them being right.
 */
export async function removeAbandonedTestStacks(
  cwd: string,
  prefix: string,
  options: { signal?: AbortSignal; detached?: boolean } = {},
): Promise<void> {
  const { signal, detached = false } = options;
  const projects = await composeProjects(cwd);
  const running = await runningTestLaunchers(
    projects.flatMap((stack) =>
      stack.startsWith(prefix) ? (testProjectLauncher(stack, prefix) ?? []) : [],
    ),
  );
  for (const leftover of abandonedTestProjects(projects, prefix, (pid) => running.has(pid))) {
    signal?.throwIfAborted();
    console.log(`Removing leftover test stack ${leftover}`);
    await removeProject(leftover, { detached });
  }
}

function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** The test command with the arguments given after `devenv test --`. */
export function testCommand(
  command: Command | ((args: string[]) => Command),
  args: string[],
): Command {
  if (typeof command === "function") return command(args);
  if (typeof command === "string") return [command, ...args.map(quote)].join(" ");
  return [...command, ...args];
}

/**
 * `devenv test`: runs the test command against a stack of its own, fresh
 * services under a project name for this run alone, on ports Docker assigns,
 * and always removed afterwards, with the images built for it: a name per run
 * would otherwise leave an image per run. The worktree's `start` stack and its
 * data are never touched.
 */
export async function test(project: Project, args: string[]): Promise<void> {
  const { root, config } = project;
  if (!config.test) throw new Error("The config has no `test` section to run tests with");
  const { setup = [], command, env } = config.test;
  const prefix = testProjectPrefix(config.name, root);
  const name = createTestProjectName(prefix, process.pid, randomBytes(3).toString("hex"));
  const composeEnv = testComposeEnv(config);
  const controller = new AbortController();
  const target: ComposeTarget = {
    root,
    project: name,
    files: [...(config.compose?.files ?? []), ...(config.compose?.test ?? [])],
    env: { ...process.env, ...composeEnv },
  };
  if (target.files.length) {
    await ensureDocker(root);
    const earlier = await readState(project.name).catch(() => null);
    if (earlier?.hostOnly) {
      // A killed test can leave Docker resources even when dev has none.
      // Remember that before creating any, so reset/prune still find them
      // after the test files or the checkout have gone.
      const { hostOnly: _previousMode, ...state } = earlier;
      await writeState({
        ...state,
        devHostOnly: true,
        composeEnv: stringValues(config.compose?.env),
      });
    }
  }

  let interrupted: NodeJS.Signals | undefined;
  let tests: ChildProcess | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let deadline = 0;
  // A closed terminal too: it would otherwise end the launcher alone, leaving
  // the tests, in their own group, running and the stack up.
  const release = onStopSignal((signal) => {
    if (interrupted) return;
    interrupted = signal;
    console.error(`\n${signal}: stopping and removing ${name}`);
    controller.abort();
    // The whole group: a test runner may exit on the signal without
    // stopping what its suites started. One that hangs on the way out is
    // killed, so the teardown still runs.
    if (tests) {
      const { pid } = tests;
      signalGroup(pid, signal);
      deadline = Date.now() + interruptGrace;
      escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), interruptGrace);
    }
  });

  let result = 1;
  try {
    // Teardown, here and of this run's stack, runs in its own process
    // group, so a second Ctrl-C at the terminal cannot cut it short.
    if (target.files.length)
      await removeAbandonedTestStacks(root, prefix, { signal: controller.signal, detached: true });

    console.log(`Test stack: ${name}`);
    const services = target.files.length
      ? await startServices({ ...target, signal: controller.signal }, config.compose?.init ?? [])
      : {};
    // Nothing listens on the apps' ports; their URLs are still configured.
    const reservations = await reserveAppPorts(config.apps ?? {});
    await reservations.releaseAll();
    const context = createContext(
      { root, project: name, composeEnv, services, apps: reservations.apps },
      config.compose?.serve,
    );
    const environment = createEnvironment(config, context, env);
    for (const step of setup)
      await run(step, { cwd: root, env: environment, signal: controller.signal });
    controller.signal.throwIfAborted();

    // Its own process group: it gets one signal, the one forwarded here,
    // since a test runner may stop at once without cleanup on a second.
    const child = spawnCommand(testCommand(command, args), {
      cwd: root,
      env: environment,
      stdio: "inherit",
      detached: true,
    });
    tests = child;
    const exit = await exited(child);
    clearTimeout(escalation);
    // Interrupted, what is left of the group keeps the rest of its grace
    // period, with no second signal.
    if (interrupted) await settleGroup(child.pid, deadline);
    else await reapGroup(child.pid);
    // A signal during the teardown has nothing left to stop.
    tests = undefined;
    result = exitStatus(interrupted ? { code: null, signal: interrupted } : exit);
  } catch (error) {
    if (interrupted) result = exitStatus({ code: null, signal: interrupted });
    else console.error((error as Error).message);
  } finally {
    clearTimeout(escalation);
    try {
      if (target.files.length) await takeDown(target, { detached: true });
    } catch (error) {
      console.error((error as Error).message);
      if (result === 0) result = 1;
    }
    release();
  }
  process.exitCode = result;
}
