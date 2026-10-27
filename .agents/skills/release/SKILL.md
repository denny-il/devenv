---
name: release
description: "Use when asked to release or publish a new version of @denny-il/devenv to npm, or to bump its version. Gives the order of the release PR and the `Publish` workflow, what needs the user (the version, merging), and how to recover from a failed run."
---

# Release @denny-il/devenv

Releases go to npm from the `Publish` workflow
(`.github/workflows/publish.yml`), dispatched by hand on `main`. It
publishes with npm trusted publishing, so no npm sign-in or second factor is
needed. A published version is public and can be neither replaced nor taken
back, so release only when the user asked for one, with a version they named
or agreed to.

## The order

1. Bump the version in a release PR, and merge it.
2. Dispatch the workflow on `main` with that version.
3. Check that npm and GitHub have the release.

The workflow refuses a version that does not match `package.json` on `main`,
or whose tag points at another commit, so it can only publish what the
release PR merged.

## Before starting

- **The version is agreed.** `pnpm view @denny-il/devenv version` shows the
  newest one published. A fix is a patch. Anything that changes what a project
  relies on (the config, a command, an exit status) is a minor: before 1.0 a
  project's `^0.x.y` range takes patches only, so a minor is what a project
  has to opt into. If the user gave no version, propose one and ask.
- **`main` has everything the release should ship**, and nothing it should
  not: the workflow publishes `main` as it is.

## Steps

From an up-to-date `main`, on a new branch:

```sh
pnpm version <patch|minor|x.y.z> --no-git-tag-version
version=$(node -p 'require("./package.json").version')
git commit package.json -m "chore: release $version"
```

Push it, open a PR titled `chore: release <version>`, and merge it as the
user asked (squash). Then:

```sh
gh workflow run publish.yml --ref main -f version="$version"
gh run list --workflow publish.yml --limit 1   # its ID
gh run watch <id> --exit-status
```

Once it has succeeded:

```sh
pnpm view @denny-il/devenv version
gh release view "v$version"
```

The registry can take a minute or two to show a new version, and answers
`Not found` or the old one until then.

## When a run fails

- **Before the publish step:** nothing was published or tagged. Fix the cause
  on `main` with a PR, keeping the version, and dispatch again.
- **At or after the publish step:** dispatch again with the same version. A
  version already on npm is skipped, and the tag and release are created if
  missing, so a rerun finishes the release.
- **The version is already on npm from another commit, or its tag points
  elsewhere:** it was released already. Bump to the next version in a new
  release PR.

## Never

- `npm unpublish`, or deleting and moving a release tag: a version that
  projects may have installed does not change or disappear.
- Publishing from a checkout: the published package would carry no
  provenance, and `main` would not be what was released.
