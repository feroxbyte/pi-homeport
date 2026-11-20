/**
 * Background jobs: long commands run in the background, with a line above the input while they
 * run, and pi hears back when they finish. A shell command still running after 2 minutes, or one you
 * press ctrl+b on, moves to the background too. `/bg` shows a job's latest output.
 *
 * Based on pi-background by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md). Rows are drawn like
 * the chat extension's: `● Bash(command)` with `⎿  Running in the background as bg1` under it.
 */

import { closeSync, createWriteStream, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { shortCommand } from "./command.ts";
import { moved, readTail, scrolled, windowOf } from "./view.ts";

const TAIL_LINES = 20;
const TAIL_BYTES = 64 * 1024;
// How much of a log the job screen can scroll back through
const VIEW_BYTES = 512 * 1024;
// A bash command still running after this long moves to the background, so it no longer blocks the turn
const AUTO_BACKGROUND_SECS = 120;
const WAKE_DEBOUNCE_MS = 1000;
const MAX_WAKES = 10;
const MAX_SHOWN_JOBS = 3;
// A running job silent this long shows how long it has been quiet, since it may be stuck
const SILENT_AFTER_MS = 10 * 60_000;
// Finished jobs listed by /bg; older ones stay reachable as /bg <id>
const MAX_LISTED_FINISHED = 10;
// How long a bash command runs before the jobs line offers ctrl+b, so quick commands don't flash it
const HINT_AFTER_MS = 3000;
// How long finished results wait for jobs started alongside them before Pi is woken anyway
const GROUP_HOLD_MS = 2 * 60_000;

interface Job {
	id: string;
	command: string;
	log: string;
	started: number;
	controller: AbortController;
	status: "running" | "exited" | "killed" | "failed";
	exitCode?: number | null;
	ended?: number;
	// The latest output line, shown while the job runs
	lastLine?: string;
	// When the job last printed anything
	lastOutput?: number;
	// The turn that started the job; jobs from the same turn are reported together
	group: number;
	// Started with wake_on, so it may run indefinitely and doesn't hold back the others
	watched: boolean;
}

function tail(path: string, lines: number): string {
	try {
		const text = readFileSync(path).subarray(-TAIL_BYTES).toString("utf8");
		return text.trimEnd().split("\n").slice(-lines).join("\n") || "(no output)";
	} catch {
		return "(no output)";
	}
}

/** 45s, 12m30s, or 1h20m once seconds no longer matter. */
function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
}

function elapsed(job: Job): string {
	return duration((job.ended ?? Date.now()) - job.started);
}

function state(job: Job): string {
	return job.status === "exited" ? `exit ${job.exitCode}` : job.status;
}

function summary(job: Job): string {
	return `${job.id} [${state(job)}, ${elapsed(job)}] ${job.command}\n  log: ${job.log}`;
}

/** An output line as a terminal would last have shown it: without escape codes or control characters, and a progress bar redrawn with \r in its latest state only. */
function cleanLine(line: string): string {
	const shown = stripTerminalSequences(line).split("\r").filter((part) => part.trim()).at(-1) ?? "";
	return shown.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
}

/** The part of a command worth showing: its first line, without a leading cd, with a script path shortened to its name and at most 50 characters. */
function shownCommand(command: string): string {
	const shown = command
		.split("\n")[0]
		.replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "")
		// Leading settings such as PYTHONPATH=/some/src, which the path shortening below would cut at their last /
		.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "")
		.replace(/^\S*\/(?=[^\s/]+(\s|$))/, "");
	return shown.length > 50 ? `${shown.slice(0, 49)}…` : shown;
}

/** Compiles wake_on, accepting Python's (?i) prefix that models often write but JavaScript only takes as a flag. */
function wakePattern(source: string): RegExp {
	const insensitive = source.startsWith("(?i)");
	return new RegExp(insensitive ? source.slice(4) : source, insensitive ? "i" : "");
}

