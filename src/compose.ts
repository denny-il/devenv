import { connect } from "node:net";
import { type RunOptions, type RunResult, run } from "./process.ts";

// `!reset` in an overlay, which a test overlay drops named volumes with.
const versionMinimum = [2, 24, 4];

/** A Compose project and what its files are read with. */
export interface ComposeTarget {
  root: string;
  project: string;
  files: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** The loopback ports Docker published each service's ports on, by target. */
export type Services = Record<string, { ports: Record<string, number> }>;

export function supportsComposeVersion(version: string): boolean {
  const match = version.trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;

  const current = match.slice(1).map(Number);
  for (const [index, minimum] of versionMinimum.entries()) {
    const part = current[index] ?? 0;
    if (part > minimum) return true;
    if (part < minimum) return false;
  }
  return true;
}

export async function ensureDocker(cwd: string): Promise<void> {
  try {
    await run(["docker", "info", "--format", "{{.ServerVersion}}"], {
      cwd,
      capture: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "Docker CLI was not found in PATH. Install Docker, or expose its `docker` command to this terminal, then retry.",
      );
    throw new Error(
      "Docker is installed, but its daemon is unavailable. Start Docker, wait until it reports that it is running, then retry.",
    );
  }
  const { stdout } = await run(["docker", "compose", "version", "--short"], {
    cwd,
    capture: true,
  });
  if (!supportsComposeVersion(stdout))
    throw new Error(
      `Docker Compose ${versionMinimum.join(".")} or newer is required; found ${stdout.trim()}`,
    );
}

export function compose(
  target: ComposeTarget,
  args: string[],
  options: Omit<RunOptions, "cwd" | "env" | "signal"> = {},
): Promise<RunResult> {
  const { root, project, files, env, signal } = target;
  return run(
    [
      "docker",
      "compose",
      ...files.flatMap((file) => ["-f", file]),
      "--project-directory",
      root,
      "--project-name",
      project,
      ...args,
    ],
    { ...options, cwd: root, env, ...(signal ? { signal } : {}) },
  );
}

/** The published ports in the output of `compose ps --format json`. */
export function parsePublishedPorts(output: string): Services {
  const services: Services = {};
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const container = JSON.parse(line) as {
      Service: string;
      Publishers?: {
        TargetPort: number;
        PublishedPort: number;
        Protocol: string;
      }[];
    };
    const { ports } = (services[container.Service] ??= { ports: {} });
    for (const publisher of container.Publishers ?? [])
      if (publisher.Protocol === "tcp" && publisher.PublishedPort > 0)
        ports[publisher.TargetPort] = publisher.PublishedPort;
  }
  return services;
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolveReachable(answer);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

async function waitForPublishedPort(service: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await reachable(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `${service} is ready inside Docker but its published port ${port} is unreachable. Restart Docker and retry.`,
  );
}

/**
 * Starts the project's services, waits until each is healthy and answers on
 * its published ports, and runs the `init` services to their end.
 */
export async function startServices(target: ComposeTarget, init: string[]): Promise<Services> {
  // `up --wait` takes an init service for ready while it still runs, and for
  // failed once it has exited, so those are left out and run on their own.
  let services: string[] = [];
  if (init.length) {
    const { stdout } = await compose(target, ["config", "--services"], {
      capture: true,
    });
    const all = stdout.split("\n").filter((line) => line.trim());
    services = all.filter((name) => !init.includes(name));
    if (!services.length) throw new Error("`compose.init` names every service; none would start");
  }
  await compose(target, ["up", "-d", "--wait", ...services]);
  for (const job of init) await compose(target, ["run", "--rm", "--no-deps", job]);

  const { stdout } = await compose(target, ["ps", "--format", "json"], {
    capture: true,
  });
  const published = parsePublishedPorts(stdout);
  await Promise.all(
    Object.entries(published).flatMap(([service, { ports }]) =>
      Object.values(ports).map((port) => waitForPublishedPort(service, port)),
    ),
  );
  return published;
}

/** Every Compose project that has a container, network or volume. */
export async function composeProjects(cwd: string): Promise<string[]> {
  const label = "com.docker.compose.project";
  const listings = await Promise.all(
    [
      ["ps", "--all"],
      ["network", "ls"],
      ["volume", "ls"],
    ].map((command) =>
      run(
        ["docker", ...command, "--filter", `label=${label}`, "--format", `{{.Label "${label}"}}`],
        { cwd, capture: true },
      ),
    ),
  );
  return listings.flatMap(({ stdout }) => stdout.split("\n").filter((line) => line.trim()));
}
