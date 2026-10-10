import { delimiter, resolve } from "node:path";
/** A stack's state as the functions of a config see it. */
export function createContext(state) {
    const port = (ref) => {
        const [app = "", name, ...rest] = ref.split(".");
        const ports = state.apps[app]?.ports;
        if (!ports || rest.length)
            throw new Error(`No app port \`${ref}\`; the apps are: ${Object.keys(state.apps).join(", ") || "none"}`);
        const names = Object.keys(ports);
        if (name === undefined && names.length !== 1)
            throw new Error(`\`${app}\` has several ports; name one: ${names.map((each) => `${app}.${each}`).join(", ")}`);
        const found = ports[name ?? names[0]];
        if (found === undefined)
            throw new Error(`\`${app}\` has no port \`${name}\`; it has: ${names.join(", ")}`);
        return found;
    };
    return {
        root: state.root,
        project: state.project,
        vars: state.composeEnv,
        tailnet: state.tailnet,
        service(name) {
            const service = state.services[name];
            if (!service)
                throw new Error(`No running service \`${name}\`; there are: ${Object.keys(state.services).join(", ") || "none"}`);
            return {
                port(target) {
                    const published = service.ports[target];
                    if (published === undefined)
                        throw new Error(`Service \`${name}\` publishes no port ${target}. Publish it on a loopback port Docker assigns.`);
                    return published;
                },
            };
        },
        port,
        url: (ref) => state.tailnet ? `https://${state.tailnet}:${port(ref)}` : `http://localhost:${port(ref)}`,
    };
}
/**
 * An app's ports for its `env`. A name the app does not have throws: read
 * from a plain object it would unset the variable without a word.
 */
export function appPorts(app, ports) {
    return new Proxy(ports, {
        get(target, name, receiver) {
            if (typeof name === "string" && !(name in target))
                throw new Error(`\`${app}\` has no port \`${name}\`; it has: ${Object.keys(target).join(", ")}`);
            return Reflect.get(target, name, receiver);
        },
    });
}
/** `values` as strings, without what is unset. */
export function stringValues(values) {
    const strings = {};
    for (const [key, value] of Object.entries(values ?? {}))
        if (value !== undefined)
            strings[key] = String(value);
    return strings;
}
/**
 * The environment of a stack's commands: this process's, which holds the
 * root `.env`, under the project's `env` and then each of `layers`.
 */
export function createEnvironment(config, context, ...layers) {
    const environment = {
        ...process.env,
        // The project's own tools, however this launcher was started.
        PATH: [resolve(context.root, "node_modules/.bin"), process.env.PATH]
            .filter(Boolean)
            .join(delimiter),
    };
    for (const layer of [config.env?.(context), ...layers])
        for (const [key, value] of Object.entries(layer ?? {}))
            environment[key] = value === undefined ? undefined : String(value);
    return environment;
}
