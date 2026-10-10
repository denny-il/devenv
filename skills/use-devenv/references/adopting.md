# Adopting devenv in a project

The launcher has one way of doing things, and the project adapts to it. This
is what has to be true of the project, then the steps to get there.

## What the project must look like

**Compose files**

- A base file with the services, plus one overlay for `dev` and, if tests need
  services, one for `test`.
- Services publish on loopback ports that Docker assigns. In the overlays:

  ```yaml
  services:
    postgres:
      ports:
        - target: 5432
          host_ip: 127.0.0.1
  ```

  A fixed host port (`"5432:5432"`) makes two worktrees collide and opens the
  service to the network.

- Readiness is a `healthcheck`. A service without one counts as ready as soon
  as it runs. For Postgres, check over TCP, because the image answers on its
  socket during a temporary first start: `pg_isready -h 127.0.0.1 -U <user>`.
- Jobs that run once and exit (create a bucket, load a fixture) are ordinary
  services listed in `compose.init`. They must be safe to run on every start.
- Variables come from `compose.env`: write `${POSTGRES_USER}` in the file and
  give the value in the config, so there is one place that knows it.
- The test overlay should keep nothing: `tmpfs` for data directories, and
  `volumes: !reset []` to drop the base file's named volumes.
- A top-level `name:` is ignored; the launcher names the project.

**Apps**

- Each app takes its port from an environment variable and listens on
  `127.0.0.1`.
- Each app reads the URLs of the other apps and services from the
  environment, with no fallback to a fixed local port.

## Steps

1. Install it as a dev dependency, as described under
   [Installing the package](#installing-the-package), and add a script:
   `"local": "devenv"`.
2. Move published ports out of the base Compose file into the `dev` overlay,
   as loopback ports Docker assigns. Add healthchecks.
3. Write `devenv.config.ts`: `name`, `compose`, then `env` built from
   `service(...)` and `vars`. Run `devenv up` and `devenv status`; fix until
   the services start and `devenv run -- <a migration or query>` works.
4. Add the apps one at a time, each with the variables that set its port and
   host. Run `devenv dev` and open the printed URLs.
5. Move migration and seed commands into `setup`.
6. If tests need services, add the `test` overlay and section and run
   `devenv test`.
7. Replace the project's old instructions (fixed ports, manual
   `docker compose` commands) with the launcher's commands.

## Installing the package

```sh
pnpm add -D github:denny-il/devenv
```

The repository is private, and pnpm reaches GitHub over HTTPS whatever the
specifier looks like: `github:`, `https://` and `git+ssh://` forms all resolve
the same way, and the lockfile records an HTTPS URL. On a machine that is not
prepared, the install fails with:

```
Failed to resolve git dependency "github:denny-il/devenv": git ls-remote failed:
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

Trying other specifier forms does not help. The remedy is in Git, not in the
specifier:

- **The machine needs an SSH key with access to the repository.** Check with
  `ssh -T git@github.com`. Without one, stop and tell the user.
- **Git must be told to reach GitHub over SSH.** The lasting form is
  `git config --global url."git@github.com:".insteadOf https://github.com/`.
  It is machine-wide, sending every HTTPS GitHub URL that Git touches over
  SSH, so it is the user's decision: suggest it, do not set it.
- **For your own command, pass the rule through the environment**, which
  changes nothing on the machine:

  ```sh
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0='url.git@github.com:.insteadOf' \
  GIT_CONFIG_VALUE_0='https://github.com/' \
  pnpm add -D github:denny-il/devenv
  ```

A missing rule can stay hidden: once the package is in pnpm's store,
`pnpm install --frozen-lockfile` passes without it. It fails when GitHub must
be reached again, on a fresh machine, after the store is pruned, or when
moving to a newer commit. An install that works on one machine is therefore no
proof that the next machine, or CI, is prepared.

To move to the newest commit of the package, run
`pnpm update @denny-il/devenv`. A plain `pnpm install` keeps the commit the
lockfile records.

## What it does not do

Work around these in the project, not in the config.

- **Fixed host ports.** Everything is assigned; nothing can be pinned.
- **Compose profiles.** Only services outside of profiles are started. A
  service in a profile runs only if it is listed in `compose.init`.
- **Containers that call apps on the host.** App ports are not known when the
  services start, and the apps listen on loopback only, which a container
  cannot reach.
- **Bind-mounted data.** `reset` removes named volumes, not a directory such
  as `./storage`. Use a named volume for data that `reset` should clear.
- **Access from other devices except over Tailscale.** There is no option to
  listen on the LAN.
