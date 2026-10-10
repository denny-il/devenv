import { type Config } from "./config.ts";
import { type Command } from "./process.ts";
/** A project's config, where it is, and its worktree's Compose project. */
export interface Project {
    root: string;
    config: Config;
    name: string;
}
export declare function createProject(root: string, config: Config): Project;
/** `devenv up`: the services alone, and ports for the apps' URLs. */
export declare function up(project: Project): Promise<void>;
/** `devenv dev`: services, setup, then every app until one stops. */
export declare function dev(project: Project, options: {
    tailscale: boolean;
}): Promise<void>;
/** `devenv status` */
export declare function status(project: Project): Promise<void>;
/** `devenv down`, and `devenv reset` with `removeVolumes`. */
export declare function down(project: Project, removeVolumes: boolean): Promise<void>;
/** `devenv run -- <command>` */
export declare function runCommand(project: Project, command: string[]): Promise<void>;
/** Whether a process's command line is this launcher running `test`. */
export declare function isTestLauncher(commandLine: string): boolean;
/** The test command with the arguments given after `devenv test --`. */
export declare function testCommand(command: Command | ((args: string[]) => Command), args: string[]): Command;
/**
 * `devenv test`: runs the test command against a stack of its own, fresh
 * services under a project name for this run alone, on ports Docker assigns,
 * and always removed afterwards. The worktree's `dev` stack and its data are
 * never touched.
 */
export declare function test(project: Project, args: string[]): Promise<void>;
