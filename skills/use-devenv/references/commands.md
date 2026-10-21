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
| `devenv up`                         | Starts the services and assigns the app ports.                                       |
| `devenv start [--tailscale]`        | Starts the services, runs `setup`, runs every app until one stops.                   |
| `devenv stop`                       | Stops this worktree's running `start` and waits until it has ended.                  |
| `devenv restart [--tailscale]`      | Stops this worktree's running `start`, if any, and starts again in its place.        |
| `devenv status`                     | Lists the containers, whether `start` runs, the app URLs and the `info` lines.       |
| `devenv run -- <command>`           | Runs a command with the stack's environment.                                         |
| `devenv test [-- <args>]`           | Runs the tests on a fresh stack that is always removed.                              |
| `devenv down`                       | Stops the services; keeps volumes, credentials and app ports.                        |
| `devenv reset`                      | Removes containers, volumes, built images, the state, and killed test runs' stacks.  |
| `devenv list`                       | Shows every stack on this machine.                                                   |
| `devenv prune [--yes]`              | Removes the stacks whose checkout is gone, with their data.                          |
| `devenv setup [docker] [tailscale]` | Installs and sets up Docker and Tailscale on this machine; both unless one is named. |
| `devenv tailnet info [--json]`      | Prints this machine's tailnet name and what keeps it from serving.                   |
| `devenv tailnet serve <port>…`      | Serves local ports to the tailnet over HTTPS until stopped.                          |

`devenv dev`, the name of `start` before 0.5.0, now fails with a message
naming `start`.

## Host-only stacks

When `compose` is omitted, or all its file lists are empty, all stack commands
skip Docker. `up` prepares app ports and enables `run`; `start` runs setup and
apps, including optional Tailscale serving. `status` prints assigned URLs,
not app liveness. `down` marks the stack stopped while preserving ports;
`reset` removes state, not files the apps wrote on the host. Stop `start` with
`devenv stop` or a signal to stop its app processes; neither `down` nor
`reset` stops them. `test` runs its setup and command with fresh
ports and a separate context, without launching apps or services.

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

## How a stack starts

`start` prints `Stack <name> (pid <pid>)`, then does these in order, and
stops at the first that fails:

1. Starts any Compose services and waits until each is healthy.
2. Runs any `compose.init` services, each to its end.
3. Reserves a port for every app port, the same ones as last time while they
   are free.
4. With `--tailscale`, serves the app ports to the tailnet.
5. Runs the `setup` commands.
6. Starts the apps in config order, each without waiting for the one
   before it.
7. Waits until every app with a `ready` check answers, then prints
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
  every process of every app, whatever the launcher received: package
  managers' script runners report an app that SIGTERM ended as a failed
  command. What is still running
  in an app's process group ten seconds later is killed, even once the app's
  command has exited, so a server finishing its own cleanup is not cut
  short. A second signal kills at once.
- A process an app moved into a process group of its own is the app's to
  stop; the launcher reaches only the app's group.
- Any app exiting stops the whole stack, with a line naming it.
- Once every app has stopped, it prints `Stopped (<signal>): <apps>`, or
  `Stopped: <apps>` when an app stopped the stack, so the end of the output
  states the outcome. Lines an app's wrapper prints after that are not.
- `start` exits 0 when it was stopped by a signal, including during setup or
  while waiting for readiness, and otherwise with the exit status of the app
  that stopped the stack, or 1 for a failed start.
- Any Compose services keep running after `start` ends. `down` stops them.
  The prepared environment remains usable by `run` until `down` or `reset`.

## `stop` and `restart`

- `start` records its PID in the stack's state, and `status` shows it while
  it runs. A second `start` for the same worktree refuses to run while one
  is, and so does `reset`, which would leave its apps running unfound.
- `stop` sends that `start` SIGINT, as Ctrl-C would, and returns once it has
  ended, which takes until its apps have stopped: at most the grace period.
  It finds the right process in each worktree, as each has its own state.
  With no `start` running, it exits 1.
- `restart` stops the running `start`, if any, then runs `start` itself, in
  the foreground: run it in the background like `start` and wait for
  `Ready:` again. It serves over Tailscale when given `--tailscale` or when
  the `start` it stopped did.
- A `start` stopped before its apps run, while starting the services say,
  ends at once, without the closing `Stopped` line.

## `run`

- Needs a started stack: run `up` or `start` first. After `down` it refuses.
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
  A run that was killed outright is cleaned up by the next `devenv test` in
  the same worktree, by `reset`, or, once the checkout is gone, by `prune` if
  the checkout had a `start` stack.
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
