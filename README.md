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

pnpm resolves GitHub repositories over HTTPS. While this one is private, let
Git reach GitHub over SSH instead, once per machine:

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

```jsonc
// package.json
{ "scripts": { "local": "devenv" } }
```

## Commands

| Command                   | What it does                                                                    |
| ------------------------- | ------------------------------------------------------------------------------- |
| `devenv up`               | Starts this worktree's services.                                                |
| `devenv dev`              | Starts the services, runs `setup`, then runs every app until one stops.         |
| `devenv dev --tailscale`  | The same, with the apps served to this machine's tailnet over HTTPS.            |
| `devenv status`           | Shows the services and the app URLs.                                            |
| `devenv run -- <command>` | Runs a command with the stack's environment.                                    |
| `devenv test [-- <args>]` | Runs the tests on a fresh stack of their own, always removed afterwards.        |
| `devenv down`             | Stops the services and keeps their volumes.                                     |
| `devenv reset`            | Stops the services and deletes this worktree's volumes, images and state.       |
| `devenv tailnet info`     | Shows this machine's tailnet name and what keeps it from serving, if anything.  |
| `devenv tailnet serve`    | Serves the given local ports to the tailnet until stopped, without any project. |

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
- **State.** `.dev/devenv/state.json` holds the ports and the Compose
  variables. The directory ignores itself in Git.
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
is issued. The entries disappear with the launcher; nothing here ever runs
`tailscale serve reset`, which would wipe every project's entries.

Everyone who can reach this machine on the tailnet reaches the stack. For
projects with a Vite dev server:

- The launcher lets Vite accept the tailnet name
  (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`); no config change is needed.
- Vite serves workspace files to whoever reaches it. Deny the state file in
  the project's Vite config, `server.fs.deny: ['**/.dev/**', ...]`, restating
  Vite's own defaults, which a custom list replaces.

## Working on this package

```sh
git config core.hooksPath .githooks   # once per clone
pnpm check && pnpm test
```

Projects install this repository as it is, and Node runs no TypeScript under
`node_modules`, so `dist/` is committed. The pre-commit hook builds and stages
it with every commit.
