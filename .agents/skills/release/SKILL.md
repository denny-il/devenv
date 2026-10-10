---
name: release
description: "Use when asked to release or publish a new version of @denny-il/devenv to npm, or to bump its version. Gives the order that leaves nothing behind when a step fails, what needs the user (the version, npm sign-in, the second factor), and how to recover from a failed step."
---

# Release @denny-il/devenv

Releases go to npm from a checkout of this repository; there is no CI. A
published version is public and can be neither replaced nor taken back, so
release only when the user asked for one, with a version they named or agreed
to.

## The order

1. Set the version in the working tree, uncommitted.
2. Dry-run the publish.
3. Publish.
4. Commit, tag and push.

Nothing is committed or pushed until npm has accepted the package, so a
failure before that is undone by restoring one file.

## Before starting

- **The checkout is `main`, clean, and level with `origin`.** The publish
  commands below skip pnpm's own Git checks, because the version change makes
  the tree dirty on purpose, so check here:

  ```sh
  git fetch origin
  git status --short --branch   # expect only: ## main...origin/main
  ```

  Anything else uncommitted would be published without being in Git. Stop and
  ask the user.

- **npm is signed in:** `pnpm whoami`. If it is not, ask the user to run
  `pnpm login`. Do not sign in for them, and do not read or print `~/.npmrc`.

- **The version is agreed.** `pnpm view @denny-il/devenv version` shows the
  newest one published. A fix is a patch. Anything that changes what a project
  relies on (the config, a command, an exit status) is a minor: before 1.0 a
  project's `^0.x.y` range takes patches only, so a minor is what a project
  has to opt into. If the user gave no version, propose one and ask.

## Steps

```sh
pnpm version <patch|minor|x.y.z> --no-git-tag-version
pnpm publish --dry-run --no-git-checks
```

The dry run runs the checks, the tests and the build, as the real publish
does. Then:

```sh
pnpm publish --no-git-checks
```

npm asks for a second factor here. If the command wants a one-time password,
ask the user for the code and run it again with `--otp <code>`. If it prints a
link to approve in a browser, give the user the link and wait.

Once it has succeeded:

```sh
version=$(node -p 'require("./package.json").version')
git commit -am "chore: release $version"
git tag "v$version"
git push origin main "v$version"
pnpm view @denny-il/devenv version   # the new version, after a moment
```

## When a step fails

- **Before the publish succeeded:** `git restore package.json`. Nothing was
  committed, pushed or published. Fix the cause and start again.
- **After the publish succeeded:** the version is on npm for good. Do not
  restore anything; fix what stopped the commit or the push and finish
  step 4, so the repository has the commit the release was made from.
- **npm says the version exists:** it was released already. Restore
  `package.json` and take the next version.

## Never

- `--force`, or `npm unpublish`: a version that projects may have installed
  does not change or disappear.
- `--ignore-scripts`: it skips the build, and `dist/` is not in Git, so the
  package would ship without its code.
