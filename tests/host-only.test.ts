import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { projectName } from "../src/names.ts";
import { reservePort } from "../src/ports.ts";
import { parseState } from "../src/state.ts";

const execute = promisify(execFile);
const cli = `import { main } from ${JSON.stringify(pathToFileURL(resolve("src/cli.ts")).href)};
main(process.argv.slice(1)).catch(error => { console.error(error.message); process.exitCode = 1; });`;
let home: string;
let root: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(resolve(tmpdir(), "devenv-host-only-")));
  root = resolve(home, "project");
  mkdirSync(root);
  const bin = resolve(home, "bin");
  mkdirSync(bin);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: home };
  // A sentinel catches even harmless Docker probes; these tests never use a daemon.
  writeFileSync(
    resolve(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(resolve(home, "docker.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (!process.env.ALLOW_DOCKER) process.exit(99);
if (process.argv[2] === "info") console.log("26.0.0");
if (process.argv.includes("version")) console.log("2.24.4");
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(bin, "tailscale"),
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "status") {
  console.log(JSON.stringify({ BackendState: "Running", CertDomains: ["test.ts.net"], Self: { DNSName: "test.ts.net." } }));
} else {
  fs.appendFileSync(${JSON.stringify(resolve(home, "tailscale.log"))}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
  console.log("https://test.ts.net");
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(root, "app.mjs"),
    `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.env.WORKER_PORT) spawn(process.execPath, ["worker.mjs"], { stdio: "inherit" });
createServer((req, res) => { if (req.url === "/exit") process.exit(7); res.end("ok"); })
  .listen(Number(process.env.PORT), process.env.HOST, () => writeFileSync(process.env.APP + ".json", JSON.stringify(process.env)));
`,
  );
  writeFileSync(
    resolve(root, "worker.mjs"),
    `
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
createServer(socket => socket.end()).listen(Number(process.env.WORKER_PORT), "127.0.0.1", () => writeFileSync("worker.ready", "ready"));
`,
  );
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }
  rmSync(home, { recursive: true, force: true });
});

function config(compose = ""): void {
  writeFileSync(resolve(root, ".env"), "FROM_DOTENV=loaded\n");
  writeFileSync(
    resolve(root, "devenv.config.js"),
    `export default {
    name: "fixture", ${compose}
    apps: {
      server: { command: [${JSON.stringify(process.execPath)}, "app.mjs"], ports: { http: {}, worker: { internal: true } },
        env: ports => ({ APP: "server", HOST: "127.0.0.1", PORT: ports.http, WORKER_PORT: ports.worker }) },
      web: { command: [${JSON.stringify(process.execPath)}, "app.mjs"],
        env: ports => ({ APP: "web", HOST: "127.0.0.1", PORT: ports.http }) }
    },
    env: ({ root, port, url, project, vars }) => ({ COMPOSE_SECRET: vars.SECRET, CONFIG: root + "/config.json", API_ORIGIN: "http://127.0.0.1:" + port("server.http"), WEB_URL: url("web"), STACK: project }),
    setup: [[${JSON.stringify(process.execPath)}, "-e", "require('fs').writeFileSync('setup.json', JSON.stringify(process.env))"]],
    test: { command: [${JSON.stringify(process.execPath)}, "-e", "require('fs').writeFileSync('test.json', JSON.stringify(process.env)); process.exit(Number(process.argv[1] || 0))"] }
  };`,
  );
}

function command(...args: string[]) {
  return execute(process.execPath, ["--input-type=module", "-e", cli, "--", ...args], {
    cwd: root,
    env,
    timeout: 20_000,
  });
}

function statePath(): string {
  return resolve(home, "devenv/stacks", `${projectName("fixture", root)}.json`);
}
function state() {
  return parseState(readFileSync(statePath(), "utf8"), projectName("fixture", root));
}
function start(...args: string[]) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", cli, "--", ...args], {
    cwd: root,
    env,
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  return { child, output: () => output };
}
async function ready() {
  await expect
    .poll(() =>
      ["server.json", "web.json", "worker.ready"].every((file) => existsSync(resolve(root, file))),
    )
    .toBe(true);
}
async function portsAreFree(ports: number[]) {
  for (const port of ports) {
    const reservation = await reservePort(port);
    try {
      expect(reservation.port).toBe(port);
    } finally {
      await reservation.release();
    }
  }
}

