/**
 * Monitor: Claude Code's Monitor and TaskStop tools, as `monitor` and `task_stop`.
 *
 * `monitor` runs a command in the background and delivers each line it prints to stdout as an event,
 * so the model can react to log entries, CI status or file changes while the conversation goes on
 * (https://code.claude.com/docs/en/tools-reference.md#monitor-tool). Every watch has a deadline: 5
 * minutes by default, at most 30; at the deadline it ends with one notice, so the model can start it
 * again. Lines that arrive within 200 ms of the first form one event; a monitor may send 10 events at
 * once and one more every 2 seconds, the rest are counted and reported, and one suppressed for 30
 * seconds without a break is stopped. stdout and stderr both go to the output file.
 *
 * `task_stop` stops a running background task by its ID: a `bg_run` job (`bg1`), a bash command that
 * moved to the background, or a monitor (`mon1`). Monitors live in the background extension's job
 * registry, so they show in the jobs line and `/bg`, `bg_status` lists them, and like jobs they keep
 * running through `/reload` and stop on quit, `/new`, `/resume` and `/fork`. A monitor stopped on
 * request sends nothing more, since the model or you asked for it.
 *
 * Left out from Claude: the WebSocket (`ws`) source, which a polling command covers, and the
 * 10-minute ceiling under `-p`: a session without a UI refuses the tool, since no later turn could
 * receive its events. With bash off in the session, as in a read-only mode, the tool is refused, as
 * Claude refuses Monitor where Bash is denied.
 *
 * Based on pi-code's monitor extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), with its
 * own registry of background shells replaced by the background extension's job registry.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type BashOperations, createBashToolDefinition, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, formatSize } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Job, shared } from "../background/index.ts";
import {
	BATCH_WINDOW_MS,
	type BatcherOptions,
	createLineBatcher,
	DEFAULT_DEADLINE_MS,
	deadlineMs,
	eventGate,
	FLOOD_BURST,
	FLOOD_REFILL_MS,
	formatDeadline,
	MAX_DEADLINE_MS,
	MIN_DEADLINE_MS,
	SUPPRESSION_LIMIT_MS,
} from "./events.ts";
import { execSplit } from "./process.ts";

/** Claude stops a background command whose output passes 5 GB. */
export const MAX_OUTPUT_BYTES = 5 * 1024 ** 3;
/** Characters of a description or command shown in a notice. */
const PREVIEW_CHARS = 80;

/** What a test may shorten; pi runs with the defaults. */
export type MonitorLimits = Pick<BatcherOptions, "windowMs"> & {
	minDeadlineMs?: number;
	floodBurst?: number;
	floodRefillMs?: number;
	suppressionLimitMs?: number;
	maxOutputBytes?: number;
};

interface Delivery {
	content: string;
	details: MonitorDetails;
}

interface MonitorDetails {
	id: string;
	description: string;
	/** The last line, shown under the row while collapsed. */
	last: string;
	/** The watch has ended: "ok" when its command exited 0, "error" otherwise. */
	ended?: "ok" | "error";
}

/**
 * Where events go. A monitor outlives a /reload, after which the copy that started it can no longer
 * send messages, so it delivers through whichever copy runs now; events that arrive between copies
 * wait for the next one.
 */
interface Mailbox {
	send?: (delivery: Delivery) => void;
	pending: Delivery[];
}

const MAILBOX = Symbol.for("pi-homeport.monitor.mailbox");

function mailbox(): Mailbox {
	const holder = globalThis as Record<symbol, Mailbox | undefined>;
	return (holder[MAILBOX] ??= { pending: [] });
}

function deliver(delivery: Delivery): void {
	const box = mailbox();
	if (!box.send) {
		box.pending.push(delivery);
		return;
	}
	try {
		box.send(delivery);
	} catch {
		// A session that is going away; nothing is left to tell
	}
}

