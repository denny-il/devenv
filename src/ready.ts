import { request } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type AppConfig, type Context, defaultPorts } from "./config.ts";

/** Seconds an app with a readiness check has, unless its config says. */
export const defaultReadyTimeout = 300;

export interface Probe {
  port: number;
  /** HTTP when given; else accepting a connection is enough. */
  path?: string;
  /** Milliseconds. */
  timeout: number;
}

/** An app's readiness check on its port in the stack; none without `ready`. */
export function readyProbe(app: string, config: AppConfig, context: Context): Probe | undefined {
  const { ready } = config;
  if (!ready) return undefined;
  const { port, path, timeout = defaultReadyTimeout } = ready === true ? {} : ready;
  if (path !== undefined && !path.startsWith("/"))
    throw new Error(`\`${app}\`'s \`ready.path\` must start with \`/\``);
  if (!(timeout > 0)) throw new Error(`\`${app}\`'s \`ready.timeout\` must be a positive number`);
  const names = Object.keys(config.ports ?? defaultPorts);
  if (port === undefined && names.length !== 1)
    throw new Error(
      `\`${app}\` has several ports; name the one to check in \`ready.port\`: ${names.join(", ")}`,
    );
  try {
    return {
      port: context.port(`${app}.${port ?? names[0]}`),
      ...(path === undefined ? {} : { path }),
      timeout: timeout * 1000,
    };
  } catch (error) {
    throw new Error(`\`${app}\`'s readiness check: ${(error as Error).message}`);
  }
}

/**
 * One attempt, settled within `timeout` milliseconds: `true` when the app
 * is ready, else what it did instead, or nothing when cut short.
 */
function answers(
  { port, path }: Probe,
  timeout: number,
  signal: AbortSignal,
): Promise<true | string | undefined> {
  return new Promise((resolveAnswer) => {
    let timer: NodeJS.Timeout | undefined;
    const settle = (answer: true | string | undefined) => {
      clearTimeout(timer);
      resolveAnswer(answer);
    };
    let attempt: { destroy(): void };
    if (path === undefined) {
      const socket = connect({ host: "127.0.0.1", port, signal });
      socket.once("connect", () => {
        socket.destroy();
        settle(true);
      });
      socket.once("close", () => settle("nothing answered"));
      socket.once("error", () => {});
      attempt = socket;
    } else {
      // No agent: a kept-alive connection would hold on to the app.
      const sent = request({ host: "127.0.0.1", port, path, agent: false, signal }, (res) => {
        // Only the status matters; a body left open would keep the
        // connection, one more for every attempt.
        sent.destroy();
        // Redirects are not followed: one is an answer.
        const status = res.statusCode ?? 0;
        settle(status > 0 && status < 400 ? true : `it answered ${status}`);
      });
      sent.once("error", () => settle("nothing answered"));
      sent.end();
      attempt = sent;
    }
    // Absolute: a socket's own timeout counts only idle time, which an app
    // trickling its answer would keep resetting.
    timer = setTimeout(() => {
      settle(undefined);
      attempt.destroy();
    }, timeout);
  });
}

/**
 * Polls until the app answers, its timeout runs out, or `signal` cancels
 * the wait. A timeout tells what the last attempt got instead.
 */
export async function waitUntilReady(
  probe: Probe,
  signal: AbortSignal,
): Promise<"ready" | "cancelled" | { timeout: string }> {
  const deadline = Date.now() + probe.timeout;
  let last = "nothing answered";
  for (;;) {
    if (signal.aborted) return "cancelled";
    const left = deadline - Date.now();
    if (left <= 0) return { timeout: last };
    const answer = await answers(probe, Math.min(left, 2_000), signal);
    if (answer === true) return "ready";
    // One cut short by the deadline says nothing about the app.
    if (answer !== undefined) last = answer;
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(
      () => {},
    );
  }
}
