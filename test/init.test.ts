import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import initExtension, { initPrompt, projectFiles } from "../extensions/init/index.ts";

let project: string;

function write(relative: string, content = "x") {
	const file = path.join(project, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-"));
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

describe("init project files", () => {
	it("finds nothing in an empty folder", () => {
		assert.deepEqual(projectFiles(project), { agentsMd: false, cursorRules: false, copilotInstructions: false });
	});

	it("finds the CLAUDE.md, AGENTS.md and other tools' rules", () => {
		write(".claude/CLAUDE.md");
		write("AGENTS.md");
		write(".cursorrules");
		write(".github/copilot-instructions.md");
		assert.deepEqual(projectFiles(project), { claudeMd: path.join(".claude", "CLAUDE.md"), agentsMd: true, cursorRules: true, copilotInstructions: true });
		write("CLAUDE.md");
		assert.equal(projectFiles(project).claudeMd, "CLAUDE.md");
	});

	it("takes a .cursor/rules folder, not a file of that name", () => {
		write(".cursor/rules/style.mdc");
		assert.equal(projectFiles(project).cursorRules, true);
		fs.rmSync(path.join(project, ".cursor"), { recursive: true });
		write(".cursor/rules");
		assert.equal(projectFiles(project).cursorRules, false);
	});
});

describe("init prompt", () => {
	it("asks for a new CLAUDE.md in the folder, with what Claude's /init covers", () => {
		const prompt = initPrompt("/work/app", { agentsMd: false, cursorRules: false, copilotInstructions: false });
		assert.match(prompt, /^Please analyze this codebase and create a CLAUDE\.md file at \/work\/app\/CLAUDE\.md\./);
		assert.match(prompt, /build, lint and test, including how to run a single test/);
		assert.match(prompt, /architecture/);
		assert.match(prompt, /Conventions/);
		assert.match(prompt, /under 200 lines/);
		assert.doesNotMatch(prompt, /AGENTS\.md|Cursor|Copilot|already exists/);
	});

	it("improves a CLAUDE.md that exists instead of replacing it", () => {
		const prompt = initPrompt("/work/app", { claudeMd: ".claude/CLAUDE.md", agentsMd: true, cursorRules: false, copilotInstructions: false });
		assert.match(prompt, /^Please analyze this codebase and improve its CLAUDE\.md, \/work\/app\/\.claude\/CLAUDE\.md,/);
		assert.match(prompt, /suggest improvements rather than rewriting it/);
		assert.doesNotMatch(prompt, /@AGENTS\.md/, "Claude reads the CLAUDE.md here, not AGENTS.md");
	});

	it("keeps AGENTS.md loading through an import, and folds in Cursor and Copilot rules", () => {
		const prompt = initPrompt("/work/app", { agentsMd: true, cursorRules: true, copilotInstructions: true });
		assert.match(prompt, /Start CLAUDE\.md with an `@AGENTS\.md` line/);
		assert.match(prompt, /Cursor rules are in \.cursor\/rules\/ or \.cursorrules/);
		assert.match(prompt, /Copilot instructions are in \.github\/copilot-instructions\.md/);
	});
});

describe("init command", () => {
	function load() {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const handlers = new Map<string, () => Promise<void>>();
		const sent: { text: string; options?: unknown }[] = [];
		const pi = {
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler),
			sendUserMessage: (text: string, options?: unknown) => sent.push(options === undefined ? { text } : { text, options }),
		};
		initExtension(pi as never);
		return { commands, handlers, sent };
	}

	it("registers /init", () => {
		assert.deepEqual([...load().commands.keys()], ["init"]);
	});

	it("sends the prompt for the working folder and stays until the turn ends", async () => {
		write("CLAUDE.md");
		const { commands, handlers, sent } = load();
		let waited = false;
		const ctx = { cwd: project, isIdle: () => true, waitForIdle: async () => void (waited = true) };
		let done = false;
		const running = commands
			.get("init")
			?.handler("", ctx)
			.then(() => void (done = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sent.length, 1);
		assert.ok(sent[0]?.text.includes(`improve its CLAUDE.md, ${path.join(project, "CLAUDE.md")},`));
		assert.equal(sent[0]?.options, undefined);
		assert.equal(done, false, "waits for the turn to start");
		await handlers.get("agent_start")?.();
		await running;
		assert.equal(waited, true);
	});

	it("queues the prompt as a follow-up while a turn runs", async () => {
		const { commands, sent } = load();
		await commands.get("init")?.handler("", { cwd: project, isIdle: () => false, waitForIdle: async () => {} });
		assert.deepEqual(sent[0]?.options, { deliverAs: "followUp" });
	});
});
