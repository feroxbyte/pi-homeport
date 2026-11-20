import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { isSafeCommand } from "../extensions/plan/bash.ts";
import planExtension, { defaultMode, EXIT_TOOL, PLAN_MODE_CHANNEL, PLAN_PROMPT, planTitle, restoredPlanState } from "../extensions/plan/index.ts";
import { fauxSession } from "./plan-goal-session.ts";

describe("plan mode's read-only commands", () => {
	it("runs reads, searches and read-only git", () => {
		for (const command of [
			"ls -la",
			"cat package.json | grep name",
			"cd src && ls",
			"rg -n 'a|b' extensions",
			"git status",
			"git log --oneline -5",
			"git diff HEAD~1 -- src",
			"git branch",
			"git branch --list 'feat/*'",
			"find . -name '*.ts'",
			"grep -r foo src 2>/dev/null",
			"wc -l a.ts 2>&1",
		]) {
			assert.equal(isSafeCommand(command), true, command);
		}
	});

	it("asks about anything that writes, runs other programs or can't be read", () => {
		for (const command of [
			"rm -rf build",
			"echo hi > notes.txt",
			"cat a >> b",
			"ls && rm x",
			"cat $(echo secret)",
			"echo `whoami`",
			"git commit -m x",
			"git branch new-feature",
			"git branch -D old",
			"git remote add origin x",
			"git diff --output=patch.diff",
			"find . -delete",
			"find . -exec rm {} ;",
			"sort -o out.txt in.txt",
			"uniq in.txt out.txt",
			"npm install",
			"node script.js",
			"sed -i s/a/b/ file",
			"top",
			"cat 'unterminated",
			`cat ${"a".repeat(10_001)}`,
		]) {
			assert.equal(isSafeCommand(command), false, command);
		}
	});
});

describe("plan mode helpers", () => {
	it("reads Claude's defaultMode from the highest-precedence settings", () => {
		assert.equal(defaultMode([{ permissions: { defaultMode: "plan" } }, { permissions: { defaultMode: "acceptEdits" } }]), "acceptEdits");
		assert.equal(defaultMode([{ permissions: { defaultMode: "plan" } }, { permissions: {} }]), "plan");
		assert.equal(defaultMode([{ defaultMode: "plan" }]), undefined);
	});

	it("names a session from the plan's first line", () => {
		assert.equal(planTitle("# Plan: Migrate the auth module\n\n1. ..."), "Migrate the auth module");
		assert.equal(planTitle("\n\n1. **Split** `parser.ts`."), "Split parser.ts");
		assert.equal(planTitle("x".repeat(80))?.length, 60);
		assert.equal(planTitle("  \n"), undefined);
	});

	it("keeps only well-formed fields from a saved state", () => {
		assert.deepEqual(restoredPlanState({ enabled: true, savedTools: ["read", "edit"] }), { enabled: true, savedTools: ["read", "edit"] });
		assert.deepEqual(restoredPlanState({ enabled: "yes", savedTools: "read" }), {});
		assert.deepEqual(restoredPlanState(null), {});
	});
});

type Handler = (event: any, ctx: any) => unknown;
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "todo", "subagent", EXIT_TOOL];

let base: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-"));
	fs.mkdirSync(path.join(base, "project", ".git"), { recursive: true });
	process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

/** Loads the extension with a fake pi and a fake TUI context, and records what it does. */
function load(options: { hasUI?: boolean; flag?: boolean; branch?: unknown[]; answers?: { select?: string; editor?: (string | undefined)[]; confirm?: boolean } } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const shortcuts: { handler: (ctx: any) => Promise<void> }[] = [];
	const tools = new Map<string, any>();
	let active = ALL_TOOLS.filter((name) => name !== EXIT_TOOL);
	const entries: { customType: string; data: any }[] = [];
	const emitted: unknown[] = [];
	const sent: unknown[] = [];
	const asked: string[] = [];
	const status: (string | undefined)[] = [];
	let sessionName: string | undefined;
	const editorAnswers = [...(options.answers?.editor ?? [])];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (_key: string, shortcut: any) => shortcuts.push(shortcut),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerFlag: () => {},
		getFlag: () => options.flag ?? false,
		getActiveTools: () => [...active],
		getAllTools: () => ALL_TOOLS.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			active = names.filter((name) => ALL_TOOLS.includes(name));
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		events: { emit: (_channel: string, data: unknown) => emitted.push(data) },
		sendUserMessage: (text: string) => sent.push(text),
		getSessionName: () => sessionName,
		setSessionName: (name: string) => {
			sessionName = name;
		},
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: path.join(base, "project"),
		signal: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => status.push(text),
			notify: () => {},
			confirm: async (title: string) => {
				asked.push(title);
				return options.answers?.confirm ?? false;
			},
			select: async (title: string) => {
				asked.push(title);
				return options.answers?.select;
			},
			editor: async (title: string) => {
				asked.push(title);
				return editorAnswers.shift();
			},
		},
	};
	planExtension(pi as never);
	return {
		ctx,
		entries,
		emitted,
		sent,
		asked,
		status,
		tools,
		active: () => active,
		sessionName: () => sessionName,
		start: (event = { reason: "startup" }) => handlers.get("session_start")!(event, ctx),
		plan: (args = "") => commands.get("plan")!.handler(args, ctx),
		toggle: () => shortcuts[0].handler(ctx),
		call: (toolName: string, input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName, input }, ctx) as Promise<any>,
		exit: (plan: string) => tools.get(EXIT_TOOL).execute("id", { plan }, undefined, undefined, ctx),
		prompt: async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await handlers.get("before_agent_start")!(event, ctx);
			return event.systemPromptOptions.sections;
		},
	};
}

