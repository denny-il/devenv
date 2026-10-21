import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";

// The launcher from source, against a stand-in for Docker that has nothing
// to start: what is under test is how it runs, reports and stops the apps.
const cli = resolve(import.meta.dirname, "../src/cli.ts");
const docker = `#!/bin/sh
case "$*" in
  "info --format "*) echo 28.0.0;;
  "compose version --short") echo 2.39.0;;
esac
exit 0
`;

let base: string;
const started: ChildProcess[] = [];
const pids: number[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "devenv-start-"));
  await writeFile(join(base, "docker"), docker, { mode: 0o755 });
});

afterEach(async () => {
  // The apps run in process groups of their own, which only the launcher
  // knows: a test that failed early leaves it to stop them.
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(15_000)]);
    }
    killGroup(child.pid);
  }
  for (const pid of pids.splice(0)) killGroup(pid);
  await rm(base, { recursive: true, force: true });
}, 20_000);

function killGroup(pid: number | undefined) {
  try {
    if (pid) process.kill(-pid, "SIGKILL");
  } catch {}
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A project whose config is `config`, a JavaScript object literal. */
async function project(config: string, files: Record<string, string> = {}) {
  await writeFile(
    join(base, "devenv.config.js"),
    `export default { name: "probe", compose: { files: ["compose.yml"] }, ${config} };`,
  );
  for (const [name, content] of Object.entries(files)) await writeFile(join(base, name), content);
}

function launch(command: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(cli)};
main([${JSON.stringify(command)}]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});`,
    ],
    {
      cwd: base,
      env: {
        ...process.env,
        PATH: `${base}:${process.env.PATH}`,
        XDG_STATE_HOME: join(base, "state"),
      },
      // Its own group, so the test can clean up whatever is left.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  started.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code)),
  );
  return {
    child,
    exited,
    output: () => output,
    async until(text: string, timeout = 10_000) {
      const end = Date.now() + timeout;
      while (!output.includes(text)) {
        if (Date.now() > end) throw new Error(`No "${text}" in:\n${output}`);
        await sleep(50);
      }
    },
  };
}

async function json(path: string, timeout = 10_000): Promise<Record<string, number>> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (Date.now() > end) throw error;
      await sleep(50);
    }
  }
}

// Like a build-then-serve tool: a helper in a process group of its own
// that ignores SIGTERM, which the server stops itself, taking longer than
// the five seconds the launcher once gave a group after its command exited.
const cleaningServer = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
let signals = 0;
writeFileSync("pids.json", JSON.stringify({ server: process.pid, helper: helper.pid }));
process.on("SIGTERM", () => {
  signals += 1;
  writeFileSync("signals.json", JSON.stringify({ signals }));
  if (signals > 1) return;
  process.kill(-helper.pid, "SIGTERM");
  setTimeout(() => { process.kill(-helper.pid, "SIGKILL"); process.exit(0); }, 6000);
});
setInterval(() => {}, 1000);
`;

test("an app's group keeps the whole grace period after its shell exits, with one signal", async () => {
  await project(`apps: { api: { command: "node server.mjs" } }`, {
    "server.mjs": cleaningServer,
  });
  const run = launch("start");
  const { helper } = await json(join(base, "pids.json"));
  pids.push(helper!);
  const signaled = Date.now();
  run.child.kill("SIGTERM");

  expect(await run.exited).toBe(0);
  expect(Date.now() - signaled).toBeGreaterThanOrEqual(5_500);
  expect(running(helper!)).toBe(false);
  expect(await json(join(base, "signals.json"))).toEqual({ signals: 1 });
}, 20_000);

test("what ignores the stop is killed once the grace period is over", async () => {
  await project(`apps: { api: { command: "node stubborn.mjs" } }`, {
    "stubborn.mjs": `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync("pids.json", JSON.stringify({ server: process.pid }));
setInterval(() => {}, 1000);`,
  });
  const run = launch("start");
  const { server } = await json(join(base, "pids.json"));
  const signaled = Date.now();
  run.child.kill("SIGTERM");

  expect(await run.exited).toBe(0);
  expect(Date.now() - signaled).toBeGreaterThanOrEqual(9_500);
  expect(running(server!)).toBe(false);
}, 20_000);

// Builds for a second, then serves `/health`.
const slowServer = `
import { createServer } from "node:http";
setTimeout(() => {
  createServer((req, res) => {
    res.statusCode = req.url === "/health" ? 200 : 404;
    res.end();
  }).listen(Number(process.env.PORT), "127.0.0.1");
}, 1000);
`;

test("the URLs come once the apps with a readiness check answer", async () => {
  await project(
    `apps: {
      api: { command: "node slow.mjs", ready: { path: "/health" }, env: (ports) => ({ PORT: ports.http }) },
      worker: { command: "node -e 'setInterval(() => {}, 1000)'" },
    }`,
    { "slow.mjs": slowServer },
  );
  const run = launch("start");
  await run.until("Waiting for api to be ready");
  expect(run.output()).not.toMatch(/api: http/);
  await run.until("worker: http://localhost:");
  const output = run.output();
  expect(output).toMatch(
    /Ready: api\nStarted, without a readiness check: worker\napi: http:\/\/localhost:\d+\n/,
  );
  run.child.kill("SIGTERM");
  expect(await run.exited).toBe(0);
}, 20_000);

test("an app that exits before it is ready fails the start", async () => {
  await project(`apps: { api: { command: "node -e 'process.exit(0)'", ready: true } }`);
  const run = launch("start");
  expect(await run.exited).toBe(1);
  expect(run.output()).toContain(
    "api exited before it was ready (exit code 0); stopping the stack",
  );
  expect(run.output()).not.toContain("http://");
});

test("an app that is not ready in time stops the stack", async () => {
  await project(
    `apps: { api: { command: "node -e 'setInterval(() => {}, 1000)'", ready: { timeout: 1 } } }`,
  );
  const run = launch("start");
  expect(await run.exited).toBe(1);
  expect(run.output()).toMatch(
    /api was not ready within 1 second: at 127\.0\.0\.1:\d+, nothing answered; stopped the stack/,
  );
  expect(run.output()).not.toContain("http://");
}, 20_000);

test("a stop while waiting for readiness reports nothing as ready", async () => {
  await project(`apps: { api: { command: "node -e 'setInterval(() => {}, 1000)'", ready: true } }`);
  const run = launch("start");
  await run.until("Waiting for api to be ready");
  run.child.kill("SIGINT");
  expect(await run.exited).toBe(0);
  expect(run.output()).not.toMatch(/Ready|http:\/\//);
});

test("a readiness check on a port the app lacks fails before anything starts", async () => {
  await project(
    `apps: { api: { command: "node -e 'require(\\"fs\\").writeFileSync(\\"ran\\", \\"\\")'", ports: { a: {}, b: {} }, ready: { port: "c" } } }`,
  );
  const run = launch("start");
  expect(await run.exited).toBe(1);
  expect(run.output()).toContain("`api`'s readiness check: `api` has no port `c`; it has: a, b");
  await expect(readFile(join(base, "ran"))).rejects.toThrow();
});

test("the former `dev` command names its replacement", async () => {
  await project(
    `apps: { api: { command: "node -e 'require(\\"fs\\").writeFileSync(\\"ran\\", \\"\\")'" } }`,
  );
  const run = launch("dev");
  expect(await run.exited).toBe(1);
  expect(run.output()).toContain("`devenv dev` is now `devenv start`");
  await expect(readFile(join(base, "ran"))).rejects.toThrow();
});
