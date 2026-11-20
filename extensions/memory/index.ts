/**
 * Claude memory: the instruction files and auto memory Claude Code loads, in pi.
 *
 * - Instruction files (CLAUDE.md, CLAUDE.local.md, rules, AGENTS.md and their imports) replace the
 *   project context files pi found itself, in Claude's order and by Claude's rules. pi's own files
 *   in its agent folder stay. Files that load later in Claude Code load here when the model reads,
 *   writes or edits a file, added to that tool's result.
 * - Auto memory: the index loads into the prompt with instructions for writing memories, and a
 *   memory file the model writes gets a `modified` time; writing `MEMORY.md` past its load limits
 *   returns an error, as in Claude Code.
 *
 * Both load at the start of a session and again after compaction. `/claude-memory` lists what loaded,
 * opens a file in your editor, and turns auto memory on or off.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ClaudeSetup, isRecord, readClaudeSetup } from "../shared/claude.ts";
import { type AutoMemory, INDEX_FILE, INDEX_MAX_LINES, indexState, memoryPrompt, readAutoMemory, stampModified } from "./auto.ts";
import { type InstructionFile, Instructions, laterFileLimit } from "./instructions.ts";

/** pi's flag that turns context files off; Claude's instruction files stay off with it. */
const NO_CONTEXT_FLAGS = new Set(["--no-context-files", "-nc"]);