test.each(["", "compose: { files: [] },"])(
  "host-only up/status/run/down/reset need no Docker (%s)",
  async (compose) => {
    config(compose);
    expect((await command("status")).stdout).toContain("No stack yet");
    await command("up");
    const first = state();
    expect(first.hostOnly).toBe(true);
    expect(first.services).toEqual({});
    const status = (await command("status")).stdout;
    expect(status).toContain(`server: http://localhost:${first.apps.server!.ports.http}`);
    expect(status).not.toContain(String(first.apps.server!.ports.worker));
    const run = await command(
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify(process.env))",
    );
    expect(JSON.parse(run.stdout)).toMatchObject({
      FROM_DOTENV: "loaded",
      API_ORIGIN: `http://127.0.0.1:${first.apps.server!.ports.http}`,
      CONFIG: `${root}/config.json`,
    });
    expect((await command("list")).stdout).toContain("ready");
    await command("down");
    expect(state().stopped).toBe(true);
    await expect(command("run", "--", process.execPath, "-v")).rejects.toThrow(
      "Run `devenv up` first",
    );
    await command("up");
    expect(state().apps).toEqual(first.apps);
    await command("reset");
    expect(existsSync(statePath())).toBe(false);
    await command("down");
    await command("reset");
    expect(existsSync(resolve(home, "docker.log"))).toBe(false);
  },
);

