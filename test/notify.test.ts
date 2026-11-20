import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import notifyExtension, { detectProtocol, FocusTracker, notificationSequences, preferredChannel, resolveChannel, sanitize } from "../extensions/notify/index.ts";
import { readClaudeSetup } from "../extensions/shared/claude.ts";

const TERMINAL_VARS = ["CLAUDE_CONFIG_DIR", "TERM_PROGRAM", "TERM", "TMUX", "WT_SESSION", "KITTY_WINDOW_ID", "ITERM_SESSION_ID", "LC_TERMINAL"];
const savedEnv = Object.fromEntries(TERMINAL_VARS.map((name) => [name, process.env[name]]));
let base: string;
let project: string;

function write(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-notify-"));
	project = path.join(base, "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	for (const name of TERMINAL_VARS) delete process.env[name];
	process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

/** Loads the extension with a fake pi, starts a terminal session and returns a way to end a run,
 * the terminal input listener, and everything written to the terminal. */
async function start(mode = "tui", cancel = false) {
	const handlers = new Map<string, Handler>();
	const emitted: unknown[] = [];
	let input: ((data: string) => unknown) | undefined;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getSessionName: () => "auth fix",
		events: {
			emit: (_name: string, data: { cancel: boolean }) => {
				emitted.push({ ...data });
				data.cancel = cancel;
			},
		},
	};
	const ctx = {
		mode,
		cwd: project,
		isProjectTrusted: () => true,
		ui: {
			onTerminalInput: (handler: typeof input) => {
				input = handler;
				return () => {
					input = undefined;
				};
			},
		},
	};
	const output: string[] = [];
	const original = process.stdout.write;
	const capture = async (run: () => Promise<void>) => {
		process.stdout.write = ((chunk: string) => {
			output.push(chunk);
			return true;
		}) as never;
		try {
			await run();
		} finally {
			process.stdout.write = original;
		}
	};
	notifyExtension(pi as never);
	await capture(() => handlers.get("session_start")!({}, ctx));
	return {
		output,
		emitted,
		input: (data: string) => input?.(data),
		settle: (aborted = false) => capture(() => handlers.get("agent_settled")!({ aborted }, ctx)),
		shutdown: () => capture(() => handlers.get("session_shutdown")!({}, ctx)),
	};
}

describe("notification channel", () => {
	it("follows Claude's preferredNotifChannel", () => {
		const env = { TERM_PROGRAM: "ghostty" };
		assert.deepEqual(resolveChannel(undefined, env), { protocol: "osc777", bell: false });
		assert.deepEqual(resolveChannel("auto", env), { protocol: "osc777", bell: false });
		assert.deepEqual(resolveChannel("terminal_bell", env), { bell: true });
		assert.deepEqual(resolveChannel("iterm2_with_bell", env), { protocol: "osc9", bell: true });
		assert.deepEqual(resolveChannel("kitty", env), { protocol: "osc99", bell: false });
		assert.deepEqual(resolveChannel("notifications_disabled", env), { bell: false });
	});

	it("sends nothing on auto in terminals Claude doesn't notify in", () => {
		assert.equal(detectProtocol({ TERM_PROGRAM: "vscode" }), undefined);
		assert.equal(detectProtocol({ TERM_PROGRAM: "Apple_Terminal" }), undefined);
		assert.equal(detectProtocol({ TERM_PROGRAM: "rex", KITTY_WINDOW_ID: "1" }), undefined);
		assert.equal(detectProtocol({ TERM_PROGRAM: "iTerm.app" }), "osc9");
		assert.equal(detectProtocol({ KITTY_WINDOW_ID: "1" }), "osc99");
		assert.equal(detectProtocol({ WT_SESSION: "x" }), "toast");
	});

	it("reads the setting from the highest-precedence file, then ~/.claude.json", () => {
		const home = path.join(base, "home");
		const read = () => preferredChannel(readClaudeSetup({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") }));
		assert.equal(read(), undefined);
		write(path.join(home, ".claude.json"), { preferredNotifChannel: "kitty" });
		assert.equal(read(), "kitty");
		write(path.join(home, ".claude", "settings.json"), { preferredNotifChannel: "terminal_bell" });
		write(path.join(project, ".claude", "settings.local.json"), { preferredNotifChannel: "notifications_disabled" });
		assert.equal(read(), "notifications_disabled");
	});
});

describe("notification sequences", () => {
	it("keeps text from ending the sequence or adding OSC 777 fields", () => {
		assert.equal(sanitize("a;b\x07c\x1b]d"), "a b c ]d");
	});

	it("writes each protocol, wrapped for tmux when inside it", () => {
		assert.deepEqual(notificationSequences("osc777", "Pi", "Ready", {}), ["\x1b]777;notify;Pi;Ready\x07"]);
		assert.deepEqual(notificationSequences("osc9", "Pi", "Ready", {}), ["\x1b]9;Pi: Ready\x07"]);
		assert.deepEqual(notificationSequences("osc99", "Pi", "Ready", {}), ["\x1b]99;i=1:d=0;Pi\x1b\\", "\x1b]99;i=1:p=body;Ready\x1b\\"]);
		assert.deepEqual(notificationSequences("osc9", "Pi", "Ready", { TMUX: "/tmp/tmux" }), ["\x1bPtmux;\x1b\x1b]9;Pi: Ready\x07\x1b\\"]);
	});
});

describe("focus", () => {
	it("tracks focus reports and keeps them out of the editor", () => {
		const focus = new FocusTracker();
		assert.equal(focus.away, true);
		assert.equal(focus.handle("abc"), undefined);
		assert.deepEqual(focus.handle("\x1b[I"), { consume: true });
		assert.equal(focus.away, false);
		assert.deepEqual(focus.handle("\x1b[Ox"), { data: "x" });
		assert.equal(focus.away, true);
		focus.handle("\x1b[O\x1b[I");
		assert.equal(focus.away, false);
	});
});

describe("notify extension", () => {
	it("notifies when a run settles while you're away, and not while you watch", async () => {
		process.env.TERM_PROGRAM = "ghostty";
		const session = await start();
		assert.deepEqual(session.output, ["\x1b[?1004h"]);
		await session.settle();
		assert.deepEqual(session.output.slice(1), ["\x1b]777;notify;Pi (auth fix);Ready for input\x07"]);
		session.input("\x1b[I");
		await session.settle();
		assert.equal(session.output.length, 2);
		session.input("\x1b[O");
		await session.settle(true);
		assert.equal(session.output.length, 2, "Esc means you're there");
		await session.shutdown();
		assert.equal(session.output.at(-1), "\x1b[?1004l");
	});

	it("rings the bell in any terminal with terminal_bell, and lets other extensions cancel", async () => {
		process.env.TERM_PROGRAM = "vscode";
		write(path.join(base, "claude", "settings.json"), { preferredNotifChannel: "terminal_bell" });
		const session = await start();
		await session.settle();
		assert.deepEqual(session.output, ["\x1b[?1004h", "\x07"]);
		assert.deepEqual(session.emitted, [{ title: "Pi (auth fix)", body: "Ready for input", cancel: false }]);
		const cancelled = await start("tui", true);
		await cancelled.settle();
		assert.deepEqual(cancelled.output, ["\x1b[?1004h"]);
	});

	it("stays quiet where Claude would, and outside the terminal UI", async () => {
		process.env.TERM_PROGRAM = "vscode";
		const vscode = await start();
		await vscode.settle();
		assert.deepEqual(vscode.output, []);
		process.env.TERM_PROGRAM = "ghostty";
		const print = await start("print");
		await print.settle();
		assert.deepEqual(print.output, []);
	});
});
