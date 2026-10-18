import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ensureDocker, removeProject } from "./compose.ts";
import { testProjectPrefixOf } from "./names.ts";
import { run } from "./process.ts";
import { removeAbandonedTestStacks } from "./stack.ts";
import { type State, listStates, removeState, stateHome } from "./state.ts";

/** The stacks whose checkout is gone: nothing can start, stop or reset them any more. */
export function orphans(states: State[], exists: (path: string) => boolean): State[] {
  return states.filter(({ root }) => !exists(root));
}

/** The Compose projects that have a running container. */
async function runningProjects(): Promise<Set<string>> {
  const label = "com.docker.compose.project";
  const { stdout } = await run(
    ["docker", "ps", "--filter", `label=${label}`, "--format", `{{.Label "${label}"}}`],
    { cwd: process.cwd(), capture: true },
  );
  return new Set(stdout.split("\n").filter((line) => line.trim()));
}

/** `devenv list`: every stack on this machine. */
export async function list(): Promise<void> {
  const states = await listStates();
  if (!states.length) {
    console.log(`No stacks: nothing under ${stateHome()}`);
    return;
  }
  const docker = states.some((state) => !state.hostOnly && !state.devHostOnly);
  if (docker) await ensureDocker(process.cwd());
  const running = docker ? await runningProjects() : new Set<string>();
  const gone = new Set(orphans(states, existsSync));
  const width = Math.max(...states.map(({ project }) => project.length));
  for (const state of states) {
    const status = [
      gone.has(state) ? "orphaned" : undefined,
      state.hostOnly || state.devHostOnly
        ? gone.has(state)
          ? undefined
          : state.stopped
            ? "stopped"
            : "ready"
        : running.has(state.project)
          ? "running"
          : gone.has(state)
            ? undefined
            : "stopped",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`${state.project.padEnd(width)}  ${status.padEnd(17)}  ${state.root}`);
  }
}

/**
 * `devenv prune`: removes the stacks whose checkout is gone, with their
 * data. A checkout that was moved, or is on a disk not mounted now, looks the
 * same, so nothing goes without a yes.
 */
export async function prune(options: { yes: boolean }): Promise<void> {
  const gone = orphans(await listStates(), existsSync);
  if (!gone.length) {
    console.log("Nothing to prune: every stack's checkout is still there.");
    return;
  }
  console.log("Stacks whose checkout is gone:");
  for (const { project, root } of gone) console.log(`  ${project}  ${root}`);

  if (!options.yes) {
    if (!process.stdin.isTTY)
      throw new Error("Run `devenv prune --yes` to remove them and their data without being asked");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Remove them and their data? [y/N] ");
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) return;
  }

  if (gone.some((state) => !state.hostOnly)) await ensureDocker(process.cwd());
  for (const { project, root, hostOnly } of gone) {
    // The answer may have taken a while: a disk mounted meanwhile brings a
    // checkout, and its right to its data, back.
    if (existsSync(root)) {
      console.log(`Kept ${project}: its checkout is there again`);
      continue;
    }
    // By name alone: the Compose files went with the checkout.
    if (!hostOnly) {
      await removeProject(project);
      // What its killed test runs left, which only a `devenv test` in the
      // checkout would have found.
      await removeAbandonedTestStacks(process.cwd(), testProjectPrefixOf(project));
    }
    await removeState(project);
    console.log(`Removed ${project}`);
  }
}
