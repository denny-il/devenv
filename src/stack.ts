import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type ComposeTarget,
  compose,
  composeProjects,
  ensureDocker,
  removal,
  removeProject,
  removeVolumesOf,
  startServices,
} from "./compose.ts";
import { type Command, type Config, type Context, defaultPorts, usesCompose } from "./config.ts";
import { appPorts, createContext, createEnvironment, stringValues } from "./context.ts";
import {
  abandonedTestProjects,
  createTestProjectName,
  projectName,
  testProjectLauncher,
  testProjectPrefix,
} from "./names.ts";
import { type AppReservations, reserveAppPorts } from "./ports.ts";
import {
  type Exit,
  exitStatus,
  processStart,
  reapGroup,
  run,
  settleGroup,
  signalGroup,
  spawnCommand,
  stopGrace,
} from "./process.ts";
import { readyProbe, waitUntilReady } from "./ready.ts";
import { type State, readState, removeState, statePath, writeState } from "./state.ts";
import { createServing, tailnetHost } from "./tailnet.ts";

/** A project's config, where it is, and its worktree's stack name. */
export interface Project {
  root: string;
  config: Config;
  name: string;
}

export function createProject(root: string, config: Config): Project {
  // The real path: it is what the stack is named after, and kept in its state.
  const real = realpathSync(root);
  return { root: real, config, name: projectName(config.name, real) };
}

const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function devTarget(
  { root, config, name }: Project,
  composeEnv: Record<string, string>,
): ComposeTarget {
  return {
    root,
    project: name,
    files: [...(config.compose?.files ?? []), ...(config.compose?.dev ?? [])],
    env: { ...process.env, ...composeEnv },
  };
}

/** The Compose variables of the worktree's stack: those it was created with. */
function composeEnvOf(project: Project, state: State | null): Record<string, string> {
  if (state?.hostOnly || state?.devHostOnly) return stringValues(project.config.compose?.env);
  return state?.composeEnv ?? stringValues(project.config.compose?.env);
}

/** The Compose variables of a test stack: `test.compose.env` over `compose.env`. */
export function testComposeEnv(config: Config): Record<string, string> {
  // Each made strings first: one left `undefined` for tests must not unset
  // what `compose.env` gives.
  return { ...stringValues(config.compose?.env), ...stringValues(config.test?.compose?.env) };
}

/**
 * Starts the worktree's services, with the variables their volumes know.
 * `launcher` is recorded from the first write on.
 */
async function startStack(project: Project, earlier: State | null, launcher?: State["launcher"]) {
  const hostOnly = !usesCompose(project.config);
  const composeEnv = composeEnvOf(project, earlier);
  const target = devTarget(project, composeEnv);
  const devHostOnly = !target.files.length;
  if (earlier && !earlier.hostOnly && !earlier.devHostOnly && devHostOnly)
    throw new Error(
      "Run `devenv reset` before switching an existing Compose stack to host-only apps",
    );
  const mode =
    hostOnly && !earlier?.devHostOnly
      ? { hostOnly: true as const }
      : devHostOnly
        ? { devHostOnly: true as const }
        : {};
  if (target.files.length) await ensureDocker(project.root);
  if (!isDeepStrictEqual(composeEnv, stringValues(project.config.compose?.env)))
    console.warn(
      "`compose.env` differs from what this stack was created with, which stays in use. Run `devenv reset` to start over with the new values.",
    );
  // Before anything creates a volume: a first start that fails halfway must
  // not forget what its volumes were created with. Written on later starts
  // too, unchanged, so one that cannot save its state starts nothing.
  const {
    hostOnly: _previousMode,
    devHostOnly: _previousDevMode,
    launcher: _previousLauncher,
    ...previous
  } = earlier ?? {};
  // The checks before may have taken a while: a `start` may have begun,
  // stopped or been restarted meanwhile.
  const current = await readState(project.name);
  if (launcher) await refuseSecondLauncher(project.root, current);
  const recorded = launcher ?? current?.launcher;
  await writeState({
    version: 1,
    root: project.root,
    project: project.name,
    services: {},
    apps: {},
    stopped: true,
    ...previous,
    composeEnv,
    ...mode,
    ...(recorded ? { launcher: recorded } : {}),
  });
  const services = target.files.length
    ? await startServices(target, project.config.compose?.init ?? [])
    : {};
  return { composeEnv, services, ...mode };
}

