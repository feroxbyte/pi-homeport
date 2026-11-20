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
			return underCall([resultSummary(toolName, text)], theme);
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

	const OWN = new Set(["bash", "read", "grep", "find", "ls", "tool_search", "codemode"]);
	const edit = fileTool("edit");
	const write = fileTool("write");
	// Only the drawing changes: the tools run as before, with their own schema and on/off state.
	pi.registerToolRenderer((toolName, next) => {
		if (toolName === "edit") return edit;
		if (toolName === "write") return write;
		if (OWN.has(toolName) || toolName.startsWith("mcp__")) {
			if (toolName === "codemode" || toolName.startsWith("mcp__")) {
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
