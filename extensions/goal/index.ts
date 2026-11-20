/**
 * `/goal`, as in Claude Code (https://code.claude.com/docs/en/goal.md): a completion condition the
 * session keeps working toward. After each turn a separate evaluation reads the conversation and
 * judges the condition met, not yet met (its reason guides the next turn), or impossible.
 *
 * - `/goal <condition>` sets or replaces the goal (up to 4,000 characters) and starts a turn with
 *   the condition as the directive. `/goal` shows the goal, how long it has run, the turns
 *   evaluated, the tokens spent and the last reason, or the last achieved goal. `/goal clear` (or
 *   `stop`, `off`, `reset`, `none`, `cancel`) removes it. The footer shows `◎ /goal active` with the
 *   time it has run, and each verdict shows in the transcript, with its reason on ctrl+o.
 * - Claude runs it as a prompt-based Stop hook. Here the check runs at pi's own boundary for that,
 *   `agent_before_settle`, which can ask for one more turn. The evaluator runs on the session's
 *   model, or on `ANTHROPIC_DEFAULT_HAIKU_MODEL` when that names a model pi can use, as Claude reads
 *   it. It can't run tools, so it judges only what the conversation shows.
 * - Several not-met verdicts in a row on turns without a tool call (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`,
 *   8 by default) pause the loop with the goal still set; your next message resumes it.
 * - A turn that fails on an error you have to fix (authentication, credits, context overflow, a
 *   missing model) clears the goal. In an interactive session any other failure retries on its
 *   own, three times at most, or pauses the goal when a retry would only repeat it (a rate limit).
 * - While a subagent run from pi-subagents or a background command from the background extension is
 *   still going, a turn isn't evaluated. After `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` (30) of that, a
 *   check-in turn asks the model to look at the work, then again at double the interval, up to four
 *   times it; idle sessions get at most three such turns between your messages. 0 turns check-ins
 *   and retries off.
 * - An active goal is restored on resume with its turn count, timer and token baseline reset.
 * - As in Claude, `/goal` is unavailable when `disableAllHooks` is on, when managed settings set
 *   `allowManagedHooksOnly`, or in an interactive session in a project pi doesn't trust.
 * - `pi -p "/goal ..."` keeps running until the goal resolves or pauses.
 *
 * Based on pi-code's goal extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), moved from
 * `agent_end` to `agent_before_settle`, reading Claude's settings through the shared reader, and
 * with the retry and pause behavior Claude added later.
 */

import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { booleanSetting, readClaudeSetup } from "../shared/claude.ts";
import {
	checkinIntervalMs,
	checkinMinutes,
	checkinText,
	classifyFailure,
	classifyUnrecoverable,
	EVALUATOR_SYSTEM,
	evaluatorPrompt,
	formatAchievedGoal,
	formatActiveGoal,
	formatDuration,
	formatTokens,
	GOAL_CONDITION_MAX_CHARS,
	type GoalSummary,
	type GoalVerdict,
	isClearAlias,
	kickoffPrompt,
	MAX_GOAL_RETRIES,
	MAX_IDLE_CHECKINS,
	NO_GOAL_TEXT,
	parseVerdict,
	type RunningWork,
	renderTranscript,
	retryDelayMs,
	stopHookBlockCap,
	summaryText,
} from "./evaluator.ts";

/** The session entry the goal's state persists under, and the custom message type of its
 * transcript lines (kickoff, verdicts, check-ins). */
const GOAL_ENTRY = "goal";
const GOAL_MESSAGE = "goal";
/** Claude's default timeout for a prompt hook. */
const EVALUATOR_TIMEOUT_MS = 30_000;
/** Claude trims the transcript to half the evaluator's context window. */
const TRANSCRIPT_WINDOW_SHARE = 0.5;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const INDICATOR_REFRESH_MS = 15_000;

export const HOOKS_GATE = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in Claude's settings).";
export const TRUST_GATE = "/goal is only available in trusted projects. Trust this project in pi (/trust) and try again.";