function printStack(config: Config, context: Context): void {
  for (const [app, { ports = defaultPorts }] of Object.entries(config.apps ?? {})) {
    const listed = Object.keys(ports).filter((name) => !ports[name]?.internal);
    for (const name of listed) {
      const ref = `${app}.${name}`;
      console.log(`${listed.length === 1 ? app : ref}: ${context.url(ref)}`);
    }
  }
  for (const [label, value] of Object.entries(config.info?.(context) ?? {}))
    console.log(`${label}: ${value}`);
}

/** `devenv up`: the services alone, and ports for the apps' URLs. */
export async function up(project: Project): Promise<void> {
  const earlier = await readState(project.name);
  const started = await startStack(project, earlier);
  const reservations = await reserveAppPorts(project.config.apps ?? {}, earlier?.apps);
  await reservations.releaseAll();
  // Ports the stack already has stay, free or not: a `start` running in
  // another terminal is what holds them, and its URLs must not change
  // under it. For the same reason its tailnet name stays.
  const apps: State["apps"] = {};
  // Starting the services may have taken a while: a `start` may have
  // stopped, or been restarted, meanwhile.
  const { launcher } = (await readState(project.name)) ?? {};
  for (const [app, { ports }] of Object.entries(reservations.apps)) {
    const held = earlier?.apps[app]?.ports ?? {};
    apps[app] = {
      ports: Object.fromEntries(
        Object.entries(ports).map(([name, port]) => [name, held[name] ?? port]),
      ),
    };
  }
  await writeState({
    version: 1,
    root: project.root,
    project: project.name,
    ...started,
    apps,
    ...(earlier?.tailnet ? { tailnet: earlier.tailnet } : {}),
    ...(launcher ? { launcher } : {}),
  });
  console.log(`State: ${statePath(project.name)}`);
}

/** The PID of the `devenv start` running the apps of the stack in `state`, if one is. */
async function runningLauncher(root: string, state: State | null): Promise<number | undefined> {
  const launcher = state?.launcher;
  if (!launcher) return undefined;
  return (await processStart(root, launcher.pid)) === launcher.started ? launcher.pid : undefined;
}

/**
 * Refuses a second `start` of a stack: it would run the apps again, on other
 * ports, and take the stack's URLs over.
 */
async function refuseSecondLauncher(root: string, state: State | null): Promise<void> {
  const running = await runningLauncher(root, state);
  if (running !== undefined && running !== process.pid)
    throw new Error(
      `\`devenv start\` is already running this stack (pid ${running}). Stop it with \`devenv stop\`, or use \`devenv restart\`.`,
    );
}

