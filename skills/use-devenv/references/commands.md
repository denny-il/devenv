# Commands

All commands find `devenv.config.ts` (or `.js`) in the current directory or
any directory above it; that directory is the project root. The root `.env` is
loaded first, and variables already set in the environment win over it.

In a git worktree that has no `.env` at its root, the one at the same place in
the main checkout is loaded instead, and a line on stderr names it. A `.env`
in the worktree, even an empty one, is used alone: the two are never merged.
This needs git 2.36 or newer.

`list`, `prune`, `setup` and `tailnet` need no project.

| Command                             | What it does                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `devenv up`                         | Starts the services, runs `compose.init`, assigns the app ports, runs `setup`.       |
| `devenv start [--tailscale]`        | Runs every app of a stack that is up, until one stops.                               |
| `devenv stop`                       | Stops this worktree's running `start`, if any, and waits until it has ended.         |
| `devenv status`                     | Lists the containers, whether `start` runs, the app URLs and the `info` lines.       |
| `devenv run -- <command>`           | Runs a command with the stack's environment.                                         |
| `devenv test [-- <args>]`           | Runs the tests on a fresh stack that is always removed.                              |
| `devenv down`                       | Stops `start`, then the services; keeps named volumes, credentials and app ports.    |
| `devenv reset`                      | Stops `start`; removes containers, volumes, built images, the state, killed tests.   |
| `devenv list`                       | Shows every stack on this machine.                                                   |
| `devenv prune [--yes]`              | Removes the stacks whose checkout is gone, with their data.                          |
| `devenv setup [docker] [tailscale]` | Installs and sets up Docker and Tailscale on this machine; both unless one is named. |
| `devenv tailnet info [--json]`      | Prints this machine's tailnet name and what keeps it from serving.                   |
| `devenv tailnet serve <port>…`      | Serves local ports to the tailnet over HTTPS until stopped.                          |

`devenv restart` no longer exists; it fails with a message naming
`devenv stop`, then `devenv start`.

## Host-only stacks

When `compose` is omitted, or all its file lists are empty, all stack commands
skip Docker and otherwise behave as usual. `status` prints assigned URLs, not
app liveness; `reset` removes state, not files the apps wrote on the host;
`test` runs its setup and command with fresh ports, without launching apps or
services.

`list` reports host-only stacks as `ready` (environment prepared) or
`stopped`. It and `prune` skip Docker when only host-only states are involved.
With only `compose.test` files, the dev stack is still host-only: `start`,
`up`, `status`, `list` and `down` skip Docker. `test`, `reset` and orphan
pruning need Docker for the test resources. Removing the test files keeps
host apps usable without Docker; saved cleanup metadata remains until
`reset` so abandoned test resources can still be found.

Older states still imply Compose and need Docker for cleanup even if the
config has since removed Compose. Run `reset` before switching such a stack
to host-only apps. Unreadable state has an unknown mode: `reset` attempts
Docker cleanup by name. If Docker is unavailable, it resets local state and
warns which project may still have containers or volumes to remove.

## How a stack is prepared

`up` does these in order, stops at the first that fails, and returns:

1. Starts any Compose services and waits until each is healthy.
2. Runs any `compose.init` services, each to its end.
3. Assigns a port to every app port, keeping those the stack already has.
4. Runs the `setup` commands, with the local app URLs: `url()` returns
   `http://localhost:<port>` even while a `start --tailscale` serves the
   apps.

Run it in a new checkout, after changes to the services, their init jobs or
`setup` (pulled migrations, say), after `down`, and after a reboot, when
Docker may not have started the containers again. Running it while `start`
runs keeps the apps' ports and URLs. A failed setup step leaves the stack up,
so `run` can be used to look into it, and `up` runs every step again.

## How a stack starts

`start` needs a stack that is up: before `up`, and after `down`, it refuses
with "The stack is not up: run `devenv up` first". It neither starts nor
checks the services, and does not run `setup`. It prints
`Stack <name> (pid <pid>)`, then does these in order, and stops at the first
that fails:

1. Reserves a port for every app port, the same ones as last time while they
   are free.
2. With `--tailscale`, serves the app ports to the tailnet.
3. Starts the apps in config order, each without waiting for the one
   before it.
4. Waits until every app with a `ready` check answers, then prints
   `Ready: <apps>`, `Started, without a readiness check: <apps>` for the
   others, and the URLs.

While it waits, it prints `Waiting for <apps> to be ready` and no URLs. An
app without a check is only known to have started: it may still be building
or compiling. Wait for its own "listening" line, or poll its URL.

An app with a check fails the start when it exits before it is ready, or is
not ready within its timeout. Either stops the stack with a message naming
the app; the exit status is the app's (1 if that was 0), or 1 after a
timeout.

An app that builds and then serves, such as a production preview, stays one
command: it builds with the app's environment, so URLs baked into the build
are the stack's. Give it a `ready` check so the stack is reported ready only
once it serves.

