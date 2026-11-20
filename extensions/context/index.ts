/**
 * Context: `/context` shows what fills the model's context window, as Claude Code's `/context` does
 * (https://code.claude.com/docs/en/commands.md): how much is used, a breakdown by category, the
 * space kept free for auto-compaction, which instruction and memory files loaded, and warnings that
 * name what frees space.
 *
 * The total is pi's own count, the one the footer shows: the last response's usage plus an estimate
 * for messages added since. The categories are estimated at four characters per token, as pi
 * estimates, from the system prompt and tools the model had at the last request, which the session
 * records; messages are the rest of the total. Before the first response and right after a
 * compaction pi has no count, so the whole breakdown is estimated until the next response. Before the
 * first prompt there's no request yet, so the breakdown shows pi's base prompt, which extensions add
 * to when a prompt starts. The report is text, without Claude's colored grid.
 *
 * Based on pi-code's context-usage extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md),
 * which showed the total only.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, estimateTokens, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** pi's estimate for text it hasn't counted: about four characters per token. */
export function tokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

/** `950`, `48.2k`, `200k`, `1M`. */
export function formatTokens(count: number): string {
	const short = (value: number, unit: string) => `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
	if (count < 1000) return `${count}`;
	if (count < 999_950) return short(count / 1000, "k");
	return short(count / 1_000_000, "M");
}

/** A top-level `<name>` section of the system prompt. The lookahead keeps a tag inside one, such as
 * `<available_skills>`, from ending it. */
const SECTION = /(?:^|\n\n)<([a-z][a-z0-9_-]*)>\n[\s\S]*?\n<\/\1>(?=\n\n<[a-z][a-z0-9_-]*>\n|\s*$)/g;
const INSTRUCTION_FILE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>(?=\n\n<project_instructions |\n<\/project_context>|\s*$)/g;

/** Claude suggests keeping each CLAUDE.md under this many lines. */
const MEMORY_FILE_LINES = 200;

/** The share of the window at which Claude stops loading MCP tool definitions upfront
 * (`ENABLE_TOOL_SEARCH=auto`). */
const MCP_SHARE = 0.1;

/** The sections of a system prompt pi built, by name: the `<name>` blocks after its preamble. A
 * prompt that replaces pi's whole prompt has none. */
export function promptSections(prompt: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const match of prompt.matchAll(SECTION)) sections.set(match[1] ?? "", match[0].replace(/^\n\n/, ""));
	return sections;
}

export interface MemoryFile {
	label: string;
	tokens: number;
	lines: number;
}

/** The instruction files in the prompt's `project_context` section, then auto memory. */
export function memoryFiles(sections: Map<string, string>, home: string = os.homedir()): MemoryFile[] {
	const files: MemoryFile[] = [];
	for (const match of (sections.get("project_context") ?? "").matchAll(INSTRUCTION_FILE)) {
		const file = match[1] ?? "";
		const content = match[2] ?? "";
		const label = file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
		files.push({ label, tokens: tokensOf(content), lines: content.replace(/\n+$/, "").split("\n").length });
	}
	const memory = sections.get("auto_memory");
	if (memory) files.push({ label: "Auto memory", tokens: tokensOf(memory), lines: 0 });
	return files;
}

export interface DeclaredTool {
	name: string;
	tokens: number;
}

export interface ReportInput {
	/** `provider/id`. */
	model: string;
	contextWindow: number;
	/** pi's count, or null while it has none: before the first response and right after a compaction. */
	used: number | null;
	systemPrompt: string;
	/** The tools declared to the model. */
	tools: DeclaredTool[];
	/** The conversation's messages, estimated; used while pi has no count. */
	messages: number;
	/** The tokens auto-compaction keeps free, or undefined when it's off. */
	reserveTokens: number | undefined;
	/** The commands that manage memory files, skills and MCP servers, where they exist. */
	commands?: { memory?: string; skills?: string; mcp?: string };
	/** Whether the prompt is pi's base one, since no request has been made yet. */
	basePrompt?: boolean;
	home?: string;
}

export interface Breakdown {
	total: number;
	estimated: boolean;
	rows: { label: string; tokens: number }[];
	memory: MemoryFile[];
	skills: number;
	mcpServers: { server: string; tools: number; tokens: number }[];
}

/** Splits the context into Claude's categories. */
export function contextBreakdown(input: ReportInput): Breakdown {
	const sections = promptSections(input.systemPrompt);
	const sized = (name: string) => tokensOf(sections.get(name) ?? "");
	const memoryTokens = sized("project_context") + sized("auto_memory");
	const skillTokens = sized("skills");
	const mcpPrompt = sized("mcp_servers");
	const systemPrompt = Math.max(0, tokensOf(input.systemPrompt) - memoryTokens - skillTokens - mcpPrompt);

	const servers = new Map<string, { tools: number; tokens: number }>();
	let systemTools = 0;
	for (const tool of input.tools) {
		const server = /^mcp__(.+?)__/.exec(tool.name)?.[1];
		if (!server) {
			systemTools += tool.tokens;
			continue;
		}
		const entry = servers.get(server) ?? { tools: 0, tokens: 0 };
		entry.tools++;
		entry.tokens += tool.tokens;
		servers.set(server, entry);
	}
	const mcpTools = mcpPrompt + [...servers.values()].reduce((sum, entry) => sum + entry.tokens, 0);

	const fixed = systemPrompt + systemTools + mcpTools + memoryTokens + skillTokens;
	const estimated = input.used === null;
	const messages = input.used === null ? input.messages : Math.max(0, input.used - fixed);
	const total = input.used ?? fixed + messages;
	const rows = [
		{ label: "System prompt", tokens: systemPrompt },
		{ label: "System tools", tokens: systemTools },
		{ label: "MCP tools", tokens: mcpTools },
		{ label: "Memory files", tokens: memoryTokens },
		{ label: "Skills", tokens: skillTokens },
		{ label: "Messages", tokens: messages },
		{ label: "Free space", tokens: Math.max(0, input.contextWindow - total - (input.reserveTokens ?? 0)) },
		...(input.reserveTokens === undefined ? [] : [{ label: "Autocompact buffer", tokens: input.reserveTokens }]),
	];
	return {
		total,
		estimated,
		rows,
		memory: memoryFiles(sections, input.home),
		skills: (sections.get("skills")?.match(/^ {2}<skill>$/gm) ?? []).length,
		mcpServers: [...servers].map(([server, entry]) => ({ server, ...entry })).sort((a, b) => b.tokens - a.tokens),
	};
}

/** The `/context` report. */
export function contextReport(input: ReportInput): string {
	const window = input.contextWindow;
	const share = (tokens: number) => `${((tokens / window) * 100).toFixed(1)}%`;
	const { total, estimated, rows, memory, skills, mcpServers } = contextBreakdown(input);
	const width = Math.max(...rows.map((row) => row.label.length));
	const lines = [
		`Context: ${formatTokens(total)} of ${formatTokens(window)} tokens (${share(total)}) · ${input.model}${estimated ? " · estimated until the next response" : ""}`,
		"",
		...rows.map((row) => `  ${row.label.padEnd(width)}  ${formatTokens(row.tokens).padStart(6)}  ${share(row.tokens).padStart(6)}`),
	];
	const heading = (title: string, command: string | undefined) => (command ? `${title} · /${command}` : title);

	if (memory.length > 0) {
		lines.push("", heading("Memory files", input.commands?.memory));
		for (const file of memory) {
			const long = file.lines > MEMORY_FILE_LINES ? ` (${file.lines} lines; Claude Code suggests under ${MEMORY_FILE_LINES})` : "";
			lines.push(`  ${file.label}: ${formatTokens(file.tokens)}${long}`);
		}
	}
	if (skills > 0) lines.push("", `${heading("Skills", input.commands?.skills)}: ${skills} listed`);
	if (mcpServers.length > 0) {
		lines.push("", heading("MCP tools", input.commands?.mcp));
		for (const entry of mcpServers) lines.push(`  ${entry.server}: ${entry.tools} tool${entry.tools === 1 ? "" : "s"}, ${formatTokens(entry.tokens)}`);
	}

	const warnings: string[] = [];
	if (total > window) warnings.push(`The conversation is ${formatTokens(total - window)} tokens over the context window. Run /compact to free space.`);
	const mcp = rows.find((row) => row.label === "MCP tools")?.tokens ?? 0;
	if (mcp >= window * MCP_SHARE) {
		warnings.push(
			`MCP tools take ${share(mcp)} of the window. Servers with deferred or codemode exposure keep their tools out of context until they're needed; change it in /mcp.`,
		);
	}
	if (warnings.length > 0) lines.push("", ...warnings);
	if (input.basePrompt) lines.push("", "No prompt has been sent yet, so this is pi's base prompt; extensions add to it when a prompt starts.");
	return lines.join("\n");
}

