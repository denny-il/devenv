import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { orphans } from "../src/stacks.ts";
import {
  type State,
  listStates,
  parseState,
  readState,
  removeState,
  stateHome,
  statePath,
  writeState,
} from "../src/state.ts";

const home = mkdtempSync(resolve(tmpdir(), "devenv-state-"));
process.env.XDG_STATE_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const written: State = {
  version: 1,
  root: "/project",
  project: "app-local-0123456789ab",
  composeEnv: { POSTGRES_USER: "app" },
  services: { postgres: { ports: { 5432: 32818 } } },
  apps: { web: { ports: { http: 4200 } } },
};

const parse = (value: unknown, project = written.project) =>
  parseState(JSON.stringify(value), project);

test("a written state is read back", () => {
  expect(parse(written)).toEqual(written);
  const stopped = { ...written, tailnet: "m.ts.net", stopped: true };
  expect(parse(stopped)).toEqual(stopped);
});

test("ports that cannot be ports are dropped", () => {
  const apps = { web: { ports: { http: "4200", https: 70000, admin: 4201 } }, api: null };
  expect(parse({ ...written, apps }).apps).toEqual({
    web: { ports: { admin: 4201 } },
    api: { ports: {} },
  });
});

test("a state whose Compose variables cannot be trusted is refused", () => {
  expect(() => parseState("{oops", written.project)).toThrow();
  expect(() => parse({ ...written, version: 2 })).toThrow();
  expect(() => parse({ ...written, composeEnv: { A: 1 } })).toThrow("`composeEnv` is damaged");
});

test("a state speaks only for the stack it is filed under, and names its checkout", () => {
  // Filed under one stack, naming another: `prune` would remove the other.
  expect(() => parse(written, "app-local-ffffffffffff")).toThrow("filed under");
  // Not a name the launcher gives a stack: nothing of Docker's to touch.
  expect(() => parse({ ...written, project: "casenetwork" }, "casenetwork")).toThrow("filed under");
  // No checkout to look for would read as a checkout that is gone.
  for (const root of [undefined, null, "", "relative/path"])
    expect(() => parse({ ...written, root })).toThrow("names no checkout");
});

test("every stack's state is kept in one place outside the checkouts", async () => {
  expect(stateHome()).toBe(resolve(home, "devenv"));
  expect(statePath(written.project)).toBe(
    resolve(home, "devenv/stacks/app-local-0123456789ab.json"),
  );

  const other = { ...written, project: "app-local-ffffffffffff", root: "/elsewhere" };
  await writeState(written);
  await writeState(other);
  // What is not a state, or is another stack's, does not hide the ones that are.
  writeFileSync(resolve(home, "devenv/stacks/broken.json"), "{oops");
  writeFileSync(resolve(home, "devenv/stacks/app-local-aaaaaaaaaaaa.json"), JSON.stringify(other));

  expect(await readState(written.project)).toEqual(written);
  expect(await listStates()).toEqual([written, other]);

  await removeState(other.project);
  expect(await readState(other.project)).toBeNull();
  expect(await listStates()).toEqual([written]);
});

test("a stack is an orphan once its checkout is gone", () => {
  const here = { ...written, root: "/here" };
  const gone = { ...written, project: "app-local-ffffffffffff", root: "/gone" };
  expect(orphans([here, gone], (path) => path === "/here")).toEqual([gone]);
});
