---
name: use-devenv
description: "Use when a project runs its local stack with @denny-il/devenv (it has a devenv.config.ts, or a package script that calls `devenv`): starting or stopping the stack, finding app URLs or service ports, running commands or tests that need the database or other services, writing or changing devenv.config.ts, adapting Compose files and apps to it, serving the apps over Tailscale, or setting up Docker and Tailscale on a machine. Read it before starting dev servers or running Docker Compose by hand in such a project."
---

# Use devenv

`@denny-il/devenv` runs a project's whole local stack from one command: its
optional Docker Compose services, the apps that run on the host, and, when asked, HTTPS
access from the machine's Tailscale network. Every checkout gets a stack of its
own, so several worktrees of one project run side by side without sharing
ports, containers or data.

The project describes itself in `devenv.config.ts` at its root. The CLI is
`devenv`. Projects usually wrap it in a package script, so check
`package.json` first and use that form (`"local": "devenv"` means
`pnpm local start`).

A stack has two parts. `devenv up` prepares it: it starts the services, which
keep running under Docker until `devenv down`, and runs the project's setup
commands, then returns. `devenv start` runs the apps in the foreground, and
they stop when it does.

## Working in a project that uses it

- **Prepare the stack with `devenv up`.** It starts any Compose services,
  runs their `compose.init` jobs and the project's `setup` commands
  (migrations, seeds), then returns. Run it once in a new checkout, and again
  after pulling or changing migrations, services or `setup`, and after a
  reboot. It is safe to run while the apps run.
- **Run the apps with `devenv start`.** It runs every app until one stops,
  and refuses with "run `devenv up` first" when the stack is not up. It does
  not return, so run it in the background and read its output. Its first
  line is `Stack <name> (pid <pid>)`. The apps belong to that process: when
  it is stopped or killed, a background task that times out included, the
  apps stop with it, and the services keep running. Start it again with
  `devenv start`.
- **Wait for the stack before using it.** Apps with a readiness check are
  ready once `Ready: <apps>` is printed, with the URLs after it. Apps listed
  under `Started, without a readiness check` may not answer yet: wait for
  their own "listening" line, or poll the URL.
- **Take URLs and ports from what it prints**, or from `devenv status`. They
  are assigned per worktree and differ between checkouts, so a port written
  into code, a script or a test breaks for the next worktree.
- **Run commands that need the stack through `devenv run -- <command>`**:
  migrations, scripts, a database shell. It supplies the same environment the
  apps get, so nothing has to be copied out of the state file.
- **Run configured tests with `devenv test [-- <args>]`.** Each run gets
  fresh services when configured and removes them afterwards; host-only tests
  need no Docker. The `start` stack and
  its data are not touched.
- **Stop the apps with `devenv stop`; restart them with `devenv stop`, then
  `devenv start`.** `stop` finds this worktree's running `start`, stops it as
  Ctrl-C would and waits until its apps are gone, so it never touches another
  worktree's stack, and the ports are free for the next `start`, which gets
  the same URLs. With no `start` running it says so and exits 0. Restart the
  apps after changes they do not pick up on their own, such as a
  build-and-serve app or a backend without a watcher; run `devenv up` in
  between when migrations, services or `setup` changed. The stopped `start`
  prints its closing `Stopped (SIGINT): <apps>` line to its own output.
  `devenv status` says whether `start` is running, its PID and the `info`
  lines it printed. `devenv restart` was removed in 0.7.0.
- **A stopped `start` ends with `Stopped (<signal>): <apps>`**, or
  `Stopped: <apps>` after an app exited, and exits 0 when stopped by a
  signal. Judge the stop by that exit status. pnpm 11 prints
  `[ELIFECYCLE] Command failed` for every app it runs that is stopped, when
  its script shell is dash, as on most Linux machines; with exit status 0
  that is not a failure.
- **`down` and `reset` stop a running `start` first.** `devenv down` then
  stops any services and marks the stack stopped, keeping data and app ports;
  `devenv up` brings it back. `devenv reset` deletes this worktree's
  containers, volumes, built images and state; run it before deleting a
  worktree, or its containers, volumes and images are left behind.
- **Leave Docker Compose to the launcher.** It names the Compose project per
  worktree. A `docker compose down --volumes` typed by hand can hit another
  worktree's data, and a plain `docker compose up` starts a second, unrelated
  stack.
- **Use `--tailscale` only when asked to.** It makes the stack, and whatever
  sign-in the project prefills, reachable by everyone on the tailnet.
- **State lives outside the checkout**, in `~/.local/state/devenv`. It holds
  the services' credentials, so do not print or copy it; ask `status` or `run`
  instead.
- **In a sandbox, ask for access instead of working around it.** The launcher
  needs write access to `~/.local/state/devenv`, and the Docker socket only
  for Compose stacks. When a
  command fails with "Cannot write … allow writing there", ask the user to
  allow that directory; pointing the state somewhere else would start a
  second stack that nothing else knows about.
- **Run `devenv prune` only when asked to.** It deletes the data of stacks
  whose checkout is gone, and a checkout that was merely moved looks the same.

## Host-only projects

Omit `compose`, or use `compose: { files: [] }` without overlays, when every
app runs on the host. No dummy service or Docker installation is needed.
`start`, `up`, `status`, `run`, `test`, `down` and `reset` keep their usual
port and environment behavior. `start --tailscale` also works; use `url()`
for the browser-facing URLs and `port()` for loopback connections.
`status` shows assigned URLs, not whether apps are listening. `list` reports
host app stacks as `ready` or `stopped`. `list` needs Docker for dev stacks
with containers; `prune` also needs it for stacks with Compose-backed tests.
Host files are not deleted by `reset`.

An older state without the host-only marker is still a Compose state. Run
`reset` before starting it with a host-only config; cleanup still needs
Docker even after removing `compose` from that config.

With only `compose.test` files, `start`, `up`, `status`, `list` and `down`
need no Docker; `test`, `reset` and orphan pruning still do. Removing test
Compose files leaves host apps usable and keeps cleanup metadata until
`reset`. Without dev Compose volumes, variables refresh on each startup.
If state is
unreadable, `reset` cannot identify its mode and attempts Docker cleanup.
When Docker is unavailable, it resets local state and warns with the project
name whose Docker resources may need manual cleanup.

## References

- [Commands](references/commands.md) - what each command does, how a stack
  starts and stops, exit statuses, where state lives.
- [Config](references/config.md) - every field of `devenv.config.ts`, the
  context its functions get, and a full example.
- [Adopting](references/adopting.md) - installing and updating the package,
  what a project's Compose files and apps must look
  like, the steps to move a project onto the launcher, and what it
  deliberately does not do.
- [Tailscale](references/tailscale.md) - `start --tailscale`, `devenv setup`,
  the one-time prerequisites, and what each failure message means.
