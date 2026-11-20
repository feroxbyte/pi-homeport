/**
 * Thinking: `ultrathink` in a prompt asks for deeper reasoning on that turn, as in Claude Code
 * (https://code.claude.com/docs/en/model-config.md#use-ultrathink-for-one-off-deep-reasoning). The
 * turn runs at `xhigh` effort, or the model's highest level below it, and an instruction in context
 * asks the model to reason more deeply. When the turn ends the session's own level comes back,
 * unless you changed it meanwhile. The word stays in the prompt, and a level at or above `xhigh`
 * stays as it is.
 *
 * As in Claude Code, `ultrathink` is the only keyword ("think hard" is ordinary text); it counts only
 * outside quotes, brackets, code and paths, in a prompt that doesn't start with `/`; and
 * `CLAUDE_CODE_DISABLE_ULTRATHINK=1` turns it off. Prompts that extensions send don't count. Claude
 * raises the level only for a prompt typed in its terminal, IDE or desktop app, so a print run
 * (`pi -p`) gets the instruction alone.
 *
 * Based on pi-code's thinking extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), which
 * raised the turn to `max` and added no instruction.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** pi's thinking levels, lowest first. */
const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The level Claude raises an `ultrathink` turn to. */
const ULTRATHINK_LEVEL = "xhigh";

/** What the model reads after a prompt with the keyword. */
export const INSTRUCTION =
	'The user wrote "ultrathink" in this message to ask for deeper reasoning on this turn. Think the request through carefully and thoroughly before you act or answer.';

/** pi's skill block, which a typed skill sends ahead of what you typed. */
const SKILL_BLOCK = /^<skill name="[^"]*"[^>]*>[\s\S]*?<\/skill>\s*/;

/** Spans the keyword doesn't count in: code, quotes and brackets, each on one line except fenced code. */
const IGNORED = [
	/```[\s\S]*?```/g,
	/`[^`\n]*`/g,
	/"[^"\n]*"/g,
	/“[^”\n]*”/g,
	/‘[^’\n]*’/g,
	// A quote that opens and closes at word edges, so the apostrophes in "don't" and "it's" stay.
	/(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
	/\([^()\n]*\)/g,
	/\[[^[\]\n]*\]/g,
	/\{[^{}\n]*\}/g,
	/<[^<>\n]*>/g,
];

function rank(level: string): number {
	return LEVELS.indexOf(level);
}

/** Whether an on/off environment variable is on, read as Claude Code reads them. */
function envOn(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** Whether a prompt asks for `ultrathink`: the word on its own, outside quotes, brackets, code and
 * paths, in a prompt that doesn't start with `/`. A sentence's punctuation may follow it. */
export function asksForUltrathink(text: string): boolean {
	const typed = text.replace(SKILL_BLOCK, "");
	if (typed.trimStart().startsWith("/")) return false;
	let prose = typed;
	// Bracket spans go innermost first, so a nested pair takes a few passes.
	for (let pass = 0; pass < 4; pass++) {
		const next = IGNORED.reduce((current, span) => current.replace(span, " "), prose);
		if (next === prose) break;
		prose = next;
	}
	return prose.split(/\s+/).some((word) => word.replace(/[.,;:!?]+$/, "").toLowerCase() === "ultrathink");
}

/** The level an `ultrathink` turn runs at: `xhigh`, or the highest level below it that the model
 * supports, as Claude falls back. Undefined for a model that can't think. */
export function ultrathinkLevel(supported: readonly string[]): string | undefined {
	return supported.filter((level) => level !== "off" && rank(level) !== -1 && rank(level) <= rank(ULTRATHINK_LEVEL)).sort((a, b) => rank(b) - rank(a))[0];
}

export default function thinkingExtension(pi: ExtensionAPI) {
	/** The session's level to put back when the turn ends, and the level the turn was raised to. */
	let raised: { prior: Level; to: Level } | undefined;
	/** Whether the prompt about to start asked for `ultrathink`. */
	let pending = false;

	function raise(ctx: ExtensionContext) {
		if (!ctx.model || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		const target = ultrathinkLevel(getSupportedThinkingLevels(ctx.model));
		const current = pi.getThinkingLevel();
		if (!target || rank(current) >= rank(target)) return;
		pi.setThinkingLevel(target as Level);
		const to = pi.getThinkingLevel();
		if (to !== current) raised = { prior: raised?.prior ?? current, to };
	}

	function restore() {
		const turn = raised;
		raised = undefined;
		// A level changed during the turn, by you or another extension, stays.
		if (turn && pi.getThinkingLevel() === turn.to) pi.setThinkingLevel(turn.prior);
	}

	pi.on("session_start", async () => {
		raised = undefined;
		pending = false;
	});

	pi.on("input", async (event, ctx) => {
		const wanted = event.source !== "extension" && !envOn(process.env.CLAUDE_CODE_DISABLE_ULTRATHINK) && asksForUltrathink(event.text);
		if (event.streamingBehavior) {
			// Queued while a turn runs: it joins that run, so the run goes on at the raised level.
			if (wanted) raise(ctx);
			return undefined;
		}
		// agent_settled puts the level back after each run; this covers a run that ended without one.
		restore();
		pending = wanted;
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !pending) return undefined;
		pending = false;
		raise(ctx);
		return { message: { customType: "ultrathink", content: INSTRUCTION, display: false } };
	});

	pi.on("agent_settled", async () => restore());

	// Quitting mid-turn skips agent_settled; without this, `pi -c` would resume at the raised level.
	pi.on("session_shutdown", async () => {
		try {
			restore();
		} catch {
			// The session is already gone.
		}
	});
}
