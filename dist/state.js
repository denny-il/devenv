import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { checkoutIdentity } from "./names.js";
/**
 * Where every stack on this machine keeps its state: outside the checkouts,
 * so a stack can be found, and removed, after its checkout is gone, and its
 * credentials are in no workspace a dev server might hand out.
 */
export function stateHome() {
    return resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local/state"), "devenv");
}
function stacksDirectory() {
    return resolve(stateHome(), "stacks");
}
/** The state file of a stack, by its Compose project, which no two checkouts share. */
export function statePath(project) {
    return resolve(stacksDirectory(), `${project}.json`);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The ports of a table in a state file; anything else in it is dropped. */
function portTable(value) {
    const table = {};
    for (const [name, entry] of Object.entries(isRecord(value) ? value : {})) {
        const ports = {};
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
export function parseState(content, project) {
    const value = JSON.parse(content);
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
    const composeEnv = {};
    for (const [key, item] of Object.entries(value.composeEnv)) {
        if (typeof item !== "string")
            throw new Error("`composeEnv` is damaged");
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
        ...(value.stopped === true ? { stopped: true } : {}),
    };
}
export async function readState(project) {
    const path = statePath(project);
    let content;
    try {
        content = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    try {
        return parseState(content, project);
    }
    catch (error) {
        // Guessing instead could start a database under another login than its
        // volume was initialized with.
        throw new Error(`Cannot read ${path} (${error.message}). Repair it, or start over with \`devenv reset\`.`, { cause: error });
    }
}
export async function writeState(state) {
    const path = statePath(state.project);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
        // The states hold the services' credentials.
        await mkdir(stacksDirectory(), { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, path);
    }
    catch (error) {
        const { code } = error;
        if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS")
            throw error;
        // A sandbox, most likely: the state is kept outside the checkout.
        throw new Error(`Cannot write ${path}. devenv keeps every stack's state under ${stateHome()}; allow writing there.`, { cause: error });
    }
}
export async function removeState(project) {
    await rm(statePath(project), { force: true });
}
/** The state of every stack on this machine that can be read. */
export async function listStates() {
    let names;
    try {
        names = await readdir(stacksDirectory());
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const states = [];
    for (const name of names.toSorted()) {
        if (!name.endsWith(".json"))
            continue;
        try {
            const content = await readFile(resolve(stacksDirectory(), name), "utf8");
            states.push(parseState(content, basename(name, ".json")));
        }
        catch {
            console.warn(`Skipping ${resolve(stacksDirectory(), name)}: it cannot be read`);
        }
    }
    return states;
}
