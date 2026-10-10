import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createServing } from "../src/tailnet.ts";

const host = "machine.example.ts.net";
let directory: string;

function script(name: string, lines: string[]): void {
  const path = join(directory, name);
  writeFileSync(path, `${["#!/bin/sh", ...lines].join("\n")}\n`);
  chmodSync(path, 0o755);
}

function servingPid(): number {
  return Number(readFileSync(join(directory, "pid"), "utf8"));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "devenv-tailnet-"));
  // As the Tailscale macOS app installs its CLI: a script that runs the real
  // program as its child and waits for it.
  script("tailscale", ['"$(dirname "$0")/serve" "$@"', "exit $?"]);
  script("serve", [
    'echo $$ > "$(dirname "$0")/pid"',
    `echo "Available within your tailnet: https://${host}"`,
    "exec sleep 60",
  ]);
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
});

afterEach(() => {
  try {
    process.kill(servingPid(), "SIGKILL");
  } catch {
    // Ended already, as it should have.
  }
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("stopping ends a `tailscale` that runs the real one as its child", async () => {
  const serving = createServing(host);
  await serving.start([4000]);
  expect(() => process.kill(servingPid(), 0)).not.toThrow();

  serving.stop();
  // The real one holds the output this waits for the end of: left running,
  // it keeps this waiting.
  await serving.closed();
});
