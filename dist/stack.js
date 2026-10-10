import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compose, composeProjects, ensureDocker, startServices, } from "./compose.js";
import { defaultPorts } from "./config.js";
import { appPorts, createContext, createEnvironment, stringValues } from "./context.js";
import { abandonedTestProjects, createTestProjectName, projectName, testProjectLauncher, testProjectPrefix, } from "./names.js";
import { reserveAppPorts } from "./ports.js";
import { exitStatus, reapGroup, run, signalGroup, spawnCommand, } from "./process.js";
import { readState, removeState, statePath, writeState } from "./state.js";
import { createServing, tailnetHost } from "./tailnet.js";
export function createProject(root, config) {
    return { root, config, name: projectName(config.name, root) };
}
const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
function devTarget({ root, config, name }, composeEnv) {
    return {
        root,
        project: name,
        files: [...config.compose.files, ...(config.compose.dev ?? [])],
        env: { ...process.env, ...composeEnv },
    };
}
/** The Compose variables of the worktree's stack: those it was created with. */
function composeEnvOf(project, state) {
    return state?.composeEnv ?? stringValues(project.config.compose.env);
}
/** Starts the worktree's services, with the variables their volumes know. */
async function startStack(project, earlier) {
    await ensureDocker(project.root);
    const composeEnv = composeEnvOf(project, earlier);
    if (!isDeepStrictEqual(composeEnv, stringValues(project.config.compose.env)))
        console.warn("`compose.env` differs from what this stack was created with, which stays in use. Run `devenv reset` to start over with the new values.");
    // Before anything creates a volume: a first start that fails halfway must
    // not forget what its volumes were created with.
    if (!earlier)
        await writeState({
            version: 1,
            root: project.root,
            project: project.name,
            composeEnv,
            services: {},
            apps: {},
            stopped: true,
        });
    const services = await startServices(devTarget(project, composeEnv), project.config.compose.init ?? []);
    return { composeEnv, services };
}
function printStack(config, context) {
    for (const [app, { ports = defaultPorts }] of Object.entries(config.apps ?? {})) {
        const listed = Object.keys(ports).filter((name) => !ports[name]?.internal);
        for (const name of listed) {
            const ref = `${app}.${name}`;
            console.log(`${listed.length === 1 ? app : ref}: ${context.url(ref)}`);
        }
    }
    for (const [label, value] of Object.entries(config.info?.(context) ?? {}))
        console.log(`${label}: ${value}`);
}
/** `devenv up`: the services alone, and ports for the apps' URLs. */
export async function up(project) {
    const earlier = await readState(project.root, project.name);
    const started = await startStack(project, earlier);
    const reservations = await reserveAppPorts(project.config.apps ?? {}, earlier?.apps);
    await reservations.releaseAll();
    await writeState({
        version: 1,
        root: project.root,
        project: project.name,
        ...started,
        apps: reservations.apps,
    });
    console.log(`State: ${statePath(project.root)}`);
}
/** `devenv dev`: services, setup, then every app until one stops. */
export async function dev(project, options) {
    const { root, config } = project;
    // Over Tailscale the apps listen on this machine only, as ever: their
    // ports are served to the tailnet over HTTPS under this machine's name
    // there, which then names every app URL.
    const tailnet = options.tailscale ? await tailnetHost() : undefined;
    const earlier = await readState(root, project.name);
    const started = await startStack(project, earlier);
    const reservations = await reserveAppPorts(config.apps ?? {}, earlier?.apps);
    try {
        const state = {
            version: 1,
            root,
            project: project.name,
            ...started,
            apps: reservations.apps,
            ...(tailnet ? { tailnet } : {}),
        };
        await writeState(state);
        await runApps(config, state, reservations);
    }
    finally {
        await reservations.releaseAll();
    }
}
/** Runs setup and then the apps of a started stack, until one stops. */
async function runApps(config, state, reservations) {
    const { root, tailnet } = state;
    const apps = Object.entries(config.apps ?? {});
    const context = createContext(state);
    const environment = createEnvironment(config, context);
    const served = apps.flatMap(([app, { ports = defaultPorts }]) => Object.keys(ports)
        .filter((name) => !ports[name]?.internal)
        .map((name) => context.port(`${app}.${name}`)));
    const serving = tailnet && served.length ? createServing(tailnet) : undefined;
    const children = [];
    const controller = new AbortController();
    let stopping = false;
    let interrupted = false;
    // The exit of the app that stopped the stack, if one did.
    let cause;
    let escalation;
    const signalChildren = (signal) => {
        for (const { child } of children)
            signalGroup(child.pid, signal);
    };
    // The first stop reaches every app's group; whatever has not stopped 10
    // seconds later is killed.
    const stop = (signal = "SIGTERM") => {
        if (stopping)
            return;
        stopping = true;
        controller.abort();
        serving?.stop();
        signalChildren(signal);
        escalation = setTimeout(() => signalChildren("SIGKILL"), 10_000);
        escalation.unref();
    };
    const onSignal = (signal) => {
        // Asked again, nobody is waiting any longer.
        if (stopping)
            return signalChildren("SIGKILL");
        interrupted = true;
        // A closed terminal ends the launcher; its apps go with it.
        stop(signal === "SIGHUP" ? "SIGTERM" : signal);
    };
    for (const signal of stopSignals)
        process.on(signal, onSignal);
    let failure;
    try {
        // Before anything is started on them: a port that cannot be served
        // would leave the URLs of a running stack dead.
        if (serving) {
            await serving.start(served);
            void serving.ended().then((message) => {
                if (stopping)
                    return;
                failure = new Error(message);
                stop();
            });
        }
        for (const command of config.setup ?? [])
            await run(command, {
                cwd: root,
                env: environment,
                signal: controller.signal,
            });
        for (const [name, app] of apps) {
            await reservations.release(name);
            // Checked after the wait: a stop during it has not reached this app.
            if (stopping)
                break;
            // Each app leads a process group of its own, so stopping it reaches
            // the servers its command starts, not only the command.
            const child = spawnCommand(app.command, {
                cwd: root,
                env: createEnvironment(config, context, app.env?.(appPorts(name, state.apps[name]?.ports ?? {}), context), 
                // Vite's dev servers answer only the host names they are told.
                tailnet
                    ? {
                        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: [
                            process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,
                            tailnet,
                        ]
                            .filter(Boolean)
                            .join(","),
                    }
                    : undefined),
                stdio: "inherit",
                detached: true,
            });
            children.push({
                child,
                // Any app stopping stops the stack.
                closed: new Promise((resolveClosed) => {
                    const closed = (exit) => {
                        if (!stopping)
                            cause = exit;
                        stop();
                        resolveClosed();
                    };
                    child.once("error", (error) => {
                        console.error(`${name} failed to start: ${error.message}`);
                        closed({ code: 1, signal: null });
                    });
                    child.once("close", (code, signal) => closed({ code, signal }));
                }),
            });
        }
        if (!stopping)
            printStack(config, context);
    }
    catch (error) {
        if (!interrupted)
            failure ??= error;
        stop();
    }
    await Promise.all(children.map(({ closed }) => closed));
    clearTimeout(escalation);
    // What an app started may outlive its command; nothing may keep holding
    // its port.
    await Promise.all(children.map(({ child }) => reapGroup(child.pid)));
    serving?.stop();
    await serving?.closed();
    for (const signal of stopSignals)
        process.off(signal, onSignal);
    if (failure)
        throw failure;
    if (cause && !interrupted)
        process.exitCode = exitStatus(cause);
}
/** `devenv status` */
export async function status(project) {
    await ensureDocker(project.root);
    const state = await readState(project.root, project.name);
    await compose(devTarget(project, composeEnvOf(project, state)), ["ps"]);
    if (!state) {
        console.log(`No stack yet: nothing at ${statePath(project.root)}`);
        return;
    }
    console.log(`State: ${statePath(project.root)}`);
    if (state.stopped)
        console.log("The services are stopped.");
    else
        printStack(project.config, createContext(state));
}
/** `devenv down`, and `devenv reset` with `removeVolumes`. */
export async function down(project, removeVolumes) {
    await ensureDocker(project.root);
    // `reset` must work on a state it cannot read.
    const state = removeVolumes
        ? await readState(project.root, project.name).catch(() => null)
        : await readState(project.root, project.name);
    await compose(devTarget(project, composeEnvOf(project, state)), [
        "down",
        "--remove-orphans",
        ...(removeVolumes ? ["--volumes", "--rmi", "local"] : []),
    ]);
    if (removeVolumes) {
        await removeState(project.root);
        return;
    }
    // The kept volumes keep what they were created with, and the apps their
    // ports. The services' published ports are anyone's again.
    if (state)
        await writeState({ ...state, services: {}, stopped: true });
}
/** `devenv run -- <command>` */
export async function runCommand(project, command) {
    const state = await readState(project.root, project.name);
    if (!state || state.stopped)
        throw new Error("Run `devenv up` first");
    const child = spawnCommand(command, {
        cwd: project.root,
        env: createEnvironment(project.config, createContext(state)),
        stdio: "inherit",
    });
    // The command decides how it stops. A terminal's Ctrl-C has reached it
    // already; any other signal came to this process alone.
    const forward = (signal) => {
        if (signal !== "SIGINT")
            child.kill(signal);
    };
    for (const signal of stopSignals)
        process.on(signal, forward);
    try {
        const exit = await new Promise((resolveExit, rejectExit) => {
            child.once("error", rejectExit);
            child.once("close", (code, signal) => resolveExit({ code, signal }));
        });
        process.exitCode = exitStatus(exit);
    }
    finally {
        for (const signal of stopSignals)
            process.off(signal, forward);
    }
}
/**
 * The PIDs that may still belong to a `devenv test` launcher. A killed
 * launcher's PID may since belong to anything else, after a reboot too; this
 * launcher's own PID can only name a stack left by an earlier one. A probe
 * that fails, interrupted for one, counts the PID as running: a stack left
 * for the next run costs less than a live run's stack removed.
 */
