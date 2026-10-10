import { expect, test } from "vitest";
import { parsePublishedPorts, supportsComposeVersion } from "./compose.ts";

test("Compose versions from 2.24.4 are supported", () => {
  expect(supportsComposeVersion("2.24.4")).toBe(true);
  expect(supportsComposeVersion("v5.5.1\n")).toBe(true);
  expect(supportsComposeVersion("2.24.3")).toBe(false);
  expect(supportsComposeVersion("1.29.2")).toBe(false);
  expect(supportsComposeVersion("unknown")).toBe(false);
});

test("published ports are read per service and target", () => {
  const lines = [
    {
      Service: "postgres",
      Publishers: [{ URL: "127.0.0.1", TargetPort: 5432, PublishedPort: 32818, Protocol: "tcp" }],
    },
    {
      Service: "storage",
      Publishers: [
        { URL: "127.0.0.1", TargetPort: 9000, PublishedPort: 32900, Protocol: "tcp" },
        // Exposed but not published, and not TCP.
        { URL: "", TargetPort: 9001, PublishedPort: 0, Protocol: "tcp" },
        { URL: "127.0.0.1", TargetPort: 53, PublishedPort: 32901, Protocol: "udp" },
      ],
    },
    { Service: "worker", Publishers: [] },
  ];
  expect(parsePublishedPorts(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)).toEqual({
    postgres: { ports: { 5432: 32818 } },
    storage: { ports: { 9000: 32900 } },
    worker: { ports: {} },
  });
  expect(parsePublishedPorts("")).toEqual({});
});
