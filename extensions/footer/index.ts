/**
 * Footer: one line with the project, model and effort, git branch and state, a context bar, the
 * prompt cache hit rate, the session's cost, whether a turn is running and for how long, and the
 * statuses other extensions set.
 *
 * When the window is narrow, the context bar shrinks first, then the least important segments go:
 * the project, the cache rate, the git details, the branch, the cost.
 *
 * Based on pi-context-bar by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md).
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, formatTokens, parseGitStatus, type GitState, usageTotals } from "./parts.ts";

const BAR_WIDTH = 20;
const MIN_BAR_WIDTH = 5;
const GIT_REFRESH_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;

type Turn = { state: "ready" } | { state: "working" | "compacting"; since: number };

export default function footerExtension(pi: ExtensionAPI) {
	let requestRender = () => {};
	let turn: Turn = { state: "ready" };
	let git: GitState | undefined;
	let gitRunning = false;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let clock: ReturnType<typeof setInterval> | undefined;

	function refreshGit(cwd: string) {
		if (gitRunning) return;
		gitRunning = true;
		execFile("git", ["status", "--porcelain=v2", "--branch"], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			gitRunning = false;
			const next = error ? undefined : parseGitStatus(stdout);
			if (JSON.stringify(next) !== JSON.stringify(git)) {
				git = next;
				requestRender();
			}
		});
	}

	function setTurn(next: Turn) {
		turn = next;
		if (clock) clearInterval(clock);
		clock = next.state === "ready" ? undefined : setInterval(() => requestRender(), 1000);
		requestRender();
	}

	pi.on("thinking_level_select", async () => requestRender());
	pi.on("model_select", async () => requestRender());
	pi.on("agent_start", async () => setTurn({ state: "working", since: Date.now() }));
	pi.on("agent_settled", async (_event, ctx) => {
		setTurn({ state: "ready" });
		refreshGit(ctx.cwd);
	});
	pi.on("session_before_compact", async () => {
		setTurn({ state: "compacting", since: Date.now() });
		return undefined;
	});
	const afterCompact = async () => setTurn(turn.state === "compacting" ? { state: "ready" } : turn);
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

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
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
					return [renderFooter(ctx, pi, theme, footerData, { git, turn }, width)];
				},
			};
		});
	});
}

type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0] & object>[1];
type FooterData = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0] & object>[2];

/** What goes first when the line is too wide, after the context bar has shrunk. */
const DROP_ORDER = ["project", "cache", "git details", "branch", "cost"] as const;
type Droppable = (typeof DROP_ORDER)[number];

function renderFooter(ctx: ExtensionContext, pi: ExtensionAPI, theme: Theme, footerData: FooterData, state: { git: GitState | undefined; turn: Turn }, width: number): string {
	const { cost, cacheRate } = usageTotals(ctx.sessionManager.getBranch());

	const usage = ctx.getContextUsage();
	const used = usage?.tokens ?? 0;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// percent is null when the token count is unknown, such as right after compaction.
	const percent = Math.min(100, Math.max(0, usage?.percent ?? (contextWindow > 0 ? (used / contextWindow) * 100 : 0)));
	const barColor = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
	const filled = (size: number) => Math.round((percent / 100) * size);

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
	const { turn } = state;

	const separator = theme.fg("dim", " │ ");
	const dropped = new Set<Droppable>();
	const line = (barSize: number) =>
		[
			dropped.has("project") ? "" : theme.fg("text", path.basename(ctx.cwd)),
			theme.fg("accent", `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "none"}`) + thinking,
			dropped.has("branch") ? "" : branch ? theme.fg("mdLink", `⎇ ${branch}`) + (dropped.has("git details") ? "" : gitDetails) : theme.fg("dim", "no git"),
			theme.fg("muted", "Context: [") +
				theme.fg(barColor, "█".repeat(filled(barSize))) +
				theme.fg("dim", "░".repeat(barSize - filled(barSize))) +
				theme.fg("muted", "] ") +
				theme.fg("mdCode", `${formatTokens(used)}/${formatTokens(contextWindow)}`) +
				theme.fg(barColor, ` (${percent.toFixed(0)}%)`),
			cacheRate === undefined || dropped.has("cache") ? "" : theme.fg("muted", "cache ") + theme.fg(cacheColor, `${cacheRate.toFixed(0)}%`),
			(free && cost === 0) || dropped.has("cost") ? "" : theme.fg("success", `$${cost.toFixed(3)}`),
			turn.state === "ready" ? theme.fg("dim", "○ ready") : theme.fg("accent", `● ${turn.state} ${formatElapsed(Date.now() - turn.since)}`),
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
