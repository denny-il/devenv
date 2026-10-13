# devenv

One command for a project's local stack: Docker Compose services, the apps
that run on the host, and, when asked, HTTPS access from every device on a
Tailscale network.

Every checkout gets a stack of its own, so several worktrees of a project run
side by side. Nothing listens beyond this machine.

Linux and macOS, Node 22.18 or newer, Docker Compose 2.24.4 or newer.

## Install

```sh
pnpm add -D @denny-il/devenv
```

```jsonc
// package.json
{ "scripts": { "local": "devenv" } }
```

### Updating

```sh
pnpm update @denny-il/devenv
```

This moves to the newest version the range in `package.json` allows. Before
1.0 a range such as `^0.2.0` covers patch releases only; `--latest` goes past
it.

pnpm prefers versions that have been out for a day, so an update can keep the
older version until then. To get a release at once, exempt the package in the
project's `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@denny-il/devenv"
```

## Agent skill

The package carries a skill for coding agents that work in a project using
the launcher: the commands and their rules, the config, and how to move a
project onto it. Install it from the installed package, and again after an
update:

```sh
npx skills add ./node_modules/@denny-il/devenv
```

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
  command gets, on top of the root `.env`. A git worktree without a `.env`
  gets the main checkout's.

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
    // Compose variables of the test stack alone, over `compose.env`.
    compose: { env: { POSTGRES_PASSWORD: "test" } },
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
| `vars`                       | The Compose variables as the stack uses them.                      |
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
  ends, on Ctrl-C too, with the images built for it. A run that was killed
  outright is cleaned up by the next one, or by `reset`.
- **`.env` in a worktree.** `.env` is not checked out, so a git worktree
  starts without one. Until it has its own, the main checkout's is loaded,
  and a line says so. An empty `.env` in the worktree turns that off.

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
data and built images. A checkout that was moved, or sits on a disk that is not mounted, looks
the same as a deleted one, so read the list before agreeing. Without a
terminal it removes nothing unless given `--yes`.

## Under a sandbox

An agent that runs commands in a sandbox needs two things allowed for the
launcher: the Docker socket, and writing to `~/.local/state/devenv`. Without
the second, a command stops before starting anything and names the directory.

## Working on this package

```sh
pnpm check && pnpm test
```

`skills/use-devenv` describes the launcher to agents in the projects that use
it. Change it together with the behaviour it describes.

Releases are published from a checkout, not by CI. `pnpm publish` runs the
checks and tests and builds `dist/`, which is not committed. The version is
committed only once npm has the package, so a release that fails leaves
nothing behind but a changed `package.json`:

```sh
pnpm version patch --no-git-tag-version   # or minor
pnpm publish --dry-run --no-git-checks
pnpm publish --no-git-checks
git commit -am "chore: release <version>" && git tag v<version>
git push origin main v<version>
```

`.agents/skills/release` gives an agent the same steps, with what to check
first and what to do when one fails.
