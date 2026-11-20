/**
 * The pure half of `/goal`: the directive a new goal starts with, the evaluator's prompt, the
 * transcript the evaluator reads, verdict parsing, which errors clear, retry or pause a goal, the
 * check-in schedule, and the status text. No pi state lives here, so each rule can be tested alone.
 *
 * Based on pi-code's internal/goal-evaluator.ts by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md).
 * The prompts are reworded from Claude's documentation (https://code.claude.com/docs/en/goal.md and
 * https://code.claude.com/docs/en/hooks.md#prompt-based-hooks), and the retry and pause rules,
 * the Stop hook block cap and Claude's stricter reading of `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` are added.
 */

/** Claude caps a goal condition at 4,000 characters. */
export const GOAL_CONDITION_MAX_CHARS = 4000;

/** `/goal clear` and its documented aliases, matched case-insensitively. */
const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export function isClearAlias(text: string): boolean {
	return CLEAR_ALIASES.has(text.toLowerCase());
}

/** The directive a set goal starts its first turn with: the condition itself is the task. */
export function kickoffPrompt(condition: string): string {
	return [
		`The user set a goal for this session: ${condition}`,
		"Work toward it now, treating the goal itself as your instructions; don't stop to ask what to do. After each of your turns a separate check reads the conversation and decides whether the goal is met, so show the evidence (run the tests, print the result) in your output. You keep getting turns until it is met.",
		"The goal clears itself once it is met; `/goal clear` is only for stopping early, so don't suggest it after success.",
	].join("\n\n");
}

/** The evaluator's instructions: judge from the transcript alone, answer with one of the three
 * verdicts Claude documents, and keep "impossible" for a condition that can never hold. */
export const EVALUATOR_SYSTEM = [
	"You check whether a coding agent has met a condition the user set. You see the conversation so far, and nothing else: you can't run commands or read files.",
	"Reply with one JSON object, in one of these shapes:",
	'- {"ok": true, "reason": "<the evidence in the conversation that the condition holds>"}',
	'- {"ok": false, "reason": "<what is still missing or failing>"}',
	'- {"ok": false, "impossible": true, "reason": "<why the condition can never hold in this session>"}',
	'Quote the conversation in the reason where you can. Without clear evidence that the condition holds, answer {"ok": false} and say what evidence is missing.',
	'Answer "impossible" only when the condition can\'t be met in this session: it contradicts itself, it needs something that isn\'t available, or every reasonable approach has been tried and failed. The agent saying it\'s impossible is evidence, not proof; judge for yourself. Slow progress is not impossible. When in doubt, leave "impossible" out.',
	// Claude pins the reply with a JSON schema; pi's one-off completion can't, so the instruction
	// carries that weight.
	"Output only the JSON object, with no text around it and no code fence.",
].join("\n");

/** The evaluation request: the transcript, then the condition to judge. */
export function evaluatorPrompt(transcript: string, condition: string): string {
	return `<transcript>\n${transcript}\n</transcript>\n\nJudging only from the transcript above, is this condition met?\nCondition: ${condition}`;
}

export interface GoalVerdict {
	ok: boolean;
	reason: string;
	/** Only meaningful when ok is false: the condition can never be satisfied. */
	impossible: boolean;
}

/** A reply with no JSON at all but an opening yes/no: a small model answering the
 * question in prose. The whole reply becomes the reason. Anything less clear-cut is
 * not a verdict. */
function proseVerdict(text: string): GoalVerdict | undefined {
	const lead = /^\s*(yes|no)\b/i.exec(text)?.[1]?.toLowerCase();
	if (lead === undefined) return undefined;
	return { ok: lead === "yes", reason: text.trim(), impossible: false };
}

/** The evaluator's JSON verdict, tolerating prose or a code fence around the object; a
 * reply with no object at all falls back to its yes/no lead. Undefined when the object
 * does not parse, `ok` is not a boolean, or no lead is there, which the caller treats
 * as an evaluator error rather than a verdict. */
export function parseVerdict(text: string): GoalVerdict | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1) return proseVerdict(text);
	if (end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { ok, reason, impossible } = parsed as Record<string, unknown>;
	if (typeof ok !== "boolean") return undefined;
	return { ok, reason: typeof reason === "string" ? reason.trim() : "", impossible: !ok && impossible === true };
}

