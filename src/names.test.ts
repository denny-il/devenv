import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  abandonedTestProjects,
  createTestProjectName,
  projectName,
  testProjectLauncher,
  testProjectPrefix,
} from "./names.ts";

test("a checkout names its own projects", () => {
  expect(projectName("app", tmpdir())).toMatch(/^app-local-[0-9a-f]{12}$/);
  expect(projectName("app", tmpdir())).toBe(projectName("app", tmpdir()));
  expect(projectName("app", tmpdir())).not.toBe(projectName("app", process.cwd()));
  expect(testProjectPrefix("app", tmpdir())).toMatch(/^app-test-[0-9a-f]{12}-$/);
});

test("a test project names the launcher that started it", () => {
  const prefix = "app-test-0123456789ab-";
  expect(testProjectLauncher(createTestProjectName(prefix, 4321, "a1b2c3"), prefix)).toBe(4321);
  expect(testProjectLauncher(`${prefix}nonsense`, prefix)).toBeUndefined();
});

test("only this worktree's test projects without a live launcher are abandoned", () => {
  const prefix = "app-test-0123456789ab-";
  const projects = [
    `${prefix}100-aaaaaa`,
    `${prefix}100-aaaaaa`,
    `${prefix}200-bbbbbb`,
    `${prefix}nonsense`,
    "app-test-ffffffffffff-100-cccccc",
    "app-local-0123456789ab",
  ];
  expect(abandonedTestProjects(projects, prefix, (pid) => pid === 200)).toEqual([
    `${prefix}100-aaaaaa`,
    `${prefix}nonsense`,
  ]);
});
