import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { runApps } from "./apps.ts";
import {
  type ComposeTarget,
  type Services,
  compose,
  ensureDocker,
  removeProject,
  removeVolumesOf,
  startServices,
  takeDown,
} from "./compose.ts";
import { type Config, type Context, usesCompose } from "./config.ts";
import {
  createContext,
  createEnvironment,
  listedPorts,
  servedPorts,
  stringValues,
} from "./context.ts";
import { testProjectPrefix } from "./names.ts";
import { reserveAppPorts } from "./ports.ts";
import {
  exitStatus,
  exited,
  onStopSignal,
  processStart,
  run,
  spawnCommand,
  stopGrace,
} from "./process.ts";
import type { Project } from "./project.ts";
import {
  type Launcher,
  type State,
  hasServices,
  readState,
  removeState,
  statePath,
  writeState,
  writeStateKeepingRun,
} from "./state.ts";
import { tailnetHost } from "./tailnet.ts";
import { removeAbandonedTestStacks } from "./testing.ts";

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
  // Nothing was created with them while the stack has no services of its own.
  return state && hasServices(state) ? state.composeEnv : stringValues(project.config.compose?.env);
}

/** Starts the worktree's services, with the variables their volumes know. */
async function startStack(project: Project, earlier: State | null) {
  const hostOnly = !usesCompose(project.config);
  const composeEnv = composeEnvOf(project, earlier);
  const target = devTarget(project, composeEnv);
  const devHostOnly = !target.files.length;
  if (earlier && hasServices(earlier) && devHostOnly)
    throw new Error(
      "Run `devenv reset` before switching an existing Compose stack to host-only apps",
    );
  // Once its tests may have left something in Docker, the stack stays one
  // that `reset` and `prune` look there for, whatever the config says since.
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
  // Read again: the checks before may have taken a while, and a `start` that
  // began meanwhile has recorded itself, and other ports for the apps if the
  // ones it found were taken.
  const {
    hostOnly: _previousMode,
    devHostOnly: _previousDevMode,
    ...previous
  } = (await readState(project.name)) ?? {};
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
  });
  const services = target.files.length
    ? await startServices(target, project.config.compose?.init ?? [])
    : {};
  return { composeEnv, services, ...mode };
}

/**
 * The app URLs, the origins of the service ports in `compose.serve`, then
 * the `info` lines: `info` as given, or the config's for `context`.
 */
function printStack(config: Config, context: Context, info?: Record<string, string>): void {
  // The service ports too: nothing else shows that one is served, as
  // `tailscale serve status` does not list the entries of a `start`.
  for (const { label, url } of listedPorts(config, context)) console.log(`${label}: ${url}`);
  for (const [label, value] of Object.entries(info ?? config.info?.(context) ?? {}))
    console.log(`${label}: ${value}`);
}

/**
 * `devenv up`: the services, ports for the apps' URLs, and `setup`: all that
 * `start` needs before it runs the apps.
 */
export async function up(project: Project): Promise<void> {
  const earlier = await readState(project.name);
  const started = await startStack(project, earlier);
  await stopOutdatedServing(project, earlier, started.services);
  // Starting the services may have taken a while: a `start` may have begun
  // meanwhile, on other ports if the ones it found were taken.
  const assigned = (await readState(project.name))?.apps ?? {};
  const reservations = await reserveAppPorts(project.config.apps ?? {}, assigned);
  await reservations.releaseAll();
  // Ports the stack already has stay, free or not: a `start` running in
  // another terminal is what holds them, and its URLs must not change
  // under it.
  const apps: State["apps"] = {};
  for (const [app, { ports }] of Object.entries(reservations.apps)) {
    const held = assigned[app]?.ports ?? {};
    apps[app] = {
      ports: Object.fromEntries(
        Object.entries(ports).map(([name, port]) => [name, held[name] ?? port]),
      ),
    };
  }
  const state: State = {
    version: 1,
    root: project.root,
    project: project.name,
    ...started,
    apps,
  };
  // Recorded as up before setup runs, so a failed step can be run again by
  // hand with `devenv run`.
  await writeStateKeepingRun(state);
  // Local URLs, whether or not a `start --tailscale` is serving the stack:
  // setup reaches the services and apps on this machine, and runs the same
  // either way.
  const context = createContext(state, project.config.compose?.serve);
  // Here, where the services are known, rather than at the next `start`.
  servedPorts(project.config, context);
  const environment = createEnvironment(project.config, context);
  // A stop reaches each step's process group, and waits for it to end, as
  // it did under `start`: a migration must not go on after `up` is gone.
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const release = onStopSignal((signal) => {
    interrupted ??= signal;
    controller.abort();
  });
  try {
    for (const command of project.config.setup ?? [])
      await run(command, { cwd: project.root, env: environment, signal: controller.signal });
  } catch (error) {
    if (interrupted) throw new Error(`Setup stopped (${interrupted})`, { cause: error });
    throw error;
  } finally {
    release();
  }
  console.log(`State: ${statePath(project.name)}`);
}

