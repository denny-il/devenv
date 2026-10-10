// Serves this machine's local ports to its Tailscale network over HTTPS:
// `https://<machine>.<tailnet>.ts.net:<port>` answers from
// `http://127.0.0.1:<port>`, so the servers keep listening on this machine
// only.

import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Runs the Tailscale CLI to its end. */
function tailscale(args: string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", rejectOutput);
    child.on("close", () => resolveOutput(stdout));
  });
}

export interface Tailnet {
  host: string | null;
  problems: string[];
}

/**
 * This machine on the tailnet: its name, and what keeps it from serving over
 * HTTPS, each with its remedy. Whether this user may serve shows only when
 * serving is tried.
 */
export async function inspect(): Promise<Tailnet> {
  let status: {
    BackendState?: string;
    CertDomains?: string[] | null;
    Self?: { DNSName?: string };
  };
  try {
    status = JSON.parse(await tailscale(["status", "--json"]));
  } catch (error) {
    return {
      host: null,
      problems: [
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "Tailscale is not installed: https://tailscale.com/download"
          : "Tailscale did not report its status. Is its service running?",
      ],
    };
  }
  const host = status.Self?.DNSName?.replace(/\.$/, "") || null;
  const problems: string[] = [];
  if (status.BackendState !== "Running")
    problems.push("Tailscale is not connected. Run `tailscale up`.");
  else if (!host)
    problems.push(
      "This machine has no tailnet name. Enable MagicDNS: https://login.tailscale.com/admin/dns",
    );
  // With them off, `tailscale serve` waits for an approval in a browser.
  else if (!status.CertDomains?.includes(host))
    problems.push(
      "HTTPS certificates are off for this tailnet. Enable them: https://login.tailscale.com/admin/dns",
    );
  return { host, problems };
}

/** This machine's tailnet name, once nothing found keeps it from serving. */
export async function tailnetHost(): Promise<string> {
  const { host, problems } = await inspect();
  if (problems.length || !host) throw new Error(problems.join("\n"));
  return host;
}

// How long a `tailscale serve` may take to put its entry in place.
const startTimeout = 15_000;

/** Failures of `tailscale serve` that another try would only repeat. */
const lasting = /Access denied|listener already exists/;

/** Why `tailscale serve` failed for `port`, from what it printed. */
function serveFailure(port: number, output: string, what = "stopped serving"): string {
  if (output.includes("Access denied"))
    return "Tailscale does not let this user serve. Run once: sudo tailscale set --operator=$USER";
  if (output.includes("listener already exists"))
    return `Port ${port} is already served under this machine's tailnet name, by this or another project.`;
  const said = output.trim().split("\n").at(-1);
  return `Tailscale ${what} port ${port}${said ? `: ${said}` : "."}`;
}

interface PortServing {
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<void>;
  passing(): boolean;
  failure(): string;
}

/**
 * One port served by a `tailscale serve` kept in the foreground: Tailscale
 * drops such an entry when its process ends, however it ends, so nothing is
 * left behind to clean up.
 */
function servePort(host: string, port: number): PortServing {
  const child = spawn(
    "tailscale",
    ["serve", `--https=${port}`, `http://127.0.0.1:${port}`],
    // A group of its own: a terminal's Ctrl-C must not end it before
    // whoever serves has decided to stop.
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let output = "";
  let overdue = false;
  const closed = new Promise<void>((resolveClosed) => {
    child.on("close", () => resolveClosed());
    child.on("error", () => resolveClosed());
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    // One that neither serves nor ends, waiting for an approval in a browser
    // say, would hold the start forever.
    const timer = setTimeout(() => {
      overdue = true;
      rejectReady(new Error(serveFailure(port, output, "did not start serving")));
      child.kill();
    }, startTimeout);
    const read = (chunk: string) => {
      output += chunk;
      // It prints the URL once the entry is in place.
      if (!output.includes(`https://${host}`)) return;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    void closed.then(() => {
      clearTimeout(timer);
      rejectReady(new Error(serveFailure(port, output)));
    });
  });
  // Whoever needs the failure awaits `ready` or reads `failure()`.
  ready.catch(() => {});
  return {
    child,
    ready,
    closed,
    passing: () => !overdue && !lasting.test(output),
    failure: () => serveFailure(port, output),
  };
}

export interface Serving {
  /** Throws if a port cannot be served. */
  start(ports: number[]): Promise<void>;
  stop(): void;
  /** Every port's `tailscale serve` has ended. */
  closed(): Promise<unknown>;
  /** The first served port to stop being served, with why. */
  ended(): Promise<string>;
}

/** Serves ports under `host`, this machine's tailnet name, until `stop()`. */
export function createServing(host: string): Serving {
  const servings: PortServing[] = [];
  let starting: PortServing | undefined;
  let stopped = false;

  return {
    async start(ports) {
      // One at a time, and again after a failure that may pass: Tailscale
      // takes one serve entry at a time and refuses another sent meanwhile
      // ("etag mismatch"), whether by this process or by another project's.
      for (const port of ports)
        for (let attempt = 1; !stopped; attempt += 1) {
          starting = servePort(host, port);
          try {
            await starting.ready;
            servings.push(starting);
            break;
          } catch (error) {
            if (stopped || attempt === 5 || !starting.passing()) throw error;
            await delay(100 * attempt);
          }
        }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const all = starting ? [...servings, starting] : servings;
      for (const { child } of all) child.kill();
      // One that does not end when asked would keep its entry, and whoever
      // waits for it waiting.
      setTimeout(() => {
        for (const { child } of all) child.kill("SIGKILL");
      }, 5_000).unref();
    },
    closed() {
      const all = starting ? [...servings, starting] : servings;
      return Promise.all(all.map((serving) => serving.closed));
    },
    ended() {
      return Promise.race(servings.map((serving) => serving.closed.then(() => serving.failure())));
    },
  };
}

function parsePorts(values: string[]): number[] {
  if (!values.length) throw new Error("Name at least one port.");
  return values.map((value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Not a port: ${value}`);
    return port;
  });
}

/** `devenv tailnet info [--json]` */
export async function info(args: string[]): Promise<void> {
  const found = await inspect();
  if (found.problems.length) process.exitCode = 1;
  if (args.includes("--json")) {
    console.log(JSON.stringify(found));
    return;
  }
  if (found.host) console.log(found.host);
  for (const problem of found.problems) console.error(problem);
}

/** `devenv tailnet serve <port>...`: serves the ports until stopped. */
export async function serve(args: string[]): Promise<void> {
  const ports = parsePorts(args);
  const host = await tailnetHost();
  const serving = createServing(host);
  let stopping = false;
  const stop = () => {
    stopping = true;
    serving.stop();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  try {
    await serving.start(ports);
    if (!stopping) {
      for (const port of ports) console.log(`https://${host}:${port} → http://127.0.0.1:${port}`);
      const failure = await serving.ended();
      if (!stopping) throw new Error(failure);
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    serving.stop();
    await serving.closed();
    for (const signal of signals) process.off(signal, stop);
  }
}
