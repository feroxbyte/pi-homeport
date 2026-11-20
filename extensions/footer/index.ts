/**
 * Footer: one line with
 *
 * - the project folder, the model and its effort;
 * - the git branch, `*` for uncommitted changes, and `↑2 ↓1` for commits ahead of or behind the
 *   upstream as of the last fetch;
 * - a context bar with a mark where auto-compaction starts;
 * - the prompt cache hit rate of the last response, and the session's cost;
 * - `● working 12s · ~48 tok/s` during a turn, `○ ready · 1.2k out · 52 tok/s` after it.
 *
 * Statuses other extensions set follow when there's room. When the window is narrow, the context
 * bar shrinks first, then segments go in `DROP_ORDER`.
 *
 * Based on pi-context-bar by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md).
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	compactionPoint,
	formatElapsed,
	formatTokens,
	type GitState,
	outputTokensSince,
	parseGitStatus,
	usageTotals,
} from "./parts.ts";

const BAR_WIDTH = 20;
const MIN_BAR_WIDTH = 5;
const GIT_REFRESH_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;

/** What goes first when the line is too wide, after the context bar has shrunk. */
const DROP_ORDER = ["project", "turn details", "cache", "git details", "branch", "cost"] as const;
type Droppable = (typeof DROP_ORDER)[number];


type Turn = { state: "ready" } | { state: "working" | "compacting"; since: number };

interface LastTurn {
	ms: number;
	output: number;
	/** Output tokens per second while the model was streaming. */
	rate: number | undefined;
}

interface State {
	git: GitState | undefined;
	turn: Turn;
	lastTurn: LastTurn | undefined;
	/** Estimated output tokens per second of the message streaming now. */
	liveRate: number | undefined;
	compaction: { enabled: boolean; reserveTokens: number } | undefined;
}

export default function footerExtension(pi: ExtensionAPI) {
	let requestRender = () => {};
	const state: State = {
		git: undefined,
		turn: { state: "ready" },
		lastTurn: undefined,
		liveRate: undefined,
		compaction: undefined,
	};
	let gitRunning = false;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let clock: ReturnType<typeof setInterval> | undefined;
	/** Where the running turn started in the session branch, to count its output tokens. */
	let turnStart = 0;
	/** The streaming message: when its first delta came, and the characters so far. */
	let stream: { since: number; chars: number } | undefined;
	/** Milliseconds spent streaming in the running turn. */
	let streamedMs = 0;

	function refreshGit(cwd: string) {
		if (gitRunning) return;
		gitRunning = true;
		execFile("git", ["status", "--porcelain=v2", "--branch"], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			gitRunning = false;
			const next = error ? undefined : parseGitStatus(stdout);
			if (JSON.stringify(next) !== JSON.stringify(state.git)) {
				state.git = next;
				requestRender();
			}
		});
	}

	function setTurn(next: Turn) {
		state.turn = next;
		if (clock) clearInterval(clock);
		clock = next.state === "ready" ? undefined : setInterval(() => requestRender(), 1000);
		requestRender();
	}

	pi.on("thinking_level_select", async () => requestRender());
	pi.on("model_select", async (_event, ctx) => {
		readCompaction(ctx);
		requestRender();
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnStart = ctx.sessionManager.getBranch().length;
		streamedMs = 0;
		stream = undefined;
		state.liveRate = undefined;
		setTurn({ state: "working", since: Date.now() });
	});
	pi.on("message_update", async (event) => {
		const update = event.assistantMessageEvent as { type?: string; delta?: unknown };
		if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type ?? "") || typeof update.delta !== "string") return;
		stream ??= { since: Date.now(), chars: 0 };
		stream.chars += update.delta.length;
		const seconds = (Date.now() - stream.since) / 1000;
		// About four characters per token; replaced by the real count when the message ends.
		if (seconds >= 1) state.liveRate = stream.chars / 4 / seconds;
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || !stream) return undefined;
		streamedMs += Date.now() - stream.since;
		stream = undefined;
		return undefined;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.turn.state === "working") {
			const output = outputTokensSince(ctx.sessionManager.getBranch(), turnStart);
			state.lastTurn = { ms: Date.now() - state.turn.since, output, rate: streamedMs >= 500 && output > 0 ? output / (streamedMs / 1000) : undefined };
		}
		state.liveRate = undefined;
		setTurn({ state: "ready" });
		refreshGit(ctx.cwd);
	});

	pi.on("session_before_compact", async () => {
		setTurn({ state: "compacting", since: Date.now() });
		return undefined;
	});
	const afterCompact = async () => setTurn(state.turn.state === "compacting" ? { state: "ready" } : state.turn);
	pi.on("session_compact", afterCompact);
	pi.on("session_compact_failed", afterCompact);

	pi.on("tool_result", async (event, ctx) => {
		if (["edit", "write", "bash"].includes(event.toolName)) refreshGit(ctx.cwd);
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		if (gitTimer) clearInterval(gitTimer);
		if (clock) clearInterval(clock);
	});

	function readCompaction(ctx: ExtensionContext) {
		try {
			state.compaction = SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings(ctx.model);
		} catch {
			state.compaction = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		readCompaction(ctx);
		refreshGit(ctx.cwd);
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = setInterval(() => refreshGit(ctx.cwd), GIT_REFRESH_MS);
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => {
				refreshGit(ctx.cwd);
				tui.requestRender();
			});
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					return [renderFooter(ctx, pi, theme, footerData, state, width)];
				},
			};
		});
	});
}

