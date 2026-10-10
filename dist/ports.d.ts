import { type AppConfig } from "./config.ts";
import type { State } from "./state.ts";
export interface Reservation {
    port: number;
    release(): Promise<void>;
}
/**
 * Holds a free port until released: `preferred` when it can be had, else any.
 * `preferred` comes from the state file, so anything may be in it.
 */
export declare function reservePort(preferred?: unknown): Promise<Reservation>;
export interface AppReservations {
    apps: State["apps"];
    /** Frees an app's ports, for the app to take. */
    release(app: string): Promise<void>;
    releaseAll(): Promise<void>;
}
/**
 * Holds a port for every port of every app: the earlier run's again while
 * they are free, so its URLs (open tabs, a phone's bookmarks) survive a
 * restart.
 */
export declare function reserveAppPorts(apps: Record<string, AppConfig>, earlier: State["apps"] | undefined): Promise<AppReservations>;