async function runningTestLaunchers(cwd, pids) {
    const running = new Set();
    for (const pid of new Set(pids)) {
        if (pid === process.pid)
            continue;
        // Unlimited width: procps truncates to $COLUMNS even into a pipe.
        const result = await run(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
            cwd,
            capture: true,
            reject: false,
        });
        const gone = !result.signal &&
            ((result.code === 1 && !result.stdout.trim()) ||
                (result.code === 0 && !isTestLauncher(result.stdout)));
        if (!gone)
            running.add(pid);
    }
    return running;
}
/** Whether a process's command line is this launcher running `test`. */
export function isTestLauncher(commandLine) {
    return /devenv(\.js)? test(\s|$)/.test(commandLine);
}
function quote(argument) {
    return `'${argument.replaceAll("'", `'\\''`)}'`;
}
/** The test command with the arguments given after `devenv test --`. */
export function testCommand(command, args) {
    if (typeof command === "function")
        return command(args);
    if (typeof command === "string")
        return [command, ...args.map(quote)].join(" ");
    return [...command, ...args];
}
/**
 * `devenv test`: runs the test command against a stack of its own, fresh
 * services under a project name for this run alone, on ports Docker assigns,
 * and always removed afterwards. The worktree's `dev` stack and its data are
 * never touched.
 */
export async function test(project, args) {
    const { root, config } = project;
    if (!config.test)
        throw new Error("The config has no `test` section to run tests with");
    const { setup = [], command, env } = config.test;
    await ensureDocker(root);
    const prefix = testProjectPrefix(config.name, root);
    const name = createTestProjectName(prefix, process.pid, randomBytes(3).toString("hex"));
    const composeEnv = stringValues(config.compose.env);
    const controller = new AbortController();
    const target = {
        root,
        project: name,
        files: [...config.compose.files, ...(config.compose.test ?? [])],
        env: { ...process.env, ...composeEnv },
    };
    // Teardown runs in its own process group, so a second Ctrl-C at the
    // terminal cannot cut it short.
    const remove = (stack) => compose({ ...target, project: stack }, ["down", "--volumes", "--remove-orphans"], {
        detached: true,
    });
    let interrupted;
    let tests;
    let escalation;
    const interrupt = (signal) => {
        if (interrupted)
            return;
        interrupted = signal;
        console.error(`\n${signal}: stopping and removing ${name}`);
        controller.abort();
        // The whole group: a test runner may exit on the signal without
        // stopping what its suites started. One that hangs on the way out is
        // killed, so the teardown still runs.
        if (tests) {
            const { pid } = tests;
            signalGroup(pid, signal);
            escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), 15_000);
        }
    };
    // SIGHUP too: a closed terminal would otherwise end the launcher alone,
    // leaving the tests, in their own group, running and the stack up.
    for (const signal of stopSignals)
        process.on(signal, interrupt);
    let result = 1;
    try {
        // Stacks of runs killed outright, which never reached their teardown.
        const projects = await composeProjects(root);
        const running = await runningTestLaunchers(root, projects.flatMap((stack) => stack.startsWith(prefix) ? (testProjectLauncher(stack, prefix) ?? []) : []));
        for (const leftover of abandonedTestProjects(projects, prefix, (pid) => running.has(pid))) {
            controller.signal.throwIfAborted();
            console.log(`Removing leftover test stack ${leftover}`);
            await remove(leftover);
        }
        console.log(`Test stack: ${name}`);
        const services = await startServices({ ...target, signal: controller.signal }, config.compose.init ?? []);
        // Nothing listens on the apps' ports; their URLs are still configured.
        const reservations = await reserveAppPorts(config.apps ?? {}, undefined);
        await reservations.releaseAll();
        const context = createContext({
            root,
            project: name,
            composeEnv,
            services,
            apps: reservations.apps,
        });
        const environment = createEnvironment(config, context, env);
        for (const step of setup)
            await run(step, {
                cwd: root,
                env: environment,
                signal: controller.signal,
            });
        controller.signal.throwIfAborted();
        // Its own process group: it gets one signal, the one forwarded here,
        // since a test runner may stop at once without cleanup on a second.
        const child = spawnCommand(testCommand(command, args), {
            cwd: root,
            env: environment,
            stdio: "inherit",
            detached: true,
        });
        tests = child;
        const exit = await new Promise((resolveExit, rejectExit) => {
            child.once("error", rejectExit);
            child.once("close", (code, signal) => resolveExit({ code, signal }));
        });
        clearTimeout(escalation);
        await reapGroup(child.pid);
        // A signal during the teardown has nothing left to stop.
        tests = undefined;
        result = exitStatus(exit);
    }
    catch (error) {
        if (interrupted)
            result = exitStatus({ code: null, signal: interrupted });
        else
            console.error(error.message);
    }
    finally {
        clearTimeout(escalation);
        try {
            await remove(name);
        }
        catch (error) {
            console.error(error.message);
            if (result === 0)
                result = 1;
        }
        for (const signal of stopSignals)
            process.off(signal, interrupt);
    }
    process.exitCode = result;
}
