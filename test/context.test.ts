import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import contextExtension, { contextBreakdown, contextReport, formatTokens, memoryFiles, promptSections, type ReportInput } from "../extensions/context/index.ts";

/** A system prompt's sections as pi builds them: a preamble, then `<name>` blocks. */
const SECTIONS = {
	preamble: "You are a coding assistant running inside pi.",
	tools: "<tools>\n- read: Read files\n</tools>",
	rules: "<rules>\n- Be concise in your responses\n</rules>",
	project_context: [
		"<project_context>",
		"Project-specific instructions and guidelines:",
		"",
		'<project_instructions path="/home/me/.claude/CLAUDE.md">',
		"# Me\n\n<example>\nAn example in a tag of its own.\n</example>\n\nMore.",
		"</project_instructions>",
		"",
		'<project_instructions path="/work/app/CLAUDE.md">',
		"line\n".repeat(250).trimEnd(),
		"</project_instructions>",
		"</project_context>",
	].join("\n"),
	skills: [
		"<skills>",
		"",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"",
		"<available_skills>",
		"  <skill>\n    <name>tdd</name>\n  </skill>",
		"  <skill>\n    <name>pr</name>\n  </skill>",
		"</available_skills>",
		"</skills>",
	].join("\n"),
	cwd: "<cwd>\n/work/app\n</cwd>",
	auto_memory: "<auto_memory>\nYou have a persistent memory folder.\n</auto_memory>",
	mcp_servers: "<mcp_servers>\n- docs: deferred\n</mcp_servers>",
};
/** The prompt as pi renders it, sections between blank lines. */
const PROMPT = Object.values(SECTIONS).join("\n\n");

function input(overrides: Partial<ReportInput> = {}): ReportInput {
	return {
		model: "anthropic/claude-sonnet-5-5",
		contextWindow: 200_000,
		used: 30_000,
		systemPrompt: PROMPT,
		tools: [
			{ name: "read", tokens: 300 },
			{ name: "bash", tokens: 500 },
			{ name: "mcp__docs__search", tokens: 1_000 },
			{ name: "mcp__docs__fetch", tokens: 800 },
			{ name: "mcp__linear__list_issues", tokens: 2_000 },
		],
		messages: 4_000,
		reserveTokens: 16_384,
		home: "/home/me",
		...overrides,
	};
}

const row = (breakdown: ReturnType<typeof contextBreakdown>, label: string) => breakdown.rows.find((entry) => entry.label === label)?.tokens;
/** A section's size at pi's four characters per token. */
const sized = (name: string) => Math.ceil((promptSections(PROMPT).get(name)?.length ?? 0) / 4);

describe("context numbers", () => {
	it("writes token counts short", () => {
		assert.equal(formatTokens(950), "950");
		assert.equal(formatTokens(48_213), "48.2k");
		assert.equal(formatTokens(200_000), "200k");
		assert.equal(formatTokens(999_950), "1M");
		assert.equal(formatTokens(1_250_000), "1.3M");
	});
});

describe("system prompt sections", () => {
	it("finds pi's sections, not the tags inside them", () => {
		assert.deepEqual([...promptSections(PROMPT).keys()], ["tools", "rules", "project_context", "skills", "cwd", "auto_memory", "mcp_servers"]);
		assert.match(promptSections(PROMPT).get("skills") ?? "", /<\/available_skills>\n<\/skills>$/);
	});

	it("has none in a prompt that replaced pi's", () => {
		assert.equal(promptSections("You are a custom agent.\n\nDo things.").size, 0);
	});

	it("lists the instruction files and auto memory, with their size", () => {
		assert.deepEqual(memoryFiles(promptSections(PROMPT), "/home/me"), [
			{ label: "~/.claude/CLAUDE.md", tokens: 17, lines: 7 },
			{ label: "/work/app/CLAUDE.md", tokens: 313, lines: 250 },
			{ label: "Auto memory", tokens: sized("auto_memory"), lines: 0 },
		]);
	});
});

