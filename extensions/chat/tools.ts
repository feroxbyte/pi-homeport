/**
 * Tool rows in the transcript, one per call, the way Claude Code draws them:
 *
 *   ● Read(notes.txt)
 *     ⎿  Read 3 lines
 *
 * The ● carries the status: dim while the model writes the call, accent while it runs, green when it
 * worked, red when it failed. A shell command shows its first output lines; ctrl+o shows everything.
 * Edits and new files show a highlighted diff. Other extensions' tools keep their own drawing under
 * the same dot.
 *
 * Based on pi-polish by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md).
 */

import { type ExtensionAPI, keyHint, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Container, stripTerminalSequences, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { shortCommand } from "./command.ts";
import { DIFF_PREVIEW_LINES, DiffView, empty, FILE_TOOL_GUIDELINES, lineCount, MARK, type Result, resultText, shortPath } from "./highlight.ts";

/** What hangs a result under its call. */
const ELBOW = "⎿";
/** Output lines a finished shell command shows before ctrl+o. */
const BASH_PREVIEW_LINES = 3;
/** Lines anything shows when expanded. */
const EXPANDED_LINES = 200;

type Theme = any;
interface RowContext {
	toolCallId: string;
	args?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	executionStarted?: boolean;
	expanded?: boolean;
	lastComponent?: Component;
}

const quote = (value: unknown) => `"${String(value ?? "").split("\n")[0]}"`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The call as Claude Code writes it: `Name(argument)`. */
export function callLabel(toolName: string, args: any, cwd: string): { name: string; argument: string } {
	switch (toolName) {
		case "bash":
			return { name: "Bash", argument: shortCommand(String(args?.command ?? ""), cwd) };
		case "read": {
			const range = args?.offset || args?.limit ? ` · lines ${args?.offset ?? 1}-${args?.limit ? Number(args?.offset ?? 1) + Number(args.limit) - 1 : "end"}` : "";
			return { name: "Read", argument: `${shortPath(args?.path, cwd)}${range}` };
		}
		case "grep":
		case "find":
			return { name: "Search", argument: `pattern: ${quote(args?.pattern)}${args?.path ? `, path: ${quote(shortPath(args.path, cwd))}` : ""}` };
		case "ls":
			return { name: "List", argument: args?.path ? shortPath(args.path, cwd) : "." };
		case "tool_search":
			return { name: "Search tools", argument: quote(args?.query) };
		case "codemode": {
			// The script's first line of code, which usually names the tool it calls.
			const first = String(args?.code ?? "")
				.split("\n")
				.map((line) => line.trim())
				.find(Boolean);
			return { name: "Codemode", argument: first ?? "" };
		}
		case "web_search": {
			const queries: unknown[] = Array.isArray(args?.queries) ? args.queries : [args?.query];
			return { name: "Web Search", argument: queries.filter(Boolean).map(quote).join(", ") };
		}
		case "web_fetch":
		case "fetch_content": {
			const urls: unknown[] = Array.isArray(args?.urls) ? args.urls : [args?.url];
			return { name: "Fetch", argument: urls.length === 1 ? String(urls[0] ?? "") : plural(urls.length, "URL") };
		}
		case "get_search_content":
			return { name: "Search results", argument: String(args?.responseId ?? args?.id ?? "") };
		case "edit":
			return { name: "Update", argument: shortPath(args?.path, cwd) };
		case "write":
			return { name: "Write", argument: shortPath(args?.path, cwd) };
		default: {
			if (toolName.startsWith("mcp__")) {
				const [, server, ...tool] = toolName.split("__");
				const first = Object.entries(args ?? {}).find(([, value]) => typeof value === "string");
				return { name: `${server} - ${tool.join("__")} (MCP)`, argument: first ? `${first[0]}: ${quote(first[1])}` : "" };
			}
			const first = Object.values(args ?? {}).find((value) => typeof value === "string") as string | undefined;
			return { name: toolName, argument: first ? first.split("\n")[0] ?? "" : "" };
		}
	}
}

/** The non-empty output lines of a result, without terminal escapes. */
function outputLines(text: string): string[] {
	return text
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()
		.split("\n")
		.map((line) => stripTerminalSequences(line).replace(/\t/g, "  "));
}

/**
 * A read's own text: the first text part of its result, without pi's closing note on a long file
 * (`[Showing lines 1-200 of 900. …]`). Extensions append other parts, such as instructions that now
 * apply, which aren't part of the file.
 */
export function readText(result: Result): string {
	const own = result.content.find((part) => part.type === "text")?.text ?? "";
	return own.replace(/\n\n\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\]]*\]\s*$/, "");
}

