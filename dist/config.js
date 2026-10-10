var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function defineConfig(config) {
    return config;
}
export const defaultPorts = { http: {} };
const configNames = ["devenv.config.ts", "devenv.config.js"];
/** The config file of the project `directory` is in. */
export function findConfig(directory) {
    for (let current = resolve(directory);; current = dirname(current)) {
        for (const name of configNames) {
            const path = resolve(current, name);
            if (existsSync(path))
                return path;
        }
        if (current === dirname(current))
            throw new Error(`No ${configNames.join(" or ")} in ${resolve(directory)} or above it`);
    }
}
export async function loadConfig(path) {
    const module = await import(__rewriteRelativeImportExtension(pathToFileURL(path).href));
    return module.default;
}
