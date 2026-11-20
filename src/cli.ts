import { loadProject } from "./project.ts";
import { setup } from "./setup.ts";
import { down, runCommand, start, status, stop, up } from "./stack.ts";
import { list, prune } from "./stacks.ts";
import { info, serve } from "./tailnet.ts";
import { test } from "./testing.ts";

const usage = `Usage: devenv <command>

Commands:
  up                       Start any services, assign app ports, and run
                           setup
  start [--tailscale]      Run the apps of a stack that is up until one
                           stops; with --tailscale they, and the service
                           ports in \`compose.serve\`, are served to this
                           machine's Tailscale network over HTTPS
  stop                     Stop this worktree's running \`start\`, if any,
                           and wait until its apps have stopped
  status                   Show this worktree's services, URLs, and whether
                           \`start\` is running
  run -- <command>         Run a command with this worktree's environment
  test [-- <args>]         Run the tests on a fresh, throwaway stack that is
                           always removed
  down                     Stop the apps and services; keep the services'
                           volumes
  reset                    Stop the apps; delete state and this worktree's
                           Compose volumes and the images built for it
  list                     Show every stack on this machine
  prune [--yes]            Remove the stacks whose checkout is gone, with
                           their data
  setup [docker] [tailscale]
                           Install and set up Docker and Tailscale on this
                           machine; both unless one is named
  tailnet info [--json]    Show this machine's tailnet name and what keeps it
                           from serving, if anything
  tailnet serve <port>...  Serve https://<machine>:<port> from
                           http://127.0.0.1:<port> until stopped`;

function noArguments(command: string, args: string[]): void {
  if (args.length) throw new Error(`\`devenv ${command}\` takes no arguments`);
}

/** Whether `flag`, all that `command` takes, was given. */
function onlyFlag(command: string, args: string[], flag: string): boolean {
  if (args.some((argument) => argument !== flag) || args.length > 1)
    throw new Error(`\`devenv ${command}\` takes only \`${flag}\``);
  return args.length === 1;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const project = () => loadProject(process.cwd());
  switch (command) {
    case "up":
      noArguments(command, args);
      await up(await project());
      break;
    case "start": {
      const tailscale = onlyFlag(command, args, "--tailscale");
      await start(await project(), { tailscale });
      break;
    }
    case "stop":
      noArguments(command, args);
      await stop(await project());
      break;
    case "status":
      noArguments(command, args);
      await status(await project());
      break;
    case "run": {
      const commandArgs = args[0] === "--" ? args.slice(1) : args;
      if (!commandArgs.length) throw new Error("A command is required after `devenv run --`");
      await runCommand(await project(), commandArgs);
      break;
    }
    case "test":
      await test(await project(), args[0] === "--" ? args.slice(1) : args);
      break;
    case "down":
      noArguments(command, args);
      await down(await project(), false);
      break;
    case "reset":
      noArguments(command, args);
      await down(await project(), true);
      break;
    case "list":
      noArguments(command, args);
      await list();
      break;
    case "prune":
      await prune({ yes: onlyFlag(command, args, "--yes") });
      break;
    case "setup":
      await setup(args);
      break;
    case "tailnet": {
      const [subcommand, ...rest] = args;
      if (subcommand === "info") await info(rest);
      else if (subcommand === "serve") await serve(rest);
      else throw new Error(`Unknown tailnet command\n\n${usage}`);
      break;
    }
    case "--help":
    case "-h":
    case undefined:
      console.log(usage);
      break;
    // Removed in 0.7.0: say what replaced it rather than that it is unknown.
    case "restart":
      throw new Error(
        "`devenv restart` is gone: run `devenv stop`, then `devenv start`, and `devenv up` first when services or setup changed",
      );
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
}