/** Whether a failed call was stopped by you (Esc), not by an error. */
export function wasInterrupted(text: string): boolean {
	return /^(?:Operation aborted|Request was aborted|Command aborted|Aborted)\.?$/i.test(text.trim());
}

/** `4s`, `1m 04s`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const compactCount = (count: number) => (count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`);

interface AgentRun {
	agent?: string;
	exitCode?: number;
	errorMessage?: string;
	messages?: Array<{ role?: string; content?: Array<{ type?: string }> }>;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** An agent run as Claude Code sums it up: `Done (12 tool uses · 31.2k tokens · 1m 04s)`. */
export function agentSummary(run: AgentRun, ms: number | undefined): string {
	const uses = (run.messages ?? []).flatMap((message) => (message.role === "assistant" ? (message.content ?? []) : [])).filter((part) => part.type === "toolCall").length;
	const usage = run.usage ?? {};
	const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	const stats = [plural(uses, "tool use"), `${compactCount(tokens)} tokens`, ...(ms !== undefined ? [formatDuration(ms)] : [])].join(" · ");
	if (run.exitCode !== undefined && run.exitCode !== 0) return `Failed (${stats})${run.errorMessage ? `: ${run.errorMessage.split("\n")[0]}` : ""}`;
	return `Done (${stats})`;
}

