import { type Command } from "./process.ts";
/** Something this machine needs before a stack can run on it. */
export interface Requirement {
    name: string;
    /** What is wrong, or nothing once it is met. */
    check(): Promise<string | undefined>;
    /** Commands that meet it, run at the terminal: an installer may ask for a password. */
    fix?: Command[];
    /** What is left for a person to do when it is still unmet. */
    manual?: string;
}
/**
 * Meets each requirement in turn, fixing what a command can fix, and stops
 * at the first that stays unmet: the ones after it build on it. Returns
 * whether all are met.
 */
export declare function meet(requirements: Requirement[], runFix: (command: Command) => Promise<unknown>): Promise<boolean>;
/**
 * `devenv setup [docker] [tailscale]`: installs and sets up what stacks need
 * on this machine; all of it unless told which.
 */
export declare function setup(wanted: string[]): Promise<void>;
