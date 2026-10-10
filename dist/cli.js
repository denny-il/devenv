import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findConfig, loadConfig } from "./config.js";
import { createProject, dev, down, runCommand, status, test, up } from "./stack.js";
import { info, serve } from "./tailnet.js";
const usage = `Usage: devenv <command>

Commands:
  up                       Start this worktree's services
  dev [--tailscale]        Start services, run setup, and run the apps; with
                           --tailscale they are served to this machine's
                           Tailscale network over HTTPS
  status                   Show this worktree's services and app URLs
  run -- <command>         Run a command with this worktree's environment
  test [-- <args>]         Run the tests on a fresh, throwaway stack that is
                           always removed
  down                     Stop services and keep their volumes
  reset                    Stop services and delete this worktree's volumes
  tailnet info [--json]    Show this machine's tailnet name and what keeps it
                           from serving, if anything
  tailnet serve <port>...  Serve https://<machine>:<port> from
                           http://127.0.0.1:<port> until stopped`;
async function loadProject() {
    const path = findConfig(process.cwd());
    const root = dirname(path);
    // Before the config, which may read it. Variables already set win.
    const envFile = resolve(root, ".env");
    if (existsSync(envFile))
        process.loadEnvFile(envFile);
    return createProject(root, await loadConfig(path));
}
function noArguments(command, args) {
    if (args.length)
        throw new Error(`\`devenv ${command}\` takes no arguments`);
}
export async function main(argv) {
    const [command, ...args] = argv;
    switch (command) {
        case "up":
            noArguments(command, args);
            await up(await loadProject());
            break;
        case "dev":
            if (args.length > 1 || (args.length === 1 && args[0] !== "--tailscale"))
                throw new Error("`devenv dev` takes only `--tailscale`");
            await dev(await loadProject(), { tailscale: args.length === 1 });
            break;
        case "status":
            noArguments(command, args);
            await status(await loadProject());
            break;
        case "run": {
            const commandArgs = args[0] === "--" ? args.slice(1) : args;
            if (!commandArgs.length)
                throw new Error("A command is required after `devenv run --`");
            await runCommand(await loadProject(), commandArgs);
            break;
        }
        case "test":
            await test(await loadProject(), args[0] === "--" ? args.slice(1) : args);
            break;
        case "down":
            noArguments(command, args);
            await down(await loadProject(), false);
            break;
        case "reset":
            noArguments(command, args);
            await down(await loadProject(), true);
            break;
        case "tailnet": {
            const [subcommand, ...rest] = args;
            if (subcommand === "info")
                await info(rest);
            else if (subcommand === "serve")
                await serve(rest);
            else
                throw new Error(`Unknown tailnet command\n\n${usage}`);
            break;
        }
        case "--help":
        case "-h":
        case undefined:
            console.log(usage);
            break;
        default:
            throw new Error(`Unknown command: ${command}\n\n${usage}`);
    }
}