/** The `devenv start` running the apps of the stack in `state`, if one is. */
async function runningLauncher(state: State | null): Promise<Launcher | undefined> {
  const launcher = state?.launcher;
  if (!launcher) return undefined;
  return (await processStart(launcher.pid)) === launcher.started ? launcher : undefined;
}

/**
 * `state` without what a `start` that has ended left in it: one killed
 * outright could not remove its launcher and the tailnet name its URLs were
 * under, which nothing serves any more.
 */
async function withoutEndedRun(state: State): Promise<State> {
  if (!state.launcher || (await runningLauncher(state))) return state;
  const { launcher: _launcher, tailnet: _tailnet, ...rest } = state;
  return rest;
}

/**
 * Stops a `start --tailscale` that serves a service port which `up` has just
 * moved: Docker publishes a recreated container's ports anew. Its tailnet
 * entry would go on forwarding to the old port, which answers nothing, or is
 * whatever Docker publishes there next, and its apps were told the old
 * origin. Starting the apps again serves the new port.
 */
async function stopOutdatedServing(
  project: Project,
  earlier: State | null,
  services: Services,
): Promise<void> {
  const moved = Object.entries(project.config.compose?.serve ?? {}).flatMap(([name, targets]) =>
    targets.flatMap((target) => {
      const before = earlier?.services[name]?.ports[target];
      const now = services[name]?.ports[target];
      return before === undefined || before === now
        ? []
        : [`${name} port ${target} (${before}, now ${now ?? "not published"})`];
    }),
  );
  if (!moved.length) return;
  // That `start` uses the services recorded when it began, which until this
  // `up` records its own are the earlier ones.
  const state = await readState(project.name);
  const launcher = state?.tailnet ? await runningLauncher(state) : undefined;
  if (!launcher) return;
  console.warn(
    `Docker no longer publishes ${moved.join(", ")} on the port the running \`devenv start --tailscale\` serves to the tailnet, so that is stopped. Run it again once \`up\` is done.`,
  );
  await stopLauncher(launcher);
}

/**
 * Refuses a second `start` of a stack: it would run the apps again, on other
 * ports, and take the stack's URLs over.
 */
async function refuseSecondLauncher(state: State | null): Promise<void> {
  const running = await runningLauncher(state);
  if (running && running.pid !== process.pid)
    throw new Error(
      `\`devenv start\` is already running this stack (pid ${running.pid}). Stop it with \`devenv stop\` first.`,
    );
}

/** Refuses to run the apps of a stack that `up` has not prepared. */
function refuseNotUp(state: State | null): asserts state is State {
  if (!state || state.stopped) throw new Error("The stack is not up: run `devenv up` first");
}

/**
 * `devenv start`: every app, on the stack `up` prepared, until one stops.
 * The services are left as they are, before and after.
 */
export async function start(project: Project, options: { tailscale: boolean }): Promise<void> {
  const { config } = project;
  const earlier = await readState(project.name);
  // Before anything else, and again just before the launcher is recorded.
  await refuseSecondLauncher(earlier);
  refuseNotUp(earlier);
  console.log(`Stack ${project.name} (pid ${process.pid})`);
  // Over Tailscale the apps listen on this machine only, as ever: their
  // ports, and the service ports in `compose.serve`, are served to the
  // tailnet over HTTPS under this machine's name there, which then names
  // every one of their URLs.
  const tailnet = options.tailscale ? await tailnetHost() : undefined;
  // For `stop`, `status` and a second `start`.
  const launched = await processStart(process.pid);
  const launcher = launched ? { pid: process.pid, started: launched } : undefined;
  let served = false;
  let recorded = false;
  try {
    const reservations = await reserveAppPorts(config.apps ?? {}, earlier.apps);
    try {
      // The checks before may have taken a while: a `start`, `up` or `down`
      // may have run meanwhile.
      const current = await readState(project.name);
      await refuseSecondLauncher(current);
      refuseNotUp(current);
      const { tailnet: _tailnet, launcher: _launcher, ...rest } = current;
      const state: State = {
        ...rest,
        apps: reservations.apps,
        ...(tailnet ? { tailnet } : {}),
        ...(launcher ? { launcher } : {}),
      };
      await writeState(state);
      recorded = true;
      served = !!tailnet;
      const context = createContext(state, config.compose?.serve);
      await runApps(config, context, reservations, async () => {
        // Recorded for `status`, which shows what this run printed: `info`
        // may depend on this process's environment, which `status` lacks.
        const info = stringValues(config.info?.(context));
        printStack(config, context, info);
        await recordInfo(project.name, info);
      });
    } finally {
      await reservations.releaseAll();
    }
  } finally {
    // Keep what other commands recorded meanwhile, such as the mode changes
    // of a test run. Nothing to undo when nothing of this run was written.
    const current = recorded ? await readState(project.name) : null;
    const ours = current?.launcher?.pid === process.pid;
    if (current && (ours || served)) {
      const { tailnet: recordedTailnet, launcher: recordedLauncher, ...rest } = current;
      await writeState({
        ...rest,
        // Nothing is served any more: the URLs are local ones again.
        ...(recordedTailnet && !served ? { tailnet: recordedTailnet } : {}),
        ...(recordedLauncher && !ours ? { launcher: recordedLauncher } : {}),
      });
    }
  }
}