export function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…` : flat;
}

/** How a notice names its watch: the ID task_stop takes and the model's own description. */
const label = (id: string, description: string): string => `Monitor ${id} ("${preview(description)}")`;

export function eventText(id: string, description: string, event: string): string {
	return `${label(id, description)} output:\n${event}`;
}

/** The one notice a watch sends when it ends on its own, at its deadline, or because it was stopped for too much output. */
function endNotice(end: { label: string; log: string; limitMs: number; reachedDeadline: boolean; stopReason?: string; exitCode?: number; error: unknown }): string {
	if (end.stopReason) return `${end.label} was stopped: ${end.stopReason}. Full output: ${end.log}`;
	if (end.reachedDeadline) return `${end.label} reached its ${formatDeadline(end.limitMs)} deadline and stopped. Start it again if you still need it.`;
	if (end.error !== undefined) return `${end.label} could not run: ${end.error instanceof Error ? end.error.message : String(end.error)}`;
	return `${end.label} ended: the command exited with code ${end.exitCode ?? "?"}. Full output: ${end.log}`;
}

const isMonitor = (id: string) => /^mon\d+$/.test(id);

const schema = Type.Object({
	description: Type.String({ description: "Short description of what you are watching. It names the watch in every message it sends and in /bg." }),
	command: Type.String({
		description:
			"Shell command to watch. Each line it prints is delivered to you as an event; write it so it prints only the lines worth reacting to (for example tail -F with grep --line-buffered, or a polling loop that prints on change).",
	}),
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: MIN_DEADLINE_MS,
			description: `Deadline in milliseconds (default ${DEFAULT_DEADLINE_MS}, minimum ${MIN_DEADLINE_MS}, maximum ${MAX_DEADLINE_MS}). At the deadline the watch ends and you get one notice.`,
		}),
	),
});

const stopSchema = Type.Object({
	task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop, such as bg1 or mon1" })),
	shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id" })),
});

const text = (body: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: body }], details });

/** `limits` is a test seam; pi passes only `pi`. */
export default function monitorExtension(pi: ExtensionAPI, limits: MonitorLimits = {}) {
	const reg = shared();
	const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	// The highest monitor number the conversation already used, so after a resume "mon2" keeps meaning one watch
	let seen = 0;
	const nextId = () => {
		const used = [...reg.jobs.keys()].map((id) => Number(/^mon(\d+)$/.exec(id)?.[1] ?? 0));
		return `mon${Math.max(seen, ...used) + 1}`;
	};

	function start(description: string, command: string, limitMs: number, ctx: ExtensionToolContext): Job {
		const id = nextId();
		const dir = join(tmpdir(), "pi-bg");
		mkdirSync(dir, { recursive: true });
		const log = join(dir, `${process.pid}-${id}.log`);
		const out = createWriteStream(log, { mode: 0o600 });
		// A full disk or a removed folder must not take pi down from a stream event
		out.on("error", () => {});

		const controller = new AbortController();
		const job: Job = { id, command, log, started: Date.now(), controller, status: "running", group: reg.turn, watched: true };
		reg.jobs.set(id, job);
		const running = () => job.status === "running" && !controller.signal.aborted;

		// Why the watch stopped itself; unset when the model or you stopped it
		let stopReason: string | undefined;
		let floodNotice: string | undefined;
		const stop = (reason?: string) => {
			stopReason ??= reason;
			controller.abort();
		};
		const send = (content: string, last: string, ended?: MonitorDetails["ended"]) => deliver({ content, details: { id, description, last, ended } });
		const gate = eventGate({
			send: (event) => send(eventText(id, description, event), event.split("\n").at(-1) ?? ""),
			stop: (notice) => {
				floodNotice = notice;
				stop("too much output");
			},
			capacity: limits.floodBurst,
			refillMs: limits.floodRefillMs,
			suppressionLimitMs: limits.suppressionLimitMs,
		});
		const batcher = createLineBatcher({
			windowMs: limits.windowMs,
			emit: (event) => {
				if (running()) gate.offer(event);
			},
		});
		const decoder = new StringDecoder("utf8");
		let written = 0;
		// Both streams go to the output file, under the cap a background command has
		const record = (data: Buffer) => {
			if (!running()) return;
			written += data.length;
			out.write(data);
			job.lastOutput = Date.now();
			if (written > maxOutputBytes) stop(`its output passed the ${formatSize(maxOutputBytes)} limit`);
		};

		let reachedDeadline = false;
		const deadline = setTimeout(() => {
			reachedDeadline = true;
			stop();
		}, limitMs);
		deadline.unref?.();

		const { shellPath, shellCommandPrefix } = pi.getSettings();
		let exitCode: number | undefined;
		// pi's bash definition resolves the command (the settings' prefix) and its environment (the PI_*
		// session variables, pi's bin folder on PATH) as it does for bash; only the process runs here
		const operations: BashOperations = {
			exec: async (resolved, cwd, { env }) => {
				exitCode = await execSplit(resolved, {
					cwd,
					shellPath,
					env,
					signal: controller.signal,
					onStdout: (data) => {
						record(data);
						if (!running()) return;
						const textNow = decoder.write(data);
						const last = textNow
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean)
							.at(-1);
						if (last) job.lastLine = last;
						batcher.push(textNow);
					},
					onStderr: record,
				});
				return { exitCode };
			},
		};
		const run = createBashToolDefinition(ctx.cwd, { operations, shellPath, commandPrefix: shellCommandPrefix }).execute(id, { command }, controller.signal, undefined, ctx);
		// Without an exit code the command never ran, and the rejection says why
		const settle = (error?: unknown) => finish(exitCode === undefined ? error : undefined);
		void run.then(() => settle(), settle);

		function finish(error: unknown) {
			clearTimeout(deadline);
			const stoppedOnRequest = controller.signal.aborted && !reachedDeadline && stopReason === undefined;
			batcher.push(decoder.end());
			const rest = batcher.drain();
			job.status = controller.signal.aborted ? "killed" : exitCode === undefined ? "failed" : "exited";
			job.exitCode = exitCode;
			job.ended = Date.now();
			reg.live?.redraw();
			// Sent once the output file is closed, so the file the notice names is complete
			out.end(() => {
				// Stopped through task_stop, bg_kill, /bg or the session ending: nothing is waiting for it
				if (stoppedOnRequest) return;
				// The last event spends a token as any other does; a stopped command's isn't sent
				const last = rest !== undefined && stopReason === undefined && gate.admit() ? [eventText(id, description, rest)] : [];
				const notice =
					floodNotice === undefined
						? endNotice({ label: label(id, description), log, limitMs, reachedDeadline, stopReason, exitCode, error })
						: eventText(id, description, floodNotice);
				const ok = !stopReason && floodNotice === undefined && (reachedDeadline || exitCode === 0);
				send([...last, notice].join("\n"), notice, ok ? "ok" : "error");
			});
		}

		reg.live?.redraw();
		return job;
	}

	// Claude: with Bash denied, Claude doesn't have the Monitor tool. A `defaultTools` setting that names monitor keeps it.
	const bashOff = () => !pi.getActiveTools().includes("bash") && !(pi.getSettings().defaultTools ?? []).includes("monitor");

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: `Run a command in the background and receive each line it prints as an event, so you can react to log entries, file changes, or polled status while the conversation continues. Only stdout lines are events; stderr goes to the output file. Lines that arrive within ${BATCH_WINDOW_MS} ms of the first are delivered together as one event. A monitor may send ${FLOOD_BURST} events at once and one more every ${FLOOD_REFILL_MS / 1000} seconds; events past that are suppressed and reported as a count, and a monitor suppressed for ${SUPPRESSION_LIMIT_MS / 1000} seconds without a break is stopped automatically, so filter the command down to the lines worth reacting to. The watch ends at its deadline (${DEFAULT_DEADLINE_MS / 60_000} minutes by default, at most ${MAX_DEADLINE_MS / 60_000}) with one notice; stop it earlier with task_stop.`,
		promptSnippet: "Watch a background command and react to each line it prints",
		promptGuidelines: [
			"Use monitor to watch logs, CI or PR status, or file changes instead of polling with sleep; make the command print only lines worth reacting to. Stop a monitor with task_stop once it is no longer needed.",
		],
		// Runs after the edits in the same reply, so a script written in that reply exists when the watch starts
		executionMode: "sequential",
		parameters: schema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error(
					"Monitor is unavailable in a session without a UI (print or json mode, or a subagent): no later turn could receive its events. Run the command with bash instead.",
				);
			}
			if (bashOff()) throw new Error("Permission to use Monitor has been denied: it runs code as Bash does, and bash is off in this session.");
			if (params.command.trim() === "") throw new Error("command must not be empty");
			if ((params.description ?? "").trim() === "") throw new Error("description must not be empty");
			const limitMs = deadlineMs(params.timeout_ms, limits.minDeadlineMs);
			const job = start(params.description, params.command, limitMs, ctx);
			return text(
				`Monitor started with ID: ${job.id}. Each line the command prints is delivered to you as it arrives, in batches. It stops at its ${formatDeadline(limitMs)} deadline; use task_stop to stop it sooner. Full output is written to: ${job.log}`,
				{ id: job.id, log: job.log },
			);
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop task",
		description: "Stop a running background task by its ID: a bg_run job (bg1), a bash command that moved to the background, or a monitor (mon1).",
		promptSnippet: "Stop a background job or monitor",
		parameters: stopSchema,
		async execute(_toolCallId, params) {
			const id = (params.task_id ?? params.shell_id ?? "").trim().toLowerCase();
			if (!id) throw new Error("task_id is required");
			const job = reg.jobs.get(id);
			if (!job) {
				const running = [...reg.jobs.values()].filter((other) => other.status === "running").map((other) => `${other.id} (${preview(other.command)})`);
				throw new Error(`No background task with ID ${id}. Running: ${running.join(", ") || "none"}`);
			}
			const kind = isMonitor(id) ? "monitor" : "background job";
			if (job.status !== "running") return text(`The ${kind} ${id} is not running (${job.status === "exited" ? `exited ${job.exitCode}` : job.status}).`);
			job.controller.abort();
			return text(`Stopped the ${kind} ${id}.`);
		},
	});

	// `● Monitor mon1 · description` with the latest event line under it; ctrl+o shows the whole message
	pi.registerMessageRenderer("monitor", (message, { expanded }, theme) => {
		const d = (message.details ?? {}) as Partial<MonitorDetails>;
		const color = d.ended === "error" ? "error" : d.ended === "ok" ? "success" : "accent";
		const head = theme.fg(color, "● ") + theme.fg("toolTitle", theme.bold("Monitor")) + theme.fg("toolTitle", ` ${d.id ?? ""} · ${d.description ?? ""}`);
		const body = expanded ? String(message.content) : (d.last ?? "");
		return {
			invalidate() {},
			render: (width: number) => [
				"",
				truncateToWidth(head, width),
				...wrapTextWithAnsi(body, Math.max(10, width - 5)).map((line, i) => (i === 0 ? `  ${theme.fg("dim", "⎿")}  ` : "     ") + theme.fg("dim", line)),
			],
		};
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// While pi is working, an event is steered in before its next step; otherwise it starts a turn
		const box = mailbox();
		box.send = ({ content, details }) => pi.sendMessage({ customType: "monitor", content, display: true, details }, { triggerTurn: true, deliverAs: "steer" });
		for (const delivery of box.pending.splice(0)) deliver(delivery);
		for (const entry of ctx.sessionManager.getBranch()) {
			const msg = entry.type === "message" ? (entry.message as any) : undefined;
			const n = Number(/^mon(\d+)$/.exec(msg?.role === "toolResult" && msg.toolName === "monitor" ? String(msg.details?.id) : "")?.[1] ?? 0);
			if (n > seen) seen = n;
		}
		if (pi.getActiveTools().includes("monitor") && bashOff()) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "monitor"));
	});

	pi.on("session_shutdown", async (event) => {
		const box = mailbox();
		box.send = undefined;
		// A reload loads the extension again in this process, so the watches carry on and report to the next copy
		if (event.reason === "reload") return;
		box.pending.length = 0;
		// The background extension stops every job on the way out too; this covers a setup without it
		for (const job of [...reg.jobs.values()]) {
			if (!isMonitor(job.id)) continue;
			if (job.status === "running") job.controller.abort();
			reg.jobs.delete(job.id);
		}
	});
}
