import { expect, test, vi } from "vitest";
import { type Requirement, meet } from "../src/setup.ts";

/** A requirement that is unmet until `fixedBy` has run, if it ever does. */
function requirement(
  name: string,
  met: boolean,
  fixedBy?: string,
): Requirement & { ran: string[] } {
  const ran: string[] = [];
  return {
    name,
    ran,
    check: async () => (met || (fixedBy && ran.includes(fixedBy)) ? undefined : "unmet"),
    ...(fixedBy ? { fix: [fixedBy] } : {}),
    manual: `do ${name} by hand`,
  };
}

test("what is met is left alone, and what a command can fix is fixed", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const installed = requirement("installed", true, "install");
  const running = requirement("running", false, "start");
  const runFix = async (command: unknown) => void running.ran.push(String(command));

  expect(await meet([installed, running], runFix)).toBe(true);
  expect(running.ran).toEqual(["start"]);
  expect(log.mock.calls.flat()).toEqual(["✓ installed", "\n$ start", "✓ running"]);
  log.mockRestore();
});

test("the first requirement that stays unmet stops the ones built on it", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const ran: string[] = [];
  const broken = requirement("installed", false, "install");
  const later = requirement("running", false, "start");
  // The installer runs and fails: nothing records it as done.
  const runFix = async (command: unknown) => void ran.push(String(command));

  expect(await meet([broken, later], runFix)).toBe(false);
  expect(ran).toEqual(["install"]);
  expect(log.mock.calls.flat()).toEqual([
    "\n$ install",
    "✗ installed: unmet",
    "  do installed by hand",
  ]);
  log.mockRestore();
});
