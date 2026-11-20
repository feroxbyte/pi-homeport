import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	checkinIntervalMs,
	classifyFailure,
	classifyUnrecoverable,
	formatActiveGoal,
	isClearAlias,
	parseVerdict,
	renderTranscript,
	stopHookBlockCap,
} from "../extensions/goal/evaluator.ts";
import goalExtension, { evaluatorModel, goalUnavailable, HOOKS_GATE, TRUST_GATE } from "../extensions/goal/index.ts";
import { fauxSession } from "./plan-goal-session.ts";

describe("goal evaluation rules", () => {
	it("reads the evaluator's verdict", () => {
		assert.deepEqual(parseVerdict('{"ok": true, "reason": "tests pass"}'), { ok: true, reason: "tests pass", impossible: false });
		assert.deepEqual(parseVerdict('```json\n{"ok": false, "impossible": true, "reason": "no network"}\n```'), { ok: false, reason: "no network", impossible: true });
		assert.deepEqual(parseVerdict('{"ok": true, "impossible": true, "reason": "x"}'), { ok: true, reason: "x", impossible: false });
		assert.equal(parseVerdict("No, the build still fails.")?.ok, false);
		assert.equal(parseVerdict('{"ok": "yes"}'), undefined);
		assert.equal(parseVerdict("I think so"), undefined);
	});

	it("trims the transcript from the start and keeps the newest message", () => {
		const messages = [
			{ role: "user", content: "first ".repeat(50) },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "middle" },
					{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
				],
			},
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "12 passing" }] },
		];
		const full = renderTranscript(messages, 100_000);
		assert.match(full, /^User: first/);
		assert.match(full, /\[tool call bash\(\{"command":"npm test"\}\)\]/);
		const cut = renderTranscript(messages, 120);
		assert.match(cut, /^\[earlier transcript omitted\]/);
		assert.match(cut, /Tool result \(bash\): 12 passing$/);
	});

	it("sorts failed turns into clear, retry and pause", () => {
		assert.equal(classifyUnrecoverable("401 Unauthorized"), "authentication");
		assert.equal(classifyUnrecoverable("Your credit balance is too low"), "credits");
		assert.equal(classifyUnrecoverable("prompt is too long: maximum context length"), "context overflow");
		assert.equal(classifyUnrecoverable("model claude-x not found"), "model unavailable");
		assert.equal(classifyUnrecoverable("529 overloaded_error"), undefined);
		assert.equal(classifyFailure("529 overloaded_error"), "retry");
		assert.equal(classifyFailure("socket hang up"), "retry");
		assert.equal(classifyFailure("429 rate_limit_error"), "pause");
		assert.equal(classifyFailure("blocked by a hook"), "pause");
	});

	it("reads Claude's check-in and block cap variables", () => {
		assert.equal(checkinIntervalMs({}, 0), 30 * 60_000);
		assert.equal(checkinIntervalMs({}, 1), 60 * 60_000);
		assert.equal(checkinIntervalMs({}, 5), 120 * 60_000);
		assert.equal(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: "5" }, 0), 5 * 60_000);
		assert.equal(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: "0" }, 0), 0);
		assert.equal(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: "1.5" }, 0), 30 * 60_000);
		assert.equal(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: "10081" }, 0), 30 * 60_000);
		assert.equal(stopHookBlockCap({}), 8);
		assert.equal(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "3" }), 3);
		assert.equal(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "0" }), 0);
		assert.equal(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "-1" }), 8);
	});

	it("accepts Claude's aliases for clear and shows turns only after an evaluation", () => {
		for (const alias of ["clear", "STOP", "off", "reset", "none", "cancel"]) assert.equal(isClearAlias(alias), true);
		assert.equal(isClearAlias("all tests pass"), false);
		assert.doesNotMatch(formatActiveGoal({ condition: "c", durationMs: 0, iterations: 0, tokens: 0 }), /turn/);
		assert.match(
			formatActiveGoal({ condition: "c", durationMs: 0, iterations: 2, tokens: 1500, lastReason: "2 failing" }),
			/\(2 turns\)[\s\S]*1\.5k tokens[\s\S]*Last check: 2 failing/,
		);
	});
});

type Handler = (event: any, ctx: any) => unknown;

