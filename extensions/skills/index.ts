/**
 * Claude skills: hands the skills Claude Code loads in this project to pi's own skill loader, and
 * makes them behave as they do in Claude Code:
 *
 * - Content: arguments, `${CLAUDE_*}` variables and injected shell commands, checked against
 *   Claude's permission rules, both when you type a skill and when the model reads one.
 * - Names: Claude's `/plugin:skill` and `/anthropic-skills:skill` commands, and the bare `/skill`
 *   when no other command has that name, next to pi's own `/skill:name`.
 * - Listing: `skillOverrides`, `Skill(...)` deny rules, `when_to_use`, and skills that appear once
 *   matching files are touched (`paths`, nested `.claude/skills`).
 * - A typed skill's `model`, `effort` and `disallowed-tools` apply until the turn ends;
 *   `user-invocable: false` refuses it.
 *
 * `/claude-skills` lists what loaded, what didn't, and why.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { booleanSetting, isRecord, listSetting } from "../shared/claude.ts";
import { listField, splitFrontmatter } from "../shared/markdown.ts";
import { activates, type ClaudeSkill, type ClaudeSkillsResult, claudeSkills } from "./discover.ts";
import { type ExpandResult, expandSkill, readsWholeFile } from "./expand.ts";
import { showSkillsScreen } from "./toggles.ts";
import { bashRules, checkCommand, splitCommand, splitRules, stripWrappers } from "./permissions.ts";

/** pi's thinking levels as Claude's `${CLAUDE_EFFORT}` values. */
const EFFORT: Record<string, string> = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** Claude's effort levels, which pi's thinking levels share. */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Search and comparison commands whose exit code 1 means "nothing found" or "differs", which
 * Claude treats as a normal result. */
const EXIT_ONE_OK = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp"]);

const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** pi's built-in commands, which a bare skill name must not shadow. */
const PI_BUILT_INS = new Set(
	"settings model thinking scoped-models login logout llama new resume name session tree fork clone compact import copy export share bug trust mcp reload hotkeys changelog quit".split(
		" ",
	),
);

/** Claude Code's tool names as pi's, for `disallowed-tools`. */
const TOOL_NAMES: Record<string, string[]> = {
	Bash: ["bash"],
	Read: ["read"],
	Edit: ["edit"],
	MultiEdit: ["edit"],
	Write: ["write"],
	Grep: ["grep"],
	Glob: ["find"],
	LS: ["ls"],
	WebFetch: ["web_fetch", "webfetch"],
	WebSearch: ["web_search", "websearch"],
};

function realPath(file: string): string | undefined {
	try {
		return fs.realpathSync(file);
	} catch {
		return undefined;
	}
}

/** Runs a command with bash in the session's directory, stderr merged into stdout, as Claude does. */
function runBash(command: string, cwd: string, signal: AbortSignal | undefined): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, COMMAND_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, output: output + error.message, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output, timedOut });
		});
	});
}

/** A Claude model value as one of pi's models: `provider/id`, an exact Anthropic model id, or an
 * alias such as `opus`, which picks the newest matching Anthropic model. */
