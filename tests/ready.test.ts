import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { waitUntilReady } from "../src/ready.ts";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolveClose) => (server ? server.close(resolveClose) : resolveClose(null)));
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  return (server.address() as AddressInfo).port;
}

const signal = new AbortController().signal;

test("an HTTP check passes on an answer below 400, redirects included", async () => {
  const port = await serve((_, res) => {
    res.statusCode = 302;
    res.setHeader("location", "/elsewhere");
    res.end();
  });
  expect(await waitUntilReady({ port, path: "/", timeout: 1_000 }, signal)).toBe("ready");
});

test("a timeout tells what the app answered instead", async () => {
  const port = await serve((_, res) => {
    res.statusCode = 503;
    res.end();
  });
  expect(await waitUntilReady({ port, path: "/health", timeout: 500 }, signal)).toEqual({
    timeout: "it answered 503",
  });
});

test("an app that keeps an answer coming does not outlast the timeout", async () => {
  // Headers a byte at a time: never idle long enough for a socket timeout.
  const port = await serve((req) => {
    const bytes = Buffer.from("HTTP/1.1 200 OK\r\n");
    let index = 0;
    const drip = setInterval(() => {
      if (index < bytes.length) req.socket.write(bytes.subarray(index, ++index));
    }, 50);
    req.socket.once("close", () => clearInterval(drip));
  });
  const began = Date.now();
  expect(await waitUntilReady({ port, path: "/", timeout: 300 }, signal)).toEqual({
    timeout: "nothing answered",
  });
  expect(Date.now() - began).toBeLessThan(700);
});

test("each attempt closes its connection, an answer with an open body too", async () => {
  let open = 0;
  let most = 0;
  const port = await serve((_, res) => {
    res.writeHead(503).write("still building");
  });
  server!.on("connection", (socket) => {
    most = Math.max(most, ++open);
    socket.once("close", () => (open -= 1));
  });
  expect(await waitUntilReady({ port, path: "/", timeout: 1_200 }, signal)).toEqual({
    timeout: "it answered 503",
  });
  expect(most).toBe(1);
});
