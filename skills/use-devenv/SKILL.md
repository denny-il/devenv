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
`pnpm local dev`).

## Working in a project that uses it

- **Start the stack with `devenv dev`.** It starts the services, runs the
  project's setup commands, then runs every app until one stops. It does not
  return, so run it in the background and read its output.
- **Take URLs and ports from what it prints**, or from `devenv status`. They
  are assigned per worktree and differ between checkouts, so a port written
  into code, a script or a test breaks for the next worktree.
- **Run commands that need the stack through `devenv run -- <command>`**:
  migrations, scripts, a database shell. It supplies the same environment the
  apps get, so nothing has to be copied out of the state file.
- **Run configured tests with `devenv test [-- <args>]`.** Each run gets
  fresh services when configured and removes them afterwards; host-only tests
  need no Docker. The `dev` stack and
  its data are not touched.
- **Stop the foreground `dev` process to stop its apps.** `devenv down`
  stops any services and marks the stack stopped, keeping data and app ports.
  `devenv reset` deletes
  this worktree's volumes, built images and state; run it before deleting a
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
`dev`, `up`, `status`, `run`, `test`, `down` and `reset` keep their usual
port and environment behavior. `dev --tailscale` also works; use `url()`
for the browser-facing URLs and `port()` for loopback connections.
`status` shows assigned URLs, not whether apps are listening. `list` reports
host-only stacks as `ready` or `stopped`; list/prune need Docker only when
Compose states are involved. Host files are not deleted by `reset`.

An older state without the host-only marker is still a Compose state. Run
`reset` before starting it with a host-only config; cleanup still needs
Docker even after removing `compose` from that config.

## References

- [Commands](references/commands.md) - what each command does, how a stack
  starts and stops, exit statuses, where state lives.
- [Config](references/config.md) - every field of `devenv.config.ts`, the
  context its functions get, and a full example.
- [Adopting](references/adopting.md) - installing and updating the package,
  what a project's Compose files and apps must look
  like, the steps to move a project onto the launcher, and what it
  deliberately does not do.
- [Tailscale](references/tailscale.md) - `dev --tailscale`, `devenv setup`,
  the one-time prerequisites, and what each failure message means.