test.each([false, true])(
  "host-only dev cleans app groups and serving, with tailscale=%s",
  async (tailscale) => {
    config();
    await command("up");
    const earlier = state();
    const dev = start("start", ...(tailscale ? ["--tailscale"] : []));
    await ready();
    const running = state();
    expect(running.apps).toEqual(earlier.apps);
    expect(JSON.parse(readFileSync(resolve(root, "server.json"), "utf8"))).toMatchObject({
      WORKER_PORT: String(running.apps.server!.ports.worker),
      FROM_DOTENV: "loaded",
    });
    const url = `${tailscale ? "https://test.ts.net" : "http://localhost"}:${running.apps.web!.ports.http}`;
    expect(JSON.parse(readFileSync(resolve(root, "setup.json"), "utf8")).WEB_URL).toBe(url);
    expect((await command("status")).stdout).toContain(url);
    // `up` while dev owns the sockets must preserve every advertised port and the tailnet.
    await command("up");
    expect(state().apps).toEqual(running.apps);
    expect(state().tailnet).toBe(running.tailnet);
    const closed = once(dev.child, "close");
    dev.child.kill("SIGTERM");
    expect((await closed)[0]).toBe(0);
    expect(state().tailnet).toBeUndefined();
    await portsAreFree(Object.values(running.apps).flatMap((app) => Object.values(app.ports)));
    if (tailscale) {
      const served = readFileSync(resolve(home, "tailscale.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(served.map((entry) => entry.args[1]).sort()).toEqual(
        [
          `--https=${running.apps.server!.ports.http}`,
          `--https=${running.apps.web!.ports.http}`,
        ].sort(),
      );
      for (const { pid } of served) expect(() => process.kill(pid, 0)).toThrow();
    }
    expect(existsSync(resolve(home, "docker.log"))).toBe(false);
  },
);

test("an app failure stops its sibling and descendant with the same exit status", async () => {
  config();
  const dev = start("start");
  await ready();
  const running = state();
  const closed = once(dev.child, "close");
  await fetch(`http://127.0.0.1:${running.apps.server!.ports.http}/exit`).catch(() => {});
  expect((await closed)[0]).toBe(7);
  await portsAreFree(Object.values(running.apps).flatMap((app) => Object.values(app.ports)));
});

test("stop, restart and status find this worktree's running start", async () => {
  config();
  await expect(command("stop")).rejects.toThrow("No `devenv start` is running for this worktree");
  const first = start("start");
  await ready();
  const { pid } = first.child;
  expect(first.output()).toContain(`Stack ${projectName("fixture", root)} (pid ${pid})`);
  expect((await command("status")).stdout).toContain(
    `\`devenv start\` is running the apps (pid ${pid})`,
  );
  await expect(command("start")).rejects.toThrow(`already running this stack (pid ${pid})`);
  await expect(command("reset")).rejects.toThrow("Stop it with `devenv stop` first");

  const ports = state().apps;
  for (const file of ["server.json", "web.json", "worker.ready"]) rmSync(resolve(root, file));
  const second = start("restart");
  expect((await once(first.child, "close"))[0]).toBe(0);
  expect(first.output().trimEnd().split("\n").at(-1)).toBe("Stopped (SIGINT): server, web");
  await ready();
  expect(state().apps).toEqual(ports);
  expect(state().launcher?.pid).toBe(second.child.pid);

  const closed = once(second.child, "close");
  expect((await command("stop")).stdout).toContain(
    `Stopping \`devenv start\` (pid ${second.child.pid})`,
  );
  expect((await closed)[0]).toBe(0);
  expect(state().launcher).toBeUndefined();
  expect((await command("status")).stdout).toContain("No `devenv start` is running");
  await portsAreFree(Object.values(ports).flatMap((app) => Object.values(app.ports)));
});

test("host-only test uses a fresh context, propagates failure, and leaves dev state alone", async () => {
  config();
  await command("up");
  const before = readFileSync(statePath(), "utf8");
  await command("test");
  const tested = JSON.parse(readFileSync(resolve(root, "test.json"), "utf8"));
  expect(tested.STACK).toContain("fixture-test-");
  expect(tested.FROM_DOTENV).toBe("loaded");
  await expect(command("test", "--", "3")).rejects.toMatchObject({ code: 3 });
  expect(readFileSync(statePath(), "utf8")).toBe(before);
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
});

test("host-only prune removes orphan state without Docker", async () => {
  config();
  await command("up");
  const path = statePath();
  rmSync(root, { recursive: true });
  root = home;
  await command("prune", "--yes");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
});

test("Compose lifecycle and legacy cleanup still use Docker after the config drops Compose", async () => {
  config('compose: { files: ["compose.yml"], env: { LOGIN: "original" } },');
  env.ALLOW_DOCKER = "1";
  await command("up");
  expect(state().hostOnly).toBeUndefined();
  expect(state().composeEnv).toEqual({ LOGIN: "original" });
  await command("status");
  await command("down");
  config();
  await expect(command("up")).rejects.toThrow("reset");
  await command("reset");
  const calls: string[][] = readFileSync(resolve(home, "docker.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.some(
      (args) => args.includes("up") && args.includes("--wait") && args.includes("compose.yml"),
    ),
  ).toBe(true);
  expect(calls.some((args) => args.includes("ps"))).toBe(true);
  expect(
    calls.some(
      (args) => args.includes("down") && args.includes("--volumes") && !args.includes("-f"),
    ),
  ).toBe(true);
  rmSync(resolve(home, "docker.log"));
  delete env.ALLOW_DOCKER;
  await command("up");
  expect(state().hostOnly).toBe(true);
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
});

test("adding Compose to a host-only stack records its credentials and restores Docker cleanup", async () => {
  config();
  await command("up");
  const ports = state().apps;
  config('compose: { files: ["compose.yml"], env: { LOGIN: "new-database" } },');
  env.ALLOW_DOCKER = "1";
  await command("up");
  expect(state().hostOnly).toBeUndefined();
  expect(state().composeEnv).toEqual({ LOGIN: "new-database" });
  expect(state().apps).toEqual(ports);
  config('compose: { files: ["compose.yml"], env: { LOGIN: "changed" } },');
  expect((await command("up")).stderr).toContain("differs from what this stack was created with");
  expect(state().composeEnv).toEqual({ LOGIN: "new-database" });
  // Even after the config disappears, down keeps volumes and reset removes them.
  config();
  await command("down");
  const calls: string[][] = readFileSync(resolve(home, "docker.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const lastDown = calls.filter((args) => args.includes("down")).at(-1)!;
  expect(lastDown).not.toContain("--volumes");
  expect(lastDown).not.toContain("-f");
  await command("reset");
  expect(existsSync(statePath())).toBe(false);
});

test("reset warns about ambiguous damaged state when Docker is unavailable", async () => {
  config();
  await command("up");
  writeFileSync(statePath(), "{broken");
  await expect(command("up")).rejects.toThrow("Cannot read");
  const reset = await command("reset");
  expect(reset.stderr).toContain(
    `Docker cleanup for project ${projectName("fixture", root)} was skipped`,
  );
  expect(reset.stderr).toContain("Containers and volumes may remain");
  expect(existsSync(statePath())).toBe(false);
});

test("adding Compose tests to a host-only stack retains Docker cleanup if the config is removed", async () => {
  config();
  await command("up");
  config('compose: { files: [], test: ["compose.test.yml"], env: { LOGIN: "new-database" } },');
  env.ALLOW_DOCKER = "1";
  await command("test");
  expect(state().hostOnly).toBeUndefined();
  expect(state().composeEnv).toEqual({ LOGIN: "new-database" });
  config();
  rmSync(resolve(home, "docker.log"));
  delete env.ALLOW_DOCKER;
  await command("up");
  expect(state().devHostOnly).toBe(true);
  expect(state().hostOnly).toBeUndefined();
  expect((await command("status")).stdout).not.toContain("run `devenv reset`");
  await command("down");
  expect(state().stopped).toBe(true);
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
  env.ALLOW_DOCKER = "1";
  await command("reset");
  const calls: string[][] = readFileSync(resolve(home, "docker.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.some((args) => args.includes("down") && args.includes("--volumes"))).toBe(true);
});

test("damaged Compose state is cleaned by name after Compose is removed from config", async () => {
  config('compose: { files: ["compose.yml"] },');
  env.ALLOW_DOCKER = "1";
  await command("up");
  writeFileSync(statePath(), "{broken");
  config();
  rmSync(resolve(home, "docker.log"));
  await command("reset");
  const calls: string[][] = readFileSync(resolve(home, "docker.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.some(
      (args) => args.includes("down") && args.includes("--volumes") && !args.includes("-f"),
    ),
  ).toBe(true);
  expect(calls.some((args) => args.includes("volume") && args.includes("ls"))).toBe(true);
  expect(existsSync(statePath())).toBe(false);
});

test("test-only Compose configs keep dev/up/status/list/down independent of Docker", async () => {
  config('compose: { files: [], test: ["compose.test.yml"] },');
  await command("up");
  expect(state().devHostOnly).toBe(true);
  expect(state().hostOnly).toBeUndefined();
  expect((await command("status")).stdout).toContain("http://localhost:");
  expect((await command("list")).stdout).toContain("ready");
  const dev = start("start");
  await ready();
  const closed = once(dev.child, "close");
  dev.child.kill("SIGTERM");
  expect((await closed)[0]).toBe(0);
  await command("down");
  expect(state().stopped).toBe(true);
  expect((await command("list")).stdout).toContain("stopped");
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
  // Reset still owns the throwaway test resources, including abandoned runs.
  env.ALLOW_DOCKER = "1";
  await command("reset");
  expect(existsSync(statePath())).toBe(false);
});

test("a dev-only Compose overlay does not make the test command require Docker", async () => {
  config('compose: { files: [], dev: ["compose.dev.yml"] },');
  env.ALLOW_DOCKER = "1";
  await command("up");
  expect(state().devHostOnly).toBeUndefined();
  rmSync(resolve(home, "docker.log"));
  delete env.ALLOW_DOCKER;
  await command("test");
  expect(existsSync(resolve(home, "docker.log"))).toBe(false);
});

test("removing dev Compose files requires cleanup even when test Compose files remain", async () => {
  config('compose: { files: ["compose.yml"] },');
  env.ALLOW_DOCKER = "1";
  await command("up");
  config('compose: { files: [], test: ["compose.test.yml"] },');
  expect((await command("status")).stdout).toContain("run `devenv reset`");
  await expect(command("up")).rejects.toThrow("reset");
  expect(state().devHostOnly).toBeUndefined();
});

test("Tailscale teardown preserves Docker cleanup recorded by a concurrent test run", async () => {
  config();
  const dev = start("start", "--tailscale");
  await ready();
  config('compose: { files: [], test: ["compose.test.yml"] },');
  env.ALLOW_DOCKER = "1";
  await command("test");
  expect(state().devHostOnly).toBe(true);
  const closed = once(dev.child, "close");
  dev.child.kill("SIGTERM");
  expect((await closed)[0]).toBe(0);
  expect(state().tailnet).toBeUndefined();
  expect(state().hostOnly).toBeUndefined();
  expect(state().devHostOnly).toBe(true);
});

test.each(["", ', test: ["compose.test.yml"]'])(
  "volume-free dev stacks refresh variables before first Compose startup (%s)",
  async (overlay) => {
    config(`compose: { files: [], env: { SECRET: "a" }${overlay} },`);
    await command("up");
    config(`compose: { files: [], env: { SECRET: "b" }${overlay} },`);
    expect((await command("up")).stderr).not.toContain(
      "differs from what this stack was created with",
    );
    expect(state().composeEnv).toEqual({ SECRET: "b" });
    const result = await command(
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.COMPOSE_SECRET)",
    );
    expect(result.stdout.trim()).toBe("b");
    expect(existsSync(resolve(home, "docker.log"))).toBe(false);
    // The first real dev volumes must use current values, then retain them.
    env.ALLOW_DOCKER = "1";
    config('compose: { files: ["compose.yml"], env: { SECRET: "c" } },');
    expect((await command("up")).stderr).not.toContain(
      "differs from what this stack was created with",
    );
    expect(state().composeEnv).toEqual({ SECRET: "c" });
    expect(state().hostOnly).toBeUndefined();
    expect(state().devHostOnly).toBeUndefined();
    config('compose: { files: ["compose.yml"], env: { SECRET: "d" } },');
    expect((await command("up")).stderr).toContain("differs from what this stack was created with");
    expect(state().composeEnv).toEqual({ SECRET: "c" });
  },
);
