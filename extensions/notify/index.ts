/**
 * Notify: a desktop notification or a terminal bell when pi finishes and waits for you, as Claude
 * Code sends when a task completes (https://code.claude.com/docs/en/terminal-config.md).
 *
 * Claude's `preferredNotifChannel` decides how: `auto` (the default) sends a desktop notification in
 * iTerm2 (OSC 9), Kitty (OSC 99), Ghostty and WezTerm (OSC 777) and Windows Terminal (a toast), and
 * nothing elsewhere; `terminal_bell` rings the bell in any terminal; `iterm2`, `iterm2_with_bell`,
 * `kitty` and `ghostty` pick the notification; `notifications_disabled` turns it off. Like Claude, it
 * notifies only when you appear to be away: the terminal reports losing focus, or can't tell. Inside
 * tmux, notifications pass through to the outer terminal (`set -g allow-passthrough on`).
 *
 * Based on pi-notify by ferologics (MIT; see THIRD_PARTY_NOTICES.md), with the channel read from
 * Claude's settings instead of `PI_NOTIFY_PROTOCOL`, focus tracking added, and without the
 * `PI_NOTIFY_SOUND_CMD` hook, which Claude does with Notification hooks.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ClaudeSetup, readClaudeSetup } from "../shared/claude.ts";

export type Protocol = "osc777" | "osc9" | "osc99" | "toast";

/** What a finished run sends: a desktop notification, the bell, both, or nothing. */
export interface Channel {
	protocol?: Protocol;
	bell: boolean;
}

const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/** `preferredNotifChannel` from the highest-precedence settings file, else the value older Claude
 * versions left in `~/.claude.json`. */
export function preferredChannel(setup: ClaudeSetup): unknown {
	let value: unknown;
	for (const file of setup.settings) if (typeof file.preferredNotifChannel === "string") value = file.preferredNotifChannel;
	return value ?? setup.claudeJson?.preferredNotifChannel;
}

/** The notification a terminal supports, or none where Claude's `auto` sends nothing. In Rex, pi
 * reports its own status (OSC 7501) and Rex notifies from that. */
export function detectProtocol(env: Record<string, string | undefined>): Protocol | undefined {
	if (env.TERM_PROGRAM === "rex") return undefined;
	if (env.WT_SESSION) return "toast";
	if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "osc99";
	if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID || env.LC_TERMINAL === "iTerm2") return "osc9";
	if (env.TERM_PROGRAM === "ghostty" || env.TERM_PROGRAM === "WezTerm") return "osc777";
	return undefined;
}

export function resolveChannel(setting: unknown, env: Record<string, string | undefined>): Channel {
	switch (setting) {
		case "notifications_disabled":
			return { bell: false };
		case "terminal_bell":
			return { bell: true };
		case "iterm2":
			return { protocol: "osc9", bell: false };
		case "iterm2_with_bell":
			return { protocol: "osc9", bell: true };
		case "kitty":
			return { protocol: "osc99", bell: false };
		case "ghostty":
			return { protocol: "osc777", bell: false };
		default:
			return { protocol: detectProtocol(env), bell: false };
	}
}

/** Control characters end an escape sequence early, and `;` separates OSC 777's fields. */
export function sanitize(text: string): string {
	return text.replace(/[\p{Cc};]/gu, " ");
}

function wrapForTmux(sequence: string, env: Record<string, string | undefined>): string {
	if (!env.TMUX) return sequence;
	// tmux passthrough: wrap in DCS and double the inner ESC bytes.
	return `\x1bPtmux;${sequence.split("\x1b").join("\x1b\x1b")}\x1b\\`;
}