## How a stack stops

- Ctrl-C, SIGTERM, a closed terminal or `devenv stop` sends one SIGINT to
  each app's process group, as Ctrl-C at a terminal would. Ten seconds later
  whatever is left in the group is killed, even after the app's command
  exited, so a server finishing its own cleanup is not cut short. A second
  signal kills at once.
- A process an app moved into a process group of its own is the app's to
  stop; the launcher reaches only the app's group.
- Any app exiting stops the whole stack, with a line naming it.
- Once every app has stopped, it prints `Stopped (<signal>): <apps>`, or
  `Stopped: <apps>` when an app stopped the stack, so the end of the output
  states the outcome. pnpm 11 prints `[ELIFECYCLE] Command failed` for an
  app it runs that is stopped, when its script shell is dash, as on most
  Linux machines; pnpm 12 does not. When `start` exits 0, it is not a
  failure.
- `start` exits 0 when it was stopped by a signal, including while waiting
  for readiness, and otherwise with the exit status of the app
  that stopped the stack, or 1 for a failed start.
- Any Compose services keep running after `start` ends. `down` stops them
  and removes their anonymous volumes, which no later container gets back.
  The prepared environment remains usable by `run`, and by the next
  `start`, until `down` or `reset`.

## `stop`, and restarting the apps

- `start` records its PID in the stack's state, and `status` shows it while
  it runs. A second `start` for the same worktree refuses to run while one
  is.
- `stop` sends that `start` SIGINT, as Ctrl-C would, and returns once it has
  ended, which takes until its apps have stopped, at most the ten-second
  grace period; it fails if `start` is still running 15 seconds later.
  It finds the right process in each worktree, as each has its own state.
  It ends with ``Stopped `devenv start` (pid <pid>)``. With no `start`
  running, it says so and exits 0. The services keep running.
- After a `kill -9` of `start`, its apps keep running and holding their
  ports, and `stop` finds nothing to stop. Stop them by hand before the next
  `start`, or it gets other ports.
- `status` prints `The stack is stopped.` after `down`, and
  ``No `devenv start` is running; the apps answer here while one runs them:``
  when the stack is up without its apps.
- `down` and `reset` stop a running `start` the same way before they touch
  the services.
- To restart the apps, run `devenv stop`, then `devenv start`; with
  `devenv up` in between when the services, their init jobs or `setup`
  changed. The new `start` gets the same ports, as `stop` waits until the
  old apps have released them.
- The stopped `start` prints its closing `Stopped (SIGINT): <apps>` line,
  and its apps' shutdown output, to its own output, not to `stop`'s.
- Once a running `start` is ready, `status` shows the `info` lines it
  printed, as its environment made them. Before that, and with no `start`
  running, `status` evaluates `info` itself.

## `run`

- Needs a stack that is up: run `up` first. After `down` it refuses. It
  does not need `start`.
- The command gets the environment from the project's `env` function, on top
  of the root `.env`, with `node_modules/.bin` of the root on `PATH`.
- It does not get an app's own `env` (its port, say); that belongs to `start`.
- The exit status is the command's.

## `test`

- Uses the base Compose files plus the `test` overlay, under a Compose project
  made for this run. `start` and `test` can run at the same time.
- Runs `test.setup`, then `test.command`. Arguments after `--` are added to a
  plain command; a function command receives them and decides.
- The stack is removed on success, failure and Ctrl-C, with the images
  Compose built for it; the next run builds them again from the build cache.
  A run that was killed outright, with any `compose.init` job it left
  running, is cleaned up by the next `devenv test` in the same worktree, by
  `reset`, or, once the checkout is gone, by `prune` if the checkout had a
  dev stack.
- The exit status is the test command's, or 130 after Ctrl-C.

## `list` and `prune`

- `list` prints every stack on the machine: its Compose project, whether it
  is `running`, `ready`, `stopped` or `orphaned`, and its checkout.
- A stack is orphaned once its checkout no longer exists, typically a
  worktree deleted without `devenv reset`. Its containers, volumes and built
  images are still in Docker.
- `prune` lists the orphans and asks before removing their containers,
  volumes, network, built images and state. Without a terminal it refuses unless given
  `--yes`.
- A checkout that was moved, or is on a disk not mounted now, is reported as
  orphaned too. Show the user the list; do not pass `--yes` on your own.

## State

- `~/.local/state/devenv/stacks/<project>.json` holds a stack's checkout
  path, published service ports, app ports, the Compose variables it was
  created with, and the PID of a running `start`. `$XDG_STATE_HOME` replaces `~/.local/state` when set. Nothing
  is written into the checkout.
- A command that cannot write there stops before it starts anything.
- Compose projects are named `<name>-local-<id>` and
  `<name>-test-<id>-<pid>-<run>`, where `<id>` is derived from the checkout's
  path. Moving or copying a checkout therefore starts a new, empty stack.