function resolveModel(value: string, ctx: ExtensionContext) {
	const clean = value.trim().replace(/\[1m\]$/i, "");
	if (clean === "" || clean === "inherit" || clean === "default") return undefined;
	const slash = clean.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(clean.slice(0, slash), clean.slice(slash + 1));
	const exact = ctx.modelRegistry.find("anthropic", clean);
	if (exact) return exact;
	const alias = clean === "opusplan" ? "opus" : clean;
	return ctx.modelRegistry
		.getAll()
		.filter((model) => model.provider === "anthropic" && model.id.startsWith(`claude-${alias}`))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

export default function claudeSkillsExtension(pi: ExtensionAPI) {
	let last: ClaudeSkillsResult | undefined;
	let byRealFile = new Map<string, ClaudeSkill>();
	let byName = new Map<string, ClaudeSkill>();
	/** Skills a touched file has activated this session, by real file. */
	const activated = new Set<string>();
	/** Commands this extension registered: the command name and the skill name it runs. */
	const commands = new Map<string, string>();
	/** What a typed skill changed for its turn, to undo when the turn ends. */
	let restore: (() => Promise<void>) | undefined;
	/** Commands waiting for the turn they started to begin. */
	const startWaiters: (() => void)[] = [];

	function report(ctx: ExtensionContext, message: string, level: "error" | "warning" | "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") process.stderr.write(`${message}\n`);
	}

	function skillAt(file: string | undefined): ClaudeSkill | undefined {
		const real = file ? realPath(file) : undefined;
		return real ? byRealFile.get(real) : undefined;
	}

	/** Whether the model may see and use a skill now. */
	function visibleToModel(skill: ClaudeSkill): boolean {
		return skill.modelVisibility !== "hidden" && (!skill.activation || activated.has(skill.realFile));
	}

	async function expand(skill: ClaudeSkill, args: string | undefined, ctx: ExtensionContext): Promise<{ result: ExpandResult; head: string }> {
		const content = fs.readFileSync(skill.file, "utf8").replace(/\r\n?/g, "\n");
		const { frontmatter, body } = splitFrontmatter(content);
		const head = content.slice(0, content.length - body.length);
		const setup = last?.setup;
		const variables: Record<string, string | undefined> = {
			CLAUDE_SKILL_DIR: skill.dir,
			CLAUDE_PROJECT_DIR: setup?.root ?? ctx.cwd,
			CLAUDE_SESSION_ID: ctx.sessionManager.getSessionId(),
			CLAUDE_EFFORT: EFFORT[pi.getThinkingLevel()],
			CLAUDE_PLUGIN_ROOT: skill.plugin?.root,
			CLAUDE_PLUGIN_DATA: skill.plugin?.dataDir,
		};
		const fill = (rule: string) => rule.replace(/\$\{(CLAUDE_[A-Z_]+)\}/g, (whole, name: string) => variables[name] ?? whole);
		const permissions = (file: Record<string, unknown>) => (isRecord(file.permissions) ? file.permissions : {});
		const rules = bashRules(
			[...(setup ? listSetting(setup, (file) => permissions(file).allow) : []), ...splitRules(frontmatter["allowed-tools"]).map(fill)],
			setup ? [...listSetting(setup, (file) => permissions(file).deny), ...listSetting(setup, (file) => permissions(file).ask)] : [],
		);
		const shell = !skill.shellAllowed ? "never" : setup && booleanSetting(setup, "disableSkillShellExecution") ? "disabled" : "run";

		const result = await expandSkill({
			body,
			args,
			argumentNames: listField(frontmatter.arguments, true),
			variables,
			shell,
			runCommand: async (command, pattern) => {
				const verdict = checkCommand(command, rules);
				if (!verdict.allowed) return { ok: false, message: `Shell command permission check failed for pattern "${pattern}": ${verdict.reason}` };
				const run = await runBash(command, ctx.cwd, ctx.signal);
				const program = (stripWrappers(splitCommand(command)?.at(-1) ?? command).split(/\s+/)[0] ?? "").replace(/^.*\//, "");
				const ok = run.code === 0 || (run.code === 1 && EXIT_ONE_OK.has(program));
				if (run.timedOut) return { ok: false, message: `Shell command failed for pattern "${pattern}": timed out after 2 minutes\n${run.output}` };
				if (!ok) return { ok: false, message: `Shell command failed for pattern "${pattern}" (exit code ${run.code}):\n${run.output}` };
				return { ok: true, output: run.output.replace(/\n$/, "") };
			},
		});
		return { result, head };
	}

	/** Applies a typed skill's `model`, `effort` and `disallowed-tools` until the turn ends. */
	async function applyTurnSettings(skill: ClaudeSkill, ctx: ExtensionContext) {
		const undo: (() => Promise<void>)[] = [];
		const { frontmatter } = skill;
		if (typeof frontmatter.model === "string") {
			const model = resolveModel(frontmatter.model, ctx);
			const previous = ctx.model;
			if (model && previous && (model.provider !== previous.provider || model.id !== previous.id)) {
				if (await pi.setModel(model)) undo.push(async () => void (await pi.setModel(previous)));
				else report(ctx, `Skill ${skill.name}: no credentials for ${model.provider}/${model.id}; keeping the current model.`, "warning");
			} else if (!model && !["inherit", "default"].includes(frontmatter.model.trim())) {
				report(ctx, `Skill ${skill.name}: pi has no model matching "${frontmatter.model}"; keeping the current model.`, "warning");
			}
		}
		if (typeof frontmatter.effort === "string" && EFFORT_LEVELS.has(frontmatter.effort)) {
			const previous = pi.getThinkingLevel();
			pi.setThinkingLevel(frontmatter.effort as Parameters<typeof pi.setThinkingLevel>[0]);
			undo.push(async () => pi.setThinkingLevel(previous));
		}
		const disallowed = listField(frontmatter["disallowed-tools"], true).filter((name) => !name.includes("("));
		if (disallowed.length > 0) {
			const previous = pi.getActiveTools();
			const removed = new Set(disallowed.flatMap((name) => [name, name.toLowerCase(), ...(TOOL_NAMES[name] ?? [])]));
			pi.setActiveTools(previous.filter((tool) => !removed.has(tool)));
			undo.push(async () => pi.setActiveTools(previous));
		}
		if (undo.length > 0) {
			const earlier = restore;
			restore = async () => {
				for (const step of undo.reverse()) await step();
				await earlier?.();
			};
		}
	}

	/** Expands a typed skill into pi's skill-block format, or reports why it can't run. What you
	 * typed follows the block, as in pi's own `/skill:name args`, so the transcript shows it. */
	async function typedSkill(skill: ClaudeSkill, args: string, typed: string, ctx: ExtensionContext): Promise<string | undefined> {
		if (!skill.userInvocable) {
			report(ctx, `Skill ${skill.name} can only be used by the model (user-invocable: false).`, "error");
			return undefined;
		}
		const { result } = await expand(skill, args, ctx);
		if (!result.ok) {
			report(ctx, result.message, "error");
			return undefined;
		}
		await applyTurnSettings(skill, ctx);
		return `<skill name="${skill.name}" location="${skill.file}">\nReferences are relative to ${skill.dir}.\n\n${result.text.trim()}\n</skill>\n\n${typed}`;
	}

	/** Registers Claude's names for the skills: qualified names always, the bare name when free. */
	function registerCommands() {
		const taken = new Set([...pi.getCommands().map((command) => command.name), ...PI_BUILT_INS]);
		for (const skill of last?.skills ?? []) {
			const bare = skill.bareName && !(taken.has(skill.name) && commands.get(skill.name) !== skill.name);
			const names = [...skill.qualifiedNames, ...(bare ? [skill.name] : [])];
			for (const name of names) {
				if (commands.has(name)) {
					commands.set(name, skill.name);
					continue;
				}
				if (taken.has(name)) continue;
				commands.set(name, skill.name);
				taken.add(name);
				pi.registerCommand(name, {
					description: `${skill.listingDescription.split("\n")[0]?.slice(0, 120) ?? ""} (Claude ${skill.commandFile ? "command" : "skill"})`,
					handler: async (args, ctx) => {
						const current = byName.get(commands.get(name) ?? "");
						if (!current) {
							ctx.ui.notify(`Claude skill /${name} isn't loaded in this project.`, "warning");
							return;
						}
						const block = await typedSkill(current, args.trim(), `/${name}${args.trim() ? ` ${args.trim()}` : ""}`, ctx);
						if (!block) return;
						// pi starts the turn without waiting for it; stay until it has started and ended, so a
						// non-interactive run doesn't exit mid-turn.
						const started = new Promise<void>((resolve) => {
							startWaiters.push(resolve);
							setTimeout(resolve, 10_000);
						});
						if (ctx.isIdle()) pi.sendUserMessage(block);
						else pi.sendUserMessage(block, { deliverAs: "followUp" });
						await started;
						await ctx.waitForIdle();
					},
				});
			}
		}
	}

	pi.on("session_start", async () => {
		activated.clear();
	});

	pi.on("resources_discover", async (event, ctx) => {
		last = claudeSkills({ cwd: event.cwd, trusted: ctx.isProjectTrusted(), commandDir: path.join(getAgentDir(), "pi-homeport", "commands") });
		byRealFile = new Map(last.skills.map((skill) => [skill.realFile, skill]));
		byName = new Map(last.skills.map((skill) => [skill.name, skill]));
		if (last.setup.reader.unreadable.length > 0) {
			report(ctx, last.setup.reader.unreadable.map((file) => `Claude skills: couldn't read ${file} as JSON.`).join("\n"), "warning");
		}
		registerCommands();
		return { skillPaths: last.skills.map((skill) => skill.file) };
	});

	// What the model sees: hide skills it may not use yet, list names only where asked, and add
	// `when_to_use` to descriptions. Copies, so pi's own skill list stays whole for `/skill:name`.
	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (!options.skills) return undefined;
		options.skills = options.skills.flatMap((entry) => {
			const skill = skillAt(entry.filePath);
			if (!skill) return [entry];
			if (!visibleToModel(skill)) return [];
			return [{ ...entry, description: skill.modelVisibility === "name-only" ? "" : skill.listingDescription }];
		});
		return undefined;
	});

	pi.on("agent_start", async () => {
		for (const resolve of startWaiters.splice(0)) resolve();
	});

	pi.on("agent_end", async () => {
		const undo = restore;
		restore = undefined;
		await undo?.();
	});

	// `/skill:name args` typed by you: hand pi the expanded skill in its own skill-block format.
	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith("/skill:")) return { action: "continue" };
		const space = event.text.indexOf(" ");
		const name = space === -1 ? event.text.slice(7) : event.text.slice(7, space);
		const args = space === -1 ? "" : event.text.slice(space + 1).trim();
		const command = pi.getCommands().find((entry) => entry.source === "skill" && entry.name === `skill:${name}`);
		const skill = skillAt(command?.sourceInfo.path);
		if (!skill) return { action: "continue" };
		const block = await typedSkill(skill, args, event.text.trim(), ctx);
		return block ? { action: "transform", text: block } : { action: "handled" };
	});

	// Files the model reads or edits activate nested and `paths` skills, and a skill it reads in full
	// gets its content expanded.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !["read", "edit", "write"].includes(event.toolName)) return undefined;
		const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof input.path !== "string") return undefined;
		const requested = input.path.startsWith("~/") ? path.join(os.homedir(), input.path.slice(2)) : path.resolve(ctx.cwd, input.path);

		// pi builds the skill listing once per run, so skills activated mid-run are announced here;
		// the next run lists them like any other.
		const announced: ClaudeSkill[] = [];
		for (const skill of last?.skills ?? []) {
			if (!skill.activation || activated.has(skill.realFile) || !activates(skill, requested, ctx.cwd)) continue;
			activated.add(skill.realFile);
			if (skill.modelVisibility !== "hidden" && skill.frontmatter["disable-model-invocation"] !== true) announced.push(skill);
		}
		const announcement = announced.length
			? [
					{
						type: "text" as const,
						text: `\n\nThese skills now apply to this file. Read a skill's file when the task matches its description:\n${announced
							.map((skill) => `- ${skill.name}: ${skill.modelVisibility === "name-only" ? "" : skill.listingDescription.replace(/\n/g, " ")} (${skill.file})`)
							.join("\n")}`,
					},
				]
			: [];
		const withAnnouncement = (content: typeof event.content) => (announcement.length ? { content: [...content, ...announcement] } : undefined);

		if (event.toolName !== "read") return withAnnouncement(event.content);
		const skill = skillAt(requested);
		if (!skill || !visibleToModel(skill)) return withAnnouncement(event.content);
		const lineCount = fs.readFileSync(skill.file, "utf8").split("\n").length;
		if (!readsWholeFile(input.offset, input.limit, lineCount)) return withAnnouncement(event.content);
		const { result, head } = await expand(skill, undefined, ctx);
		if (!result.ok) return { content: [{ type: "text" as const, text: result.message }], isError: true };
		if (!result.changed) return withAnnouncement(event.content);
		return { content: [{ type: "text" as const, text: head + result.text }, ...announcement] };
	});

	pi.registerCommand("claude-plugins", {
		description: "Turn Claude plugins on or off for this project or everywhere, in Claude Code too",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/claude-plugins needs pi's interactive mode.", "warning");
				return;
			}
			if (!last) {
				ctx.ui.notify("Claude skills: nothing loaded yet.", "info");
				return;
			}
			await showSkillsScreen(ctx, { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }, last, "plugins");
		},
	});

	pi.registerCommand("claude-skills", {
		description: "Turn Claude skills on, off or name-only, and see what each one costs in context",
		handler: async (_args, ctx) => {
			if (!last) {
				ctx.ui.notify("Claude skills: nothing loaded yet.", "info");
				return;
			}
			if (ctx.mode === "tui") {
				await showSkillsScreen(ctx, { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }, last, "skills");
				return;
			}
			const lines = [`Handed to pi (${last.skills.length}):`];
			const bySource = new Map<string, ClaudeSkill[]>();
			for (const skill of last.skills) {
				const group = skill.commandFile ? `${skill.source} commands` : skill.source;
				bySource.set(group, [...(bySource.get(group) ?? []), skill]);
			}
			for (const [source, skills] of bySource) lines.push(`  ${source}: ${skills.map((skill) => skill.qualifiedNames[0] ?? skill.name).join(", ")}`);
			const hidden = last.skills.filter((skill) => skill.modelVisibility === "hidden" || skill.modelVisibility === "name-only");
			if (hidden.length > 0) {
				lines.push("Limited for the model:");
				for (const skill of hidden) lines.push(`  ${skill.name}: ${skill.modelVisibility === "name-only" ? "name only (skillOverrides)" : (skill.hiddenBecause ?? "hidden")}`);
			}
			const waiting = last.skills.filter((skill) => skill.activation && !activated.has(skill.realFile));
			if (waiting.length > 0) lines.push(`Waiting for a matching file: ${waiting.map((skill) => skill.name).join(", ")}`);
			const partial = last.skills.filter((skill) => skill.unsupported.length > 0);
			if (partial.length > 0) {
				lines.push("Loaded, but these Claude fields have no effect in pi:");
				for (const skill of partial) lines.push(`  ${skill.name}: ${skill.unsupported.join("; ")}`);
			}
			if (last.skipped.length > 0) {
				lines.push("Skipped:");
				for (const skill of last.skipped) lines.push(`  ${skill.name} (${skill.source}): ${skill.reason}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
