# Config

`devenv.config.ts` (or `.js`) in the project root. It is plain TypeScript that
Node runs as it is, so it may read `process.env`, which already includes the
root `.env` (the main checkout's, in a git worktree that has none), and
compute anything.

```ts
import { defineConfig } from "@denny-il/devenv";

export default defineConfig({
  name: "shop",

  compose: {
    files: [".infra/compose.yml"],
    dev: [".infra/compose.local.yml"],
    test: [".infra/compose.test.yml"],
    init: ["create-bucket"],
    env: {
      POSTGRES_USER: process.env.POSTGRES_USER || "shop",
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "shop",
    },
  },

  apps: {
    api: {
      command: "pnpm --filter api dev",
      ports: { proxy: {}, worker: { internal: true } },
      env: (ports) => ({
        API_HOST: "127.0.0.1",
        API_PORT: ports.proxy,
        WORKER_PORT: ports.worker,
      }),
    },
    web: {
      command: "pnpm --filter web dev",
      env: (ports) => ({ HOST: "127.0.0.1", PORT: ports.http }),
      ready: { path: "/" },
    },
  },

  env: ({ service, vars, url, project }) => ({
    DATABASE_URL: `postgresql://${vars.POSTGRES_USER}:${vars.POSTGRES_PASSWORD}@127.0.0.1:${service("postgres").port(5432)}/shop`,
    API_URL: `${url("api.proxy")}/api`,
    WEB_URL: url("web"),
    COOKIE_PREFIX: project,
  }),

  setup: ["pnpm database migrate", "pnpm database seed"],

  test: {
    setup: ["pnpm database migrate"],
    command: "pnpm test",
    env: { DATABASE_TESTS: "true" },
    compose: { env: { POSTGRES_PASSWORD: "test" } },
  },

  info: () => ({ "Sign-in": "admin@shop.local / admin" }),
});
```

## Host-only config

`compose` is optional. Omit it, or use `compose: { files: [] }` with no
`dev` or `test` files, for a stack that never needs Docker. App ports,
internal ports, `env`, `setup`, `info` and `--tailscale` work the same way.
`vars` is empty when no Compose variables are configured; `service()` throws
because there are no services. `project` still names a unique stack per
worktree. Build loopback origins with `port()` and public origins with
`url()`.

An empty base list with nonempty mode files still uses Compose in that mode.
With only `compose.test` files, `start`, `up`, `status`, `list` and `down` do
not need Docker. `test`, `reset` and orphan pruning manage Docker resources.

## Fields

| Field              | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `name`             | Start of the stack names. Lowercase letters, digits, `-`, `_`.                   |
| `compose`          | Optional Compose configuration; omitted for host-only stacks.                    |
| `compose.files`    | Compose files of every mode, relative to the root.                               |
| `compose.dev`      | Overlays added for `up` and `start`.                                             |
| `compose.test`     | Overlays added for `test`.                                                       |
| `compose.init`     | Services that do a job and exit. Each runs to its end once the others are ready. |
| `compose.env`      | Variables for the Compose files (`${POSTGRES_USER}`).                            |
| `apps`             | The host apps, started by `start` in this order.                                 |
| `env`              | A function from the stack to the variables every app and command gets.           |
| `setup`            | Commands `up` runs once the services are up, with local URLs.                    |
| `test`             | `setup` commands, the test `command`, and extra `env` for `devenv test`.         |
| `test.compose.env` | Variables for the Compose files of the test stack alone, over `compose.env`.     |
| `info`             | A function returning lines to print under the URLs, such as a seeded sign-in.    |

A command is a line for the shell (`"pnpm database migrate"`), or a list of a
program and its arguments, which runs without a shell.

An environment value may be a string or a number. A value of `undefined`
unsets the variable, even if the root `.env` sets it. `compose.env` and
`test.compose.env` are the exception: there it leaves the variable as the
environment, or `compose.env`, has it.

## Apps and ports

- An app without `ports` has one port named `http`.
- An app declares every port it listens on. The launcher reserves a free one
  for each and hands them to the app's `env` function, which maps them to the
  variables the app reads.
- `internal: true` marks a port that is reserved and remembered but neither
  printed nor served over Tailscale: a worker behind a proxy port, a metrics
  endpoint.
- Reading a port name the app does not have throws, so a typo cannot silently
  unset a variable.
- The app must listen on `127.0.0.1`. Set its host variable in the app's
  `env` instead of trusting a default or the root `.env`.

## Apps and their commands

- `command` is whatever runs the app: a dev server with a watcher, or a
  command that builds and then serves the build. Each app chooses its own,
  so one stack can mix a production preview with dev servers. There is no
  mode setting; to switch an app, change its command.
- Keep a build step in the app's command rather than in `setup`: the command
  gets the app's `env` and ports, so URLs a build bakes in are the stack's.
- Apps start in config order, each without waiting for the one before it.
  There is no ordering between apps; an app that needs another must wait
  for it itself.

## Readiness

`ready` is optional. Without it, an app counts as started once its command
runs, and nothing waits for it.

| Form                         | Ready once                                                 |
| ---------------------------- | ---------------------------------------------------------- |
| `ready: true`                | The app's one port accepts a TCP connection.               |
| `ready: { port: "proxy" }`   | That port accepts a connection; needed with several ports. |
| `ready: { path: "/health" }` | `GET` on that path answers with a status below 400.        |
| `ready: { timeout: 600 }`    | As above, with 600 seconds to get there instead of 300.    |

- The check goes to `127.0.0.1` on the app's port, never through Tailscale.
- `start` prints the URLs only once every app with a check is ready, so a
  slow build delays them; an app that exits first, or runs out of time,
  fails the start and stops the stack.
- A port that accepts connections before the app can answer (a proxy in
  front of a server that is still building, say) is better checked with a
  `path`.
- A watcher's later rebuilds are not checked: readiness is about the start.

## The context

`env`, `info` and each app's `env` (as its second argument) receive:

| Member                       | What it is                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `service(name).port(target)` | The loopback port Docker published a service's port on.            |
| `port(ref)`                  | An app's port: `"api.proxy"`, or `"web"` for an app with one port. |
| `url(ref)`                   | The origin that port answers at.                                   |
| `vars`                       | The Compose variables as the stack uses them.                      |
| `project`                    | The stack's Compose project name, unique per worktree.             |
| `root`                       | The project root.                                                  |
| `tailnet`                    | This machine's tailnet name under `start --tailscale`, else unset. |

- `service(name)` takes the service's name from the Compose file. Nothing
  about services is declared in the config: the launcher reads every published
  port after starting them.
- `url(ref)` is `http://localhost:<port>`, or `https://<tailnet>:<port>` under
  `--tailscale`. Build every URL an app is told from it, so the same config
  works in both modes. For a path, append it: `` `${url("api.proxy")}/api` ``.