/** `devenv start`: services, setup, then every app until one stops. */
export async function start(project: Project, options: { tailscale: boolean }): Promise<void> {
  const { root, config } = project;
  const earlier = await readState(project.name);
  // Before anything else, and again just before the launcher is recorded.
  await refuseSecondLauncher(root, earlier);
  console.log(`Stack ${project.name} (pid ${process.pid})`);
  // Over Tailscale the apps listen on this machine only, as ever: their
  // ports are served to the tailnet over HTTPS under this machine's name
  // there, which then names every app URL.
  const tailnet = options.tailscale ? await tailnetHost() : undefined;
  // For `stop`, `restart`, `status` and a second `start`, from the first
  // write on: one stopped before the apps run, while starting the services
  // say, ends at once, as there is nothing of its own to stop yet.
  const launched = await processStart(root, process.pid);
  const launcher = launched ? { pid: process.pid, started: launched } : undefined;
  let served = false;
  try {
    const started = await startStack(project, earlier, launcher);
    const reservations = await reserveAppPorts(config.apps ?? {}, earlier?.apps);
    try {
      const state: State = {
        version: 1,
        root,
        project: project.name,
        ...started,
        apps: reservations.apps,
        ...(tailnet ? { tailnet } : {}),
        ...(launcher ? { launcher } : {}),
      };
      await writeState(state);
      served = !!tailnet;
      await runApps(config, state, reservations);
    } finally {
      await reservations.releaseAll();
    }
  } finally {
    // Keep what other commands recorded meanwhile, such as the mode changes
    // of a test run. Nothing to undo when nothing of this run was written.
    const current = await readState(project.name);
    const ours = current?.launcher?.pid === process.pid;
    if (current && (ours || served)) {
      const { tailnet: recordedTailnet, launcher: recorded, ...rest } = current;
      await writeState({
        ...rest,
        // Nothing is served any more: the URLs are local ones again.
        ...(recordedTailnet && !served ? { tailnet: recordedTailnet } : {}),
        ...(recorded && !ours ? { launcher: recorded } : {}),
      });
    }
  }
}

/**
 * Stops the `devenv start` running the stack, as Ctrl-C at its terminal
 * would, and waits until it has ended, which it does once its apps have.
 */
async function stopLauncher(root: string, state: State, pid: number): Promise<void> {
  console.log(`Stopping \`devenv start\` (pid ${pid})`);
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    // It ended since it was found.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  // It kills what is left of its apps once the grace period is over.
  const deadline = Date.now() + stopGrace + 5_000;
  while ((await processStart(root, pid)) === state.launcher?.started) {
    if (Date.now() > deadline)
      throw new Error(
        `\`devenv start\` (pid ${pid}) is still running ${(stopGrace + 5_000) / 1000} seconds after it was asked to stop`,
      );
    await sleep(100);
  }
}

/** `devenv stop`: stops the `devenv start` running this worktree's stack. */
export async function stop(project: Project): Promise<void> {
  const state = await readState(project.name);
  const pid = await runningLauncher(project.root, state);
  if (!state || pid === undefined)
    throw new Error("No `devenv start` is running for this worktree");
  await stopLauncher(project.root, state, pid);
  console.log("Stopped");
}

/**
 * `devenv restart`: stops the `devenv start` running this worktree's stack,
 * if one is, and starts again in this process, served over Tailscale when
 * asked to or when the stopped one was.
 */
export async function restart(project: Project, options: { tailscale: boolean }): Promise<void> {
  const state = await readState(project.name);
  const pid = await runningLauncher(project.root, state);
  if (state && pid !== undefined) await stopLauncher(project.root, state, pid);
  else console.log("No `devenv start` was running for this worktree");
  await start(project, { tailscale: options.tailscale || (pid !== undefined && !!state?.tailnet) });
}

/** How an exit reads in a message. */
function describeExit({ code, signal }: Exit): string {
  return signal ? `signal ${signal}` : `exit code ${code}`;
}

/**
 * Runs setup and then the apps of a started stack, until one stops. The
 * apps start one after another without waiting for each other; the stack is
 * reported ready once every app with a readiness check answers.
 */
