import { userInfo } from "node:os";
import { composeVersionMinimum, supportsComposeVersion } from "./compose.ts";
import type { Command } from "./config.ts";
import { describeCommand, run } from "./process.ts";
import { certificatesOff, inspect } from "./tailnet.ts";

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

const cwd = process.cwd();

/** What `command` printed, or nothing if it is missing or failed. */
async function output(command: Command): Promise<string | undefined> {
  try {
    const result = await run(command, { cwd, capture: true, reject: false });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function dockerRequirements(
  platform: NodeJS.Platform,
  user: string,
  context: string | undefined,
): Requirement[] {
  const linux = platform === "linux";
  // A rootless or remote Docker is its owner's to start: the system daemon
  // and the `docker` group, which is as good as root, are no remedy for it.
  const systemDaemon = !process.env.DOCKER_HOST && (!context || context === "default");
  return [
    {
      name: "Docker is installed",
      check: async () => ((await output(["docker", "--version"])) ? undefined : "not found"),
      fix: linux
        ? // Docker's own installer, for every distribution it supports.
          ["curl -fsSL https://get.docker.com | sudo sh"]
        : ["brew install --cask docker-desktop"],
      manual: linux
        ? "Install Docker Engine: https://docs.docker.com/engine/install/"
        : "Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/",
    },
    {
      name: "Docker runs, and answers this user",
      check: async () =>
        (await output(["docker", "info", "--format", "{{.ServerVersion}}"]))
          ? undefined
          : "its daemon does not answer",
      ...(!linux
        ? { manual: "Open Docker Desktop and finish its first-run setup." }
        : systemDaemon
          ? {
              fix: [
                "sudo systemctl enable --now docker",
                ["sudo", "usermod", "-aG", "docker", user],
              ],
              manual:
                "If this user was just added to the `docker` group, log out and back in, then run `devenv setup` again.",
            }
          : {
              manual: `Start the daemon that Docker is set to use${context ? ` (context \`${context}\`)` : ""}.`,
            }),
    },
    {
      name: `Docker Compose is ${composeVersionMinimum.join(".")} or newer`,
      check: async () => {
        const version = await output(["docker", "compose", "version", "--short"]);
        if (version && supportsComposeVersion(version)) return undefined;
        return version ? `found ${version.trim()}` : "not found";
      },
      manual: "Update Docker; Compose comes with it.",
    },
  ];
}

function tailscaleRequirements(platform: NodeJS.Platform, user: string): Requirement[] {
  const linux = platform === "linux";
  const problem = async () => (await inspect()).problems[0];
  return [
    {
      name: "Tailscale is installed",
      check: async () => ((await output(["tailscale", "version"])) ? undefined : "not found"),
      fix: linux
        ? // Tailscale's own installer; it asks for a password itself.
          ["curl -fsSL https://tailscale.com/install.sh | sh"]
        : ["brew install --cask tailscale-app"],
      manual: linux
        ? "Install Tailscale: https://tailscale.com/download"
        : "If the installer stopped at its system extension, allow it in System Settings → Privacy & Security and run `devenv setup` again. Or install Tailscale from https://tailscale.com/download",
    },
    {
      name: "Tailscale is connected",
      check: async () => {
        const found = await problem();
        // Certificates are their own requirement, below.
        return found === certificatesOff ? undefined : found;
      },
      ...(linux
        ? // Prints a link to sign in with, and waits for it.
          { fix: ["sudo systemctl enable --now tailscaled", "sudo tailscale up"] }
        : { manual: "Open Tailscale and sign in." }),
    },
    ...(linux
      ? [
          {
            name: "This user may serve over Tailscale",
            check: async () => {
              // Root may, whoever the operator is.
              if (process.getuid?.() === 0) return undefined;
              const prefs = await output(["tailscale", "debug", "prefs"]);
              try {
                const { OperatorUser } = JSON.parse(prefs ?? "") as { OperatorUser?: string };
                return OperatorUser === user ? undefined : "only root may";
              } catch {
                return "Tailscale's preferences could not be read";
              }
            },
            fix: [["sudo", "tailscale", "set", `--operator=${user}`]],
          },
        ]
      : []),
    {
      name: "The tailnet issues HTTPS certificates",
      check: problem,
    },
  ];
}

/**
 * Meets each requirement in turn, fixing what a command can fix, and stops
 * at the first that stays unmet: the ones after it build on it. Returns
 * whether all are met.
 */
export async function meet(
  requirements: Requirement[],
  runFix: (command: Command) => Promise<unknown>,
): Promise<boolean> {
  for (const { name, check, fix = [], manual } of requirements) {
    let problem = await check();
    if (problem) {
      for (const command of fix) {
        console.log(`\n$ ${describeCommand(command)}`);
        await runFix(command);
      }
      if (fix.length) problem = await check();
    }
    if (problem) {
      console.log(`✗ ${name}: ${problem}`);
      if (manual) console.log(`  ${manual}`);
      return false;
    }
    console.log(`✓ ${name}`);
  }
  return true;
}

const targets = ["docker", "tailscale"] as const;

/**
 * `devenv setup [docker] [tailscale]`: installs and sets up what stacks need
 * on this machine; all of it unless told which.
 */
export async function setup(wanted: string[]): Promise<void> {
  const { platform } = process;
  if (platform !== "linux" && platform !== "darwin")
    throw new Error("`devenv setup` knows Linux and macOS only");
  const unknown = wanted.filter((target) => !targets.some((known) => known === target));
  if (unknown.length)
    throw new Error(`\`devenv setup\` knows ${targets.join(" and ")}, not ${unknown.join(", ")}`);
  const user = userInfo().username;
  // A command that fails shows in the requirement staying unmet.
  const runFix = (command: Command) => run(command, { cwd, reject: false });

  let met = true;
  for (const target of targets) {
    if (wanted.length && !wanted.includes(target)) continue;
    const requirements =
      target === "docker"
        ? dockerRequirements(platform, user, (await output(["docker", "context", "show"]))?.trim())
        : tailscaleRequirements(platform, user);
    if (!(await meet(requirements, runFix))) met = false;
  }
  if (!met) process.exitCode = 1;
}
