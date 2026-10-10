import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
/** What tells a checkout's stacks from every other's: a digest of its real path. */
export function checkoutIdentity(realRoot) {
    return createHash("sha256").update(realRoot).digest("hex").slice(0, 12);
}
function worktreeIdentity(root) {
    return checkoutIdentity(realpathSync(root));
}
/** The Compose project of the checkout at `root`, so worktrees run side by side. */
export function projectName(name, root) {
    return `${name}-local-${worktreeIdentity(root)}`;
}
/** The prefix of this worktree's test projects, never a dev project's. */
export function testProjectPrefix(name, root) {
    return `${name}-test-${worktreeIdentity(root)}-`;
}
/** A run's own project: the launcher's PID tells a live run from a killed one. */
export function createTestProjectName(prefix, pid, runId) {
    return `${prefix}${pid}-${runId}`;
}
/** The PID of the launcher that started a test project, if it names one. */
export function testProjectLauncher(project, prefix) {
    const pid = Number(project.slice(prefix.length).split("-")[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
/**
 * This worktree's test projects whose launcher is gone, a run killed outright.
 * A project whose launcher still runs belongs to a concurrent run and stays.
 */
export function abandonedTestProjects(projects, prefix, isRunning) {
    return [...new Set(projects)].filter((project) => {
        if (!project.startsWith(prefix))
            return false;
        const pid = testProjectLauncher(project, prefix);
        return pid === undefined || !isRunning(pid);
    });
}
