# Tailscale and machine setup

## `devenv dev --tailscale`

Serves every app port that is not `internal` as
`https://<machine>.<tailnet>.ts.net:<port>`, with the same port number as
locally. The apps keep listening on `127.0.0.1`; Tailscale forwards to them.

- Those are the app URLs for the whole run, on this machine too. `url()` in
  the config returns them, so apps are configured with the tailnet origins.
  One run uses one host name: mixing `localhost` and the tailnet name breaks
  cookies and baked-in API URLs.
- Serving starts before `setup` and the apps, so a missing permission or a
  port already served fails at once.
- The entries exist only while `dev` runs. Nothing is left to clean up,
  unless the launcher is killed outright (`kill -9`): then its apps and its
  `tailscale serve` processes keep running until they are stopped by hand.
- The first request to a name can take about half a minute, while its
  certificate is issued.
- Until an app has started, its URL answers 502.

Everyone who can reach the machine on the tailnet, including users it is
shared with, reaches the stack. Turn it on when the user asks for access from
another device, not by default.

Never run `tailscale serve reset`: the serve configuration is shared by the
whole machine, and that command wipes every project's entries.

## `devenv setup`

Checks what a stack needs on this machine, installs what is missing, and
prints one line per requirement. `devenv setup docker` or
`devenv setup tailscale` does one of the two. It changes nothing that is already in place,
so run it again until every line is checked.

- **Linux:** installs Docker and Tailscale with their own install scripts,
  starts both services, adds the user to the `docker` group, signs in to
  Tailscale, and makes the user Tailscale's operator. It asks for the sudo
  password, so run it in a terminal the user can type in.
- **macOS:** installs Docker Desktop and Tailscale with Homebrew, and prints
  the rest (open both apps, sign in) as steps for the user.
- **Left to a person everywhere:** enabling HTTPS certificates for the
  tailnet, and logging out and back in after joining the `docker` group.

## Prerequisites, once per tailnet and machine

- HTTPS certificates enabled on the tailnet's DNS page:
  https://login.tailscale.com/admin/dns
- On Linux, the user allowed to serve:
  `sudo tailscale set --operator=$USER`

`devenv tailnet info` reports whether certificates are on. A missing operator
permission shows only when serving is tried, or in `devenv setup tailscale`.

## Failure messages

| Message                                       | Meaning and remedy                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Tailscale is not connected`                  | Run `tailscale up`, or `devenv setup`.                                                      |
| `HTTPS certificates are off for this tailnet` | Enable them in the admin console. Only a tailnet admin can.                                 |
| `Tailscale does not let this user serve`      | The operator is not set. Run the `sudo tailscale set --operator=$USER` it prints.           |
| `Port N is already served`                    | Another project, or a leftover `tailscale serve`, holds that port. Stop it and start again. |
| `Tailscale did not start serving port N`      | It did not answer in 15 seconds. Check `tailscale status`.                                  |

## `devenv tailnet serve <port>…`

Serves any local ports the same way without a project, until stopped. Useful
for a server that the launcher does not run.
