import type { Services } from "./compose.ts";
/** What a worktree's stack is made of, kept between commands. */
export interface State {
    version: 1;
    /** The real path of the stack's checkout. A stack whose checkout is gone is an orphan. */
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
/**
 * Where every stack on this machine keeps its state: outside the checkouts,
 * so a stack can be found, and removed, after its checkout is gone, and its
 * credentials are in no workspace a dev server might hand out.
 */
export declare function stateHome(): string;
/** The state file of a stack, by its Compose project, which no two checkouts share. */
export declare function statePath(project: string): string;
/**
 * A state file's content as the state of `project`, the stack the file is
 * named after. A file that speaks for another stack, or names no checkout,
 * is refused: it could have `prune` remove a stack that is in use.
 */
export declare function parseState(content: string, project: string): State;
export declare function readState(project: string): Promise<State | null>;
export declare function writeState(state: State): Promise<void>;
export declare function removeState(project: string): Promise<void>;
/** The state of every stack on this machine that can be read. */
export declare function listStates(): Promise<State[]>;
