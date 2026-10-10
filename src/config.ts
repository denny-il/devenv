import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export interface AppConfig {
  /** Started in the project root, in a process group of its own. */
  command: Command;
  /** The ports the app listens on, by name. One named `http` unless given. */
  ports?: Record<string, PortOptions>;
  /**
   * How the app takes its ports and listen address, on top of the project's
   * `env`. The app must listen on `127.0.0.1`.
   */
  env?: (ports: Record<string, number>, context: Context) => EnvValues;
}

export interface ComposeConfig {
  /** The Compose files of every mode, relative to the project root. */
  files: string[];
  /** Added for `up` and `dev`. */
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
}

export interface TestConfig {
  /** Run on the fresh stack before the tests, a migration say. */
  setup?: Command[];
  /** Given the arguments after `test --`, which are added to a plain command. */
  command: Command | ((args: string[]) => Command);
  /** On top of the project's `env`. */
  env?: EnvValues;
}

export interface Config {
  /** Names this project's Compose projects, and so its containers and volumes. */
  name: string;
  compose: ComposeConfig;
  /** Started by `dev` in this order. */
  apps?: Record<string, AppConfig>;
  /** The environment of every app and command, on top of the root `.env`. */
  env?: (context: Context) => EnvValues;
  /** Run by `dev` once the services are up, before the apps start. */
  setup?: Command[];
  test?: TestConfig;
  /** Lines `dev` and `status` print under the URLs, such as a seeded login. */
  info?: (context: Context) => Record<string, string>;
}

/** What a stack is made of, for the functions of a config. */
export interface Context {
  /** The directory of the config file. */
  root: string;
  /** The stack's Compose project: one per worktree, and per run for tests. */
  project: string;
  /** `compose.env` as the stack uses it. */
  vars: Readonly<Record<string, string>>;
  /** This machine's tailnet name while the apps are served over Tailscale. */
  tailnet: string | undefined;
  /** A Compose service, for the loopback port Docker published one of its ports on. */
  service(name: string): { port(target: number): number };
  /** An app's port: `'api.proxy'`, or `'web'` for an app with a single port. */
  port(ref: string): number;
  /** The origin that port answers at. */
  url(ref: string): string;
}

export function defineConfig(config: Config): Config {
  return config;
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

export async function loadConfig(path: string): Promise<Config> {
  const module: { default: Config } = await import(pathToFileURL(path).href);
  return module.default;
}