- Asking for a service, port or app that does not exist throws with the names
  that do.

## Things that surprise

- **`compose.env` is fixed when dev Compose services first start.** A
  database volume keeps the login it was initialized with, so the launcher
  keeps using the original values and warns when the config's have changed.
  `devenv reset` applies new ones, with empty data. Host-only dev stacks,
  including those with Compose-backed tests, refresh these variables on each
  startup until they first start dev Compose services.
- **A variable only the test overlay reads belongs in `test.compose.env`.**
  In `compose.env` it would change what the `start` stack was created with and
  set off that warning. Under `test`, `vars` holds both.
- **A test stack's images do not outlive the run.** What Compose builds for a
  test run is removed with it, so a service with `build:` and no `image:` is
  built anew for each run and leaves nothing behind. One that also names an
  `image:` is built only when that image is missing, unless it sets
  `pull_policy: build`.
- **`url()` and `port()` work without running apps.** `up` and `test` assign
  app ports too, so the URLs in `env` are valid values under `run` and `test`,
  even when nothing listens on them.
- **Sessions leak between worktrees unless cookies are named per stack.**
  Browsers share cookies across ports of one host. Pass `project` to the app
  as a cookie prefix when two worktrees must stay signed in separately.
- **Types are the only validation.** A wrong shape fails where it is used, so
  run a type check over the config after changing it.