async function runApps(config: Config, state: State, reservations: AppReservations): Promise<void> {
  const { root, tailnet } = state;
  const apps = Object.entries(config.apps ?? {});
  const context = createContext(state);
  const environment = createEnvironment(config, context);
  // Before anything runs: a check on a port the app lacks is a config error.
  const probes = new Map(
    apps.flatMap(([name, app]) => {
      const probe = readyProbe(name, app, context);
      return probe ? [[name, probe] as const] : [];
    }),
  );

  const served = apps.flatMap(([app, { ports = defaultPorts }]) =>
    Object.keys(ports)
      .filter((name) => !ports[name]?.internal)
      .map((name) => context.port(`${app}.${name}`)),
  );
  const serving = tailnet && served.length ? createServing(tailnet) : undefined;
  const children: { name: string; child: ChildProcess; closed: Promise<void> }[] = [];
  const waits: Promise<void>[] = [];
  const ready = new Set<string>();
  const controller = new AbortController();
  let stopping = false;
  // The signal that stopped the stack, if one did.
  let interrupted: NodeJS.Signals | undefined;
  // The exit status of the app that stopped the stack, if one did.
  let cause: number | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let deadline = 0;
  const signalChildren = (signal: NodeJS.Signals) => {
    for (const { child } of children) signalGroup(child.pid, signal);
  };
  // The first stop reaches every app's group once; whatever is still
  // running in a group when the grace period is over is killed, even after
  // the app's command itself has exited. Always SIGINT, as Ctrl-C at a
  // terminal sends: package managers' script runners report an app that
  // SIGTERM ended as a failed command, and one that SIGINT ended as stopped.
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    serving?.stop();
    signalChildren("SIGINT");
    deadline = Date.now() + stopGrace;
    escalation = setTimeout(() => signalChildren("SIGKILL"), stopGrace);
    escalation.unref();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    // Asked again, nobody is waiting any longer.
    if (stopping) return signalChildren("SIGKILL");
    // A closed terminal ends the launcher too; its apps go with it.
    interrupted = signal;
    stop();
  };
  for (const signal of stopSignals) process.on(signal, onSignal);

  let failure: unknown;
  try {
    // Before anything is started on them: a port that cannot be served
    // would leave the URLs of a running stack dead.
    if (serving) {
      await serving.start(served);
      void serving.ended().then((message) => {
        if (stopping) return;
        failure = new Error(message);
        stop();
      });
    }
    for (const command of config.setup ?? [])
      await run(command, {
        cwd: root,
        env: environment,
        signal: controller.signal,
      });

    for (const [name, app] of apps) {
      await reservations.release(name);
      // Checked after the wait: a stop during it has not reached this app.
      if (stopping) break;
      // Each app leads a process group of its own, so stopping it reaches
      // the servers its command starts, not only the command.
      const child = spawnCommand(app.command, {
        cwd: root,
        env: createEnvironment(
          config,
          context,
          app.env?.(appPorts(name, state.apps[name]?.ports ?? {}), context),
          // Vite's dev servers answer only the host names they are told.
          tailnet
            ? {
                __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: [
                  process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,
                  tailnet,
                ]
                  .filter(Boolean)
                  .join(","),
              }
            : undefined,
        ),
        stdio: "inherit",
        detached: true,
      });
      const probe = probes.get(name);
      children.push({
        name,
        child,
        // Any app stopping stops the stack.
        closed: new Promise((resolveClosed) => {
          const closed = (exit: Exit) => {
            if (!stopping) {
              // One that never answered failed to start, whatever its status.
              const early = probe && !ready.has(name);
              cause = early ? exitStatus(exit) || 1 : exitStatus(exit);
              console.error(
                `${name} exited${early ? " before it was ready" : ""} (${describeExit(exit)}); stopping the stack`,
              );
            }
            stop();
            resolveClosed();
          };
          child.once("error", (error) => {
            console.error(`${name} failed to start: ${error.message}`);
            closed({ code: 1, signal: null });
          });
          child.once("close", (code, signal) => closed({ code, signal }));
        }),
      });
      if (probe)
        waits.push(
          waitUntilReady(probe, controller.signal).then((result) => {
            if (result === "ready") ready.add(name);
            if (typeof result !== "object" || stopping) return;
            failure ??= new Error(
              `${name} was not ready within ${probe.timeout / 1000} second${probe.timeout === 1000 ? "" : "s"}: at ${probe.path === undefined ? `127.0.0.1:${probe.port}` : `http://127.0.0.1:${probe.port}${probe.path}`}, ${result.timeout}; stopped the stack`,
            );
            stop();
          }),
        );
    }
    if (probes.size && !stopping)
      console.log(`Waiting for ${[...probes.keys()].join(", ")} to be ready`);
    await Promise.all(waits);
    if (!stopping) {
      const unchecked = apps.map(([name]) => name).filter((name) => !probes.has(name));
      if (probes.size) console.log(`Ready: ${[...probes.keys()].join(", ")}`);
      if (unchecked.length)
        console.log(`Started, without a readiness check: ${unchecked.join(", ")}`);
      printStack(config, context);
    }
  } catch (error) {
    if (!interrupted) failure ??= error;
    stop();
  }

  await Promise.all(children.map(({ closed }) => closed));
  // What an app started may outlive its command, and is still within the
  // grace period: a shell's server, say, that is waiting for its own
  // children. Nothing may keep holding the app's port.
  await Promise.all(children.map(({ child }) => settleGroup(child.pid, deadline)));
  clearTimeout(escalation);
  serving?.stop();
  await serving?.closed();
  for (const signal of stopSignals) process.off(signal, onSignal);
  // The last word on how it ended, after whatever the apps printed on their
  // way out.
  if (interrupted || children.length)
    console.log(
      `Stopped${interrupted ? ` (${interrupted})` : ""}${children.length ? `: ${children.map(({ name }) => name).join(", ")}` : ""}`,
    );

  if (failure) throw failure;
  if (cause !== undefined && !interrupted) process.exitCode = cause;
}

