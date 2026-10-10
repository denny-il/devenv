import { expect, test } from "vitest";
import { parseState } from "./state.ts";

const project = "app-local-0123456789ab";
const written = {
  version: 1,
  root: "/project",
  project,
  composeEnv: { POSTGRES_USER: "app" },
  services: { postgres: { ports: { 5432: 32818 } } },
  apps: { web: { ports: { http: 4200 } } },
};

test("a written state is read back", () => {
  expect(parseState(JSON.stringify(written), project)).toEqual(written);
  expect(
    parseState(JSON.stringify({ ...written, tailnet: "m.ts.net", stopped: true }), project),
  ).toEqual({
    ...written,
    tailnet: "m.ts.net",
    stopped: true,
  });
});

test("another project's state, of a copied worktree, is nobody's", () => {
  expect(parseState(JSON.stringify(written), "app-local-ffffffffffff")).toBeNull();
});

test("ports that cannot be ports are dropped", () => {
  const apps = { web: { ports: { http: "4200", https: 70000, admin: 4201 } }, api: null };
  expect(parseState(JSON.stringify({ ...written, apps }), project)?.apps).toEqual({
    web: { ports: { admin: 4201 } },
    api: { ports: {} },
  });
});

test("a state whose Compose variables cannot be trusted is refused", () => {
  expect(() => parseState("{oops", project)).toThrow();
  expect(() => parseState(JSON.stringify({ ...written, version: 2 }), project)).toThrow();
  expect(() => parseState(JSON.stringify({ ...written, composeEnv: { A: 1 } }), project)).toThrow(
    "`composeEnv` is damaged",
  );
});