/** pi-subagents' events for background subagent runs (docs/observability.md in that package). */
const SUBAGENT_STARTED = "subagent:async-started";
const SUBAGENT_COMPLETE = "subagent:async-complete";
/** What the background extension publishes about its running jobs. */
const BACKGROUND_JOBS = Symbol.for("pi-homeport.background");

type GoalState = "active" | "cleared" | "achieved" | "failed";

interface GoalEntry {
	state: GoalState;
	condition: string;
}

/** What the goal's transcript lines carry for drawing: a one-line head, and more on ctrl+o. */
export interface GoalMessageDetails {
	head: string;
	body?: string;
	level?: "accent" | "success" | "warning" | "error";
}

interface ActiveGoal {
	condition: string;
	setAt: number;
	iterations: number;
	lastReason?: string;
	/** The session's token total when the goal was set; spend counts from here. */
	tokensAtStart: number;
	/** Evaluator calls aren't in the session's totals, so they're added here. */
	evaluatorTokens: number;
}

interface TokenUsage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function usageTokens(usage: TokenUsage | undefined): number {
	if (!usage) return 0;
	return usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

type SessionReader = Pick<ExtensionContext, "sessionManager">;

/** The branch as the evaluator reads it: messages, plus the goal's own lines in custom messages. */
function branchMessages(ctx: SessionReader): unknown[] {
	const messages: unknown[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") messages.push(entry.message);
		else if (entry.type === "custom_message") messages.push({ role: "custom", customType: entry.customType, content: entry.content });
	}
	return messages;
}

function sessionTokens(ctx: SessionReader): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") total += usageTokens(entry.message.usage as TokenUsage | undefined);
	}
	return total;
}

/** The newest goal entry on the branch: the goal's persisted state. */
function lastGoalEntry(ctx: SessionReader): GoalEntry | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
		const data = entry.data as Partial<GoalEntry> | undefined;
		return typeof data?.condition === "string" && typeof data.state === "string" ? { state: data.state, condition: data.condition } : undefined;
	}
	return undefined;
}

/** Why `/goal` is unavailable here, or undefined when it can run. The evaluator is part of Claude's
 * hooks system, so the hooks restrictions apply, and the trust rule of hooks in settings files:
 * an interactive session needs a trusted project, a `-p` run doesn't. */
export function goalUnavailable(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "hasUI">,
	options: { home?: string; managedSettingsDir?: string } = {},
): string | undefined {
	const trusted = ctx.isProjectTrusted();
	const setup = readClaudeSetup({ cwd: ctx.cwd, trusted, ...options });
	if (booleanSetting(setup, "disableAllHooks") === true || setup.managedSettings.some((file) => file.allowManagedHooksOnly === true)) return HOOKS_GATE;
	if (ctx.hasUI && !trusted) return TRUST_GATE;
	return undefined;
}

type EvaluatorModel = NonNullable<ExtensionContext["model"]>;

/** The session's model, unless `ANTHROPIC_DEFAULT_HAIKU_MODEL` names one pi can use (`id` or `provider/id`). */
export function evaluatorModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, override = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()): EvaluatorModel | undefined {
	if (override) {
		const match = ctx.modelRegistry.getAvailable().find((model) => model.id === override || `${model.provider}/${model.id}` === override);
		if (match) return match;
	}
	return ctx.model;
}

/** The session's model registry, narrowed to the one call made here. */
interface Completer {
	streamSimple(model: Model<any>, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> };
}

