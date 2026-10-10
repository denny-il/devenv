/**
 * `devenv setup codex`: has the Codex app remove a worktree's stack when it
 * deletes the worktree, on archiving its chat or trimming old worktrees. The
 * app does that through the cleanup script of the local environment the
 * worktree was created with.
 */
export declare function setupCodex(root: string, name: string): Promise<void>;
