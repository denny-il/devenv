import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { findEnvFile } from "../src/config.ts";

const home = realpathSync(mkdtempSync(resolve(tmpdir(), "devenv-config-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

// A main checkout with a project at its top and one below it, and a linked
// worktree of it, where nothing ignored by git exists yet.
const main = resolve(home, "main");
const worktree = resolve(home, "worktree");
// Whatever this machine's git is set up to do, signing or hooks say, and
// whichever repository a hook running these tests points it at.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
  delete env[name];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], {
    cwd,
    env,
    stdio: "ignore",
  });
mkdirSync(resolve(main, "apps/shop"), { recursive: true });
git(main, "init");
writeFileSync(resolve(main, "apps/shop/devenv.config.ts"), "");
git(main, "add", ".");
git(main, "commit", "--message", "initial");
git(main, "worktree", "add", worktree);
writeFileSync(resolve(main, ".env"), "");
writeFileSync(resolve(main, "apps/shop/.env"), "");

test("a worktree without a .env takes the main checkout's, from the same place", async () => {
  expect(await findEnvFile(worktree)).toBe(resolve(main, ".env"));
  expect(await findEnvFile(resolve(worktree, "apps/shop"))).toBe(resolve(main, "apps/shop/.env"));
});

test("a .env of the worktree's own is the one used", async () => {
  const other = resolve(home, "other");
  git(main, "worktree", "add", other);
  writeFileSync(resolve(other, ".env"), "");
  expect(await findEnvFile(other)).toBe(resolve(other, ".env"));
});

test("a bare repository's directory is no checkout to take a .env from", async () => {
  const storage = resolve(home, "storage");
  git(home, "clone", "--bare", main, resolve(storage, ".git"));
  git(resolve(storage, ".git"), "worktree", "add", resolve(home, "linked"));
  writeFileSync(resolve(storage, ".env"), "");
  expect(await findEnvFile(resolve(home, "linked"))).toBeUndefined();
});

test("nothing is taken from elsewhere outside a linked worktree", async () => {
  const plain = resolve(home, "plain");
  mkdirSync(plain);
  expect(await findEnvFile(plain)).toBeUndefined();
  // The main checkout itself, where no .env means there is none.
  rmSync(resolve(main, ".env"));
  expect(await findEnvFile(main)).toBeUndefined();
  expect(await findEnvFile(worktree)).toBeUndefined();
});
