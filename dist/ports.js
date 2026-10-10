import { createServer } from "node:net";
import { defaultPorts } from "./config.js";
/**
 * Holds a free port until released: `preferred` when it can be had, else any.
 * `preferred` comes from the state file, so anything may be in it.
 */
export function reservePort(preferred) {
    const wanted = typeof preferred === "number" &&
        Number.isInteger(preferred) &&
        preferred > 0 &&
        preferred < 65536
        ? preferred
        : 0;
    return new Promise((resolveReservation, rejectReservation) => {
        const server = createServer();
        // A client that tries the port meanwhile would keep it from being
        // released: closing waits for every open connection.
        server.on("connection", (socket) => socket.destroy());
        server.once("error", (error) => {
            if (wanted)
                resolveReservation(reservePort());
            else
                rejectReservation(error);
        });
        server.listen(wanted, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                rejectReservation(new Error("Failed to reserve a local port"));
                return;
            }
            resolveReservation({
                port: address.port,
                release: () => new Promise((resolveRelease) => server.close(() => resolveRelease())),
            });
        });
    });
}
/**
 * Holds a port for every port of every app: the earlier run's again while
 * they are free, so its URLs (open tabs, a phone's bookmarks) survive a
 * restart.
 */
export async function reserveAppPorts(apps, earlier) {
    const wanted = Object.entries(apps).flatMap(([app, { ports }]) => Object.keys(ports ?? defaultPorts).map((name) => ({ app, name })));
    const settled = await Promise.allSettled(wanted.map(({ app, name }) => reservePort(earlier?.[app]?.ports[name])));
    const held = new Map();
    const reserved = {};
    let failure;
    for (const [index, result] of settled.entries()) {
        const { app, name } = wanted[index];
        if (result.status === "rejected") {
            failure ??= result.reason;
            continue;
        }
        held.set(app, [...(held.get(app) ?? []), result.value]);
        (reserved[app] ??= { ports: {} }).ports[name] = result.value.port;
    }
    const release = async (app) => {
        const reservations = held.get(app) ?? [];
        held.delete(app);
        await Promise.all(reservations.map((reservation) => reservation.release()));
    };
    const releaseAll = async () => {
        await Promise.all([...held.keys()].map(release));
    };
    if (failure) {
        await releaseAll();
        throw failure;
    }
    return { apps: reserved, release, releaseAll };
}