function inside(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export default function claudeMemoryExtension(pi: ExtensionAPI) {
	let setup: ClaudeSetup | undefined;
	let instructions: Instructions | undefined;
	let memory: AutoMemory | undefined;
	const contextOff = process.argv.some((arg) => NO_CONTEXT_FLAGS.has(arg));

	function report(ctx: ExtensionContext, message: string, level: "error" | "warning" | "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") process.stderr.write(`${message}\n`);
	}

	function refresh(ctx: ExtensionContext) {
		setup = readClaudeSetup({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		instructions = new Instructions(setup, { cwd: ctx.cwd });
		memory = readAutoMemory(setup, ctx.cwd);
		const unapproved = instructions.skipped.filter((file) => file.reason.includes("not approved"));
		if (unapproved.length > 0) {
			report(
				ctx,
				`Claude memory: ${unapproved.length} import(s) from outside this folder didn't load, because Claude Code hasn't approved external imports for this project. Approve them in a Claude Code session; /claude-memory lists them.`,
				"warning",
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (instructions && !contextOff) {
			const agentDir = getAgentDir();
			const piOwn = (options.contextFiles ?? []).filter((file) => path.dirname(path.resolve(file.path)) === agentDir);
			options.contextFiles = [...piOwn, ...instructions.files.map(({ path: file, content }) => ({ path: file, content }))];
		}
		if (memory?.enabled) options.sections = { ...options.sections, auto_memory: memoryPrompt(memory) };
		else if (options.sections) delete options.sections.auto_memory;
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !["read", "edit", "write"].includes(event.toolName)) return undefined;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return undefined;
		const file = input.path.startsWith("~/") ? path.join(os.homedir(), input.path.slice(2)) : path.resolve(ctx.cwd, input.path);
		const added: { type: "text"; text: string }[] = [];
		let isError = false;

		if (instructions && !contextOff) {
			const loaded = instructions.touched(file, event.toolName as "read" | "write" | "edit", laterFileLimit(ctx.model?.contextWindow));
			if (loaded.length > 0) {
				added.push({
					type: "text",
					text: `\n\nThese instructions apply to files here:\n\n${loaded.map((entry) => `<project_instructions path="${entry.path}">\n${entry.content}\n</project_instructions>`).join("\n\n")}`,
				});
			}
		}

		if (memory?.enabled && event.toolName !== "read" && inside(file, memory.dir) && file.endsWith(".md")) {
			try {
				const content = fs.readFileSync(file, "utf8");
				if (path.basename(file) === INDEX_FILE) {
					const state = indexState(content);
					if (state === "over") {
						isError = true;
						added.push({
							type: "text",
							text: `\n\n${INDEX_FILE} was written, but it's over its load limit (${INDEX_MAX_LINES} lines or 25KB), and everything past the limit is dropped when the next session starts. Rewrite it now: one line per memory, details in the memory files, stale entries merged or removed.`,
						});
					} else if (state === "near") {
						added.push({
							type: "text",
							text: `\n\n${INDEX_FILE} is close to its load limit (${INDEX_MAX_LINES} lines or 25KB). Shorten it: one line per memory, details in the memory files, stale entries merged or removed.`,
						});
					}
				} else {
					const stamped = stampModified(content, new Date().toISOString());
					if (stamped !== content) fs.writeFileSync(file, stamped);
				}
			} catch {
				// The file moved or can't be read; nothing to stamp.
			}
		}

		if (added.length === 0) return undefined;
		return { content: [...event.content, ...added], ...(isError ? { isError: true } : {}) };
	});

	pi.registerCommand("claude-memory", {
		description: "List Claude's instruction files and auto memory, open one in your editor, or turn auto memory on or off",
		handler: async (_args, ctx) => {
			if (!instructions || !memory || !setup) refresh(ctx);
			if (!instructions || !memory || !setup) return;
			const listing = describe(instructions, memory);
			if (!ctx.hasUI) {
				process.stdout.write(`${listing}\n`);
				return;
			}
			const userFile = path.join(setup.configDir, "CLAUDE.md");
			const projectFile = path.join(ctx.cwd, "CLAUDE.md");
			const localFile = path.join(ctx.cwd, "CLAUDE.local.md");
			const toggle = memory.enabled ? "Turn auto memory off" : "Turn auto memory on";
			const choices = [
				"Show what loaded",
				`Open user instructions (${userFile})`,
				`Open project instructions (${projectFile})`,
				`Open local instructions (${localFile})`,
				`Open the auto memory folder (${memory.dir})`,
				toggle,
			];
			const choice = await ctx.ui.select("Claude memory", choices);
			if (choice === undefined) return;
			if (choice === choices[0]) ctx.ui.notify(listing, "info");
			else if (choice === toggle) toggleAutoMemory(ctx, setup, !memory.enabled);
			else {
				const target = choice.slice(choice.lastIndexOf("(") + 1, -1);
				await openInEditor(ctx, target);
			}
		},
	});
}

function describe(instructions: Instructions, memory: AutoMemory): string {
	const line = (file: InstructionFile) => `  ${file.path} (${file.kind})`;
	const lines = [`Instruction files (${instructions.mode}${instructions.readsAgents ? ", reading AGENTS.md" : ""}):`];
	lines.push(...(instructions.files.length > 0 ? instructions.files.map(line) : ["  none"]));
	if (instructions.loadedLater.length > 0) lines.push("Loaded as files were touched:", ...instructions.loadedLater.map(line));
	const waiting = instructions.waitingRules();
	if (waiting.length > 0) lines.push("Rules waiting for a matching file:", ...waiting.map((file) => `  ${file}`));
	if (instructions.skipped.length > 0) lines.push("Skipped:", ...instructions.skipped.map((file) => `  ${file.path}: ${file.reason}`));
	lines.push(
		memory.enabled
			? `Auto memory: on, ${memory.dir}${memory.index === undefined ? ` (no ${INDEX_FILE} yet)` : ""}`
			: `Auto memory: off (${memory.disabledBy})`,
	);
	return lines.join("\n");
}

/** Writes `autoMemoryEnabled` to Claude's user settings, as Claude's `/memory` toggle does. */
function toggleAutoMemory(ctx: ExtensionContext, setup: ClaudeSetup, on: boolean) {
	const file = path.join(setup.configDir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed)) throw new Error("not a JSON object");
		settings = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			ctx.ui.notify(`Claude memory: couldn't read ${file}, so auto memory wasn't changed.`, "error");
			return;
		}
	}
	settings.autoMemoryEnabled = on;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	fs.renameSync(temporary, file);
	ctx.ui.notify(`Auto memory is ${on ? "on" : "off"} from the next session, in Claude Code too.`, "info");
}

/** Opens a file or folder in `$VISUAL` or `$EDITOR`, handing it the terminal until it exits. A
 * missing instruction file is created first, as in Claude Code. */
async function openInEditor(ctx: ExtensionContext, target: string) {
	const editor = process.env.VISUAL || process.env.EDITOR;
	if (!editor) {
		ctx.ui.notify(`Set $VISUAL or $EDITOR to open files from pi. The file is ${target}.`, "warning");
		return;
	}
	if (target.endsWith(".md") && !fs.existsSync(target)) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "");
	} else if (!target.endsWith(".md")) fs.mkdirSync(target, { recursive: true });
	const code = await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
		tui.stop();
		const finish = (exit: number | null) => {
			tui.start();
			tui.requestRender(true);
			done(exit);
		};
		const child = spawn(`${editor} "${target.replace(/"/g, '\\"')}"`, { stdio: "inherit", shell: true });
		child.once("error", () => finish(null));
		child.once("close", (exit) => finish(exit));
		return { render: () => [], invalidate: () => {} };
	});
	if (code !== 0) ctx.ui.notify(`The editor (${editor}) ${code === null ? "didn't start" : `exited with code ${code}`}.`, "error");
}
