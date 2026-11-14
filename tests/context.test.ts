import { expect, test } from "vitest";
import { appPorts, createContext, createEnvironment, servedPorts } from "../src/context.ts";

const state = {
  root: "/project",
  project: "app-local-0123456789ab",
  composeEnv: { POSTGRES_USER: "app" },
  services: { postgres: { ports: { 5432: 32818 } } },
  apps: { api: { ports: { proxy: 4100, worker: 4101 } }, web: { ports: { http: 4200 } } },
};

test("ports and URLs are found by app and port name", () => {
  const context = createContext(state);
  expect(context.service("postgres").port(5432)).toBe(32818);
  expect(context.port("api.worker")).toBe(4101);
  expect(context.port("web")).toBe(4200);
  expect(context.url("api.proxy")).toBe("http://localhost:4100");
  expect(context.vars.POSTGRES_USER).toBe("app");
});

test("over Tailscale the URLs are under the tailnet name", () => {
  const context = createContext({ ...state, tailnet: "machine.tail.ts.net" });
  expect(context.url("web")).toBe("https://machine.tail.ts.net:4200");
});

test("a service port has an origin only when compose.serve names it", () => {
  const serve = { postgres: [5432] };
  expect(createContext(state, serve).service("postgres").url(5432)).toBe("http://localhost:32818");
  expect(
    createContext({ ...state, tailnet: "machine.tail.ts.net" }, serve)
      .service("postgres")
      .url(5432),
  ).toBe("https://machine.tail.ts.net:32818");
  // Locally too: an origin that nothing would serve over Tailscale.
  expect(() => createContext(state).service("postgres").url(5432)).toThrow(
    "has no origin: name it in `compose.serve`, as `postgres: [5432]`",
  );
});

test("a service with several served ports lists each by its target", () => {
  const services = { storage: { ports: { 9000: 32820, 9001: 32821 } }, ...state.services };
  const serve = { storage: [9000, 9001], postgres: [5432] };
  const config = { name: "app", compose: { files: ["compose.yml"], serve } };
  expect(servedPorts(config, createContext({ ...state, services }, serve))).toEqual([
    { label: "storage.9000", port: 32820, url: "http://localhost:32820" },
    { label: "storage.9001", port: 32821, url: "http://localhost:32821" },
    { label: "postgres", port: 32818, url: "http://localhost:32818" },
  ]);
});

test("what a stack does not have is named with what it has", () => {
  const context = createContext(state);
  expect(() => context.port("api")).toThrow("name one: api.proxy, api.worker");
  expect(() => context.port("api.http")).toThrow("it has: proxy, worker");
  expect(() => context.port("admin")).toThrow("the apps are: api, web");
  expect(() => context.service("redis")).toThrow("there are: postgres");
  expect(() => context.service("postgres").port(5433)).toThrow("publishes no port 5433");
});

test("an app's env cannot read a port the app does not have", () => {
  const ports = appPorts("web", { http: 4200 });
  expect(ports.http).toBe(4200);
  expect(() => ports.https).toThrow("`web` has no port `https`; it has: http");
});

test("the environment is layered over this process's, and can unset", () => {
  process.env.DEVENV_TEST_KEPT = "kept";
  process.env.DEVENV_TEST_UNSET = "set";
  const environment = createEnvironment(
    {
      name: "app",
      compose: { files: ["compose.yml"] },
      env: ({ url }) => ({ WEB_URL: url("web"), DEVENV_TEST_UNSET: undefined, LAYERED: "project" }),
    },
    createContext(state),
    { LAYERED: "app", PORT: 4200 },
    undefined,
  );
  expect(environment).toMatchObject({
    DEVENV_TEST_KEPT: "kept",
    WEB_URL: "http://localhost:4200",
    LAYERED: "app",
    PORT: "4200",
  });
  expect(environment.DEVENV_TEST_UNSET).toBeUndefined();
  expect(environment.PATH?.startsWith("/project/node_modules/.bin")).toBe(true);
});