/** `devenv status` */
export async function status(project: Project): Promise<void> {
  const state = await readState(project.name);
  const target = devTarget(project, composeEnvOf(project, state));
  if (target.files.length) {
    await ensureDocker(project.root);
    await compose(target, ["ps"]);
  }
  if (state && !state.hostOnly && !state.devHostOnly && !target.files.length)
    console.log(
      "This stack still has Compose state; run `devenv reset` to switch to host-only apps.",
    );
  if (!state) {
    console.log(`No stack yet: nothing at ${statePath(project.name)}`);
    return;
  }
  console.log(`State: ${statePath(project.name)}`);
  const launcher = await runningLauncher(project.root, state);
  if (launcher !== undefined)
    console.log(`\`devenv start\` is running the apps (pid ${launcher}).`);
  if (state.stopped) console.log("The stack is stopped.");
  else {
    if (launcher === undefined && Object.keys(project.config.apps ?? {}).length)
      console.log("No `devenv start` is running; the apps answer here while one runs them:");
    printStack(project.config, createContext(state));
  }
}

/** `devenv down`, and `devenv reset` with `removeVolumes`. */
export async function down(project: Project, removeVolumes: boolean): Promise<void> {
  // `reset` must work on a state it cannot read.
  let damaged = false;
  const state = await readState(project.name).catch((error) => {
    if (!removeVolumes) throw error;
    damaged = true;
    return null;
  });
  // Its apps would keep running, and nothing would find them any more.
  const launcher = removeVolumes ? await runningLauncher(project.root, state) : undefined;
  if (launcher !== undefined)
    throw new Error(
      `\`devenv start\` is running this stack (pid ${launcher}). Stop it with \`devenv stop\` first.`,
    );
  const target = devTarget(project, composeEnvOf(project, state));
  // Legacy states imply Docker even if the config has since dropped Compose.
  let docker = removeVolumes
    ? usesCompose(project.config) || !!(state && !state.hostOnly)
    : !!target.files.length || !!(state && !state.hostOnly && !state.devHostOnly);
  if (damaged && !docker) {
    // Its mode is unknown: do not silently abandon an old Compose stack.
    try {
      await ensureDocker(project.root);
      docker = true;
    } catch (error) {
      console.warn(
        `The unreadable state cannot identify this stack's mode. Docker cleanup for project ${project.name} was skipped: ${(error as Error).message} Containers and volumes may remain; remove that project's Docker resources manually.`,
      );
    }
  } else if (docker) await ensureDocker(project.root);
  if (docker) {
    if (target.files.length)
      await compose(target, removeVolumes ? removal : ["down", "--remove-orphans"]);
    else await removeProject(project.name, { keepVolumes: !removeVolumes });
  }
  if (removeVolumes) {
    if (docker) {
      await removeVolumesOf(project.root, project.name);
      await removeAbandonedTestStacks(
        project.root,
        testProjectPrefix(project.config.name, project.root),
      );
    }
    await removeState(project.name);
    return;
  }
  // The kept volumes keep what they were created with, and the apps their
  // ports. The services' published ports are anyone's again.
  if (state) {
    // Stopping the services may have taken a while: a `start` may have
    // stopped, or been restarted, meanwhile.
    const { launcher } = (await readState(project.name)) ?? {};
    const { launcher: _earlier, ...rest } = state;
    await writeState({ ...rest, services: {}, stopped: true, ...(launcher ? { launcher } : {}) });
  }
}

