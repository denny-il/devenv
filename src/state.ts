import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Services } from "./compose.ts";

/** What a worktree's stack is made of, kept between commands. */
export interface State {
  version: 1;
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

export function stateDirectory(root: string): string {
  return resolve(root, ".dev/devenv");
}

export function statePath(root: string): string {
  return resolve(stateDirectory(root), "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ports of a table in the state file; anything else in it is dropped. */
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

/**
 * The state file's content as a state of `project`, or nothing when it is
 * another project's: a copied worktree starts a stack of its own.
 */
export function parseState(content: string, project: string): State | null {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.composeEnv))
    throw new Error("not a state this version writes");
  if (value.project !== project) return null;

  const composeEnv: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.composeEnv)) {
    if (typeof item !== "string") throw new Error("`composeEnv` is damaged");
    composeEnv[key] = item;
  }
  return {
    version: 1,
    root: String(value.root),
    project,
    composeEnv,
    services: portTable(value.services),
    apps: portTable(value.apps),
    ...(typeof value.tailnet === "string" ? { tailnet: value.tailnet } : {}),
    ...(value.stopped === true ? { stopped: true as const } : {}),
  };
}

export async function readState(root: string, project: string): Promise<State | null> {
  const path = statePath(root);
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
  const directory = stateDirectory(state.root);
  await mkdir(directory, { recursive: true });
  // The state holds the services' credentials: out of version control
  // wherever the project keeps its ignore rules.
  await writeFile(resolve(directory, ".gitignore"), "*\n");
  const path = statePath(state.root);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function removeState(root: string): Promise<void> {
  await rm(stateDirectory(root), { force: true, recursive: true });
}
