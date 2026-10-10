import { type RunOptions, type RunResult } from "./process.ts";
export declare const composeVersionMinimum: number[];
/** A Compose project and what its files are read with. */
export interface ComposeTarget {
    root: string;
    project: string;
    files: string[];
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}
/** The loopback ports Docker published each service's ports on, by target. */
export type Services = Record<string, {
    ports: Record<string, number>;
}>;
export declare function supportsComposeVersion(version: string): boolean;
export declare function ensureDocker(cwd: string): Promise<void>;
export declare function compose(target: ComposeTarget, args: string[], options?: Omit<RunOptions, "cwd" | "env" | "signal">): Promise<RunResult>;
/** The published ports in the output of `compose ps --format json`. */
export declare function parsePublishedPorts(output: string): Services;
/**
 * Starts the project's services, waits until each is healthy and answers on
 * its published ports, and runs the `init` services to their end.
 */
export declare function startServices(target: ComposeTarget, init: string[]): Promise<Services>;
/**
 * Removes every volume of `project`. `down --volumes` removes those of the
 * Compose files as they are now, not one of a service since deleted from
 * them, which would come back with its data if the service did.
 */
export declare function removeVolumesOf(cwd: string, project: string): Promise<void>;
/** Every Compose project that has a container, network or volume. */
export declare function composeProjects(cwd: string): Promise<string[]>;
