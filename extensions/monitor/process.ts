/**
 * Runs a monitor's command with stdout and stderr apart, since only stdout lines are events, in the
 * shell pi's bash tool uses. pi's own bash operations hand both streams to one callback, so the
 * process is spawned here, in its own process group, and stopping it ends everything it started.
 *
 * Based on pi-code's monitor extension and process-tree helper by ilovepixelart (MIT; see
 * THIRD_PARTY_NOTICES.md).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** Kills a detached child and everything it spawned: `sh -c 'a; b'` forks, and signalling the shell
 * alone would leave a grandchild holding the pipes open. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
	if (platform === "win32") {
		// Windows has no process groups: taskkill /T ends the whole tree. By absolute path, so a
		// writable PATH entry can't stand in for it.
		const taskkill = join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "taskkill.exe");
		if (child.pid) spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill(signal));
		else child.kill(signal);
		return;
	}
	try {
		// A negative pid targets the whole process group, which `detached` gave the child
		if (child.pid) {
			process.kill(-child.pid, signal);
			return;
		}
	} catch {
		// The group is already gone; fall through to the direct kill
	}
	try {
		child.kill(signal);
	} catch {
		// already gone
	}
}

export interface SplitRun {
	cwd: string;
	shellPath: string | undefined;
	env: NodeJS.ProcessEnv | undefined;
	/** Aborting it ends the command's process tree. */
	signal: AbortSignal;
	onStdout: (data: Buffer) => void;
	onStderr: (data: Buffer) => void;
}

/** Runs `command` with stdout and stderr apart. Resolves with the exit code once both streams have
 * closed, and rejects for a command that could not start. */
export function execSplit(command: string, run: SplitRun): Promise<number> {
	return new Promise((resolve, reject) => {
		if (!existsSync(run.cwd)) throw new Error(`Working directory does not exist: ${run.cwd}`);
		const shell = getShellConfig(run.shellPath);
		const fromStdin = shell.commandTransport === "stdin";
		// Its own process group off Windows, so the kill reaches what the shell spawned
		const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
			cwd: run.cwd,
			env: run.env,
			detached: process.platform !== "win32",
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		const kill = (): void => killProcessTree(child, "SIGKILL");
		if (run.signal.aborted) kill();
		else run.signal.addEventListener("abort", kill, { once: true });
		child.stdout?.on("data", run.onStdout);
		child.stderr?.on("data", run.onStderr);
		child.once("error", reject);
		// A process the shell forked while the kill was landing survives it and holds the pipes open, so
		// 'close' would never come: once the stopped shell is gone, end what is left of its group and let
		// go of the pipes. Not on Windows, where the shell's pid may already belong to another process.
		child.once("exit", () => {
			if (!run.signal.aborted) return;
			if (process.platform !== "win32") kill();
			child.stdout?.destroy();
			child.stderr?.destroy();
		});
		child.once("close", (code, signal) => {
			run.signal.removeEventListener("abort", kill);
			// A shell ended by a signal has no exit code: the shell convention stands in
			resolve(code ?? 128 + (signal ? osConstants.signals[signal] : 0));
		});
	});
}
