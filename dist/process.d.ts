import { type ChildProcess, type SpawnOptions } from "node:child_process";
/** A program with its arguments, or a line for the shell. */
export type Command = string | readonly string[];
export interface RunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Collects the output instead of passing it through. */
    capture?: boolean;
    /** Rejects when the command fails; on unless turned off. */
    reject?: boolean;
    signal?: AbortSignal;
    detached?: boolean;
}
export interface RunResult {
    code: number;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}
export interface Exit {
    code: number | null;
    signal: NodeJS.Signals | null;
}
export declare function describeCommand(command: Command): string;
export declare function spawnCommand(command: Command, options: SpawnOptions): ChildProcess;
/** Runs a command to its end. */
export declare function run(command: Command, options: RunOptions): Promise<RunResult>;
/** Sends `signal` to the process group `pid` leads, if it still exists. */
export declare function signalGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean;
/**
 * Waits for the processes left in a child's group, such as servers a suite
 * started, to end, then ends them: none may outlive the stack they use.
 */
export declare function reapGroup(pid: number | undefined): Promise<void>;
/** The shell's exit status for a child's exit. */
export declare function exitStatus({ code, signal }: Exit): number;
