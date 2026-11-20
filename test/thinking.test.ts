import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import thinkingExtension, { asksForUltrathink, INSTRUCTION, ultrathinkLevel } from "../extensions/thinking/index.ts";

/** Claude Sonnet 5.5 in pi: low to max, thinking always on. */
const SONNET = {
	provider: "anthropic",
	id: "claude-sonnet-5-5",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};
/** A model with max but no xhigh, as Claude lists Opus 4.6. */
const NO_XHIGH = { provider: "anthropic", id: "claude-opus-4-6", reasoning: true, thinkingLevelMap: { max: "max" } };
const NO_THINKING = { provider: "local", id: "plain", reasoning: false };

const savedDisable = process.env.CLAUDE_CODE_DISABLE_ULTRATHINK;
afterEach(() => {
	if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_ULTRATHINK;
	else process.env.CLAUDE_CODE_DISABLE_ULTRATHINK = savedDisable;
});

describe("ultrathink keyword", () => {
	it("counts the word on its own, in any case, with a sentence's punctuation", () => {
		for (const text of [
			"ultrathink about the parser",
			"Fix the parser. Ultrathink.",
			"please ULTRATHINK, then answer",
			"don't stop, ultrathink: it's hard",
			"1) first\n2) ultrathink please",
		]) {
			assert.equal(asksForUltrathink(text), true, text);
		}
	});

	it("ignores other phrases, other words, and the word in quotes, brackets, code or paths", () => {
		for (const text of [
			"think hard about this",
			"rethink the ultrathinking approach",
			"ultrathink-mode",
			"see docs/ultrathink.md",
			"run `ultrathink` there",
			"```\nultrathink\n```\nok",
			'he said "ultrathink" yesterday',
			"the word 'ultrathink' is special",
			"“ultrathink” in smart quotes",
			"(ultrathink)",
			"[ultrathink] tag",
			"a (nested (pair) ultrathink) here",
			"<ultrathink>",
		]) {
			assert.equal(asksForUltrathink(text), false, text);
		}
	});

	it("ignores a prompt that starts with /, including a typed skill pi expanded", () => {
		assert.equal(asksForUltrathink("/review ultrathink"), false);
		assert.equal(asksForUltrathink("  /skill:tdd ultrathink"), false);
		assert.equal(asksForUltrathink('<skill name="tdd" location="/s/tdd/SKILL.md">\nultrathink first\n</skill>\n\n/skill:tdd fix it'), false);
	});

	it("raises to xhigh, or the model's highest level below it", () => {
		assert.equal(ultrathinkLevel(["low", "medium", "high", "xhigh", "max"]), "xhigh");
		assert.equal(ultrathinkLevel(["off", "minimal", "low", "medium", "high", "max"]), "high");
		assert.equal(ultrathinkLevel(["off"]), undefined);
	});
});

describe("thinking extension", () => {
	function load(level: string, model: unknown = SONNET, mode = "tui") {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const changes: string[] = [];
		let current = level;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			getThinkingLevel: () => current,
			setThinkingLevel: (next: string) => {
				current = next;
				changes.push(next);
			},
		};
		thinkingExtension(pi as never);
		const ctx = { model, mode };
		const emit = (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx);
		return {
			changes,
			level: () => current,
			set: (next: string) => {
				current = next;
			},
			/** You type a prompt while pi is idle and it starts a turn. */
			prompt: async (text: string, source = "interactive") => {
				await emit("input", { text, source });
				return emit("before_agent_start", { messageType: "user", prompt: text });
			},
			queue: (text: string) => emit("input", { text, source: "interactive", streamingBehavior: "followUp" }),
			settle: () => emit("agent_settled", { aborted: false }),
			shutdown: () => emit("session_shutdown", { reason: "quit" }),
			start: () => emit("session_start", { reason: "startup" }),
		};
	}

	it("raises the turn to xhigh with an instruction in context, then puts the level back", async () => {
		const session = load("medium");
		await session.start();
		const result = await session.prompt("ultrathink: why is the build slow?");
		assert.deepEqual(result, { message: { customType: "ultrathink", content: INSTRUCTION, display: false } });
		assert.equal(session.level(), "xhigh");
		await session.settle();
		assert.equal(session.level(), "medium");
		assert.equal(await session.prompt("and now the tests"), undefined);
		assert.deepEqual(session.changes, ["xhigh", "medium"]);
	});

	it("never lowers a level, but still asks for deeper reasoning", async () => {
		const session = load("max");
		const result = await session.prompt("ultrathink");
		assert.ok(result);
		await session.settle();
		assert.deepEqual(session.changes, []);
	});

	it("falls back below xhigh on a model without it, and doesn't raise a model that can't think", async () => {
		const opus = load("medium", NO_XHIGH);
		await opus.prompt("ultrathink");
		assert.equal(opus.level(), "high");
		const plain = load("off", NO_THINKING);
		assert.ok(await plain.prompt("ultrathink"));
		assert.deepEqual(plain.changes, []);
	});

	it("leaves a level you changed during the turn", async () => {
		const session = load("medium");
		await session.prompt("ultrathink");
		session.set("low");
		await session.settle();
		assert.equal(session.level(), "low");
	});

	it("gives a print run the instruction without raising the level, as Claude does for `claude -p`", async () => {
		const print = load("medium", SONNET, "print");
		assert.deepEqual(await print.prompt("ultrathink"), { message: { customType: "ultrathink", content: INSTRUCTION, display: false } });
		assert.deepEqual(print.changes, []);
		const rpc = load("medium", SONNET, "rpc");
		await rpc.prompt("ultrathink");
		assert.equal(rpc.level(), "xhigh");
	});

	it("ignores prompts from extensions, and is off with CLAUDE_CODE_DISABLE_ULTRATHINK", async () => {
		const session = load("medium");
		assert.equal(await session.prompt("ultrathink", "extension"), undefined);
		process.env.CLAUDE_CODE_DISABLE_ULTRATHINK = "true";
		assert.equal(await session.prompt("ultrathink"), undefined);
		assert.deepEqual(session.changes, []);
	});

	it("raises a running turn for a queued prompt with the keyword", async () => {
		const session = load("medium");
		await session.prompt("fix the parser");
		await session.queue("ultrathink about the edge cases");
		assert.equal(session.level(), "xhigh");
		await session.settle();
		assert.equal(session.level(), "medium");
	});

	it("puts the level back when pi quits mid-turn", async () => {
		const session = load("medium");
		await session.prompt("ultrathink");
		await session.shutdown();
		assert.equal(session.level(), "medium");
	});
});