/** Runs a command through the registered bash tool, such as a sandbox's, which another extension can't reach directly. */
async function throughBash(ctx: ExtensionToolContext, command: string, signal: AbortSignal, onData: (d: Buffer) => void): Promise<{ exitCode: number | null }> {
	let seen = "";
	let sent = 0;
	let full: string | undefined;
	const pass = (d: Buffer) => {
		sent += d.length;
		if (d.length) onData(d);
	};
	// Once output outgrows the tail an update holds, bash saves all of it to a file, which is read from where the updates left off
	const fromFile = () => {
		if (!full) return;
		let fd: number;
		try {
			fd = openSync(full, "r");
		} catch {
			// Not created yet; a later update or the read at the end gets it
			return;
		}
		try {
			const d = Buffer.alloc(Math.max(0, fstatSync(fd).size - sent));
			pass(d.subarray(0, readSync(fd, d, 0, d.length, sent)));
		} finally {
			closeSync(fd);
		}
	};
	// A day, so a bash that backgrounds commands at its timeout leaves this one running
	const outcome = await ctx.executeTool("bash", { command, timeout: 24 * 60 * 60 }, {
		signal,
		onUpdate: (partial) => {
			full ??= (partial.details as any)?.fullOutputPath;
			if (full) return fromFile();
			// Each update holds the output so far, or only its tail from a bash without the file; what follows the previous one is new
			const text = partial.content.map((c: any) => c.text ?? "").join("");
			const anchor = seen.slice(-256);
			const found = text.lastIndexOf(anchor);
			const at = text.startsWith(seen) ? seen.length : found < 0 ? 0 : found + anchor.length;
			pass(Buffer.from(text.slice(at)));
			seen = text;
		},
	});
	// The file is complete only once bash has finished
	fromFile();
	if (signal.aborted) throw new Error("killed");
	const text = outcome.result.content.map((c: any) => c.text ?? "").join("");
	const code = (outcome.result.structuredContent as any)?.exit_code ?? /Command exited with code (\d+)$/.exec(text)?.[1];
	if (code !== undefined) return { exitCode: Number(code) };
	// A bash that backgrounds long commands itself (pi-code's does after two minutes) answers with a note, not an exit
	// code. Reporting that as "exited 0" would tell Pi a job that is still running had succeeded.
	if (/moved to the background|moved to background/i.test(text)) {
		throw new Error(`the bash tool moved this command to a background job of its own, which bg_run can't follow: ${text.split("\n")[0]}`);
	}
	if (outcome.isError) throw new Error(text.trimEnd().split("\n").at(-1) || "bash failed");
	return { exitCode: 0 };
}

/** Thrown by the bash operations below when a command moves to the background, carrying the job and its output so far. */
class MovedToBackground extends Error {
	readonly job: { id: string; log: string; started: number };
	readonly output: string;

	constructor(job: { id: string; log: string; started: number }, output: string) {
		super(`moved to background as ${job.id}`);
		this.job = job;
		this.output = output;
	}
}

type Wake = (content: string, details: { headline: string; last: string; error: boolean }, triggerTurn?: boolean) => void;

/**
 * What outlives a /reload. pi loads an extension afresh on reload, but the processes it started keep running,
 * so the jobs, their numbering and who reports on them live here, where the next copy finds them. Without it a
 * reload would stop every job, or leave it running with nobody to tell pi when it ends.
 */
interface Shared {
	jobs: Map<string, Job>;
	next: number;
	turn: number;
	/** The running copy of the extension. Missing between one copy's shutdown and the next copy's start. */
	live?: { wake: Wake; redraw(): void; finished(job: Job): void };
	/** Jobs that ended while no copy was running, for the next one to report. */
	unreported: Job[];
}

const REGISTRY = Symbol.for("pi-homeport.background.registry");

function shared(): Shared {
	const holder = globalThis as Record<symbol, Shared | undefined>;
	return (holder[REGISTRY] ??= { jobs: new Map(), next: 1, turn: 0, unreported: [] });
}

/** Hands a job that has ended to whichever copy of the extension is running, or keeps it for the next. */
function settle(job: Job) {
	const reg = shared();
	// A job the session forgot, stopped by a shutdown or ended after it, has nobody to tell. By identity, since a new
	// session may already have started a job under the same id.
	if (reg.jobs.get(job.id) !== job) return;
	if (reg.live) reg.live.finished(job);
	else reg.unreported.push(job);
}

