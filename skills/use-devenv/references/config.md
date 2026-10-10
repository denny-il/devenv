# Config

`devenv.config.ts` (or `.js`) in the project root. It is plain TypeScript that
Node runs as it is, so it may read `process.env`, which already includes the
root `.env`, and compute anything.

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
  },

  info: () => ({ "Sign-in": "admin@shop.local / admin" }),
});
```

## Fields

| Field           | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `name`          | Start of the Compose project names. Lowercase letters, digits, `-`, `_`.         |
| `compose.files` | Compose files of every mode, relative to the root.                               |
| `compose.dev`   | Overlays added for `up` and `dev`.                                               |
| `compose.test`  | Overlays added for `test`.                                                       |
| `compose.init`  | Services that do a job and exit. Each runs to its end once the others are ready. |
| `compose.env`   | Variables for the Compose files (`${POSTGRES_USER}`).                            |
| `apps`          | The host apps, started by `dev` in this order.                                   |
| `env`           | A function from the stack to the variables every app and command gets.           |
| `setup`         | Commands `dev` runs once the services are up, before the apps.                   |
| `test`          | `setup` commands, the test `command`, and extra `env` for `devenv test`.         |
| `info`          | A function returning lines to print under the URLs, such as a seeded sign-in.    |

A command is a line for the shell (`"pnpm database migrate"`), or a list of a
program and its arguments, which runs without a shell.

An environment value may be a string or a number. A value of `undefined`
unsets the variable, even if the root `.env` sets it.

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

## The context

`env`, `info` and each app's `env` (as its second argument) receive:

| Member                       | What it is                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `service(name).port(target)` | The loopback port Docker published a service's port on.            |
| `port(ref)`                  | An app's port: `"api.proxy"`, or `"web"` for an app with one port. |
| `url(ref)`                   | The origin that port answers at.                                   |
| `vars`                       | `compose.env` as the stack uses it.                                |
| `project`                    | The stack's Compose project name, unique per worktree.             |
| `root`                       | The project root.                                                  |
| `tailnet`                    | This machine's tailnet name under `dev --tailscale`, else unset.   |

- `service(name)` takes the service's name from the Compose file. Nothing
  about services is declared in the config: the launcher reads every published
  port after starting them.
- `url(ref)` is `http://localhost:<port>`, or `https://<tailnet>:<port>` under
  `--tailscale`. Build every URL an app is told from it, so the same config
  works in both modes. For a path, append it: `` `${url("api.proxy")}/api` ``.
- Asking for a service, port or app that does not exist throws with the names
  that do.

## Things that surprise

- **`compose.env` is fixed when the stack is first started.** A database
  volume keeps the login it was initialized with, so the launcher keeps using
  the original values and warns when the config's have changed. `devenv reset`
  applies new ones, with empty data.
- **`url()` and `port()` work without running apps.** `up` and `test` assign
  app ports too, so the URLs in `env` are valid values under `run` and `test`,
  even when nothing listens on them.
- **Sessions leak between worktrees unless cookies are named per stack.**
  Browsers share cookies across ports of one host. Pass `project` to the app
  as a cookie prefix when two worktrees must stay signed in separately.
- **Types are the only validation.** A wrong shape fails where it is used, so
  run a type check over the config after changing it.
