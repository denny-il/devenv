# devenv

One command for a project's local stack: Docker Compose services, the apps
that run on the host, and, when asked, HTTPS access from every device on a
Tailscale network.

Every checkout gets a stack of its own, so several worktrees of a project run
side by side. Nothing listens beyond this machine.

Linux and macOS, Node 22.18 or newer, Docker Compose 2.24.4 or newer.

## Install

```sh
pnpm add -D github:denny-il/devenv
```

```jsonc
// package.json
{ "scripts": { "local": "devenv" } }
```

### While the repository is private

On a machine that is not prepared, the install fails like this:

```
Failed to resolve git dependency "github:denny-il/devenv": git ls-remote failed:
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

pnpm takes a GitHub specifier as the repository's identity, not as a choice of
transport. `github:`, `https://` and `git+ssh://` forms all resolve through
`https://github.com/…`, which is also what the lockfile records, so no
SSH-looking specifier helps. The transport is the machine's
[Git configuration](https://pnpm.io/package-sources#how-git-dependencies-are-resolved).

A machine needs two things, once:

1. An SSH key with access to the repository. `ssh -T git@github.com` checks it.
2. Git told to reach GitHub over SSH:

   ```sh
   git config --global url."git@github.com:".insteadOf https://github.com/
   ```

   This is machine-wide: every HTTPS GitHub URL that Git touches then goes
   over SSH.

To leave the machine's configuration alone, give one command the rule through
its environment:

```sh
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0='url.git@github.com:.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
pnpm add -D github:denny-il/devenv
```

- **A missing rule can stay hidden.** Once the package is in pnpm's store,
  `pnpm install --frozen-lockfile` passes without it, because nothing is
  fetched. It fails when GitHub must be reached again: a fresh machine, a
  pruned store, or a newer commit of this package.
- **CI** needs an SSH key and the rule, or an HTTPS credential for GitHub. The
  lockfile is the same either way.

### Updating

```sh
pnpm update @denny-il/devenv
```

This moves the lockfile to the newest commit on `main`. A plain `pnpm install`
keeps the commit the lockfile records.

## Agent skill

The repository carries a skill for coding agents that work in a project using
the launcher: the commands and their rules, the config, and how to move a
project onto it.

```sh
npx skills add git@github.com:denny-il/devenv.git
```

This form clones over SSH. The installer turns `denny-il/devenv` and
`git+ssh://` addresses into HTTPS ones, which reach a private repository only
on a machine with the Git rule above, or with HTTPS credentials for GitHub.

## Commands

| Command                             | What it does                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `devenv up`                         | Starts this worktree's services.                                                |
| `devenv dev`                        | Starts the services, runs `setup`, then runs every app until one stops.         |
| `devenv dev --tailscale`            | The same, with the apps served to this machine's tailnet over HTTPS.            |
| `devenv status`                     | Shows the services and the app URLs.                                            |
| `devenv run -- <command>`           | Runs a command with the stack's environment.                                    |
| `devenv test [-- <args>]`           | Runs the tests on a fresh stack of their own, always removed afterwards.        |
| `devenv down`                       | Stops the services and keeps their volumes.                                     |
| `devenv reset`                      | Stops the services and deletes this worktree's volumes, images and state.       |
| `devenv list`                       | Shows every stack on this machine.                                              |
| `devenv prune`                      | Removes the stacks whose checkout is gone, with their data.                     |
| `devenv setup [docker] [tailscale]` | Installs Docker and Tailscale on this machine, and sets them up.                |
| `devenv tailnet info`               | Shows this machine's tailnet name and what keeps it from serving, if anything.  |
| `devenv tailnet serve`              | Serves the given local ports to the tailnet until stopped, without any project. |

## Setting up a machine

`devenv setup` checks what a stack needs on this machine and installs what is
missing. `devenv setup docker` and `devenv setup tailscale` do one of the two.
It installs Docker and Tailscale with their own installers on Linux, with
Homebrew on macOS. The installers ask for a password.

On Linux it also starts both, signs in to Tailscale, and lets your user run
Docker and serve over Tailscale. What only a person can do is printed: on
macOS opening the two apps and signing in, and on any machine enabling HTTPS
certificates for the tailnet.

Run it again until every line is checked; it changes nothing that is already
in place.

## What a project provides

A project adapts to the launcher, not the other way around.

- **Compose files.** A base file and an overlay per mode. Services publish
  their ports on loopback ports that Docker assigns
  (`ports: [{ target: 5432, host_ip: 127.0.0.1 }]`), never on fixed ones.
  Readiness is a `healthcheck`; a service without one is ready once it runs.
  The launcher names the Compose project, and starts only the services
  outside of profiles.
- **Apps.** Each is a command that takes its ports from its environment and
  listens on `127.0.0.1`.
- **Environment.** One function from the stack to the variables every app and
  command gets, on top of the root `.env`.

## Config

`devenv.config.ts` (or `.js`) in the project root, found from
any directory below it:

```ts
import { defineConfig } from "@denny-il/devenv";

export default defineConfig({
  // Names the Compose projects: `shop-local-<worktree>`, `shop-test-<worktree>-<run>`.
  name: "shop",

  compose: {
    files: [".infra/compose.yml"],
    dev: [".infra/compose.local.yml"],
    test: [".infra/compose.test.yml"],
    // Services that do a job and exit. Each runs once the others are ready.
    init: ["create-bucket"],
    // Variables for the Compose files. A stack keeps the values its volumes
    // were created with until `reset`.
    env: {
      POSTGRES_USER: process.env.POSTGRES_USER || "shop",
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "shop",
    },
  },

  // Started by `dev` in this order.
  apps: {
    api: {
      command: "pnpm --filter api dev",
      // `internal` ports are reserved, but neither listed nor served.
      ports: { proxy: {}, worker: { internal: true } },
      env: (ports) => ({
        API_HOST: "127.0.0.1",
        API_PORT: ports.proxy,
        WORKER_PORT: ports.worker,
      }),
    },
    // Without `ports`, an app has one port named `http`.
    web: {
      command: "pnpm --filter web dev",
      env: (ports) => ({ HOST: "127.0.0.1", PORT: ports.http }),
    },
  },

  env: ({ service, vars, url, project }) => ({
    DATABASE_URL: `postgresql://${vars.POSTGRES_USER}:${vars.POSTGRES_PASSWORD}@127.0.0.1:${service("postgres").port(5432)}/shop`,
    API_URL: `${url("api.proxy")}/api`,
    WEB_URL: url("web"),
    // Browsers share cookies across ports: a name per worktree keeps their
    // sessions apart.
    COOKIE_PREFIX: project,
  }),

  // Run by `dev` once the services are up, before the apps.
  setup: ["pnpm database migrate", "pnpm database seed"],

  test: {
    setup: ["pnpm database migrate"],
    // Arguments after `devenv test --` are added; a function decides itself.
    command: "vitest --run",
    env: { DATABASE_TESTS: "true" },
  },

  // Printed under the URLs by `dev` and `status`.
  info: () => ({ "Sign-in": "admin@shop.local / admin" }),
});
```

A command is a line for the shell, or a list of a program and its arguments.

The functions get the stack as a context:

| Member                       | What it is                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `service(name).port(target)` | The loopback port Docker published a service's port on.            |
| `port(ref)`                  | An app's port: `'api.proxy'`, or `'web'` for an app with one port. |
| `url(ref)`                   | The origin that port answers at.                                   |
| `vars`                       | `compose.env` as the stack uses it.                                |
| `project`                    | The stack's Compose project name.                                  |
| `root`                       | The project root.                                                  |
| `tailnet`                    | This machine's tailnet name, under `dev --tailscale`.              |

## How a stack behaves

- **Ports.** Docker assigns the services' ports; the launcher picks free
  ports for the apps and uses the same ones on the next run while they are
  free, so URLs open elsewhere keep working.
- **State.** Each stack's ports and Compose variables are kept in
  `~/.local/state/devenv/stacks/<project>.json` (under `$XDG_STATE_HOME` when
  that is set), not in the checkout. So the credentials are in no workspace,
  and a stack can still be found after its checkout is gone.
- **Stopping.** One signal stops every app and whatever each started; what
  has not stopped ten seconds later is killed. Any app stopping stops the
  stack.
- **Tests.** Each run has a Compose project of its own, removed when the run
  ends, on Ctrl-C too. A run that was killed outright is cleaned up by the
  next one.

## Tailscale

`devenv dev --tailscale` serves every app port that is not `internal` as
`https://<machine>.<tailnet>.ts.net:<port>`. Those are the app URLs for the
run, on this machine too.