describe("context breakdown", () => {
	it("splits pi's count into Claude's categories, messages taking the rest", () => {
		const breakdown = contextBreakdown(input());
		assert.equal(breakdown.estimated, false);
		assert.equal(breakdown.total, 30_000);
		assert.equal(row(breakdown, "System tools"), 800);
		assert.equal(row(breakdown, "MCP tools"), 3_800 + sized("mcp_servers"), "tools plus the mcp_servers section");
		assert.equal(row(breakdown, "Memory files"), sized("project_context") + sized("auto_memory"));
		assert.equal(row(breakdown, "Skills"), sized("skills"));
		const fixed = ["System prompt", "System tools", "MCP tools", "Memory files", "Skills"].reduce((sum, label) => sum + (row(breakdown, label) ?? 0), 0);
		assert.equal(row(breakdown, "Messages"), 30_000 - fixed);
		assert.equal(row(breakdown, "Free space"), 200_000 - 30_000 - 16_384);
		assert.equal(row(breakdown, "Autocompact buffer"), 16_384);
		assert.equal(breakdown.skills, 2);
		assert.deepEqual(breakdown.mcpServers, [
			{ server: "linear", tools: 1, tokens: 2_000 },
			{ server: "docs", tools: 2, tokens: 1_800 },
		]);
	});

	it("estimates everything while pi has no count", () => {
		const breakdown = contextBreakdown(input({ used: null }));
		assert.equal(breakdown.estimated, true);
		assert.equal(row(breakdown, "Messages"), 4_000);
		const sum = breakdown.rows.filter((entry) => !["Free space", "Autocompact buffer"].includes(entry.label)).reduce((total, entry) => total + entry.tokens, 0);
		assert.equal(breakdown.total, sum);
	});

	it("has no buffer when auto-compaction is off", () => {
		const breakdown = contextBreakdown(input({ reserveTokens: undefined }));
		assert.equal(row(breakdown, "Autocompact buffer"), undefined);
		assert.equal(row(breakdown, "Free space"), 170_000);
	});
});

describe("context report", () => {
	it("shows the total, the categories and what loaded", () => {
		const report = contextReport(input({ commands: { memory: "claude-memory", skills: "claude-skills", mcp: "mcp" } }));
		assert.match(report, /^Context: 30k of 200k tokens \(15\.0%\) · anthropic\/claude-sonnet-5-5\n/);
		assert.match(report, /\n {2}System tools +800 +0\.4%\n/);
		assert.match(report, /\n {2}Autocompact buffer +16\.4k +8\.2%\n/);
		assert.match(
			report,
			/\nMemory files · \/claude-memory\n {2}~\/\.claude\/CLAUDE\.md: 17\n {2}\/work\/app\/CLAUDE\.md: 313 \(250 lines; Claude Code suggests under 200\)\n {2}Auto memory: \d+\n/,
		);
		assert.match(report, /\nSkills · \/claude-skills: 2 listed\n/);
		assert.match(report, /\nMCP tools · \/mcp\n {2}linear: 1 tool, 2k\n {2}docs: 2 tools, 1\.8k$/);
	});

	it("names a command only where it exists, and says when it's estimated", () => {
		const report = contextReport(input({ used: null }));
		assert.match(report, / · estimated until the next response\n/);
		assert.match(report, /\nMemory files\n/);
		assert.match(report, /\nSkills: 2 listed\n/);
	});

	it("warns when the conversation is over the window, and when MCP tools take a tenth of it", () => {
		const over = contextReport(input({ used: 212_000 }));
		assert.match(over, /The conversation is 12k tokens over the context window\. Run \/compact to free space\./);
		assert.doesNotMatch(over, /MCP tools take/);
		const mcp = contextReport(input({ tools: [{ name: "mcp__docs__search", tokens: 20_000 }] }));
		assert.match(mcp, /MCP tools take 10\.0% of the window\. .* change it in \/mcp\.$/);
	});
});

