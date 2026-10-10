import { connect } from "node:net";
import { expect, test } from "vitest";
import { reserveAppPorts, reservePort } from "./ports.ts";

test("a preferred port is reserved while it is free, else any other", async () => {
  const first = await reservePort();
  const taken = await reservePort(first.port);
  expect(taken.port).not.toBe(first.port);
  await first.release();
  await taken.release();

  const again = await reservePort(first.port);
  expect(again.port).toBe(first.port);
  await again.release();
});

test("anything that is not a port is no preference", async () => {
  for (const preferred of ["4200", 0, -1, 70000, 1.5, null]) {
    const reservation = await reservePort(preferred);
    expect(reservation.port).toBeGreaterThan(0);
    await reservation.release();
  }
});

test("every port of every app is reserved, the earlier ones again", async () => {
  const apps = {
    api: { command: "api", ports: { proxy: {}, worker: { internal: true } } },
    web: { command: "web" },
  };
  const first = await reserveAppPorts(apps, undefined);
  expect(Object.keys(first.apps.api?.ports ?? {})).toEqual(["proxy", "worker"]);
  expect(Object.keys(first.apps.web?.ports ?? {})).toEqual(["http"]);
  await first.releaseAll();

  const second = await reserveAppPorts(apps, first.apps);
  expect(second.apps).toEqual(first.apps);
  await second.release("api");
  // Released for the app to take; `web` is still held.
  const api = await reservePort(first.apps.api?.ports.proxy);
  const web = await reservePort(first.apps.web?.ports.http);
  expect(api.port).toBe(first.apps.api?.ports.proxy);
  expect(web.port).not.toBe(first.apps.web?.ports.http);
  await Promise.all([api.release(), web.release(), second.releaseAll()]);
});

test("a client holding a connection does not keep a port reserved", async () => {
  const reservation = await reservePort();
  const client = connect({ host: "127.0.0.1", port: reservation.port });
  await new Promise((resolveConnected) => client.once("connect", resolveConnected));
  await reservation.release();
  client.destroy();
});
