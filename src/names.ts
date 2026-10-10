import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

function worktreeIdentity(root: string): string {
  return createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 12);
}

/** The Compose project of the checkout at `root`, so worktrees run side by side. */
export function projectName(name: string, root: string): string {
  return `${name}-local-${worktreeIdentity(root)}`;
}

/** The prefix of this worktree's test projects, never a dev project's. */
export function testProjectPrefix(name: string, root: string): string {
  return `${name}-test-${worktreeIdentity(root)}-`;
}

/** A run's own project: the launcher's PID tells a live run from a killed one. */
export function createTestProjectName(prefix: string, pid: number, runId: string): string {
  return `${prefix}${pid}-${runId}`;
}

/** The PID of the launcher that started a test project, if it names one. */
export function testProjectLauncher(project: string, prefix: string): number | undefined {
  const pid = Number(project.slice(prefix.length).split("-")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * This worktree's test projects whose launcher is gone, a run killed outright.
 * A project whose launcher still runs belongs to a concurrent run and stays.
 */
export function abandonedTestProjects(
  projects: string[],
  prefix: string,
  isRunning: (pid: number) => boolean,
): string[] {
  return [...new Set(projects)].filter((project) => {
    if (!project.startsWith(prefix)) return false;
    const pid = testProjectLauncher(project, prefix);
    return pid === undefined || !isRunning(pid);
  });
}