/** One message's rendering is capped so a single tool dump cannot consume the budget. */
const BLOCK_MAX_CHARS = 6000;
/** Tool arguments are context, not evidence; a short prefix identifies the call. */
const TOOL_ARGS_MAX_CHARS = 400;
const OMITTED_MARKER = "[earlier transcript omitted]";

interface ContentPart {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

interface TranscriptMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
	customType?: string;
	stopReason?: string;
	errorMessage?: string;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

/** Text and tool-call parts of a content value; thinking is dropped, images noted. */
function partsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const rendered: string[] = [];
	for (const part of content as ContentPart[]) {
		if (part?.type === "text" && typeof part.text === "string") rendered.push(part.text);
		else if (part?.type === "image") rendered.push("[image]");
		else if (part?.type === "toolCall") rendered.push(`[tool call ${part.name}(${truncate(JSON.stringify(part.arguments ?? {}), TOOL_ARGS_MAX_CHARS)})]`);
	}
	return rendered.join("\n");
}

function renderMessage(message: TranscriptMessage): string | undefined {
	switch (message.role) {
		case "user":
			return `User: ${partsText(message.content)}`;
		case "assistant": {
			const body = message.stopReason === "error" ? `[error: ${message.errorMessage ?? "unknown error"}]` : partsText(message.content);
			return `Assistant: ${body}`;
		}
		case "toolResult":
			return `Tool result (${message.toolName ?? "tool"}): ${partsText(message.content)}`;
		case "custom":
			return `Note (${message.customType ?? "note"}): ${partsText(message.content)}`;
		default:
			return undefined;
	}
}

/**
 * The conversation as the evaluator reads it: one block per message, newest last,
 * trimmed from the head to `budgetChars` (Claude trims to half the evaluator's
 * context window). A cut is marked so the model knows evidence may predate it; the
 * newest message always survives, cut to the budget when it alone exceeds it.
 */
export function renderTranscript(messages: readonly unknown[], budgetChars: number): string {
	const blocks: string[] = [];
	for (const message of messages as TranscriptMessage[]) {
		const rendered = renderMessage(message);
		if (rendered !== undefined) blocks.push(truncate(rendered, BLOCK_MAX_CHARS));
	}
	const newest = blocks.at(-1);
	if (newest === undefined) return "";
	const separator = "\n\n";
	const kept: string[] = [];
	let used = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const cost = blocks[i].length + (kept.length > 0 ? separator.length : 0);
		if (used + cost > budgetChars) {
			if (kept.length > 0) kept.unshift(OMITTED_MARKER);
			break;
		}
		kept.unshift(blocks[i]);
		used += cost;
	}
	if (kept.length === 0) return newest.slice(0, budgetChars);
	return kept.join(separator);
}

export type UnrecoverableKind = "authentication" | "credits" | "context overflow" | "model unavailable";

/** Claude clears a goal after an error the user has to fix. Transient failures (rate
 * limits, overloads, network) deliberately match nothing so the goal stays set. */
const UNRECOVERABLE: ReadonlyArray<[UnrecoverableKind, RegExp]> = [
	["authentication", /\b40[13]\b|unauthori[sz]ed|authentication|invalid (?:api[ -])?key|x-api-key/i],
	["credits", /\bcredit|billing|insufficient[ _](?:funds|balance|quota)|payment required|\b402\b/i],
	["context overflow", /context (?:window|length)|too (?:long|many tokens)|maximum (?:context|input) (?:length|tokens)/i],
	["model unavailable", /model.*(?:not found|unavailable|does not exist|not available|unsupported)|no such model|not_found_error|\b404\b/i],
];

export function classifyUnrecoverable(errorMessage: string): UnrecoverableKind | undefined {
	return UNRECOVERABLE.find(([, pattern]) => pattern.test(errorMessage))?.[0];
}

/** Failures that tend to clear on their own: an overloaded or failing server, a dropped connection. */
const TRANSIENT =
	/overload|\b5\d\d\b|server error|internal error|bad gateway|unavailable|timed? ?out|timeout|econnreset|econnrefused|etimedout|socket hang up|network|connection|fetch failed|stream/i;
/** Failures a retry would only repeat: rate and usage limits. */
const LIMITS = /rate[ _-]?limit|\b429\b|too many requests|usage limit|quota/i;

/** What Claude does with a failed turn that doesn't clear the goal: retry a failure that tends to
 * clear on its own, and pause on one a retry would only repeat. */
