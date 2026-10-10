import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Services } from "./compose.ts";
import { checkoutIdentity } from "./names.ts";

/** What a worktree's stack is made of, kept between commands. */
export interface State {
  version: 1;
  /** The real path of the stack's checkout. A stack whose checkout is gone is an orphan. */
  root: string;
  project: string;
  /** `compose.env` as the stack's volumes were created with. */
  composeEnv: Record<string, string>;
  services: Services;
  apps: Record<string, { ports: Record<string, number> }>;
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
export function stateHome(): string {
  return resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local/state"), "devenv");
}

function stacksDirectory(): string {
  return resolve(stateHome(), "stacks");
}

/** The state file of a stack, by its Compose project, which no two checkouts share. */
export function statePath(project: string): string {
  return resolve(stacksDirectory(), `${project}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ports of a table in a state file; anything else in it is dropped. */
function portTable(value: unknown): Services {
  const table: Services = {};
  for (const [name, entry] of Object.entries(isRecord(value) ? value : {})) {
    const ports: Record<string, number> = {};
    const listed = isRecord(entry) && isRecord(entry.ports) ? entry.ports : {};
    for (const [key, port] of Object.entries(listed))
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536)
        ports[key] = port;
    table[name] = { ports };
  }
  return table;
}

// What the launcher names a checkout's Compose project. `prune` hands the
// name to Docker, so nothing else may pass for one.
const projectPattern = /^[a-z0-9][a-z0-9_-]*-local-[0-9a-f]{12}$/;

/**
 * A state file's content as the state of `project`, the stack the file is
 * named after. A file that speaks for another stack, or names no checkout,
 * is refused: it could have `prune` remove a stack that is in use.
 */
export function parseState(content: string, project: string): State {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.composeEnv))
    throw new Error("not a state this version writes");
  if (value.project !== project || !projectPattern.test(project))
    throw new Error("not the state of the stack it is filed under");
  if (typeof value.root !== "string" || !isAbsolute(value.root))
    throw new Error("it names no checkout");
  // A stack's name is made from its checkout's path, so a path that does
  // not make this name is not where the stack came from.
  if (!project.endsWith(`-local-${checkoutIdentity(value.root)}`))
    throw new Error("it names another checkout than its stack's");

  const composeEnv: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.composeEnv)) {
    if (typeof item !== "string") throw new Error("`composeEnv` is damaged");
    composeEnv[key] = item;
  }
  return {
    version: 1,
    root: value.root,
    project,
    composeEnv,
    services: portTable(value.services),
    apps: portTable(value.apps),
    ...(typeof value.tailnet === "string" ? { tailnet: value.tailnet } : {}),
    ...(value.stopped === true ? { stopped: true as const } : {}),
  };
}

export async function readState(project: string): Promise<State | null> {
  const path = statePath(project);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseState(content, project);
  } catch (error) {
    // Guessing instead could start a database under another login than its
    // volume was initialized with.
    throw new Error(
      `Cannot read ${path} (${(error as Error).message}). Repair it, or start over with \`devenv reset\`.`,
      { cause: error },
    );
  }
}

export async function writeState(state: State): Promise<void> {
  const path = statePath(state.project);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    // The states hold the services' credentials.
    await mkdir(stacksDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    // A sandbox, most likely: the state is kept outside the checkout.
    throw new Error(
      `Cannot write ${path}. devenv keeps every stack's state under ${stateHome()}; allow writing there.`,
      { cause: error },
    );
  }
}

export async function removeState(project: string): Promise<void> {
  await rm(statePath(project), { force: true });
}

/** The state of every stack on this machine that can be read. */
export async function listStates(): Promise<State[]> {
  let names: string[];
  try {
    names = await readdir(stacksDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states: State[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) continue;
    try {
      const content = await readFile(resolve(stacksDirectory(), name), "utf8");
      states.push(parseState(content, basename(name, ".json")));
    } catch {
      console.warn(`Skipping ${resolve(stacksDirectory(), name)}: it cannot be read`);
    }
  }
  return states;
}