Once per tailnet and machine:

- Enable HTTPS certificates on the tailnet's
  [DNS page](https://login.tailscale.com/admin/dns).
- On Linux, allow your user to serve: `sudo tailscale set --operator=$USER`.

The first request to a new name can take half a minute while its certificate
is issued. The entries disappear when the launcher stops; nothing here ever runs
`tailscale serve reset`, which would wipe every project's entries.

Everyone who can reach this machine on the tailnet reaches the stack. For a
Vite dev server the launcher sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, so
it accepts the tailnet name without a config change.

## Every stack on the machine

`devenv list` shows each stack with its checkout and whether it is running,
stopped or orphaned. A stack is orphaned once its checkout is gone, which
happens when a worktree is deleted without `devenv reset`: its containers and
volumes stay in Docker with nothing left to manage them.

`devenv prune` lists the orphans and, after a yes, removes them with their
data. A checkout that was moved, or sits on a disk that is not mounted, looks
the same as a deleted one, so read the list before agreeing. Without a
terminal it removes nothing unless given `--yes`.

## Under a sandbox

An agent that runs commands in a sandbox needs two things allowed for the
launcher: the Docker socket, and writing to `~/.local/state/devenv`. Without
the second, a command stops before starting anything and names the directory.

## Working on this package

```sh
git config core.hooksPath .githooks   # once per clone
pnpm check && pnpm test
```

`skills/use-devenv` describes the launcher to agents in the projects that use
it. Change it together with the behaviour it describes.

Projects install this repository as it is, and Node runs no TypeScript under
`node_modules`, so `dist/` is committed. The pre-commit hook builds and stages
it with every commit.
