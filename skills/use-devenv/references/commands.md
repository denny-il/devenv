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
| `devenv dev [--tailscale]`          | Starts the services, runs `setup`, runs every app until one stops.                   |
| `devenv status`                     | Lists the containers, the app URLs and the project's `info` lines.                   |
| `devenv run -- <command>`           | Runs a command with the stack's environment.                                         |
| `devenv test [-- <args>]`           | Runs the tests on a fresh stack that is always removed.                              |
| `devenv down`                       | Stops the services; keeps volumes, credentials and app ports.                        |
| `devenv reset`                      | Removes containers, volumes, built images, the state, and killed test runs' stacks.  |
| `devenv list`                       | Shows every stack on this machine.                                                   |
| `devenv prune [--yes]`              | Removes the stacks whose checkout is gone, with their data.                          |
| `devenv setup [docker] [tailscale]` | Installs and sets up Docker and Tailscale on this machine; both unless one is named. |
| `devenv tailnet info [--json]`      | Prints this machine's tailnet name and what keeps it from serving.                   |
| `devenv tailnet serve <port>…`      | Serves local ports to the tailnet over HTTPS until stopped.                          |

## How a stack starts

`dev` does these in order, and stops at the first that fails:

1. Starts the Compose services and waits until each is healthy.
2. Runs the `compose.init` services, each to its end.
3. Reserves a port for every app port, the same ones as last time while they
   are free.
4. With `--tailscale`, serves the app ports to the tailnet.
5. Runs the `setup` commands.
6. Starts the apps in config order and prints the URLs.

The URLs are printed as soon as the apps are started, which is before they
answer. Wait for an app's own "listening" line, or poll its URL.

## How a stack stops

- Ctrl-C, SIGTERM or a closed terminal stops every app and whatever each
  started. What has not stopped ten seconds later is killed. A second signal
  kills at once.
- Any app exiting stops the whole stack.
- `dev` exits 0 when it was stopped by a signal, and otherwise with the exit
  status of the app that stopped the stack.
- The services keep running after `dev` ends. `down` stops them.

## `run`

- Needs a started stack: run `up` or `dev` first. After `down` it refuses.
- The command gets the environment from the project's `env` function, on top
  of the root `.env`, with `node_modules/.bin` of the root on `PATH`.
- It does not get an app's own `env` (its port, say); that belongs to `dev`.
- The exit status is the command's.

## `test`

- Uses the base Compose files plus the `test` overlay, under a Compose project
  made for this run. `dev` and `test` can run at the same time.
- Runs `test.setup`, then `test.command`. Arguments after `--` are added to a
  plain command; a function command receives them and decides.
- The stack is removed on success, failure and Ctrl-C, with the images
  Compose built for it; the next run builds them again from the build cache.
  A run that was killed outright is cleaned up by the next `devenv test` in
  the same worktree, by `reset`, or, once the checkout is gone, by `prune` if
  the checkout had a `dev` stack.
- The exit status is the test command's, or 130 after Ctrl-C.

## `list` and `prune`

- `list` prints every stack on the machine: its Compose project, whether it
  is `running`, `stopped` or `orphaned`, and its checkout.
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
  path, published service ports, app ports, and the Compose variables it was
  created with. `$XDG_STATE_HOME` replaces `~/.local/state` when set. Nothing
  is written into the checkout.
- A command that cannot write there stops before it starts anything.
- Compose projects are named `<name>-local-<id>` and
  `<name>-test-<id>-<pid>-<run>`, where `<id>` is derived from the checkout's
  path. Moving or copying a checkout therefore starts a new, empty stack.
