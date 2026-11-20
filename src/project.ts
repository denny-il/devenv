import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, findConfig, findEnvFile, loadConfig } from "./config.ts";
import { projectName } from "./names.ts";

/** A project's config, where it is, and its worktree's stack name. */
export interface Project {
  root: string;
  config: Config;
  name: string;
}

/** The project `directory` is in, its `.env` loaded into this process. */
export async function loadProject(directory: string): Promise<Project> {
  const path = findConfig(directory);
  // The real path: it is what the stack is named after, and kept in its state.
  const root = realpathSync(dirname(path));
  // Before the config, which may read it. Variables already set win.
  const envFile = await findEnvFile(root);
  if (envFile) {
    // On stderr: under `run` the standard output is the command's alone.
    if (dirname(envFile) !== root)
      console.error(`Environment: ${envFile}, as this worktree has no .env of its own`);
    process.loadEnvFile(envFile);
  }
  const config = await loadConfig(path);
  return { root, config, name: projectName(config.name, root) };
}
