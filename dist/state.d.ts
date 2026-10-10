import type { Services } from "./compose.ts";
/** What a worktree's stack is made of, kept between commands. */
export interface State {
    version: 1;
    root: string;
    project: string;
    /** `compose.env` as the stack's volumes were created with. */
    composeEnv: Record<string, string>;
    services: Services;
    apps: Record<string, {
        ports: Record<string, number>;
    }>;
    /** The tailnet name the app URLs are under, when served over Tailscale. */
    tailnet?: string;
    /** The services are down; their volumes and so `composeEnv` remain. */
    stopped?: true;
}
export declare function stateDirectory(root: string): string;
export declare function statePath(root: string): string;
/**
 * The state file's content as a state of `project`, or nothing when it is
 * another project's: a copied worktree starts a stack of its own.
 */
export declare function parseState(content: string, project: string): State | null;
export declare function readState(root: string, project: string): Promise<State | null>;
export declare function writeState(state: State): Promise<void>;
export declare function removeState(root: string): Promise<void>;
