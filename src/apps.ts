import type { Config, Context } from "./config.ts";
import { appPorts, createEnvironment, listedPorts } from "./context.ts";
import type { AppReservations } from "./ports.ts";
import {
  type Exit,
  exitStatus,
  exited,
  onStopSignal,
  settleGroup,
  signalGroup,
  spawnCommand,
  stopGrace,
} from "./process.ts";
import { readyProbe, waitUntilReady } from "./ready.ts";
import { createServing } from "./tailnet.ts";

/** How an exit reads in a message. */
function describeExit({ code, signal }: Exit): string {
  return signal ? `signal ${signal}` : `exit code ${code}`;
}

/**
 * Runs the apps of the stack `context` describes, on the ports held for them,
 * until one stops, serving the stack's URLs to the tailnet meanwhile if they
 * are under its name. The apps start one after another without waiting for
 * each other; `onReady` is called once every app with a readiness check
 * answers.
 */
export async function runApps(
  config: Config,
  context: Context,
  reservations: AppReservations,
  onReady: () => Promise<void>,
): Promise<void> {
  const { root, tailnet } = context;
  const apps = Object.entries(config.apps ?? {});
  // Before anything runs: a check on a port the app lacks is a config error.
  const probes = new Map(
    apps.flatMap(([name, app]) => {
      const probe = readyProbe(name, app, context);
      return probe ? [[name, probe] as const] : [];
    }),
  );

  // Found whether or not they are served: a service port the stack lacks is
  // a config error, as above.
  const served = listedPorts(config, context).map(({ port }) => port);
  const serving = tailnet && served.length ? createServing(tailnet) : undefined;
  const children: { name: string; pid: number | undefined; closed: Promise<void> }[] = [];
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
    for (const { pid } of children) signalGroup(pid, signal);
  };
  // The first stop reaches every app's group once; whatever is still
  // running in a group when the grace period is over is killed, even after
  // the app's command itself has exited. Always SIGINT, as Ctrl-C at a
  // terminal sends, so a stop reaches the apps the same way whatever
  // stopped the launcher.
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
  const release = onStopSignal((signal) => {
    // Asked again, nobody is waiting any longer.
    if (stopping) return signalChildren("SIGKILL");
    // A closed terminal ends the launcher too; its apps go with it.
    interrupted = signal;
    stop();
  });

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
          app.env?.(appPorts(name, reservations.apps[name]?.ports ?? {}), context),
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
        pid: child.pid,
        // Any app stopping stops the stack.
        closed: exited(child)
          .catch((error: Error): Exit => {
            console.error(`${name} failed to start: ${error.message}`);
            return { code: 1, signal: null };
          })
          .then((exit) => {
            if (!stopping) {
              // One that never answered failed to start, whatever its status.
              const early = probe && !ready.has(name);
              cause = early ? exitStatus(exit) || 1 : exitStatus(exit);
              console.error(
                `${name} exited${early ? " before it was ready" : ""} (${describeExit(exit)}); stopping the stack`,
              );
            }
            stop();
          }),
      });
      if (probe)
        waits.push(
          waitUntilReady(probe, controller.signal).then((result) => {
            if (result === "ready") ready.add(name);
            if (typeof result !== "object" || stopping) return;
            const seconds = probe.timeout / 1000;
            const address = `127.0.0.1:${probe.port}`;
            failure ??= new Error(
              `${name} was not ready within ${seconds} second${seconds === 1 ? "" : "s"}: at ${probe.path === undefined ? address : `http://${address}${probe.path}`}, ${result.timeout}; stopped the stack`,
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
      await onReady();
    }
  } catch (error) {
    if (!interrupted) failure ??= error;
    stop();
  }

  await Promise.all(children.map(({ closed }) => closed));
  // What an app started may outlive its command, and is still within the
  // grace period: a shell's server, say, that is waiting for its own
  // children. Nothing may keep holding the app's port.
  await Promise.all(children.map(({ pid }) => settleGroup(pid, deadline)));
  clearTimeout(escalation);
  serving?.stop();
  await serving?.closed();
  release();
  // The last word on how it ended, after whatever the apps printed on their
  // way out.
  if (interrupted || children.length)
    console.log(
      `Stopped${interrupted ? ` (${interrupted})` : ""}${children.length ? `: ${children.map(({ name }) => name).join(", ")}` : ""}`,
    );

  if (failure) throw failure;
  if (cause !== undefined && !interrupted) process.exitCode = cause;
}