let base: string;
const ENV = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_STOP_HOOK_BLOCK_CAP", "CLAUDE_CODE_GOAL_CHECKIN_MINUTES", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const MODEL = { provider: "anthropic", id: "sonnet", contextWindow: 200_000, maxTokens: 8000 };
const HAIKU = { provider: "anthropic", id: "haiku", contextWindow: 200_000, maxTokens: 8000 };

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "goal-"));
	fs.mkdirSync(path.join(base, "project", ".git"), { recursive: true });
	for (const name of ENV) delete process.env[name];
	process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** Loads the extension with a fake pi; the evaluator answers with `verdicts` in turn. */
function load(options: { hasUI?: boolean; trusted?: boolean; branch?: unknown[]; verdicts?: string[] } = {}) {
	const handlers = new Map<string, Handler>();
	const bus = new Map<string, (data: unknown) => void>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const entries: { customType: string; data: any }[] = [];
	const sent: { message: any; options: any }[] = [];
	const notes: string[] = [];
	const prompts: { model: string; prompt: string }[] = [];
	const verdicts = [...(options.verdicts ?? [])];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, options: any) => {
			command = options.handler;
		},
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		events: { on: (channel: string, handler: (data: unknown) => void) => bus.set(channel, handler) },
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: path.join(base, "project"),
		model: MODEL,
		signal: undefined,
		isIdle: () => true,
		isProjectTrusted: () => options.trusted ?? true,
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => options.branch ?? [] },
		modelRegistry: {
			getAvailable: () => [MODEL, HAIKU],
			streamSimple: (model: { id: string }, context: { messages: { content: string }[] }) => ({
				result: async () => {
					prompts.push({ model: model.id, prompt: context.messages[0].content });
					const text = verdicts.shift();
					if (text === undefined) return { stopReason: "error", errorMessage: "no verdict left", content: [], usage: {} };
					return { stopReason: "stop", content: [{ type: "text", text }], usage: { totalTokens: 100 } };
				},
			}),
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			notify: (text: string) => notes.push(text),
		},
	};
	goalExtension(pi as never);
	const settle = (outcome = "completed") => handlers.get("agent_before_settle")!({ entries: [], continue: false, outcome }, ctx) as Promise<any>;
	return {
		ctx,
		entries,
		sent,
		notes,
		prompts,
		bus,
		start: () => handlers.get("session_start")!({ reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, ctx),
		goal: (args: string) => command!(args, ctx),
		turn: async (options: { tools?: boolean; error?: string } = {}) => {
			await handlers.get("agent_start")!({}, ctx);
			if (options.tools) await handlers.get("tool_execution_start")!({}, ctx);
			const assistant = options.error ? { role: "assistant", stopReason: "error", errorMessage: options.error } : { role: "assistant", stopReason: "stop" };
			await handlers.get("agent_end")!({ messages: [assistant] }, ctx);
			const result = await settle(options.error ? "error" : "completed");
			await handlers.get("agent_settled")!({ aborted: false }, ctx);
			return result;
		},
		input: (source = "interactive") => handlers.get("input")!({ source, text: "go on" }, ctx),
	};
}

