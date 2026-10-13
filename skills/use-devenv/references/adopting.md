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
  `volumes: !reset []` to drop the base file's named volumes. Images it
  builds are removed with each run. Variables only it reads go in
  `test.compose.env`.
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
pnpm add -D @denny-il/devenv
```

To move to a newer version, run `pnpm update @denny-il/devenv`. It stays
within the range in `package.json`, and before 1.0 a range such as `^0.2.0`
covers patch releases only: `pnpm update --latest @denny-il/devenv` goes past
it. A plain `pnpm install` keeps the version the lockfile records.

If an update keeps the older version right after a release, pnpm is holding
the new one back: by default it prefers versions that have been out for a day
(`minimumReleaseAge`). Listing
the package under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` exempts
it; that changes the project's install policy, so suggest it, do not set it.

This skill ships with the package. After an update, install it again with
`npx skills add ./node_modules/@denny-il/devenv`.

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