describe("context command", () => {
	let base: string;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-"));
		const agentDir = path.join(base, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 20_000 } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	});

	function load() {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const pi = {
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			getActiveTools: () => ["read", "mcp__docs__search"],
			getAllTools: () => [
				{ name: "read", description: "Read a file", parameters: { type: "object" } },
				{ name: "write", description: "Not active", parameters: { type: "object" } },
				{ name: "mcp__docs__search", description: "Search the docs", parameters: { type: "object", properties: { query: { type: "string" } } } },
			],
			getCommands: () => [{ name: "claude-memory" }],
		};
		contextExtension(pi as never);
		return commands;
	}

	function context(options: { model?: boolean; hasUI?: boolean; responded?: boolean; notes?: string[] }) {
		const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object" } });
		// A session that made a request records the request's prompt and tools as a system message.
		const messages: unknown[] = options.responded
			? [
					{
						role: "system",
						content: "",
						sections: SECTIONS,
						toolsAdded: [tool("read", "Read a file"), tool("mcp__docs__search", "Search the docs"), tool("mcp__linear__list_issues", "List issues")],
						timestamp: 0,
					},
					{ role: "user", content: "Fix the parser", timestamp: 0 },
					{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 },
				]
			: [{ role: "user", content: "Fix the parser", timestamp: 0 }];
		return {
			cwd: base,
			hasUI: options.hasUI ?? true,
			model: options.model === false ? undefined : { provider: "anthropic", id: "claude-sonnet-5-5", contextWindow: 200_000 },
			isProjectTrusted: () => false,
			getContextUsage: () => (options.model === false ? undefined : { tokens: 50_000, contextWindow: 200_000, percent: 25 }),
			// Between runs, pi's own getter has only its base prompt.
			getSystemPrompt: () => (options.responded ? "You are a coding assistant running inside pi." : PROMPT),
			sessionManager: { buildSessionProjection: () => ({ messages }) },
			ui: { notify: (message: string) => options.notes?.push(message) },
		};
	}

	it("registers /context", () => {
		assert.deepEqual([...load().keys()], ["context"]);
	});

	it("reports pi's count, the prompt and tools of the last request, and the buffer from pi's settings", async () => {
		const notes: string[] = [];
		await load()
			.get("context")
			?.handler("", context({ responded: true, notes }));
		assert.equal(notes.length, 1);
		const report = notes[0] ?? "";
		assert.match(report, /^Context: 50k of 200k tokens \(25\.0%\) · anthropic\/claude-sonnet-5-5\n/);
		assert.match(report, /\n {2}Autocompact buffer +20k +10\.0%\n/);
		assert.match(report, /\nMemory files · \/claude-memory\n {2}\/home\/me\/\.claude\/CLAUDE\.md: 17\n/);
		assert.match(report, /\nSkills: 2 listed\n/);
		assert.doesNotMatch(report, /Skills · /, "no /claude-skills command here");
		assert.match(report, /\nMCP tools · \/mcp\n {2}(docs|linear): 1 tool, \d+\n {2}(docs|linear): 1 tool, \d+$/);
	});

	it("shows pi's base prompt and the active tools before the first request, estimated", async () => {
		const notes: string[] = [];
		await load().get("context")?.handler("", context({ notes }));
		const report = notes[0] ?? "";
		assert.match(report, / · estimated until the next response\n/);
		assert.match(report, /\nMCP tools · \/mcp\n {2}docs: 1 tool, \d+\n/);
		assert.doesNotMatch(report, /linear/);
		assert.match(report, /\nNo prompt has been sent yet, so this is pi's base prompt; extensions add to it when a prompt starts\.$/);
	});

	it("says so when there's no model, and prints without a UI", async () => {
		const notes: string[] = [];
		await load()
			.get("context")
			?.handler("", context({ model: false, notes }));
		assert.match(notes[0] ?? "", /^Context usage isn't available/);
		const written: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as never;
		try {
			await load()
				.get("context")
				?.handler("", context({ hasUI: false, responded: true }));
		} finally {
			process.stdout.write = original;
		}
		assert.match(written.join(""), /^Context: 50k of 200k tokens/);
	});
});