export function classifyFailure(errorMessage: string): "retry" | "pause" {
	if (LIMITS.test(errorMessage)) return "pause";
	return TRANSIENT.test(errorMessage) ? "retry" : "pause";
}

/** Automatic retries before a goal pauses instead. */
export const MAX_GOAL_RETRIES = 3;

/** How long a goal waits before its next automatic retry: 30 seconds, doubling. */
export function retryDelayMs(attempt: number): number {
	return 30_000 * 2 ** Math.max(0, attempt - 1);
}

/** A whole number of minutes or turns in plain digits, as Claude reads these variables; anything
 * else is unset. */
function plainCount(value: string | undefined, max: number): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const count = Number(value.trim());
	return count <= max ? count : undefined;
}

/** Not-met verdicts in a row on turns without a tool call before the loop stops:
 * `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 8 by default, 0 for no cap. */
export function stopHookBlockCap(env: Record<string, string | undefined>): number {
	return plainCount(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, Number.MAX_SAFE_INTEGER) ?? 8;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface GoalSummary {
	condition: string;
	durationMs: number;
	/** Turns the evaluator has judged. */
	iterations: number;
	/** Tokens spent since the goal was set, evaluator calls included. */
	tokens: number;
	lastReason?: string;
}

/** Claude's status view fields: duration, turn count, and token spend. */
export function summaryText(summary: GoalSummary): string {
	return `${formatDuration(summary.durationMs)} · ${plural(summary.iterations, "turn")} · ${formatTokens(summary.tokens)} tokens`;
}

export const NO_GOAL_TEXT = "No goal set. Usage: /goal <condition>";

export function formatActiveGoal(summary: GoalSummary): string {
	// Claude shows the turn count and the last reason once the first evaluation has run.
	const turns = summary.iterations === 0 ? "" : ` (${plural(summary.iterations, "turn")})`;
	const lines = [`Goal active: ${summary.condition}${turns}`, `Running for ${formatDuration(summary.durationMs)} · ${formatTokens(summary.tokens)} tokens`];
	if (summary.lastReason) lines.push(`Last check: ${summary.lastReason}`);
	lines.push("/goal clear to stop early");
	return lines.join("\n");
}

export function formatAchievedGoal(summary: GoalSummary): string {
	return `Goal achieved: ${summary.condition} (${summaryText(summary)})\n/goal <condition> to set another`;
}

/** Claude's first check-in interval while background work keeps a goal waiting. */
export const DEFAULT_CHECKIN_MINUTES = 30;
/** Later check-ins wait twice as long each, up to four times the first interval. */
const MAX_CHECKIN_DOUBLINGS = 2;
/** Idle check-ins per goal between user prompts; the third says they are paused. */
export const MAX_IDLE_CHECKINS = 3;

/** The first check-in interval in minutes: `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` in whole minutes up to a
 * week, 0 to turn check-ins and automatic retries off; any other value is the default. */
export function checkinMinutes(env: Record<string, string | undefined>): number {
	return plainCount(env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES, 10_080) ?? DEFAULT_CHECKIN_MINUTES;
}

/** Milliseconds until the next check-in given how many have been delivered for this goal: the first
 * interval, doubling up to four times it. 0 means check-ins are off. */
export function checkinIntervalMs(env: Record<string, string | undefined>, delivered: number): number {
	return checkinMinutes(env) * 60_000 * 2 ** Math.min(delivered, MAX_CHECKIN_DOUBLINGS);
}

export interface RunningWork {
	id: string;
	/** What it is, such as `subagent reviewer` or `background shell`. */
	kind: string;
}

/** Claude's check-in turn: the running work to look at, or a nudge to continue when
 * the work stopped without reporting. `paused` marks the capped idle check-in. */
export function checkinText(condition: string, deferredMs: number, running: readonly RunningWork[], paused: boolean): string {
	const minutes = Math.max(1, Math.round(deferredMs / 60_000));
	const pausedNote = paused ? " Idle check-ins are paused until your next message, so say clearly where things stand." : "";
	if (running.length === 0) {
		return `Goal check-in: «${condition}» is still active. Its evaluation was deferred for ${minutes} min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal.${pausedNote}`;
	}
	const list = running.map((work) => `- ${work.id} · ${work.kind}`).join("\n");
	return `Goal check-in: «${condition}» is still active, and evaluation has been deferred for ${minutes} min because background work is still running:\n${list}\nCheck on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.${pausedNote}`;
}
