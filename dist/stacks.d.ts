import { type State } from "./state.ts";
/** The stacks whose checkout is gone: nothing can start, stop or reset them any more. */
export declare function orphans(states: State[], exists: (path: string) => boolean): State[];
/** `devenv list`: every stack on this machine. */
export declare function list(): Promise<void>;
/**
 * `devenv prune`: removes the stacks whose checkout is gone, with their
 * data. A checkout that was moved, or is on a disk not mounted now, looks the
 * same, so nothing goes without a yes.
 */
export declare function prune(options: {
    yes: boolean;
}): Promise<void>;