export default function backgroundExtension(pi: ExtensionAPI) {
	const reg = shared();
	const jobs = reg.jobs;

	// While Pi is working, the message is steered in before its next step instead of following up after the whole run,
	// which for a long run left results hours late and woke Pi once per stale message when the run ended
	const deliver: Wake = (content, details, triggerTurn = true) =>
		pi.sendMessage({ customType: "background-job", content, display: true, details }, { triggerTurn, deliverAs: "steer" });
	// Through the running copy, since a job started before a reload reports to the one running after it
	const wake: Wake = (content, details, triggerTurn = true) => reg.live?.wake(content, details, triggerTurn);

	// Jobs started in the same turn usually belong together, like several benchmarks to compare. While some of them
	// still run, a successful one's result is added to the conversation without waking Pi, so it answers once at the
	// end instead of after each job. A job that runs on too long doesn't hold the others back for more than GROUP_HOLD_MS.
	pi.on("turn_start", async () => {
		reg.turn++;
	});
	const holds = new Map<number, NodeJS.Timeout>();
	const runningInGroup = (job: Job) =>
		[...jobs.values()].filter((other) => other !== job && other.group === job.group && other.status === "running" && !other.watched);
	const report = (job: Job, content: string, details: { headline: string; last: string; error: boolean }) => {
		const others = job.watched ? [] : runningInGroup(job);
		// Only Pi stops jobs, with bg_kill, so it already knows; the message is added without waking it again
		if (job.status === "killed") {
			if (others.length === 0) {
				clearTimeout(holds.get(job.group));
				holds.delete(job.group);
			}
			return wake(content, details, false);
		}
		// A failure wakes Pi straight away, so it can react before the rest of the group finishes
		if (others.length === 0 || details.error) {
			clearTimeout(holds.get(job.group));
			holds.delete(job.group);
			return wake(content, details);
		}
		wake(`${content}\n(Still running from the same turn: ${others.map((other) => other.id).join(", ")}; you'll be woken when they finish.)`, details, false);
		if (holds.has(job.group)) return;
		holds.set(job.group, setTimeout(() => {
			holds.delete(job.group);
			const still = runningInGroup(job);
			if (still.length === 0) return;
			wake(`Background jobs from the same turn are still running after ${GROUP_HOLD_MS / 60_000} minutes: ${still.map((other) => other.id).join(", ")}. The results of the ones that finished are above; you'll get a message when each of these finishes.`, {
				headline: `${still.map((other) => other.id).join(", ")} still running`,
				last: "",
				error: false,
			});
		}, GROUP_HOLD_MS));
	};

	// Wakes the agent with output lines matching pattern, batched per second and capped per job
	const watcher = (job: Job, pattern: RegExp) => {
		let partial = "";
		let pending: string[] = [];
		let timer: NodeJS.Timeout | undefined;
		let wakes = 0;
		const flush = () => {
			timer = undefined;
			// Once the job has ended, its final message carries the log tail instead
			if (job.status !== "running") return;
			wakes++;
			const capped = wakes === MAX_WAKES ? `\n(Reached ${MAX_WAKES} wake-ups; further matches are ignored, use bg_status to check.)` : "";
			wake(`Background job ${job.id} output matched /${pattern.source}/ (still running):\n${pending.slice(-TAIL_LINES).join("\n")}${capped}`, {
				headline: `${job.id} matched /${pattern.source}/`,
				last: pending[pending.length - 1] ?? "",
				error: false,
			});
			pending = [];
		};
		return (data: Buffer) => {
			if (wakes >= MAX_WAKES) return;
			const lines = (partial + data.toString("utf8")).split(/\r?\n|\r/);
			partial = lines.pop() ?? "";
			const hits = lines.filter((line) => pattern.test(line));
			if (hits.length === 0) return;
			pending.push(...hits);
			timer ??= setTimeout(flush, WAKE_DEBOUNCE_MS);
		};
	};

	// One line per running job above the input, with its elapsed time and latest output
	const running = () => [...jobs.values()].filter((job) => job.status === "running");
	// The chat extension adds "2 background jobs · ↓ to manage" to its turn line from this, without importing us
	(globalThis as any)[Symbol.for("pi-homeport.background")] = { running: () => running().length };
	// For telling whether the input has the keyboard focus, so ↓ doesn't open the list over another screen
	// getFocusedComponent is newer than the pi this builds against; without it ↓ is left alone
	let tuiRef: object | undefined;
	let listing = false;
	// The job open in /bg, left out of the jobs line meanwhile so it isn't shown twice
	let viewing: Job | undefined;
	// "full" (the default), "compact" without the output, or "off", set with "background": { "jobs": ... } in pi's settings.json
	const jobsLine = () => (pi.getSettings() as { background?: { jobs?: string } }).background?.jobs ?? "full";
	// The widget is set once per session and redrawn in place: setting it again would move it below the widgets other
	// extensions added since, while running jobs belong at the top, next to what Pi is doing now
	let redrawJobs = () => {};
	let ticker: NodeJS.Timeout | undefined;
	const showJobs = () => {
		// A running job's elapsed time and latest output change every second
		if (running().length > 0) ticker ??= setInterval(() => redrawJobs(), 1000);
		else {
			clearInterval(ticker);
			ticker = undefined;
		}
		redrawJobs();
	};
	// Running bash commands that ctrl+b can move to the background now, by tool call id, once they have run for
	// HINT_AFTER_MS. Shared so pi-polish can show the hint under the command's row instead of in the jobs line.
	const hinted = new Map<string, () => void>();
	(globalThis as any)[Symbol.for("pi-background.movable")] = hinted;
	let stopCtrlB = () => {};
	const jobsWidget = (theme: any) => ({
		invalidate() {},
		render(width: number) {
			if (jobsLine() === "off") return [];
			const live = running().filter((job) => job !== viewing);
			const silentFor = (job: Job) => Date.now() - (job.lastOutput ?? job.started);
			let lines: string[];
			if (live.length <= MAX_SHOWN_JOBS) {
				lines = live.map((job) => {
					const silent = silentFor(job);
					const detail = silent >= SILENT_AFTER_MS ? ` · no output for ${duration(silent)}` : jobsLine() === "full" && job.lastLine ? ` · ${job.lastLine}` : "";
					const text = theme.fg("accent", "● ") + theme.fg("toolTitle", `${job.id} ${shownCommand(job.command)}`) + theme.fg("dim", ` · ${elapsed(job)}${detail}`);
					return truncateToWidth(text, width);
				});
			} else {
				// Past a few jobs, a line each crowds the input, so they share one with just the count, and a warning when
				// some have gone quiet, since they may be stuck; /bg has the rest
				const silent = live.filter((job) => silentFor(job) >= SILENT_AFTER_MS).length;
				const warning = silent ? theme.fg("warning", ` · ${silent} silent for ${SILENT_AFTER_MS / 60_000}m+`) : "";
				lines = [truncateToWidth(theme.fg("accent", "● ") + theme.fg("toolTitle", `${live.length} jobs`) + warning, width)];
			}
			if (hinted.size > 0 && !(globalThis as any)[Symbol.for("pi-polish.showsMoveHint")]) lines.push(theme.fg("dim", "  ctrl+b to run in background"));
			return lines;
		},
	});

	const find = (id: string): Job => {
		const job = jobs.get(id);
		if (!job) throw new Error(`No background job ${id}; known: ${[...jobs.keys()].join(", ") || "none"}`);
		return job;
	};

	// Rows like the chat's: a status dot and `Name(argument)`, then "  ⎿  text" in dim, with long and extra lines
	// wrapped under the text instead of at the left edge
	const branch = (theme: any, text: string, head?: string) => ({
		invalidate() {},
		render: (width: number) => [
			...(head ? ["", truncateToWidth(head, width)] : []),
			...wrapTextWithAnsi(text, Math.max(10, width - 5)).map((line, i) => (i === 0 ? `  ${theme.fg("dim", "⎿")}  ` : "     ") + theme.fg("dim", line)),
		],
	});
	pi.registerMessageRenderer("background-job", (message, { expanded }, theme) => {
		const d = (message.details ?? {}) as { headline?: string; last?: string; error?: boolean };
		const title = `Background ${d.headline ?? ""}`;
		const head = theme.fg(d.error ? "error" : "success", "● ") + theme.fg("toolTitle", title);
		return branch(theme, expanded ? String(message.content) : (d.last ?? ""), head);
	});
	// `● Name(argument)` on one line, like the chat's tool rows; expanded (ctrl+o) shows the whole argument, wrapped
	// under the row. The dot is accent while the call runs, then green, or red when it failed.
	const row = (theme: any, name: string, argument: string, context: any, full = argument) => ({
		invalidate() {},
		render(width: number) {
			const color = context.isError ? "error" : context.executionStarted && context.isPartial ? "accent" : "success";
			const mark = theme.fg(color, "● ");
			const text = (value: string) => theme.fg("toolTitle", theme.bold(name)) + theme.fg("toolTitle", `(${value})`);
			if (!context.expanded) return ["", mark + truncateToWidth(text(argument), Math.max(10, width - 2))];
			return ["", ...wrapTextWithAnsi(text(full), Math.max(10, width - 2)).map((line, i) => (i === 0 ? mark : "  ") + line)];
		},
	});
	const note = (theme: any, result: any, expanded: boolean) => {
		const text = result.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
		// Collapsed: first sentence only, without the log path; "Started bg1" reads as Claude Code's
		const first = text.split("\n")[0].split(";")[0];
		const short = first.replace(/^Started (bg\d+)$/, "Running in the background as $1");
		return branch(theme, expanded ? text : short);
	};

	// Starts tracking a job: its output goes to a log and the jobs line, and Pi is told when run's promise settles.
	// A bash command that moves to the background brings its start time and the output it printed before.
	const startJob = (
		command: string,
		pattern: RegExp | undefined,
		controller: AbortController,
		run: (onData: (d: Buffer) => void) => Promise<{ exitCode: number | null }>,
		earlier?: { started: number; output: Buffer; lastOutput?: number },
	) => {
		const id = `bg${reg.next++}`;
		const dir = join(tmpdir(), "pi-bg");
		mkdirSync(dir, { recursive: true });
		const log = join(dir, `${process.pid}-${id}.log`);
		const out = createWriteStream(log);
		const job: Job = { id, command, log, started: earlier?.started ?? Date.now(), controller, status: "running", group: reg.turn, watched: Boolean(pattern) };
		jobs.set(id, job);

		const watch = pattern ? watcher(job, pattern) : undefined;
		const onData = (d: Buffer) => {
			out.write(d);
			watch?.(d);
			job.lastOutput = Date.now();
			const last = d.toString("utf8").split("\n").map(cleanLine).filter((line) => line.trim()).at(-1)?.trim();
			if (last) job.lastLine = last;
		};
		if (earlier?.output.length) {
			onData(earlier.output);
			job.lastOutput = earlier.lastOutput;
		}

		run(onData)
			.then(({ exitCode }) => {
				job.status = "exited";
				job.exitCode = exitCode;
			})
			.catch((err: Error) => {
				job.status = controller.signal.aborted ? "killed" : "failed";
				out.write(`\n[bg] ${err.message}\n`);
			})
			.finally(() => {
				job.ended = Date.now();
				reg.live?.redraw();
				out.end(() => settle(job));
			});

		showJobs();
		return job;
	};

	// Pi's bash, except that a command still running after AUTO_BACKGROUND_SECS becomes a background job
	// instead of blocking the turn until it ends or times out. The command keeps running in the same
	// process; its output so far goes to the job's log, and Pi gets the usual message when it exits.
	const handoff = (local: BashOperations, toolCallId: string): BashOperations => ({
		exec(command, cwd, options) {
			// Pi's own check, which its exec would otherwise have made
			if (options.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
				return Promise.reject(new Error("Invalid timeout: must be a finite number of seconds"));
			}
			const started = Date.now();
			// Its own signal, so a job outlives the turn; until then the turn's abort is passed on
			const controller = new AbortController();
			const forward = () => controller.abort();
			if (options.signal?.aborted) controller.abort();
			options.signal?.addEventListener("abort", forward, { once: true });
			// The output so far goes to the job's log; only its last TAIL_BYTES are kept, like the log tails
			let earlier = Buffer.alloc(0);
			let lastOutput: number | undefined;
			let sink = (d: Buffer) => {
				earlier = Buffer.concat([earlier, d]).subarray(-TAIL_BYTES);
				lastOutput = Date.now();
				options.onData(d);
			};
			const env = { ...(options.env ?? process.env), PYTHONUNBUFFERED: "1" };
			// A timeout moves the command to the background sooner rather than stopping it, so its work isn't lost
			const after = Math.min(options.timeout ?? AUTO_BACKGROUND_SECS, AUTO_BACKGROUND_SECS);
			const running = local.exec(command, cwd, { onData: (d) => sink(d), signal: controller.signal, env });
			return new Promise((resolve, reject) => {
				let timer: NodeJS.Timeout | undefined;
				let hint: NodeJS.Timeout | undefined;
				const settle = () => {
					clearTimeout(timer);
					clearTimeout(hint);
					options.signal?.removeEventListener("abort", forward);
					if (hinted.delete(toolCallId)) redrawJobs();
				};
				const move = () => {
					settle();
					const output = earlier;
					const job = startJob(command, undefined, controller, (onData) => {
						sink = onData;
						return running;
					}, { started, output, lastOutput });
					reject(new MovedToBackground(job, output.toString("utf8")));
				};
				timer = setTimeout(move, after * 1000);
				hint = setTimeout(() => {
					hinted.set(toolCallId, move);
					redrawJobs();
				}, HINT_AFTER_MS);
				running.then(resolve, reject).finally(settle);
			});
		},
	});
	// Only Pi's own bash is wrapped; one that another extension replaced, such as a sandbox's, is left alone. By
	// session_start every extension has registered its tools, whichever order they loaded in.
	let wrapped = false;
	// bg_run then runs its jobs through that bash, so they stay inside such a sandbox
	let foreignBash = false;
	pi.on("session_start", async () => {
		if (wrapped) return;
		foreignBash = !pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path.startsWith("builtin:");
		if (foreignBash) return;
		wrapped = true;
		const pisBash = createBashToolDefinition(process.cwd());
		pi.registerTool({
			...pisBash,
			promptGuidelines: [
				...(pisBash.promptGuidelines ?? []),
				`A bash command still running after ${AUTO_BACKGROUND_SECS} seconds, or after its timeout if that is shorter, moves to the background on its own, as if started with bg_run, and you get its job id instead of its output; it is not stopped. Still start a command you expect to take that long with bg_run, so you choose wake_on and the turn isn't held up first.`,
			],
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// Built per call from the same settings Pi builds its own bash from
				const { shellPath, shellCommandPrefix } = pi.getSettings();
				const bash = createBashToolDefinition(ctx.cwd, { commandPrefix: shellCommandPrefix, operations: handoff(createLocalBashOperations({ shellPath }), toolCallId) });
				try {
					return await bash.execute(toolCallId, params, signal, onUpdate, ctx);
				} catch (err) {
					if (!(err instanceof MovedToBackground)) throw err;
					const { id, log, started } = err.job;
					const soFar = err.output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n") || "(no output)";
					const text = `Still running after ${duration(Date.now() - started)}, so it moved to the background as ${id}. You will be notified when it exits; check it with bg_status, or stop it with bg_kill if it shouldn't take this long.\nOutput so far:\n${soFar}\nlog: ${log}`;
					return { content: [{ type: "text", text }], details: undefined };
				}
			},
		});
	});

	pi.registerTool({
		name: "bg_run",
		label: "Background",
		description:
			"Start a shell command in the background and return immediately with a job id. Output goes to a log file. " +
			"When the command exits you automatically receive a message with its exit code and the last log lines, so do not poll or sleep waiting for it.",
		promptSnippet: "Run long shell commands (downloads, builds, long test suites) in the background",
		promptGuidelines: [
			"Use bg_run instead of bash for any command that may take longer than about 30 seconds, in particular: downloading large files, datasets, dumps or model weights; " +
				"installing heavy packages (torch, tensorflow, CUDA libraries, transformers, large requirement sets) or creating environments with them; cloning large repositories; " +
				"builds, compiles and docker builds; full test suites of non-trivial projects; training, evaluation, benchmark and data-processing scripts; and anything that sleeps, waits or polls.",
			"Run quick checks, short scripts and test files that likely finish within a minute with bash, even when you're not sure: their result is needed now, and each bg_run job reports back as a separate message.",
			"After bg_run, continue with independent work or end your turn; a message with the exit code and log tail arrives automatically when the job exits, so never sleep, poll or tail the log to wait for it.",
			"Keep using bash for quick commands whose output you need right away, such as git, ls, cat, grep, find, file inspection and short checks.",
			"Pass wake_on only when you must act before a bg_run job ends, such as a server becoming ready to test against, or when the user asked to follow its progress. Make it a pattern for that one event, which matches once, not a line the job prints for every item, file, epoch or step. To report a job's result, leave wake_on out: the exit message already brings the exit code and last lines.",
			"Don't redirect a bg_run command's output to a file (> file, 2>&1, nohup): bg_run already saves all of it to the job's log, and redirecting hides the job's progress from the user and from wake_on. If the output should be kept, tell the user where the job's log is.",
			"bg_run starts only after the other tool calls in the same reply have finished, so editing a file and starting a job that uses it in one reply is safe.",
			"Use bg_status to check progress of a bg_run job and bg_kill to stop one.",
			"Unless the user explicitly asks for that bash command, never wait, poll or sleep in bash (while/until loops with sleep, watch, repeated status checks), not even as part of a larger command; start the wait with bg_run and pass wake_on to be woken when the awaited output appears.",
			"Unless the user explicitly asks otherwise, start long-running processes (training or evaluation runs, servers, watchers) with bg_run, not with & or nohup in bash followed by sleep.",
		],
		// Runs after the edits in the same reply, so the job starts from the code pi just wrote
		executionMode: "sequential",
		renderShell: "self",
		renderCall: (args: any, theme, context) => {
			const command = String(args?.command ?? "");
			// Collapsed, without leading settings such as PYTHONPATH=/some/src, like the jobs line; ctrl+o shows them
			const short = shortCommand(command, args?.cwd ?? process.cwd()).replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "");
			return row(theme, "Bash", short, context, command.trim());
		},
		renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
			wake_on: Type.Optional(
				Type.String({
					description: `Regex; also wake you while the job runs whenever an output line matches, e.g. 'listening on|ready'. Matches within a second are batched; at most ${MAX_WAKES} wake-ups per job.`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const pattern = params.wake_on ? wakePattern(params.wake_on) : undefined;
			const controller = new AbortController();
			// The same shell and command prefix as Pi's own bash, from settings.json; without shellPath, Windows can pick WSL's bash
			const { shellPath, shellCommandPrefix } = pi.getSettings();
			const ops = createLocalBashOperations({ shellPath });
			// Output goes to a pipe, where Python would buffer prints until it exits; unbuffered, the latest line and wake_on stay live
			const command = `export PYTHONUNBUFFERED=1; ${params.command}`;
			const { id, log } = startJob(params.command, pattern, controller, (onData) =>
				foreignBash
					? throughBash(ctx, params.cwd ? `cd '${params.cwd.replace(/'/g, `'\\''`)}' && ${command}` : command, controller.signal, onData)
					: ops.exec(shellCommandPrefix ? `${shellCommandPrefix}\n${command}` : command, params.cwd ?? ctx.cwd, { onData, signal: controller.signal }),
			);
			return { content: [{ type: "text", text: `Started ${id}; log: ${log}. You will be notified when it exits.` }], details: { id, log } };
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background status",
		description: "List background jobs, or show one job's state and the tail of its log.",
		renderShell: "self",
		renderCall: (args: any, theme, context) => row(theme, "BashOutput", args?.id ?? "all", context),
		renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Job id such as bg1; omit to list all jobs" })),
			lines: Type.Optional(Type.Number({ description: `Log lines to show (default ${TAIL_LINES})` })),
		}),
		async execute(_toolCallId, params) {
			if (!params.id) {
				const text = [...jobs.values()].map(summary).join("\n") || "No background jobs.";
				return { content: [{ type: "text", text }], details: {} };
			}
			const job = find(params.id);
			return { content: [{ type: "text", text: `${summary(job)}\n${tail(job.log, params.lines ?? TAIL_LINES)}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background kill",
		description: "Stop a running background job and its child processes.",
		renderShell: "self",
		renderCall: (args: any, theme, context) => row(theme, "Kill Shell", args?.id ?? "", context),
		renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
		parameters: Type.Object({ id: Type.String({ description: "Job id such as bg1" }) }),
		async execute(_toolCallId, params) {
			const job = find(params.id);
			if (job.status !== "running") return { content: [{ type: "text", text: `${job.id} already ${job.status}` }], details: {} };
			job.controller.abort();
			return { content: [{ type: "text", text: `Stopping ${job.id}` }], details: {} };
		},
	});

	const statusColor = (job: Job) => (job.status === "running" ? "accent" : job.status === "exited" && job.exitCode === 0 ? "success" : "error");
	// Running jobs first, then the latest finished ones
	const listed = () => {
		const all = [...jobs.values()].reverse();
		return [...all.filter((job) => job.status === "running"), ...all.filter((job) => job.status !== "running").slice(0, MAX_LISTED_FINISHED)];
	};

	// The list of jobs in place of the input: ↑ ↓ select, enter opens one, x stops it, esc closes. The selection is
	// kept by id, since the order changes as jobs finish while the list is open.
	const pickJob = (ctx: ExtensionContext, first: string | undefined) =>
		ctx.ui.custom<Job | undefined>((tui, theme, _kb, done) => {
			let selected: string | undefined = first ?? listed()[0]?.id;
			const timer = setInterval(() => tui.requestRender(), 1000);
			return {
				dispose: () => clearInterval(timer),
				invalidate() {},
				handleInput: (data: string) => {
					const jobsNow = listed();
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return done(undefined);
					if (matchesKey(data, Key.enter)) return done(jobs.get(selected ?? ""));
					if (data === "x") jobs.get(selected ?? "")?.controller.abort();
					selected = moved(data, jobsNow.map((job) => job.id), selected);
					tui.requestRender();
				},
				render(width: number) {
					const rows = listed();
					const idWidth = Math.max(0, ...rows.map((job) => job.id.length));
					const body = rows.map((job) => {
						const on = job.id === selected;
						const text =
							theme.fg(on ? "accent" : "dim", on ? "❯ " : "  ") +
							theme.fg(statusColor(job), "● ") +
							theme.fg(on ? "toolTitle" : "text", `${job.id.padEnd(idWidth)} ${shownCommand(job.command)}`) +
							theme.fg("dim", ` · ${state(job)} · ${elapsed(job)}`);
						return truncateToWidth(text, width);
					});
					return [
						theme.fg("borderMuted", "─".repeat(width)),
						theme.fg("toolTitle", " Background jobs"),
						...(body.length ? body : [theme.fg("dim", "  none")]),
						theme.fg("dim", " ↑↓ select · enter open · x stop · esc close"),
						theme.fg("borderMuted", "─".repeat(width)),
					].map((line) => truncateToWidth(line, width));
				},
			};
		});

	// A job's output in place of the input, refreshed every second while it runs and following the end of the log until
	// you scroll up: ↑ ↓ by a line, page up and down by a screen, g and G to the start and the end, x stops the job.
	const viewJob = async (ctx: ExtensionContext, shown: Job) => {
		viewing = shown;
		const log = shown.log.replace(homedir(), "~");
		let fromBottom = 0;
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const timer = setInterval(() => tui.requestRender(), 1000);
				// At most 60% of the terminal, so the conversation above stays in view
				const height = () => Math.max(3, Math.floor(tui.terminal.rows * 0.6));
				const lines = () => {
					const text = readTail(shown.log, VIEW_BYTES).trimEnd();
					return text ? text.split("\n").map(cleanLine) : [];
				};
				return {
					dispose: () => clearInterval(timer),
					invalidate() {},
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return done();
						if (data === "x") shown.controller.abort();
						const all = lines();
						fromBottom = scrolled(data, fromBottom, height(), all.length) ?? fromBottom;
						fromBottom = windowOf(all, height(), fromBottom).fromBottom;
						tui.requestRender();
					},
					render(width: number) {
						const title = theme.fg(statusColor(shown), " ● ") + theme.fg("toolTitle", `${shown.id} ${shownCommand(shown.command)}`);
						const status = theme.fg("muted", `${state(shown)} · ${elapsed(shown)} `);
						const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(status));
						const view = windowOf(lines(), height(), fromBottom);
						const output = view.lines.length ? view.lines.map((line) => `   ${line}`) : [theme.fg("dim", theme.italic("   no output yet"))];
						const position = view.below > 0 ? ` · ${view.below} lines below, G for the end` : view.above > 0 ? ` · ${view.above} lines above` : "";
						const stop = shown.status === "running" ? " · x stop" : "";
						return [
							theme.fg("borderMuted", "─".repeat(width)),
							title + " ".repeat(gap) + status,
							...output,
							theme.fg("dim", ` ↑↓ scroll${stop} · esc back · ${log}${position}`),
							theme.fg("borderMuted", "─".repeat(width)),
						].map((line) => truncateToWidth(line, width));
					},
				};
			});
		} finally {
			viewing = undefined;
		}
	};

	// "/bg" lists the jobs, "/bg 2" or "/bg bg2" opens one; esc in a job returns to the list it came from
	const showJob = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (jobs.size === 0) return ctx.ui.notify("No background jobs yet", "info");
		const wanted = args.trim().toLowerCase().replace(/^(\d+)$/, "bg$1");
		const direct = wanted ? jobs.get(wanted) : undefined;
		if (wanted && !direct) return ctx.ui.notify(`No background job ${args.trim()}; there's ${[...jobs.keys()].join(", ")}`, "warning");
		if (direct) return viewJob(ctx, direct);
		let last: string | undefined;
		for (;;) {
			const picked = await pickJob(ctx, last);
			if (!picked) return;
			last = picked.id;
			await viewJob(ctx, picked);
		}
	};
	pi.registerCommand("bg", {
		description: "Show a background job's latest output",
		getArgumentCompletions: (prefix) => {
			const matching = [...jobs.values()].filter((job) => job.id.startsWith(prefix.trim().toLowerCase()));
			return matching.length ? matching.map((job) => ({ value: job.id, label: job.id, description: `${shownCommand(job.command)} · ${state(job)}` })) : null;
		},
		handler: showJob,
	});
	// "/bg3" without the space isn't a command, so pi would send it to the model as a message; open the job instead
	pi.on("input", async (event, ctx) => {
		const id = event.text.trim().match(/^\/(bg\d+)$/i)?.[1];
		if (!id || !jobs.has(id.toLowerCase())) return { action: "continue" };
		await showJob(id, ctx);
		return { action: "handled" };
	});

	// After /reload or a resume, carry on after the ids already in the conversation so "bg3" keeps meaning one job
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("background-jobs", (tui, theme) => {
				redrawJobs = () => tui.requestRender();
				tuiRef = tui;
				return jobsWidget(theme);
			});
			// ctrl+b moves running bash commands to the background; otherwise it stays the editor's cursor-left.
			// ↓ in an empty input opens the list of jobs, when the input has the keyboard.
			stopCtrlB();
			stopCtrlB = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, Key.down) && !listing && jobs.size > 0) {
					const focused = (tuiRef as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.() as { getText?: () => string } | null | undefined;
					if (typeof focused?.getText === "function" && focused.getText() === "") {
						listing = true;
						void showJob("", ctx).finally(() => {
							listing = false;
						});
						return { consume: true };
					}
				}
				if (hinted.size === 0 || !matchesKey(data, Key.ctrl("b"))) return undefined;
				for (const move of [...hinted.values()]) move();
				return { consume: true };
			});
		}
		for (const entry of ctx.sessionManager.getBranch()) {
			const msg = entry.type === "message" ? (entry.message as any) : undefined;
			const n = Number(/^bg(\d+)$/.exec(msg?.role === "toolResult" && msg.toolName === "bg_run" ? String(msg.details?.id) : "")?.[1]);
			if (n >= reg.next) reg.next = n + 1;
		}
		// After a reload, the jobs that carried on show again, and their clock starts ticking
		showJobs();
	});

	// This copy reports on jobs from now on; the ones that ended between copies are reported first
	reg.live = {
		wake: deliver,
		redraw: showJobs,
		finished(job) {
			report(job, `Background job finished: ${summary(job)}\nLast lines:\n${tail(job.log, TAIL_LINES)}`, {
				headline: `${job.id} ${job.status === "exited" ? `exited ${job.exitCode}` : job.status} · ${elapsed(job)}`,
				last: tail(job.log, 1),
				error: job.status !== "exited" || job.exitCode !== 0,
			});
		},
	};
	for (const job of reg.unreported.splice(0)) settle(job);

	pi.on("session_shutdown", async (event) => {
		clearInterval(ticker);
		for (const timer of holds.values()) clearTimeout(timer);
		holds.clear();
		reg.live = undefined;
		// A reload loads the extension again in this process, so its jobs carry on and the next copy takes them over.
		// Any other way out leaves the jobs without a session, so they stop.
		if (event.reason === "reload") return;
		for (const job of jobs.values()) {
			if (job.status === "running") job.controller.abort();
		}
		jobs.clear();
		reg.unreported.length = 0;
		reg.next = 1;
		reg.turn = 0;
	});
}