/** The one-line summary under a finished call. */
export function resultSummary(toolName: string, text: string): string {
	const lines = text.trim() === "" ? [] : text.trimEnd().split("\n");
	switch (toolName) {
		case "read":
			return `Read ${plural(lines.length, "line")}`;
		case "grep":
			return lines.length === 0 || /^no matches/i.test(lines[0] ?? "") ? "No matches" : `Found ${plural(lines.length, "line")}`;
		case "find":
			return lines.length === 0 || /^no files/i.test(lines[0] ?? "") ? "No files found" : `Found ${plural(lines.length, "file")}`;
		case "ls":
			return `Listed ${plural(lines.length, "path")}`;
		case "web_fetch":
		case "fetch_content": {
			const kb = Buffer.byteLength(text, "utf8") / 1024;
			return `Received ${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
		}
		default:
			return lines.length === 0 ? "(No output)" : (lines[0] ?? "") + (lines.length > 1 ? ` … +${plural(lines.length - 1, "line")}` : "");
	}
}

export default function chatTools(pi: ExtensionAPI) {
	// Tells pi-background that its ctrl+b hint goes under the running command's row, drawn here.
	(globalThis as any)[Symbol.for("pi-polish.showsMoveHint")] = true;
	const cwd = process.cwd();
	let live = false;
	pi.on("agent_start", async () => {
		live = true;
	});
	pi.on("agent_end", async () => {
		live = false;
	});
	/** When each running call started and how long finished ones took, for agent rows. */
	const started = new Map<string, number>();
	const took = new Map<string, number>();
	pi.on("tool_execution_start", async (event) => {
		started.set(event.toolCallId, Date.now());
	});
	pi.on("tool_execution_end", async (event) => {
		const start = started.get(event.toolCallId);
		if (start !== undefined) took.set(event.toolCallId, Date.now() - start);
		started.delete(event.toolCallId);
	});

	/** The dot's color: dim while the call streams, accent while it runs, then green or red. History
	 * rows redrawn after /reload have no execution state, so they count as done. */
	const status = (context: RowContext) => {
		if (context.isError) return "error";
		if (context.executionStarted && context.isPartial) return "accent";
		if (!context.executionStarted && live) return "dim";
		return "success";
	};

	/** `● Name(argument)`, wrapping under the name instead of at the left edge. */
	const callRow = (toolName: string, args: unknown, theme: Theme, context: RowContext): Component => {
		const { name, argument } = callLabel(toolName, args, cwd);
		const text = theme.fg("toolTitle", theme.bold(name)) + (argument ? theme.fg("toolTitle", `(${argument})`) : "");
		return {
			invalidate() {},
			render: (width: number) => ["", ...wrapTextWithAnsi(text, Math.max(10, width - 2)).map((line, i) => (i === 0 ? theme.fg(status(context), `${MARK} `) : "  ") + line)],
		};
	};

	/** Lines under a call: the first after `⎿`, the rest lined up with it. */
	const underCall = (lines: string[], theme: Theme, color = "dim"): Component => ({
		invalidate() {},
		render: (width: number) =>
			lines.flatMap((line, i) =>
				wrapTextWithAnsi(theme.fg(color, line), Math.max(10, width - 5)).map((part, j) => (i === 0 && j === 0 ? `  ${theme.fg("dim", ELBOW)}  ` : "     ") + part),
			),
	});

	const expandHint = (count: number) => `… +${plural(count, "line")} (${keyHint("app.tools.expand", "to expand")})`;

	/** A failed call's error: its first line, or all of it when expanded. */
	const errorRows = (text: string, expanded: boolean | undefined, theme: Theme) => {
		if (wasInterrupted(text)) return underCall(["Interrupted by user"], theme, "error");
		const lines = outputLines(text);
		if (expanded || lines.length <= 1) return underCall(lines.slice(0, EXPANDED_LINES), theme, "error");
		return underCall([lines[0] ?? "", expandHint(lines.length - 1)], theme, "error");
	};

	/** Pi's own result views for MCP and codemode calls, which show images and nested calls when expanded. */
	const pisResult = new Map<string, ToolRenderers["renderResult"]>();

	const plainTool = (toolName: string): ToolRenderers => ({
		renderShell: "self",
		renderCall: (args, theme, context) => callRow(toolName, args, theme, context as RowContext),
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = resultText(result as Result);
			if (isPartial) {
				if (toolName !== "bash") return underCall(["Running…"], theme);
				// The latest output line of a running command, as a terminal would show it.
				const latest = outputLines(text)
					.map((line) => line.split("\r").filter((part) => part.trim()).at(-1) ?? "")
					.filter((line) => line.trim())
					.at(-1);
				const movable = (globalThis as any)[Symbol.for("pi-background.movable")]?.has(context.toolCallId) ? ["(ctrl+b to run in background)"] : [];
				return underCall([latest ?? "Running…", ...movable], theme);
			}
			if (context.isError) return errorRows(text, expanded, theme);
			const pis = pisResult.get(toolName);
			if (expanded && pis) {
				const own = pis(result, { expanded: true, isPartial: false }, theme, { ...context, lastComponent: undefined });
				return { invalidate: () => own.invalidate(), render: (width: number) => own.render(Math.max(10, width - 5)).map((line) => `     ${line}`) };
			}
			const lines = outputLines(text);
			if (expanded) return underCall([...lines.slice(0, EXPANDED_LINES), ...(lines.length > EXPANDED_LINES ? [`… +${plural(lines.length - EXPANDED_LINES, "line")}`] : [])], theme, "toolOutput");
			if (toolName === "bash") {
				if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return underCall(["(No output)"], theme);
				const shown = lines.slice(0, BASH_PREVIEW_LINES);
				return underCall(lines.length > shown.length ? [...shown, expandHint(lines.length - shown.length)] : shown, theme, "toolOutput");
			}
			if (toolName === "web_search") {
				const args = context.args as any;
				const searches = Array.isArray(args?.queries) ? args.queries.length : 1;
				const ms = took.get(context.toolCallId);
				return underCall([`Did ${plural(searches, "search", "searches")}${ms !== undefined ? ` in ${formatDuration(ms)}` : ""}`], theme);
			}
			return underCall([resultSummary(toolName, toolName === "read" ? readText(result as Result) : text)], theme);
		},
	});

	/** An edit or a new file: the summary, then the diff. */
	const fileTool = (toolName: "edit" | "write"): ToolRenderers => ({
		renderShell: "self",
		renderCall: (args, theme, context) => callRow(toolName, args, theme, context as RowContext),
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError) return errorRows(resultText(result as Result), expanded, theme);
			const args = context.args as any;
			const path = shortPath(args?.path, cwd);
			let summary: string;
			let lines: string[];
			if (toolName === "edit") {
				lines = String((result as any).details?.diff ?? "")
					.split("\n")
					.filter(Boolean);
				const added = lines.filter((line) => line.startsWith("+")).length;
				const removed = lines.filter((line) => line.startsWith("-")).length;
				summary = `Updated ${path} with ${plural(added, "addition")} and ${plural(removed, "removal")}`;
			} else {
				const content = String(args?.content ?? "").replace(/\n$/, "").split("\n");
				const digits = String(content.length).length;
				lines = content.map((line, i) => `+${String(i + 1).padStart(digits)} ${line}`);
				summary = `Wrote ${lineCount(content.length)} to ${path}`;
			}
			const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
			const more = lines.length - shown.length;
			const box = new Container();
			box.addChild(underCall([summary], theme));
			box.addChild(new DiffView(shown, theme, more > 0 ? theme.fg("dim", `     … +${plural(more, "line")} (${keyHint("app.tools.expand", "to expand")})`) : undefined, String(args?.path ?? "")));
			return box;
		},
	});

	// Other extensions' tools keep their own drawing, without pi's colored box, under the status dot.
	// Their renderer gets back its own component, not the wrapper, to reuse.
	type Framed = Component & { inner: Component };
	const frame = (inner: Component, mark: string, gap: boolean): Framed => ({
		inner,
		invalidate: () => inner.invalidate(),
		render: (width: number) => [...(gap ? [""] : []), ...inner.render(Math.max(10, width - 2)).map((line, i) => (i === 0 ? mark : "  ") + line)],
	});
	const unframed = <C extends { lastComponent?: Component }>(context: C): C => ({ ...context, lastComponent: (context.lastComponent as Framed | undefined)?.inner });
	const otherTool = (toolName: string, own: ToolRenderers): ToolRenderers => ({
		renderShell: "self",
		renderCall(args, theme, context) {
			const mark = theme.fg(status(context as RowContext), `${MARK} `);
			if (!own.renderCall) return callRow(toolName, args, theme, context as RowContext);
			return frame(own.renderCall(args, theme, unframed(context)), mark, true);
		},
		renderResult(result, options, theme, context) {
			if (own.renderResult) return frame(own.renderResult(result, options, theme, unframed(context)), "  ", false);
			const text = resultText(result as Result);
			if (options.isPartial) return empty();
			if (context.isError) return errorRows(text, options.expanded, theme);
			return options.expanded ? underCall(outputLines(text).slice(0, EXPANDED_LINES), theme, "toolOutput") : underCall([resultSummary(toolName, text)], theme);
		},
	});

	/** The todo tool: `● Update Todos` with the list as a checklist under it. */
	const todoTool: ToolRenderers = {
		renderShell: "self",
		renderCall: (_args, theme, context) => {
			const mark = theme.fg(status(context as RowContext), `${MARK} `);
			return { invalidate() {}, render: () => ["", mark + theme.fg("toolTitle", theme.bold("Update Todos"))] };
		},
		renderResult(result, { isPartial, expanded }, theme, context) {
			if (isPartial) return empty();
			// pi-homeport's todo extension reports `tasks` with a `subject`; pi-code's reported `todos` with `text`.
			const details = (result as any).details as
				| { tasks?: Array<{ subject: string; status: string }>; todos?: Array<{ text: string; status: string }>; error?: string }
				| undefined;
			if (context.isError || details?.error) return errorRows(details?.error ?? resultText(result as Result), expanded, theme);
			const todos = [
				...(details?.tasks ?? []).filter((task) => task.status !== "deleted").map((task) => ({ text: task.subject, status: task.status })),
				...(details?.todos ?? []),
			];
			if (todos.length === 0) return underCall(["No todos"], theme);
			return {
				invalidate() {},
				render: (width: number) =>
					todos.flatMap((todo, i) => {
						const box = todo.status === "completed" ? "☒" : "☐";
						const text =
							todo.status === "completed"
								? theme.fg("dim", theme.strikethrough ? theme.strikethrough(todo.text) : todo.text)
								: todo.status === "in_progress"
									? theme.bold(todo.text)
									: todo.text;
						return wrapTextWithAnsi(`${box} ${text}`, Math.max(10, width - 5)).map((line, j) => (i === 0 && j === 0 ? `  ${theme.fg("dim", ELBOW)}  ` : "     ") + line);
					}),
			};
		},
	};

	/** pi-code's subagent tool: one `● agent(task)` row per agent, with `Done (…)` under it. */
	const agentTool = (own: ToolRenderers | undefined): ToolRenderers => ({
		renderShell: "self",
		renderCall(args: any, theme, context) {
			const calls: Array<{ agent?: string; task?: string }> = args?.chain?.length ? args.chain : args?.tasks?.length ? args.tasks : [{ agent: args?.agent, task: args?.task }];
			const mark = theme.fg(status(context as RowContext), `${MARK} `);
			const rows = calls.map((call, i) => {
				const task = String(call.task ?? "").split("\n")[0] ?? "";
				const label = theme.fg("toolTitle", theme.bold(call.agent ?? "agent")) + theme.fg("toolTitle", `(${task})`);
				return (i === 0 ? mark : `${args?.chain?.length ? theme.fg("dim", "→") : theme.fg(status(context as RowContext), MARK)} `) + label;
			});
			return { invalidate() {}, render: (width: number) => ["", ...rows.map((row) => truncateToWidth(row, width))] };
		},
		renderResult(result, options, theme, context) {
			if (options.expanded && own?.renderResult) {
				const inner = own.renderResult(result, options, theme, { ...context, lastComponent: undefined });
				return { invalidate: () => inner.invalidate(), render: (width: number) => inner.render(Math.max(10, width - 5)).map((line) => `     ${line}`) };
			}
			const runs = (((result as any).details?.results ?? []) as AgentRun[]).filter(Boolean);
			if (options.isPartial) return underCall([runs.length ? `Running… (${plural(runs.length, "agent")} started)` : "Running…"], theme);
			if (runs.length === 0) return context.isError ? errorRows(resultText(result as Result), options.expanded, theme) : underCall([resultSummary("subagent", resultText(result as Result))], theme);
			const ms = took.get(context.toolCallId);
			const lines = runs.map((run) => (runs.length > 1 ? `${run.agent ?? "agent"}: ` : "") + agentSummary(run, runs.length === 1 ? ms : undefined));
			if (runs.length > 1 && ms !== undefined) lines.push(`All done in ${formatDuration(ms)}`);
			return underCall([...lines, `(${keyHint("app.tools.expand", "to see the transcript")})`], theme, runs.some((run) => run.exitCode) ? "error" : "dim");
		},
	});

	const OWN = new Set(["bash", "read", "grep", "find", "ls", "tool_search", "codemode", "web_search", "web_fetch", "fetch_content", "get_search_content"]);
	const edit = fileTool("edit");
	const write = fileTool("write");
	// Only the drawing changes: the tools run as before, with their own schema and on/off state.
	pi.registerToolRenderer((toolName, next) => {
		if (toolName === "edit") return edit;
		if (toolName === "write") return write;
		if (toolName === "todo") return todoTool;
		if (toolName === "subagent") {
			const own = next();
			const ours = agentTool(own);
			const theirs = own && own.renderShell !== "self" ? otherTool(toolName, own) : own;
			if (!theirs) return ours;
			// Known results (pi-code's: per-agent messages and usage) get Claude's `Done (…)` summary; any
			// other subagent extension, such as pi-subagents, keeps its own live view under the dot.
			const known = (result: unknown) => {
				const runs = (result as any)?.details?.results;
				return Array.isArray(runs) && runs.every((run: any) => Array.isArray(run?.messages) && typeof run?.usage === "object");
			};
			return {
				...theirs,
				renderResult: (result, options, theme, context) =>
					known(result) || !theirs.renderResult ? ours.renderResult!(result, options, theme, context) : theirs.renderResult(result, options, theme, context),
			};
		}
		if (OWN.has(toolName) || toolName.startsWith("mcp__")) {
			// Expanded, these keep pi's own result view: highlighted file content, images, nested calls.
			if (toolName === "read" || toolName === "codemode" || toolName.startsWith("mcp__")) {
				const pis = next()?.renderResult;
				if (pis) pisResult.set(toolName, pis);
			}
			return plainTool(toolName);
		}
		const own = next();
		// Tools that draw their own frame, like bg_run, already fit in.
		return own && own.renderShell !== "self" ? otherTool(toolName, own) : own;
	});

	// pi only lists a tool's guidelines while the tool is on.
	pi.on("before_agent_start", async (event) => {
		const guidelines = event.systemPromptOptions.toolGuidelines;
		for (const [name, rules] of Object.entries(FILE_TOOL_GUIDELINES)) guidelines[name] = [...(guidelines[name] ?? []), ...rules];
	});
}