/** `devenv run -- <command>` */
export async function runCommand(project: Project, command: string[]): Promise<void> {
  const state = await readState(project.name);
  if (!state || state.stopped) throw new Error("Run `devenv up` first");
  const child = spawnCommand(command, {
    cwd: project.root,
    env: createEnvironment(project.config, createContext(state)),
    stdio: "inherit",
  });
  // The command decides how it stops. A terminal's Ctrl-C has reached it
  // already; any other signal came to this process alone.
  const forward = (signal: NodeJS.Signals) => {
    if (signal !== "SIGINT") child.kill(signal);
  };
  for (const signal of stopSignals) process.on(signal, forward);
  try {
    const exit = await new Promise<Exit>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    process.exitCode = exitStatus(exit);
  } finally {
    for (const signal of stopSignals) process.off(signal, forward);
  }
}

/**
 * The PIDs that may still belong to a `devenv test` launcher. A killed
 * launcher's PID may since belong to anything else, after a reboot too; this
 * launcher's own PID can only name a stack left by an earlier one. A probe
 * that fails, interrupted for one, counts the PID as running: a stack left
 * for the next run costs less than a live run's stack removed.
 */
async function runningTestLaunchers(cwd: string, pids: number[]): Promise<Set<number>> {
  const running = new Set<number>();
  for (const pid of new Set(pids)) {
    if (pid === process.pid) continue;
    // Unlimited width: procps truncates to $COLUMNS even into a pipe.
    const result = await run(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      cwd,
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
    cwd,
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

/** Whether a process's command line is this launcher running `test`. */
export function isTestLauncher(commandLine: string): boolean {
  return /devenv(\.js)? test(\s|$)/.test(commandLine);
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
  const interrupt = (signal: NodeJS.Signals) => {
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
      deadline = Date.now() + 15_000;
      escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), 15_000);
    }
  };
  // SIGHUP too: a closed terminal would otherwise end the launcher alone,
  // leaving the tests, in their own group, running and the stack up.
  for (const signal of stopSignals) process.on(signal, interrupt);

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
    const reservations = await reserveAppPorts(config.apps ?? {}, undefined);
    await reservations.releaseAll();
    const context = createContext({
      root,
      project: name,
      composeEnv,
      services,
      apps: reservations.apps,
    });
    const environment = createEnvironment(config, context, env);
    for (const step of setup)
      await run(step, {
        cwd: root,
        env: environment,
        signal: controller.signal,
      });
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
    const exit = await new Promise<Exit>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
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
      if (target.files.length) await compose(target, removal, { detached: true });
    } catch (error) {
      console.error((error as Error).message);
      if (result === 0) result = 1;
    }
    for (const signal of stopSignals) process.off(signal, interrupt);
  }
  process.exitCode = result;
}
