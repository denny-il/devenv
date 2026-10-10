/** The Compose project of the checkout at `root`, so worktrees run side by side. */
export declare function projectName(name: string, root: string): string;
/** The prefix of this worktree's test projects, never a dev project's. */
export declare function testProjectPrefix(name: string, root: string): string;
/** A run's own project: the launcher's PID tells a live run from a killed one. */
export declare function createTestProjectName(prefix: string, pid: number, runId: string): string;
/** The PID of the launcher that started a test project, if it names one. */
export declare function testProjectLauncher(project: string, prefix: string): number | undefined;
/**
 * This worktree's test projects whose launcher is gone, a run killed outright.
 * A project whose launcher still runs belongs to a concurrent run and stays.
 */
export declare function abandonedTestProjects(projects: string[], prefix: string, isRunning: (pid: number) => boolean): string[];
