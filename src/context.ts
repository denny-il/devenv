import { delimiter, resolve } from "node:path";
import type { ComposeConfig, Config, Context, EnvValues } from "./config.ts";
import type { State } from "./state.ts";

/**
 * A stack's state as the functions of a config see it. `serve` is the
 * config's `compose.serve`: the service ports that have an origin.
 */
export function createContext(
  state: Pick<State, "root" | "project" | "composeEnv" | "services" | "apps" | "tailnet">,
  serve: ComposeConfig["serve"] = {},
): Context {
  const origin = (port: number) =>
    state.tailnet ? `https://${state.tailnet}:${port}` : `http://localhost:${port}`;
  const port = (ref: string) => {
    const [app = "", name, ...rest] = ref.split(".");
    const ports = state.apps[app]?.ports;
    if (!ports || rest.length)
      throw new Error(
        `No app port \`${ref}\`; the apps are: ${Object.keys(state.apps).join(", ") || "none"}`,
      );
    const names = Object.keys(ports);
    if (name === undefined && names.length !== 1)
      throw new Error(
        `\`${app}\` has several ports; name one: ${names.map((each) => `${app}.${each}`).join(", ")}`,
      );
    const found = ports[name ?? names[0]!];
    if (found === undefined)
      throw new Error(`\`${app}\` has no port \`${name}\`; it has: ${names.join(", ")}`);
    return found;
  };

  return {
    root: state.root,
    project: state.project,
    vars: state.composeEnv,
    tailnet: state.tailnet,
    service(name) {
      const service = state.services[name];
      if (!service)
        throw new Error(
          `No running service \`${name}\`; there are: ${Object.keys(state.services).join(", ") || "none"}`,
        );
      const published = (target: number) => {
        const found = service.ports[target];
        if (found === undefined)
          throw new Error(
            `Service \`${name}\` publishes no port ${target}. Publish it on a loopback port Docker assigns.`,
          );
        return found;
      };
      return {
        port: published,
        url(target) {
          // In every mode, not only over Tailscale, where the origin of a
          // port that is not served would answer nothing: a config that
          // works locally must not fail on the first `start --tailscale`.
          if (!serve[name]?.includes(target))
            throw new Error(
              `Service \`${name}\` port ${target} has no origin: name it in \`compose.serve\`, as \`${name}: [${target}]\`, so that \`start --tailscale\` serves it.`,
            );
          return origin(published(target));
        },
      };
    },
    port,
    url: (ref) => origin(port(ref)),
  };
}

/** A service port of `compose.serve` in a stack. */
export interface ServedPort {
  /** As `start` and `status` list it. */
  label: string;
  /** The loopback port Docker published it on. */
  port: number;
  url: string;
}

/** The service ports `compose.serve` names, as `context`'s stack has them. */
export function servedPorts(config: Config, context: Context): ServedPort[] {
  return Object.entries(config.compose?.serve ?? {}).flatMap(([name, targets]) =>
    targets.map((target) => {
      try {
        const service = context.service(name);
        return {
          label: targets.length === 1 ? name : `${name}.${target}`,
          port: service.port(target),
          url: service.url(target),
        };
      } catch (error) {
        throw new Error(`\`compose.serve\`: ${(error as Error).message}`);
      }
    }),
  );
}

/**
 * An app's ports for its `env`. A name the app does not have throws: read
 * from a plain object it would unset the variable without a word.
 */
export function appPorts(app: string, ports: Record<string, number>): Record<string, number> {
  return new Proxy(ports, {
    get(target, name, receiver) {
      if (typeof name === "string" && !(name in target))
        throw new Error(
          `\`${app}\` has no port \`${name}\`; it has: ${Object.keys(target).join(", ")}`,
        );
      return Reflect.get(target, name, receiver);
    },
  });
}

/** `values` as strings, without what is unset. */
export function stringValues(values: EnvValues | undefined): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {}))
    if (value !== undefined) strings[key] = String(value);
  return strings;
}

/**
 * The environment of a stack's commands: this process's, which holds the
 * root `.env`, under the project's `env` and then each of `layers`.
 */
export function createEnvironment(
  config: Config,
  context: Context,
  ...layers: (EnvValues | undefined)[]
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // The project's own tools, however this launcher was started.
    PATH: [resolve(context.root, "node_modules/.bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  };
  for (const layer of [config.env?.(context), ...layers])
    for (const [key, value] of Object.entries(layer ?? {}))
      environment[key] = value === undefined ? undefined : String(value);
  return environment;
}
