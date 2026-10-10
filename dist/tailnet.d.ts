export interface Tailnet {
    host: string | null;
    problems: string[];
}
/**
 * This machine on the tailnet: its name, and what keeps it from serving over
 * HTTPS, each with its remedy. Whether this user may serve shows only when
 * serving is tried.
 */
export declare function inspect(): Promise<Tailnet>;
/** This machine's tailnet name, once nothing found keeps it from serving. */
export declare function tailnetHost(): Promise<string>;
export interface Serving {
    /** Throws if a port cannot be served. */
    start(ports: number[]): Promise<void>;
    stop(): void;
    /** Every port's `tailscale serve` has ended. */
    closed(): Promise<unknown>;
    /** The first served port to stop being served, with why. */
    ended(): Promise<string>;
}
/** Serves ports under `host`, this machine's tailnet name, until `stop()`. */
export declare function createServing(host: string): Serving;
/** `devenv tailnet info [--json]` */
export declare function info(args: string[]): Promise<void>;
/** `devenv tailnet serve <port>...`: serves the ports until stopped. */
export declare function serve(args: string[]): Promise<void>;
