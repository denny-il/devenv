import { expect, test } from "vitest";
import { exitStatus } from "../src/process.ts";
import { isTestLauncher, testCommand } from "../src/stack.ts";

test("a test launcher is told from whatever else has its PID", () => {
  expect(isTestLauncher("node /project/node_modules/@denny-il/devenv/bin/devenv.js test\n")).toBe(
    true,
  );
  expect(isTestLauncher("node /usr/local/bin/devenv test -- --watch")).toBe(true);
  expect(isTestLauncher("node /project/node_modules/@denny-il/devenv/bin/devenv.js dev")).toBe(
    false,
  );
  expect(isTestLauncher("node /home/me/devenv/node_modules/.bin/vitest tests")).toBe(false);
});

test("arguments are added to a plain test command", () => {
  expect(testCommand(["vitest", "--run"], ["-t", "a b"])).toEqual(["vitest", "--run", "-t", "a b"]);
  expect(testCommand("vitest --run", ["-t", "it's"])).toBe(`vitest --run '-t' 'it'\\''s'`);
  expect(
    testCommand((args) => (args.length ? ["vitest", ...args] : "vitest --project api"), []),
  ).toBe("vitest --project api");
});

test("an exit reads as a shell would report it", () => {
  expect(exitStatus({ code: 3, signal: null })).toBe(3);
  expect(exitStatus({ code: null, signal: "SIGINT" })).toBe(130);
  expect(exitStatus({ code: null, signal: "SIGKILL" })).toBe(137);
});