describe("/goal", () => {
	it("sets a goal and starts working on it", async () => {
		const pi = load();
		await pi.start();
		await pi.goal("all tests in test/auth pass");
		assert.deepEqual(pi.entries.at(-1), { customType: "goal", data: { state: "active", condition: "all tests in test/auth pass" } });
		const kickoff = pi.sent.at(-1)!;
		assert.equal(kickoff.options.triggerTurn, true);
		assert.match(kickoff.message.content, /all tests in test\/auth pass/);
		assert.equal(kickoff.message.details.head, "Goal set: all tests in test/auth pass");
	});

	it("keeps going while the goal isn't met, and clears it once it is", async () => {
		const pi = load({ verdicts: ['{"ok": false, "reason": "2 tests fail"}', '{"ok": true, "reason": "12 passing"}'] });
		await pi.start();
		await pi.goal("tests pass");
		const first = await pi.turn({ tools: true });
		assert.equal(first.continue, true);
		assert.match(first.entries[0].content, /^Goal not yet met \(turn 1[^)]*\): 2 tests fail\nGoal: tests pass$/);
		assert.match(pi.prompts[0].prompt, /<transcript>[\s\S]*Condition: tests pass$/);
		assert.equal(pi.prompts[0].model, "sonnet");
		const second = await pi.turn({ tools: true });
		assert.equal(second.continue, false);
		assert.match(second.entries[0].content, /^Goal achieved \([^)]*2 turns[^)]*\): tests pass\nEvaluator: 12 passing$/);
		assert.deepEqual(pi.entries.at(-1)?.data, { state: "achieved", condition: "tests pass" });
		await pi.goal("");
		assert.match(pi.notes.at(-1)!, /^Goal achieved: tests pass/);
		assert.equal(await pi.turn(), undefined);
	});

	it("clears a goal the evaluator judges impossible", async () => {
		const pi = load({ verdicts: ['{"ok": false, "impossible": true, "reason": "needs a network"}'] });
		await pi.start();
		await pi.goal("deploy");
		const result = await pi.turn({ tools: true });
		assert.equal(result.continue, false);
		assert.match(result.entries[0].content, /could not be achieved[\s\S]*needs a network/);
		assert.equal(pi.entries.at(-1)?.data.state, "failed");
	});

	it("pauses after the block cap of turns without a tool call, until your next message", async () => {
		process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = "2";
		const notMet = '{"ok": false, "reason": "not yet"}';
		const pi = load({ verdicts: [notMet, notMet, notMet] });
		await pi.start();
		await pi.goal("done");
		assert.equal((await pi.turn()).continue, true);
		assert.equal((await pi.turn()).continue, false);
		assert.match(pi.notes.at(-1)!, /Goal paused after 2 turns/);
		assert.equal(await pi.turn(), undefined);
		await pi.input("extension");
		assert.equal(await pi.turn(), undefined);
		await pi.input();
		assert.equal((await pi.turn()).continue, true);
	});

	it("shows status, and clears with an alias", async () => {
		const pi = load();
		await pi.start();
		await pi.goal("");
		assert.equal(pi.notes.at(-1), "No goal set. Usage: /goal <condition>");
		await pi.goal("lint is clean");
		await pi.goal("");
		assert.match(pi.notes.at(-1)!, /^Goal active: lint is clean\nRunning for/);
		await pi.goal("stop");
		assert.equal(pi.sent.at(-1)?.message.content, "Goal cleared: lint is clean");
		assert.equal(pi.entries.at(-1)?.data.state, "cleared");
		await pi.goal("cancel");
		assert.equal(pi.notes.at(-1), "No goal set");
	});

	it("refuses a condition over 4,000 characters", async () => {
		const pi = load();
		await pi.start();
		await pi.goal("x".repeat(4001));
		assert.match(pi.notes.at(-1)!, /up to 4000 characters/);
		assert.equal(pi.entries.length, 0);
	});

	it("leaves the goal set when the evaluator fails", async () => {
		const pi = load({ verdicts: [] });
		await pi.start();
		await pi.goal("done");
		assert.equal(await pi.turn({ tools: true }), undefined);
		assert.match(pi.notes.at(-1)!, /Goal evaluator error: no verdict left/);
		await pi.goal("");
		assert.match(pi.notes.at(-1)!, /^Goal active: done/);
	});

	it("doesn't evaluate while background work runs", async () => {
		const pi = load({ verdicts: ['{"ok": true, "reason": "done"}'] });
		await pi.start();
		await pi.goal("done");
		pi.bus.get("subagent:async-started")!({ id: "run-1", agent: "reviewer" });
		assert.equal(await pi.turn({ tools: true }), undefined);
		assert.equal(pi.prompts.length, 0);
		pi.bus.get("subagent:async-complete")!({ id: "run-1" });
		assert.equal((await pi.turn({ tools: true })).continue, false);
		await pi.shutdown();
	});

	it("clears the goal after an error you have to fix", async () => {
		const pi = load();
		await pi.start();
		await pi.goal("done");
		await pi.turn({ error: "401 invalid x-api-key" });
		assert.equal(pi.entries.at(-1)?.data.state, "cleared");
		assert.match(pi.notes.at(-1)!, /^Goal cleared after an unrecoverable error \(authentication\).*Run \/goal again to continue\.$/);
	});

	it("retries a passing failure and pauses on a rate limit", async () => {
		const pi = load();
		await pi.start();
		await pi.goal("done");
		await pi.turn({ error: "529 overloaded_error" });
		assert.match(pi.notes.at(-1)!, /^Goal still active .*Retrying in 30s \(attempt 1 of 3\)/);
		await pi.turn({ error: "429 rate_limit_error" });
		assert.match(pi.notes.at(-1)!, /^Goal paused: "429 rate_limit_error"/);
		assert.equal(pi.entries.at(-1)?.data.state, "active");
		await pi.shutdown();
	});

	it("restores an active goal on resume", async () => {
		const branch = [{ type: "custom", customType: "goal", data: { state: "active", condition: "ship it" } }];
		const pi = load({ branch });
		await pi.start();
		assert.equal(pi.notes.at(-1), "Goal restored: ship it");
		const done = load({ branch: [...branch, { type: "custom", customType: "goal", data: { state: "achieved", condition: "ship it" } }] });
		await done.start();
		assert.equal(done.notes.length, 0);
		await pi.shutdown();
	});

	it("is unavailable where Claude's hooks are restricted or the project isn't trusted", async () => {
		const ctx = { cwd: path.join(base, "project"), hasUI: true, isProjectTrusted: () => true };
		const managed = path.join(base, "managed");
		assert.equal(goalUnavailable(ctx, { managedSettingsDir: managed }), undefined);
		assert.equal(goalUnavailable({ ...ctx, isProjectTrusted: () => false }, { managedSettingsDir: managed }), TRUST_GATE);
		assert.equal(goalUnavailable({ ...ctx, hasUI: false, isProjectTrusted: () => false }, { managedSettingsDir: managed }), undefined);
		fs.mkdirSync(managed, { recursive: true });
		fs.writeFileSync(path.join(managed, "managed-settings.json"), JSON.stringify({ allowManagedHooksOnly: true }));
		assert.equal(goalUnavailable(ctx, { managedSettingsDir: managed }), HOOKS_GATE);
		fs.rmSync(managed, { recursive: true });
		fs.mkdirSync(path.join(base, "claude"), { recursive: true });
		fs.writeFileSync(path.join(base, "claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
		assert.equal(goalUnavailable(ctx, { managedSettingsDir: managed }), HOOKS_GATE);
		const pi = load();
		await pi.start();
		await pi.goal("done");
		assert.equal(pi.notes.at(-1), HOOKS_GATE);
	});

	it("works toward the goal turn after turn in a pi session until the evaluator confirms it", async () => {
		const judged: string[] = [];
		const run = await fauxSession(
			[goalExtension],
			[
				fauxAssistantMessage([fauxText("Starting."), fauxToolCall("bash", { command: "echo one" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Step one is done."),
				fauxAssistantMessage('{"ok": false, "reason": "step two is missing"}'),
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo two" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Step two is done."),
				(context) => {
					judged.push(String(context.messages.at(-1)?.content));
					return fauxAssistantMessage('{"ok": true, "reason": "both steps are done"}');
				},
			],
		);
		try {
			await run.session.prompt("/goal both steps are done");
			await run.session.waitForIdle();
			assert.deepEqual(run.errors, []);
			assert.equal(run.faux.getPendingResponseCount(), 0);
			const lines = run.customs().map((entry) => (entry.type === "custom" ? `state ${(entry.data as { state: string }).state}` : String(entry.content).split("\n")[0]));
			assert.equal(lines.length, 5);
			assert.equal(lines[0], "state active");
			assert.match(lines[1], /^The user set a goal for this session: both steps are done$/);
			assert.match(lines[2], /^Goal not yet met \(turn 1 .*\): step two is missing$/);
			assert.equal(lines[3], "state achieved");
			assert.match(lines[4], /^Goal achieved \(.*2 turns.*\): both steps are done$/);
			assert.match(judged[0], /Step two is done\.[\s\S]*Condition: both steps are done$/);
		} finally {
			run.dispose();
		}
	});

	it("evaluates on ANTHROPIC_DEFAULT_HAIKU_MODEL when pi has that model", () => {
		const ctx = { model: MODEL, modelRegistry: { getAvailable: () => [MODEL, HAIKU] } } as never;
		assert.equal(evaluatorModel(ctx, undefined), MODEL);
		assert.equal(evaluatorModel(ctx, "haiku"), HAIKU);
		assert.equal(evaluatorModel(ctx, "anthropic/haiku"), HAIKU);
		assert.equal(evaluatorModel(ctx, "missing"), MODEL);
	});
});
