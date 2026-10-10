import { spawn } from "node:child_process";
import { constants } from "node:os";
export function describeCommand(command) {
    return typeof command === "string" ? command : command.join(" ");
}
export function spawnCommand(command, options) {
    if (typeof command === "string")
        return spawn(command, { ...options, shell: true });
    const [program, ...args] = command;
    if (program === undefined)
        throw new Error("A command names a program");
    return spawn(program, args, options);
}
/** Runs a command to its end. */
export function run(command, options) {
    const { cwd, env = process.env, capture = false, reject = true, signal, detached = false, } = options;
    return new Promise((resolveRun, rejectRun) => {
        if (signal?.aborted) {
            rejectRun(signal.reason);
            return;
        }
        // An abortable child leads a process group of its own, which an abort
        // interrupts as a whole, as Ctrl-C at a terminal would, and kills if it
        // has not stopped in time; the call settles only once the child has
        // exited, so nothing it starts outlives it.
        const child = spawnCommand(command, {
            cwd,
            env,
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
            detached: detached || signal !== undefined,
        });
        let escalation;
        const abort = () => {
            signalGroup(child.pid, "SIGINT");
            escalation = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 10_000);
        };
        signal?.addEventListener("abort", abort, { once: true });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => {
            signal?.removeEventListener("abort", abort);
            rejectRun(error);
        });
        child.on("close", (code, exitSignal) => {
            signal?.removeEventListener("abort", abort);
            clearTimeout(escalation);
            const settle = () => {
                if (signal?.aborted) {
                    rejectRun(signal.reason);
                    return;
                }
                if (reject && code !== 0) {
                    rejectRun(new Error(`${describeCommand(command)} failed${stderr ? `\n${stderr.trim()}` : ""}`));
                    return;
                }
                resolveRun({ code: code ?? 1, signal: exitSignal, stdout, stderr });
            };
            // What it started may outlive it, ignoring an interrupt or left
            // running by a command that ended on its own.
            if (signal)
                void reapGroup(child.pid).then(settle);
            else
                settle();
        });
    });
}
/** Sends `signal` to the process group `pid` leads, if it still exists. */
export function signalGroup(pid, signal) {
    if (pid === undefined)
        return false;
    try {
        process.kill(-pid, signal);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/**
 * Waits for the processes left in a child's group, such as servers a suite
 * started, to end, then ends them: none may outlive the stack they use.
 */
export async function reapGroup(pid) {
    if (!signalGroup(pid, 0))
        return;
    signalGroup(pid, "SIGTERM");
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        if (!signalGroup(pid, 0))
            return;
    }
    signalGroup(pid, "SIGKILL");
}
/** The shell's exit status for a child's exit. */
export function exitStatus({ code, signal }) {
    if (code !== null)
        return code;
    return 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
}