/**
 * Stops the `devenv start` running the stack, as Ctrl-C at its terminal
 * would, and waits until it has ended, which it does once its apps have.
 */
async function stopLauncher({ pid, started }: Launcher): Promise<void> {
  console.log(`Stopping \`devenv start\` (pid ${pid})`);
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    // It ended since it was found.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  // It kills what is left of its apps once the grace period is over.
  const patience = stopGrace + 5_000;
  const deadline = Date.now() + patience;
  while ((await processStart(pid)) === started) {
    if (Date.now() > deadline)
      throw new Error(
        `\`devenv start\` (pid ${pid}) is still running ${patience / 1000} seconds after it was asked to stop`,
      );
    await sleep(100);
  }
  console.log(`Stopped \`devenv start\` (pid ${pid})`);
}

/**
 * `devenv stop`: stops the `devenv start` running this worktree's stack, if
 * one is. Nothing to stop is no failure: `stop; start` restarts the apps
 * whatever ran before.
 */
export async function stop(project: Project): Promise<void> {
  const launcher = await runningLauncher(await readState(project.name));
  if (launcher) await stopLauncher(launcher);
  else console.log("No `devenv start` is running for this worktree");
}

/** Adds `info` to this process's launcher record, if it is still the recorded one. */
async function recordInfo(project: string, info: Record<string, string>): Promise<void> {
  const current = await readState(project);
  if (current?.launcher?.pid !== process.pid) return;
  await writeState({ ...current, launcher: { ...current.launcher, info } });
}

/** `devenv status` */
export async function status(project: Project): Promise<void> {
  const recorded = await readState(project.name);
  const target = devTarget(project, composeEnvOf(project, recorded));
  if (target.files.length) {
    await ensureDocker(project.root);
    await compose(target, ["ps"]);
  }
  // After Compose has answered, which may take a while: a `start` may have
  // ended meanwhile.
  const state = recorded && (await withoutEndedRun(recorded));
  if (state && hasServices(state) && !target.files.length)
    console.log(
      "This stack still has Compose state; run `devenv reset` to switch to host-only apps.",
    );
  if (!state) {
    console.log(`No stack yet: nothing at ${statePath(project.name)}`);
    return;
  }
  console.log(`State: ${statePath(project.name)}`);
  const { launcher } = state;
  if (launcher) console.log(`\`devenv start\` is running the apps (pid ${launcher.pid}).`);
  if (state.stopped) console.log("The stack is stopped.");
  else {
    if (!launcher && Object.keys(project.config.apps ?? {}).length)
      console.log("No `devenv start` is running; the apps answer here while one runs them:");
    // What the running `start` printed, which `info` evaluated in this
    // environment may not match. One not ready yet, or of an older version,
    // has recorded none.
    printStack(project.config, createContext(state, project.config.compose?.serve), launcher?.info);
  }
}

/** `devenv down`, and `devenv reset` with `removeVolumes`. */
export async function down(project: Project, removeVolumes: boolean): Promise<void> {
  // `reset` must work on a state it cannot read.
  let damaged = false;
  const read = () =>
    readState(project.name).catch((error) => {
      if (!removeVolumes) throw error;
      damaged = true;
      return null;
    });
  // The apps first: they would lose their services, and after `reset`
  // nothing would find them any more.
  let state = await read();
  const launcher = await runningLauncher(state);
  if (launcher) {
    await stopLauncher(launcher);
    // Again: the stopped `start` has removed what it recorded, such as the
    // tailnet name of its URLs.
    state = await read();
  }
  const target = devTarget(project, composeEnvOf(project, state));
  // Legacy states imply Docker even if the config has since dropped Compose.
  let docker = removeVolumes
    ? usesCompose(project.config) || !!(state && !state.hostOnly)
    : !!target.files.length || !!(state && hasServices(state));
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
    if (target.files.length) await takeDown(target, { keepVolumes: !removeVolumes });
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
  if (state) await writeStateKeepingRun({ ...state, services: {}, stopped: true });
}

/** `devenv run -- <command>` */
export async function runCommand(project: Project, command: string[]): Promise<void> {
  const recorded = await readState(project.name);
  if (!recorded || recorded.stopped) throw new Error("Run `devenv up` first");
  const state = await withoutEndedRun(recorded);
  const child = spawnCommand(command, {
    cwd: project.root,
    env: createEnvironment(project.config, createContext(state, project.config.compose?.serve)),
    stdio: "inherit",
  });
  // The command decides how it stops. What a terminal's keys send, Ctrl-C
  // and Ctrl-\, has reached it already; any other signal came to this
  // process alone.
  const release = onStopSignal((signal) => {
    if (signal !== "SIGINT" && signal !== "SIGQUIT") child.kill(signal);
  });
  try {
    process.exitCode = exitStatus(await exited(child));
  } finally {
    release();
  }
}
