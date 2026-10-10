import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { run } from "./process.ts";

const reset = "[ -x node_modules/.bin/devenv ] && node_modules/.bin/devenv reset || true";

// Codex runs it in the worktree, as the last thing before deleting it. A
// script that fails keeps Codex from deleting the worktree, so this one never
// does: a stack it could not remove shows in `devenv list`.
const cleanup = `
[cleanup]
script = '''
# Removes this worktree's devenv stack before Codex deletes the worktree.
${reset}
'''
`;

// A cleanup table or key, however the file spells it.
const cleanupPattern = /^[ \t]*(\[[ \t]*["']?cleanup["']?[ \t]*\]|["']?cleanup["']?[ \t]*=)/m;

const installs = [
  ["pnpm-lock.yaml", "pnpm install"],
  ["bun.lock", "bun install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
] as const;

/**
 * `devenv setup codex`: has the Codex app remove a worktree's stack when it
 * deletes the worktree, on archiving its chat or trimming old worktrees. The
 * app does that through the cleanup script of the local environment the
 * worktree was created with.
 */
export async function setupCodex(root: string, name: string): Promise<void> {
  // Codex keeps a project's environments at the root of its repository and
  // runs their scripts there, which is where the script expects the launcher.
  const repository = await run(["git", "rev-parse", "--show-toplevel"], {
    cwd: root,
    capture: true,
    reject: false,
  });
  if (repository.code === 0 && resolve(repository.stdout.trim()) !== resolve(root)) {
    const inside = relative(repository.stdout.trim(), root);
    console.log("✗ devenv.config.ts is not at the root of the repository, where Codex looks.");
    console.log(`  Add to the cleanup script of the repository's Codex environment:`);
    console.log(`  (cd ${inside} && ${reset})`);
    process.exitCode = 1;
    return;
  }

  const directory = resolve(root, ".codex/environments");
  const files = existsSync(directory)
    ? (await readdir(directory)).filter((file) => file.endsWith(".toml"))
    : [];

  if (!files.length) {
    // The launcher has to be installed in a worktree for its stack to run
    // there, and to be removed from there.
    const install = installs.find(([lockfile]) => existsSync(resolve(root, lockfile)))?.[1] ?? "";
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "environment.toml"),
      `version = 1\nname = ${JSON.stringify(name)}\n\n[setup]\nscript = ${JSON.stringify(install)}\n${cleanup}`,
    );
    console.log("✓ Wrote .codex/environments/environment.toml");
  }
  for (const file of files) {
    const path = resolve(directory, file);
    const content = await readFile(path, "utf8");
    const found = content.search(cleanupPattern);
    if (found === -1) {
      await appendFile(path, cleanup);
      console.log(`✓ Added a cleanup script to .codex/environments/${file}`);
    } else if (content.slice(found).includes(reset)) {
      console.log(`✓ .codex/environments/${file} already removes the stack`);
    } else {
      console.log(`✗ .codex/environments/${file} has a cleanup script of its own. Add to it:`);
      console.log(`  ${reset}`);
      process.exitCode = 1;
    }
  }
  console.log(
    "  Commit the file, and pick this environment when starting a worktree chat in the Codex app.",
  );
}