/** The escape sequences for a desktop notification; the toast goes through PowerShell instead. */
export function notificationSequences(protocol: Exclude<Protocol, "toast">, title: string, body: string, env: Record<string, string | undefined>): string[] {
	const sequences =
		protocol === "osc777"
			? [`\x1b]777;notify;${title};${body}\x07`]
			: protocol === "osc9"
				? [`\x1b]9;${title}: ${body}\x07`]
				: // Kitty: i is the notification id, d=0 means more parts follow, p=body is the second part
					[`\x1b]99;i=1:d=0;${title}\x1b\\`, `\x1b]99;i=1:p=body;${body}\x1b\\`];
	return sequences.map((sequence) => wrapForTmux(sequence, env));
}

function notifyToast(message: string): void {
	// PowerShell treats curly single quotes as quotes too; doubling any of them escapes it.
	const quoted = `'${message.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
	const type = "Windows.UI.Notifications";
	const script = [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text').Item(0).AppendChild($xml.CreateTextNode(${quoted})) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('Pi').Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
	// -EncodedCommand takes base64 UTF-16LE, so no command-line quoting gets in the way. The callback
	// keeps a missing powershell.exe from becoming an unhandled error event.
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	execFile("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], () => {});
}

/**
 * Tracks whether the terminal has focus from its focus reports (`CSI I` and `CSI O`), and removes
 * them from the input so they never reach the editor. Undefined until the terminal sends one, which
 * terminals without focus reporting never do.
 */
export class FocusTracker {
	focused: boolean | undefined;

	handle(data: string): { consume?: boolean; data?: string } | undefined {
		if (!data.includes(FOCUS_IN) && !data.includes(FOCUS_OUT)) return undefined;
		this.focused = data.lastIndexOf(FOCUS_IN) > data.lastIndexOf(FOCUS_OUT);
		const rest = data.split(FOCUS_IN).join("").split(FOCUS_OUT).join("");
		return rest ? { data: rest } : { consume: true };
	}

	/** You appear to be away when the terminal lost focus, or when it can't tell. */
	get away(): boolean {
		return this.focused !== true;
	}
}

function notify(pi: ExtensionAPI, channel: Channel, title: string, body: string): void {
	// Listeners run synchronously inside emit, so they can cancel or change the title and body first.
	// The event keeps pi-notify's name so extensions written for it work unchanged.
	const notification = { title, body, cancel: false };
	pi.events.emit("pi-notify:before-notify", notification);
	if (notification.cancel) return;
	const safeTitle = sanitize(notification.title);
	const safeBody = sanitize(notification.body);
	if (channel.protocol === "toast") notifyToast(`${safeTitle}: ${safeBody}`);
	else if (channel.protocol) for (const sequence of notificationSequences(channel.protocol, safeTitle, safeBody, process.env)) process.stdout.write(sequence);
	if (channel.bell) process.stdout.write("\x07");
}

export default function notifyExtension(pi: ExtensionAPI) {
	let channel: Channel = { bell: false };
	let focus = new FocusTracker();
	let stopListening: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		stopListening?.();
		stopListening = undefined;
		if (ctx.mode !== "tui") return;
		const setup = readClaudeSetup({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		channel = resolveChannel(preferredChannel(setup), process.env);
		if (!channel.protocol && !channel.bell) return;
		focus = new FocusTracker();
		stopListening = ctx.ui.onTerminalInput((data) => focus.handle(data));
		process.stdout.write(FOCUS_ON);
	});

	pi.on("session_shutdown", async () => {
		if (!stopListening) return;
		stopListening();
		stopListening = undefined;
		process.stdout.write(FOCUS_OFF);
	});

	// agent_settled fires once nothing else runs on its own: no retry, compaction or queued message.
	pi.on("agent_settled", async (event, ctx) => {
		// Esc means you're at the keyboard; print, JSON and RPC runs have no terminal to notify.
		if (event.aborted || ctx.mode !== "tui" || !stopListening || !focus.away) return;
		const name = pi.getSessionName() || path.basename(ctx.cwd);
		notify(pi, channel, name ? `Pi (${name})` : "Pi", "Ready for input");
	});
}
