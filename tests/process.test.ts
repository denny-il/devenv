import { expect, test } from "vitest";
import { exitStatus } from "../src/process.ts";

test("an exit reads as a shell would report it", () => {
  expect(exitStatus({ code: 3, signal: null })).toBe(3);
  expect(exitStatus({ code: null, signal: "SIGINT" })).toBe(130);
  expect(exitStatus({ code: null, signal: "SIGKILL" })).toBe(137);
});