/** A tool as sent, estimated from its name, description and parameters. */
function declared(tool: { name: string; description?: string; parameters?: unknown }): DeclaredTool {
	return { name: tool.name, tokens: tokensOf(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })) };
}

/** The tokens pi's auto-compaction keeps free for this model, or undefined when it's off. */
function reserveTokens(ctx: ExtensionCommandContext): number | undefined {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings(ctx.model);
		return settings.enabled ? settings.reserveTokens : undefined;
	} catch {
		return undefined;
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show what fills the context window, by category, with the memory files that loaded",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow || ctx.model?.contextWindow || 0;
			let report: string;
			if (!ctx.model || contextWindow <= 0) {
				report = "Context usage isn't available: no model is selected, or pi doesn't know its context window.";
			} else {
				const transcript = ctx.sessionManager.buildSessionProjection().messages;
				const messages = transcript.filter((message) => message.role !== "system");
				// The session records the prompt and tools of each request as system messages. Between runs
				// pi's getSystemPrompt() is its base prompt, without what extensions add for a run.
				const requested = transcript.some((message) => message.role === "system");
				const active = new Set(pi.getActiveTools());
				const commands = new Set(pi.getCommands().map((command) => command.name));
				const has = (name: string) => (commands.has(name) ? name : undefined);
				report = contextReport({
					model: `${ctx.model.provider}/${ctx.model.id}`,
					contextWindow,
					// pi counts from a response; until the first one, the breakdown's own estimate stands in.
					used: messages.some((message) => message.role === "assistant") ? (usage?.tokens ?? null) : null,
					systemPrompt: requested ? getCurrentSystemPrompt(transcript) : ctx.getSystemPrompt(),
					tools: requested
						? getCurrentTools(transcript).map(declared)
						: pi
								.getAllTools()
								.filter((tool) => active.has(tool.name))
								.map(declared),
					basePrompt: !requested,
					messages: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
					reserveTokens: reserveTokens(ctx),
					// `/mcp` is pi's own command, which getCommands doesn't list.
					commands: { memory: has("claude-memory"), skills: has("claude-skills"), mcp: "mcp" },
				});
			}
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else process.stdout.write(`${report}\n`);
		},
	});
}