describe("plan mode", () => {
	it("enters with /plan: read-only tools, the instructions and the status", async () => {
		const pi = load();
		await pi.start();
		assert.equal(pi.tools.get(EXIT_TOOL).defaultActive, false);
		await pi.plan();
		assert.deepEqual(pi.active(), ["read", "bash", "grep", "find", "ls", "web_search", "todo", EXIT_TOOL]);
		assert.equal(pi.status.at(-1), "⏸ plan mode on");
		assert.deepEqual(pi.emitted.at(-1), { active: true });
		assert.equal((await pi.prompt()).plan_mode, PLAN_PROMPT);
		assert.deepEqual(pi.entries.at(-1), {
			customType: "plan-mode",
			data: { enabled: true, savedTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "todo", "subagent"] },
		});
		assert.equal(PLAN_MODE_CHANNEL, "pi-code:plan-mode");
	});

	it("starts a task given to /plan", async () => {
		const pi = load();
		await pi.start();
		await pi.plan("fix the auth bug");
		assert.deepEqual(pi.sent, ["fix the auth bug"]);
		assert.ok(pi.active().includes(EXIT_TOOL));
	});

	it("blocks edits, runs read-only commands and asks about the rest", async () => {
		const pi = load({ answers: { confirm: false } });
		await pi.start();
		await pi.plan();
		assert.equal((await pi.call("edit", { path: "a.ts" }))?.block, true);
		assert.equal((await pi.call("write", { path: "a.ts" }))?.block, true);
		assert.equal(await pi.call("read", { path: "a.ts" }), undefined);
		assert.equal(await pi.call("bash", { command: "git status" }), undefined);
		assert.equal(pi.asked.length, 0);
		assert.equal((await pi.call("bash", { command: "npm test" }))?.block, true);
		assert.equal((await pi.call("subagent", { task: "x" }))?.block, true);
		assert.deepEqual(pi.asked, ["Plan mode: run this command?", "Plan mode: use subagent?"]);
	});

	it("runs a command you allow", async () => {
		const pi = load({ answers: { confirm: true } });
		await pi.start();
		await pi.plan();
		assert.equal(await pi.call("bash", { command: "npm test" }), undefined);
	});

	it("blocks a command outside the read-only set when no one can be asked", async () => {
		const pi = load({ hasUI: false, flag: true });
		await pi.start();
		assert.ok(pi.active().includes(EXIT_TOOL));
		assert.equal((await pi.call("bash", { command: "npm test" }))?.block, true);
		const result = await pi.exit("1. Do it");
		assert.equal(result.terminate, true);
	});

	it("leaves everything alone outside plan mode", async () => {
		const pi = load();
		await pi.start();
		assert.equal(await pi.call("edit", { path: "a.ts" }), undefined);
		const result = await pi.exit("1. Do it");
		assert.match(result.content[0].text, /Plan mode is off/);
		assert.equal((await pi.prompt()).plan_mode, undefined);
	});

	it("starts on the approved plan: tools back, plan mode off, session named", async () => {
		const pi = load({ answers: { select: "Yes, start" } });
		await pi.start();
		await pi.plan();
		const result = await pi.exit("# Rename the parser\n\n1. Rename it");
		assert.equal(result.terminate, undefined);
		assert.match(result.content[0].text, /approved the plan[\s\S]*Rename the parser/);
		assert.deepEqual(pi.active(), ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "todo", "subagent"]);
		assert.equal(pi.status.at(-1), undefined);
		assert.equal(pi.sessionName(), "Rename the parser");
		assert.deepEqual(pi.entries.at(-1)?.data.enabled, false);
		assert.equal(await pi.call("edit", { path: "a.ts" }), undefined);
	});

	it("approves an edited plan", async () => {
		const pi = load({ answers: { select: "Yes, after I edit the plan", editor: ["1. A better plan"] } });
		await pi.start();
		await pi.plan();
		const result = await pi.exit("1. A plan");
		assert.match(result.content[0].text, /edited it[\s\S]*A better plan/);
		assert.ok(pi.active().includes("edit"));
	});

	it("keeps planning with your feedback", async () => {
		const pi = load({ answers: { select: "No, keep planning", editor: ["Also cover the CLI"] } });
		await pi.start();
		await pi.plan();
		const result = await pi.exit("1. A plan");
		assert.equal(result.terminate, undefined);
		assert.match(result.content[0].text, /Also cover the CLI[\s\S]*call exit_plan_mode again/);
		assert.ok(!pi.active().includes("edit"));
	});

	it("stops the turn and stays in plan mode on Esc", async () => {
		const pi = load({ answers: { select: undefined } });
		await pi.start();
		await pi.plan();
		const result = await pi.exit("1. A plan");
		assert.equal(result.terminate, true);
		assert.ok(pi.active().includes(EXIT_TOOL));
	});

	it("toggles with the shortcut", async () => {
		const pi = load();
		await pi.start();
		await pi.toggle();
		assert.ok(!pi.active().includes("edit"));
		await pi.toggle();
		assert.ok(pi.active().includes("edit"));
		assert.ok(!pi.active().includes(EXIT_TOOL));
	});

	it("resumes in plan mode with the tools saved before it", async () => {
		const branch = [{ type: "custom", customType: "plan-mode", data: { enabled: true, savedTools: ["read", "bash", "edit"] } }];
		const pi = load({ branch });
		await pi.start({ reason: "resume" });
		assert.deepEqual(pi.active(), ["read", "bash", EXIT_TOOL]);
		await pi.toggle();
		assert.deepEqual(pi.active(), ["read", "bash", "edit"]);
	});

	it("doesn't resume a plan mode you left", async () => {
		const branch = [{ type: "custom", customType: "plan-mode", data: { enabled: false, savedTools: ["read"] } }];
		const pi = load({ branch, flag: true });
		await pi.start({ reason: "resume" });
		assert.ok(pi.active().includes("edit"));
	});

	it("plans, gets approval and starts editing in one pi session", async () => {
		const tools: string[][] = [];
		const asked: string[] = [];
		const run = await fauxSession(
			[planExtension],
			[
				() => {
					tools.push(run.session.getActiveToolNames());
					return fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }), fauxToolCall("edit", { path: "a.ts", edits: [] })], { stopReason: "toolUse" });
				},
				fauxAssistantMessage([fauxToolCall(EXIT_TOOL, { plan: "# Rename the parser\n\n1. Rename it" })], { stopReason: "toolUse" }),
				() => {
					tools.push(run.session.getActiveToolNames());
					return fauxAssistantMessage(fauxText("Renamed."));
				},
			],
			{ select: (title, options) => (asked.push(`${title} ${options.join(" | ")}`), "Yes, start") },
		);
		try {
			await run.session.prompt("/plan");
			await run.session.prompt("rename the parser");
			assert.deepEqual(run.errors, []);
			assert.ok(tools[0].includes(EXIT_TOOL) && !tools[0].includes("edit"));
			assert.ok(tools[1].includes("edit") && !tools[1].includes(EXIT_TOOL));
			assert.equal(asked[0], "Would you like to proceed? Yes, start | Yes, after I edit the plan | No, keep planning");
			const results = run.session.messages.filter((message: any) => message.role === "toolResult");
			assert.deepEqual(
				results.map((message: any) => `${message.toolName}:${message.isError}`),
				["bash:false", "edit:true", `${EXIT_TOOL}:false`],
			);
			assert.match((results[2] as any).content[0].text, /^The user approved the plan\./);
			assert.equal((run.session.messages.at(-1) as any).content[0].text, "Renamed.");
			assert.equal(run.session.sessionManager.getSessionName(), "Rename the parser");
			assert.equal(run.faux.getPendingResponseCount(), 0);
		} finally {
			run.dispose();
		}
	});

	it("starts in plan mode when Claude's defaultMode is plan", async () => {
		fs.mkdirSync(path.join(base, "project", ".claude"), { recursive: true });
		fs.writeFileSync(path.join(base, "project", ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
		const pi = load();
		await pi.start();
		assert.ok(!pi.active().includes("edit"));
		assert.equal(pi.entries.at(-1)?.data.enabled, true);
	});
});