/** One tool-less completion on the session's own runtime; throws when the provider fails. */
async function complete(registry: Completer, model: EvaluatorModel, prompt: string, signal: AbortSignal) {
	const context: Context = { systemPrompt: EVALUATOR_SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
	// Claude sets no output cap on the evaluator, so the model's own limit applies; a model without
	// a declared one (maxTokens 0) gets the provider's default.
	const message = await registry.streamSimple(model, context, { maxTokens: model.maxTokens > 0 ? model.maxTokens : undefined, signal }).result();
	if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `completion ${message.stopReason}`);
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	return { text, tokens: usageTokens(message.usage as TokenUsage) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shortDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function goalExtension(pi: ExtensionAPI) {
	let goal: ActiveGoal | undefined;
	/** The last goal achieved this session, for the status view after it clears. */
	let achieved: GoalSummary | undefined;
	/** The live context, for timers that fire outside any pi event. */
	let sessionCtx: ExtensionContext | undefined;
	/** Bumped whenever the goal is set, cleared or the session changes, so a late verdict is dropped. */
	let generation = 0;
	/** Whether the run now ending called a tool: Claude's progress for the block cap. */
	let turnUsedTools = false;
	let noProgressStreak = 0;
	/** Paused by the block cap or a failure: no evaluation until your next message. */
	let paused = false;
	/** The error the last run ended on, judged once the run settles (after pi's own retries). */
	let lastTurnError: string | undefined;
	let retries = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Background subagent runs still going, by id. */
	const subagents = new Map<string, string>();
	let deferredSince: number | undefined;
	let checkinsDelivered = 0;
	let idleCheckins = 0;
	/** A check-in came due while a turn ran: it goes out when that turn ends. */
	let checkinDue = false;
	let checkinTimer: ReturnType<typeof setTimeout> | undefined;
	let indicatorTimer: ReturnType<typeof setInterval> | undefined;

	const line = (content: string, details: GoalMessageDetails) => ({ customType: GOAL_MESSAGE, content, display: true, details });

	/** A goal line in the transcript, which the model reads too. A timer can outlive its session, and
	 * sendMessage throws on a disposed one. */
	function send(content: string, details: GoalMessageDetails, options: { triggerTurn: boolean; deliverAs?: "followUp" }): void {
		try {
			pi.sendMessage(line(content, details), options);
		} catch {
			// Disposed session: nothing left to tell.
		}
	}

	/** A note for you. Headless runs have nowhere to show it, so it goes to stderr too. */
	function tell(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
		ctx.ui.notify(text, level);
		if (!ctx.hasUI) process.stderr.write(`${text}\n`);
	}

	function currentSummary(ctx: SessionReader): GoalSummary | undefined {
		if (!goal) return undefined;
		return {
			condition: goal.condition,
			durationMs: Date.now() - goal.setAt,
			iterations: goal.iterations,
			tokens: sessionTokens(ctx) - goal.tokensAtStart + goal.evaluatorTokens,
			lastReason: goal.lastReason,
		};
	}

	function showIndicator(ctx: ExtensionContext): void {
		// Print mode has no footer, and no theme to color one with.
		if (!goal || !ctx.hasUI) return;
		const state = paused ? "paused" : "active";
		ctx.ui.setStatus("goal", ctx.ui.theme.fg(paused ? "warning" : "accent", `◎ /goal ${state} ${shortDuration(Date.now() - goal.setAt)}`));
		if (!indicatorTimer) {
			indicatorTimer = setInterval(() => {
				if (sessionCtx) showIndicator(sessionCtx);
			}, INDICATOR_REFRESH_MS);
			indicatorTimer.unref?.();
		}
	}

	function stopTimers(): void {
		clearInterval(indicatorTimer);
		indicatorTimer = undefined;
		clearTimeout(checkinTimer);
		checkinTimer = undefined;
		clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function endDeferral(): void {
		deferredSince = undefined;
		checkinDue = false;
		clearTimeout(checkinTimer);
		checkinTimer = undefined;
	}

	function resetLoop(): void {
		noProgressStreak = 0;
		paused = false;
		retries = 0;
		checkinsDelivered = 0;
		idleCheckins = 0;
		clearTimeout(retryTimer);
		retryTimer = undefined;
		endDeferral();
	}

	/** Make `condition` the active goal with fresh counters; the caller writes the entry. */
	function activate(ctx: ExtensionContext, condition: string): void {
		goal = { condition, setAt: Date.now(), iterations: 0, tokensAtStart: sessionTokens(ctx), evaluatorTokens: 0 };
		generation += 1;
		resetLoop();
		showIndicator(ctx);
	}

	/** Drop the active goal, recording how it ended; returns its condition. */
	function endGoal(ctx: ExtensionContext, state: Exclude<GoalState, "active">): string | undefined {
		const ended = goal;
		if (!ended) return undefined;
		goal = undefined;
		generation += 1;
		resetLoop();
		stopTimers();
		ctx.ui.setStatus("goal", undefined);
		pi.appendEntry(GOAL_ENTRY, { state, condition: ended.condition } satisfies GoalEntry);
		return ended.condition;
	}

	function runningWork(): RunningWork[] {
		const work: RunningWork[] = [...subagents].map(([id, agent]) => ({ id, kind: `subagent ${agent}` }));
		const jobs = (globalThis as Record<symbol, { running?: () => number } | undefined>)[BACKGROUND_JOBS]?.running?.() ?? 0;
		if (jobs > 0) work.push({ id: "/bg", kind: `${jobs} background shell command${jobs === 1 ? "" : "s"}` });
		return work;
	}

	function checkinLine(last: boolean): CustomMessageEntryDraft | undefined {
		if (!goal) return undefined;
		checkinDue = false;
		checkinsDelivered += 1;
		const content = checkinText(goal.condition, Date.now() - (deferredSince ?? Date.now()), runningWork(), last);
		return { type: "custom_message", ...line(content, { head: "Goal check-in", body: content }) };
	}

	function onCheckinDue(): void {
		checkinTimer = undefined;
		if (!goal || !sessionCtx) return;
		// Due during a turn, it goes out when that turn ends; idle, it starts a turn of its own, up to
		// the cap between your messages.
		if (!sessionCtx.isIdle() || !sessionCtx.hasUI || idleCheckins >= MAX_IDLE_CHECKINS) {
			checkinDue = true;
			return;
		}
		idleCheckins += 1;
		const checkin = checkinLine(idleCheckins >= MAX_IDLE_CHECKINS);
		if (checkin) send(String(checkin.content), checkin.details as GoalMessageDetails, { triggerTurn: true });
		armCheckin();
	}

	function armCheckin(): void {
		if (checkinTimer || !goal) return;
		const ms = checkinIntervalMs(process.env, checkinsDelivered);
		if (ms <= 0) return;
		checkinTimer = setTimeout(onCheckinDue, ms);
		checkinTimer.unref?.();
	}

	async function evaluate(ctx: ExtensionContext, active: ActiveGoal): Promise<GoalVerdict | string> {
		const model = evaluatorModel(ctx);
		if (!model) return "the evaluator has no model to run on";
		const transcript = renderTranscript(branchMessages(ctx), Math.floor((model.contextWindow || DEFAULT_CONTEXT_WINDOW) * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN));
		const deadline = AbortSignal.timeout(EVALUATOR_TIMEOUT_MS);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
		try {
			const { text, tokens } = await complete(ctx.modelRegistry as unknown as Completer, model, evaluatorPrompt(transcript, active.condition), signal);
			active.evaluatorTokens += tokens;
			return parseVerdict(text) ?? `unreadable verdict: ${text.slice(0, 200)}`;
		} catch (error) {
			return errorMessage(error);
		}
	}

	/** The transcript line for a verdict, and whether the goal continues with another turn. */
	function applyVerdict(ctx: ExtensionContext, active: ActiveGoal, verdict: GoalVerdict): { draft: CustomMessageEntryDraft; continue: boolean } {
		active.iterations += 1;
		active.lastReason = verdict.reason;
		retries = 0;
		if (verdict.ok || verdict.impossible) {
			const summary = currentSummary(ctx);
			if (verdict.ok && summary) achieved = summary;
			endGoal(ctx, verdict.ok ? "achieved" : "failed");
			const head = verdict.ok ? `Goal achieved (${summary ? summaryText(summary) : ""}): ${active.condition}` : `Goal could not be achieved: ${active.condition}`;
			const content = verdict.reason ? `${head}\nEvaluator: ${verdict.reason}` : head;
			return { draft: { type: "custom_message", ...line(content, { head, body: verdict.reason, level: verdict.ok ? "success" : "error" }) }, continue: false };
		}
		noProgressStreak = turnUsedTools ? 0 : noProgressStreak + 1;
		const cap = stopHookBlockCap(process.env);
		const summary = currentSummary(ctx);
		const spent = summary ? ` · ${formatDuration(summary.durationMs)} · ${formatTokens(summary.tokens)} tokens` : "";
		const head = `Goal not yet met (turn ${active.iterations}${spent})`;
		const content = `${head}: ${verdict.reason}\nGoal: ${active.condition}`;
		if (cap > 0 && noProgressStreak >= cap) {
			noProgressStreak = 0;
			paused = true;
			showIndicator(ctx);
			tell(ctx, `Goal paused after ${cap} turns in a row without a tool call. It stays set, and evaluation resumes after your next message.`, "warning");
			return { draft: { type: "custom_message", ...line(content, { head, body: verdict.reason }) }, continue: false };
		}
		showIndicator(ctx);
		return { draft: { type: "custom_message", ...line(content, { head, body: verdict.reason }) }, continue: true };
	}

	function statusText(ctx: SessionReader): string {
		const summary = currentSummary(ctx);
		if (summary) return paused ? `${formatActiveGoal(summary)}\nPaused: send a message to continue` : formatActiveGoal(summary);
		if (achieved) return formatAchievedGoal(achieved);
		return NO_GOAL_TEXT;
	}

	pi.registerMessageRenderer<GoalMessageDetails>(GOAL_MESSAGE, (message, { expanded }, theme) => {
		const details = message.details;
		const head = theme.fg(details?.level ?? "accent", "◎ ") + theme.fg("toolTitle", details?.head ?? "Goal");
		const body = expanded ? (details?.body ?? (typeof message.content === "string" ? message.content : "")) : "";
		return {
			invalidate() {},
			render: (width: number) => [
				"",
				truncateToWidth(head, width),
				...(body ? wrapTextWithAnsi(body, Math.max(10, width - 5)).map((text, i) => (i === 0 ? `  ${theme.fg("dim", "⎿")}  ` : "     ") + theme.fg("dim", text)) : []),
			],
		};
	});

	pi.registerCommand("goal", {
		description: "Keep working until a condition is met: /goal <condition>, /goal for status, /goal clear to stop",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			const condition = args.trim();
			if (condition === "") {
				tell(ctx, statusText(ctx), "info");
				return;
			}
			if (isClearAlias(condition)) {
				const cleared = endGoal(ctx, "cleared");
				if (cleared === undefined) tell(ctx, "No goal set", "info");
				else send(`Goal cleared: ${cleared}`, { head: `Goal cleared: ${cleared}`, level: "warning" }, { triggerTurn: false });
				return;
			}
			if (condition.length > GOAL_CONDITION_MAX_CHARS) {
				tell(ctx, `A goal condition can be up to ${GOAL_CONDITION_MAX_CHARS} characters (this one has ${condition.length}).`, "error");
				return;
			}
			const blocked = goalUnavailable(ctx);
			if (blocked) {
				tell(ctx, blocked, "error");
				return;
			}
			activate(ctx, condition);
			pi.appendEntry(GOAL_ENTRY, { state: "active", condition } satisfies GoalEntry);
			const kickoff = kickoffPrompt(condition);
			send(kickoff, { head: `Goal set: ${condition}`, body: kickoff }, ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
			// `pi -p "/goal ..."` would exit when the command returns. The continuations extend the run,
			// so waiting for idle holds the process until the goal resolves or pauses, as Claude's -p does.
			if (!ctx.hasUI) await ctx.waitForIdle();
		},
	});

	pi.events.on(SUBAGENT_STARTED, (data) => {
		const event = data as { id?: unknown; agent?: unknown };
		if (typeof event?.id === "string") subagents.set(event.id, typeof event.agent === "string" ? event.agent : "run");
	});
	pi.events.on(SUBAGENT_COMPLETE, (data) => {
		const id = (data as { id?: unknown })?.id;
		if (typeof id === "string") subagents.delete(id);
	});

	pi.on("session_start", async (_event, ctx) => {
		// RPC mode can reuse one instance across sessions: nothing carries over but the saved state.
		sessionCtx = ctx;
		goal = undefined;
		achieved = undefined;
		generation += 1;
		turnUsedTools = false;
		lastTurnError = undefined;
		resetLoop();
		stopTimers();
		ctx.ui.setStatus("goal", undefined);
		const entry = lastGoalEntry(ctx);
		if (entry?.state !== "active") return;
		activate(ctx, entry.condition);
		tell(ctx, `Goal restored: ${entry.condition}`, "info");
	});

	pi.on("session_shutdown", async () => {
		stopTimers();
	});

	pi.on("agent_start", async () => {
		turnUsedTools = false;
	});

	pi.on("tool_execution_start", async () => {
		turnUsedTools = true;
	});

	pi.on("input", async (event) => {
		// Only your own messages count: goal turns and other extensions' prompts come from extensions.
		if (event.source === "extension") return;
		noProgressStreak = 0;
		idleCheckins = 0;
		retries = 0;
		clearTimeout(retryTimer);
		retryTimer = undefined;
		if (paused) {
			paused = false;
			if (sessionCtx) showIndicator(sessionCtx);
		}
		return undefined;
	});

	pi.on("agent_end", async (event) => {
		let last: { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		for (let i = event.messages.length - 1; i >= 0 && !last; i--) {
			const message = event.messages[i] as { role?: string };
			if (message?.role === "assistant") last = message;
		}
		lastTurnError = last?.stopReason === "error" ? (last.errorMessage ?? "unknown error") : undefined;
	});

	// Claude's Stop hook: after the turn, before pi settles. Returned entries join the transcript, and
	// `continue` starts the next turn as part of the same run.
	pi.on("agent_before_settle", async (event, ctx) => {
		sessionCtx = ctx;
		const active = goal;
		if (!active || paused || event.outcome !== "completed" || lastTurnError !== undefined) return undefined;
		if (runningWork().length > 0) {
			// Background work defers the verdict; a check-in that came due goes out now.
			deferredSince ??= Date.now();
			const checkin = checkinDue ? checkinLine(false) : undefined;
			armCheckin();
			return checkin ? { entries: [...event.entries, checkin], continue: true } : undefined;
		}
		endDeferral();
		const started = generation;
		const verdict = await evaluate(ctx, active);
		// Interrupted, cleared or replaced while the evaluator ran: this verdict no longer applies.
		if (ctx.signal?.aborted || generation !== started) return undefined;
		if (typeof verdict === "string") {
			// No verdict is a hook error in Claude's terms: the turn ends and the goal stays.
			tell(ctx, `Goal evaluator error: ${verdict}. The goal stays set; the next turn is evaluated again.`, "warning");
			return undefined;
		}
		const outcome = applyVerdict(ctx, active, verdict);
		return { entries: [...event.entries, outcome.draft], continue: event.continue || outcome.continue };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const message = lastTurnError;
		lastTurnError = undefined;
		if (!goal || message === undefined) return;
		const kind = classifyUnrecoverable(message);
		if (kind) {
			endGoal(ctx, "cleared");
			const text = `Goal cleared after an unrecoverable error (${kind}): "${message}". Run /goal again to continue.`;
			send(text, { head: text, level: "error" }, { triggerTurn: false });
			tell(ctx, text, "warning");
			return;
		}
		// Claude retries or pauses only in an interactive session; elsewhere the goal just stays set.
		if (!ctx.hasUI) return;
		if (checkinMinutes(process.env) > 0 && classifyFailure(message) === "retry" && retries < MAX_GOAL_RETRIES) {
			retries += 1;
			const delay = retryDelayMs(retries);
			tell(ctx, `Goal still active after an error ("${message}"). Retrying in ${Math.round(delay / 1000)}s (attempt ${retries} of ${MAX_GOAL_RETRIES}).`, "warning");
			const started = generation;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				if (!goal || generation !== started || !sessionCtx?.isIdle()) return;
				send(
					`The last turn failed ("${message}"). Continue working toward the goal: ${goal.condition}`,
					{ head: `Goal retry ${retries} of ${MAX_GOAL_RETRIES}` },
					{ triggerTurn: true },
				);
			}, delay);
			retryTimer.unref?.();
			return;
		}
		paused = true;
		showIndicator(ctx);
		tell(ctx, `Goal paused: "${message}". It stays set; send a message to continue.`, "warning");
	});
}
