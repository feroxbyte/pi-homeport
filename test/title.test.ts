import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import titleExtension, { cleanTitle, firstPrompt, promptText, requestTitle, type TitleRegistry, titleModel, titlesWanted } from "../extensions/title/index.ts";

const savedHaiku = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
beforeEach(() => {
	delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
});
afterEach(() => {
	if (savedHaiku === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
	else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = savedHaiku;
});

/** A model that can't turn thinking off, like Claude Sonnet 5.5, and one that can. */
const ALWAYS_THINKS = { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", xhigh: "xhigh", max: "max" } };
const CAN_STOP = { provider: "anthropic", id: "claude-haiku", reasoning: true, thinkingLevelMap: {} };

function reply(text: string, stopReason = "stop") {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text },
		],
		stopReason,
		usage: {},
		timestamp: 0,
	};
}

/** A model registry that records requests and answers each with the next reply, or one you resolve. */
function registry(answers: (ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>)[], available: unknown[] = []) {
	const calls: { model: unknown; context: any; options: any }[] = [];
	const models = {
		calls,
		getAvailable: () => available,
		streamSimple(model: unknown, context: unknown, options: unknown) {
			calls.push({ model, context, options });
			const answer = answers.shift() ?? reply("");
			return { result: () => Promise.resolve(answer) };
		},
	};
	return models as unknown as TitleRegistry & { calls: typeof calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("title text", () => {
	it("cleans the model's reply into a bare title", () => {
		assert.equal(cleanTitle("Fix The Parser"), "Fix The Parser");
		assert.equal(cleanTitle('  "Fix The Parser."  '), "Fix The Parser");
		assert.equal(cleanTitle("**Title: “Refactor Auth Module”**\n\nThis title captures the task."), "Refactor Auth Module");
		assert.equal(cleanTitle("# Port Extensions\u200b To Pi"), "Port Extensions To Pi");
		assert.equal(cleanTitle("Fix the C++ parser!?"), "Fix the C++ parser");
		assert.equal(cleanTitle("\n\n"), "");
		assert.equal(cleanTitle("x".repeat(300)).length, 200);
	});

	it("reads what you typed, without a typed skill's block", () => {
		assert.equal(promptText("  fix the parser  "), "fix the parser");
		assert.equal(
			promptText([
				{ type: "text", text: "fix" },
				{ type: "image", data: "", mimeType: "image/png" },
				{ type: "text", text: "it" },
			]),
			"fix it",
		);
		assert.equal(promptText('<skill name="tdd" location="/s/tdd/SKILL.md">\nWrite the test first.\n</skill>\n\n/tdd fix the parser'), "/tdd fix the parser");
		assert.equal(promptText(undefined), "");
	});

	it("takes the first prompt with text in the branch", () => {
		const entries = [
			{ type: "model_change" },
			{ type: "message", message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "An image." }] } },
			{ type: "message", message: { role: "user", content: "Why is the build slow?" } },
			{ type: "message", message: { role: "user", content: "Later prompt" } },
		];
		assert.equal(firstPrompt(entries), "Why is the build slow?");
		assert.equal(firstPrompt([]), "");
	});
});

