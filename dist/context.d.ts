import type { Config, Context, EnvValues } from "./config.ts";
import type { State } from "./state.ts";
/** A stack's state as the functions of a config see it. */
export declare function createContext(state: Pick<State, "root" | "project" | "composeEnv" | "services" | "apps" | "tailnet">): Context;
/**
 * An app's ports for its `env`. A name the app does not have throws: read
 * from a plain object it would unset the variable without a word.
 */
export declare function appPorts(app: string, ports: Record<string, number>): Record<string, number>;
/** `values` as strings, without what is unset. */
export declare function stringValues(values: EnvValues | undefined): Record<string, string>;
/**
 * The environment of a stack's commands: this process's, which holds the
 * root `.env`, under the project's `env` and then each of `layers`.
 */
export declare function createEnvironment(config: Config, context: Context, ...layers: (EnvValues | undefined)[]): NodeJS.ProcessEnv;
