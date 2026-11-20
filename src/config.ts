import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./process.ts";

/** A program with its arguments, or a line for the shell. */
export type Command = string | readonly string[];

/** Environment variables; one left `undefined` is unset. */
export type EnvValues = Record<string, string | number | undefined>;

export interface PortOptions {
  /**
   * Reserved and remembered like any port, but neither listed nor served to
   * the tailnet: an upstream behind another of the app's ports, say.
   */
  internal?: boolean;
}

export interface ReadyCheck {
  /** The port to try, by name; may be left out for an app with one port. */
  port?: string;
  /**
   * Asks for this path over HTTP, ready on a status below 400. Without it,
   * the app is ready once its port accepts a connection.
   */
  path?: string;
  /** Seconds before the app counts as failed to start; 300 unless given. */
  timeout?: number;
}

export interface AppConfig {
  /**
   * Started in the project root, in a process group of its own. A command
   * that builds first and then serves is still one command.
   */
  command: Command;
  /** The ports the app listens on, by name. One named `http` unless given. */
  ports?: Record<string, PortOptions>;
  /**
   * How the app takes its ports and listen address, on top of the project's
   * `env`. The app must listen on `127.0.0.1`.
   */
  env?: (ports: Record<string, number>, context: Context) => EnvValues;
  /**
   * How `start` tells the app answers, before it reports the stack ready.
   * `true` waits for the app's one port to accept connections. Without it,
   * the app counts as started once its command runs.
   */
  ready?: boolean | ReadyCheck;
}

export interface ComposeConfig {
  /** The Compose files of every mode, relative to the project root. */
  files: string[];
  /** Added for `up` and `start`. */
  dev?: string[];
  /** Added for `test`. */
  test?: string[];
  /**
   * Services that do a job and exit, such as creating a bucket. Each runs to
   * its end once the others are ready.
   */
  init?: string[];
  /**
   * Variables for the Compose files. A stack keeps the values its volumes
   * were created with until `reset`, so a login a database was initialized
   * with cannot change under it. One left `undefined` here is not unset: it
   * stays as the environment has it.
   */
  env?: EnvValues;
  /**
   * Service ports that browsers reach themselves, by service and target
   * port: `{ storage: [9000] }`. `start --tailscale` serves each to the
   * tailnet as it serves the app ports, under the number of the loopback
   * port Docker published it on. `service(name).url(target)` gives the
   * origin of one. Without `--tailscale` nothing is served.
   */
  serve?: Record<string, number[]>;
}

export interface TestConfig {
  /** Run on the fresh stack before the tests, a migration say. */
  setup?: Command[];
  /** Given the arguments after `test --`, which are added to a plain command. */
  command: Command | ((args: string[]) => Command);
  /** On top of the project's `env`. */
  env?: EnvValues;
  compose?: {
    /**
     * Variables for the Compose files of the test stack alone, on top of
     * `compose.env`: a `start` stack neither gets them nor counts them among
     * what it was created with.
     */
    env?: EnvValues;
  };
}

export interface Config {
  /** Names this project's stacks, and any Compose containers and volumes. */
  name: string;
  /** Omit for host-only apps. Empty file lists also need no Docker. */
  compose?: ComposeConfig;
  /** Started by `start` in this order, without waiting for one another. */
  apps?: Record<string, AppConfig>;
  /**
   * The environment of every app and command, on top of the root `.env`, or
   * the main checkout's in a git worktree that has none.
   */
  env?: (context: Context) => EnvValues;
  /** Run by `up` once the services are up, with the local app URLs. */
  setup?: Command[];
  test?: TestConfig;
  /** Lines `start` and `status` print under the URLs, such as a seeded login. */
  info?: (context: Context) => Record<string, string>;
}

/** What a stack is made of, for the functions of a config. */
export interface Context {
  /** The directory of the config file. */
  root: string;
  /** The stack's name: one per worktree, and per run for tests. */
  project: string;
  /** `compose.env` as the stack uses it, under `test.compose.env` for tests. */
  vars: Readonly<Record<string, string>>;
  /** This machine's tailnet name while the stack is served over Tailscale. */
  tailnet: string | undefined;
  /** A Compose service, by its name in the Compose files. */
  service(name: string): {
    /** The loopback port Docker published its port `target` on. */
    port(target: number): number;
    /**
     * The origin that port answers at, for one named in `compose.serve`:
     * under the tailnet name while the stack is served over Tailscale, as
     * `url()` is for an app's port.
     */
    url(target: number): string;
  };
  /** An app's port: `'api.proxy'`, or `'web'` for an app with a single port. */
  port(ref: string): number;
  /** The origin that port answers at. */
  url(ref: string): string;
}

export function defineConfig(config: Config): Config {
  return config;
}

/** Whether any mode can leave Docker resources behind. */
export function usesCompose(config: Config): boolean {
  const compose = config.compose;
  return !!(compose && (compose.files.length || compose.dev?.length || compose.test?.length));
}

export const defaultPorts: Record<string, PortOptions> = { http: {} };

const configNames = ["devenv.config.ts", "devenv.config.js"];

/** The config file of the project `directory` is in. */
export function findConfig(directory: string): string {
  for (let current = resolve(directory); ; current = dirname(current)) {
    for (const name of configNames) {
      const path = resolve(current, name);
      if (existsSync(path)) return path;
    }
    if (current === dirname(current))
      throw new Error(`No ${configNames.join(" or ")} in ${resolve(directory)} or above it`);
  }
}

/**
 * The `.env` of the project at `root`: its own, or, in a linked git worktree
 * that has none, the one at the same place in the main checkout. `.env` is
 * not checked out, so a new worktree would otherwise start without the keys
 * its apps need and fail far from the cause.
 */
export async function findEnvFile(root: string): Promise<string | undefined> {
  const own = resolve(root, ".env");
  if (existsSync(own)) return own;
  // The repository `root` is in, wherever a hook or a wrapper points git.
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const git = (...args: string[]) => run(["git", ...args], { cwd: root, env, capture: true });
  try {
    const [toplevel, worktrees] = await Promise.all([
      git("rev-parse", "--show-toplevel"),
      git("worktree", "list", "--porcelain", "-z"),
    ]);
    // The main checkout is listed first, a NUL after each of its lines. A
    // bare repository is listed there too, and is no checkout.
    const [path = "", ...attributes] = (worktrees.stdout.split("\0\0")[0] ?? "").split("\0");
    if (!path.startsWith("worktree ") || attributes.includes("bare")) return undefined;
    const main = realpathSync(path.slice("worktree ".length));
    const here = realpathSync(toplevel.stdout.replace(/\n$/, ""));
    if (main === here) return undefined;
    const inMain = resolve(main, relative(here, realpathSync(root)), ".env");
    return existsSync(inMain) ? inMain : undefined;
  } catch {
    // No git, or one before 2.36, no repository, or no main checkout left.
    return undefined;
  }
}

// What Compose takes for a project's name, which every stack's name starts
// with. A stack's state is filed under that name, and read back only under
// one of this form.
const namePattern = /^[a-z0-9][a-z0-9_-]*$/;

export async function loadConfig(path: string): Promise<Config> {
  const module: { default?: unknown } = await import(pathToFileURL(path).href);
  const config = module.default;
  if (typeof config !== "object" || config === null)
    throw new Error(`${path} must have the config as its default export`);
  const { name } = config as Partial<Config>;
  if (typeof name !== "string" || !namePattern.test(name))
    throw new Error(
      `\`name\` in ${path} must be made of lowercase letters, digits, \`-\` and \`_\`, and start with a letter or digit`,
    );
  return config as Config;
}