describe("title rules", () => {
	it("titles terminal and RPC sessions, not print or JSON runs", () => {
		assert.equal(titlesWanted("tui", {}), true);
		assert.equal(titlesWanted("rpc", {}), true);
		assert.equal(titlesWanted("print", {}), false);
		assert.equal(titlesWanted("json", {}), false);
	});

	it("follows CLAUDE_CODE_DISABLE_TERMINAL_TITLE, and leaves subagent sessions alone", () => {
		assert.equal(titlesWanted("tui", { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" }), false);
		assert.equal(titlesWanted("tui", { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "TRUE" }), false);
		assert.equal(titlesWanted("tui", { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "0" }), true);
		assert.equal(titlesWanted("tui", { PI_SUBAGENT_CHILD: "1" }), false);
	});

	it("writes with ANTHROPIC_DEFAULT_HAIKU_MODEL when pi can use that model, else the session's model", () => {
		const haiku = { provider: "anthropic", id: "claude-haiku-5-5" };
		const ctx = { model: ALWAYS_THINKS, modelRegistry: { getAvailable: () => [ALWAYS_THINKS, haiku] } } as never;
		assert.equal(titleModel(ctx, undefined), ALWAYS_THINKS);
		assert.equal(titleModel(ctx, "claude-haiku-5-5"), haiku);
		assert.equal(titleModel(ctx, "anthropic/claude-haiku-5-5"), haiku);
		assert.equal(titleModel(ctx, "claude-haiku-4-5"), ALWAYS_THINKS, "a model pi can't use");
	});
});

describe("title request", () => {
	it("sends the start of the first prompt, with as little thinking as the model allows", async () => {
		const models = registry([reply("Speed Up The Build."), reply("Fix Parser")]);
		assert.equal(await requestTitle(models, ALWAYS_THINKS as never, `Why is the build slow? ${"x".repeat(2000)}`), "Speed Up The Build");
		const [first] = models.calls;
		assert.match(first?.context.systemPrompt, /terse 3 to 6 word title/);
		assert.equal(first?.context.messages[0].content.length, "First user message of a new coding session:\n\n".length + 1000);
		assert.equal(first?.options.reasoning, "low");
		assert.equal(first?.options.maxTokens, 1024);
		await requestTitle(models, CAN_STOP as never, "Fix the parser");
		assert.equal(models.calls[1]?.options.reasoning, undefined, "a model that can stop thinking doesn't think");
	});

	it("throws when the request fails, since pi-ai resolves failures", async () => {
		await assert.rejects(() => requestTitle(registry([reply("", "error")]), CAN_STOP as never, "x"), /title request error/);
		await assert.rejects(() => requestTitle(registry([reply("", "aborted")]), CAN_STOP as never, "x"), /title request aborted/);
	});
});

describe("title extension", () => {
	function load(options: { name?: string } = {}) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const named: string[] = [];
		let name = options.name;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			getSessionName: () => name,
			setSessionName: (value: string) => {
				name = value;
				named.push(value);
			},
		};
		titleExtension(pi as never);
		return {
			named,
			rename: (value: string) => {
				name = value;
			},
			start: () => handlers.get("session_start")?.({ reason: "startup" }, {}),
			prompt: (ctx: unknown, prompt = "Why is the build slow?") => handlers.get("before_agent_start")?.({ messageType: "user", prompt }, ctx),
			shutdown: () => handlers.get("session_shutdown")?.({ reason: "quit" }, {}),
		};
	}

	it("names the session from its first prompt, once, without holding up the prompt", async () => {
		const session = load();
		await session.start();
		const models = registry([reply("Speed Up The Build")]);
		assert.equal(await session.prompt(ctxFor(models)), undefined);
		await tick();
		assert.deepEqual(session.named, ["Speed Up The Build"]);
		await session.prompt(ctxFor(models), "Next prompt");
		assert.equal(models.calls.length, 1);
	});

	it("titles a resumed session from its own first prompt", async () => {
		const session = load();
		await session.start();
		const models = registry([reply("Fix Login")]);
		await session.prompt(
			{ ...ctxFor(models), sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "fix the login redirect" } }] } },
			"and the tests",
		);
		assert.match(models.calls[0]?.context.messages[0].content, /fix the login redirect$/);
	});

	it("asks Claude's background model when ANTHROPIC_DEFAULT_HAIKU_MODEL names one", async () => {
		process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-5-5";
		const session = load();
		await session.start();
		const haiku = { ...CAN_STOP, id: "claude-haiku-5-5" };
		const models = registry([reply("Speed Up The Build")], [haiku]);
		await session.prompt(ctxFor(models));
		assert.equal(models.calls[0]?.model, haiku);
	});

	it("keeps a name you set, before or during the request", async () => {
		const named = load({ name: "auth fix" });
		await named.start();
		const models = registry([reply("Other")]);
		await named.prompt(ctxFor(models));
		assert.equal(models.calls.length, 0);

		const racing = load();
		await racing.start();
		let answer: (value: ReturnType<typeof reply>) => void = () => {};
		const slow = registry([new Promise((resolve) => (answer = resolve))]);
		await racing.prompt(ctxFor(slow));
		racing.rename("my name");
		answer(reply("Generated"));
		await tick();
		assert.deepEqual(racing.named, []);
	});

	it("leaves print runs, failures and empty prompts unnamed", async () => {
		const print = load();
		await print.start();
		const models = registry([reply("Title")]);
		await print.prompt({ ...ctxFor(models), mode: "print" });
		assert.equal(models.calls.length, 0);

		const failing = load();
		await failing.start();
		await failing.prompt(ctxFor(registry([reply("", "error")])));
		await tick();
		assert.deepEqual(failing.named, []);

		const empty = load();
		await empty.start();
		const unused = registry([reply("Title")]);
		await empty.prompt(ctxFor(unused), "   ");
		assert.equal(unused.calls.length, 0);
	});

	it("cancels the request when the session ends", async () => {
		const session = load();
		await session.start();
		let signal: AbortSignal | undefined;
		// Like pi-ai, a cancelled request resolves as aborted.
		const models = {
			calls: [] as unknown[],
			streamSimple(_model: unknown, _context: unknown, options: { signal?: AbortSignal }) {
				signal = options.signal;
				return { result: () => new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(reply("", "aborted")))) };
			},
		};
		await session.prompt(ctxFor(models as never));
		assert.equal(signal?.aborted, false);
		await session.shutdown();
		assert.equal(signal?.aborted, true);
		await tick();
		assert.deepEqual(session.named, []);
	});
});

/** A terminal session's context on a model that always thinks. */
function ctxFor(models: ReturnType<typeof registry>) {
	return { mode: "tui", model: ALWAYS_THINKS, modelRegistry: models, sessionManager: { getBranch: () => [] } };
}