type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0] & object>[1];
type FooterData = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0] & object>[2];

function renderFooter(ctx: ExtensionContext, pi: ExtensionAPI, theme: Theme, footerData: FooterData, state: State, width: number): string {
	const now = Date.now();
	const { cost, cacheRate } = usageTotals(ctx.sessionManager.getBranch());

	const usage = ctx.getContextUsage();
	const used = usage?.tokens ?? 0;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// percent is null when the token count is unknown, such as right after compaction.
	const percent = Math.min(100, Math.max(0, usage?.percent ?? (contextWindow > 0 ? (used / contextWindow) * 100 : 0)));
	const barColor = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
	const compactAt = compactionPoint(contextWindow, state.compaction);
	const bar = (size: number) => {
		const filled = Math.round((percent / 100) * size);
		// The cell where auto-compaction starts, drawn as a mark unless the bar has passed it.
		const mark = compactAt === undefined ? -1 : Math.min(size - 1, Math.floor(compactAt * size));
		let out = "";
		for (let cell = 0; cell < size; cell++) {
			if (cell === mark && cell >= filled) out += theme.fg("warning", "┊");
			else out += cell < filled ? theme.fg(barColor, "█") : theme.fg("dim", "░");
		}
		return out;
	};

	// The thinking level only means something for models that can think.
	const thinking = ctx.model?.reasoning ? theme.fg("muted", ` · ${pi.getThinkingLevel()}`) : "";
	const branch = state.git?.branch ?? footerData.getGitBranch();
	const git = state.git;
	const gitDetails = git
		? (git.dirty ? theme.fg("warning", "*") : "") + (git.ahead ? theme.fg("muted", ` ↑${git.ahead}`) : "") + (git.behind ? theme.fg("muted", ` ↓${git.behind}`) : "")
		: "";
	const cacheColor = cacheRate === undefined ? "dim" : cacheRate >= 80 ? "success" : cacheRate >= 40 ? "warning" : "error";
	// A local or otherwise free model has no prices, so a cost that's still $0 says nothing.
	const free = !ctx.model?.cost?.input && !ctx.model?.cost?.output;

	const turn = (details: boolean) => {
		const { turn: current, lastTurn, liveRate } = state;
		if (current.state !== "ready") {
			const speed = details && current.state === "working" && liveRate !== undefined ? ` · ~${liveRate.toFixed(0)} tok/s` : "";
			return theme.fg("accent", `● ${current.state} ${formatElapsed(now - current.since)}${speed}`);
		}
		if (!details || !lastTurn) return theme.fg("dim", "○ ready");
		// The turn's length is in the chat's "Worked for" line, so the footer keeps to tokens and speed.
		const parts = [`${formatTokens(lastTurn.output)} out`, ...(lastTurn.rate !== undefined ? [`${lastTurn.rate.toFixed(0)} tok/s`] : [])];
		return theme.fg("dim", `○ ready · ${parts.join(" · ")}`);
	};

	const separator = theme.fg("dim", " │ ");
	const dropped = new Set<Droppable>();
	const line = (barSize: number) =>
		[
			dropped.has("project") ? "" : theme.fg("text", path.basename(ctx.cwd)),
			theme.fg("accent", `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "none"}`) + thinking,
			dropped.has("branch") ? "" : branch ? theme.fg("mdLink", `⎇ ${branch}`) + (dropped.has("git details") ? "" : gitDetails) : theme.fg("dim", "no git"),
			theme.fg("muted", "Context: [") +
				bar(barSize) +
				theme.fg("muted", "] ") +
				theme.fg("mdCode", `${formatTokens(used)}/${formatTokens(contextWindow)}`) +
				theme.fg(barColor, ` (${percent.toFixed(0)}%)`),
			cacheRate === undefined || dropped.has("cache") ? "" : theme.fg("muted", "cache ") + theme.fg(cacheColor, `${cacheRate.toFixed(0)}%`),
			(free && cost === 0) || dropped.has("cost") ? "" : theme.fg("success", `$${cost.toFixed(3)}`),
			turn(!dropped.has("turn details")),
		]
			.filter(Boolean)
			.join(separator);

	// Shrink the bar first, then drop segments, least important first.
	let barSize = BAR_WIDTH;
	while (visibleWidth(line(barSize)) > width && barSize > MIN_BAR_WIDTH) barSize--;
	for (const segment of DROP_ORDER) {
		if (visibleWidth(line(barSize)) <= width) break;
		dropped.add(segment);
	}

	// Other extensions' statuses go last, sorted by key, when they fit whole.
	let out = line(barSize);
	const statuses = [...footerData.getExtensionStatuses()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	for (const status of statuses) {
		if (visibleWidth(out + separator + status) > width) break;
		out += separator + status;
	}
	return truncateToWidth(out, width);
}
