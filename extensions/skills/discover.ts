/**
 * The skills Claude Code loads in a project, as files for pi's own skill loader, and how Claude
 * shows each one to the model.
 *
 * Sources, in Claude Code's precedence order (https://code.claude.com/docs/en/skills.md):
 *
 * 1. Managed: `.claude/skills/<skill>/SKILL.md` in the managed settings folder.
 * 2. Personal: `~/.claude/skills/<skill>/SKILL.md`.
 * 3. Project: `.claude/skills/<skill>/SKILL.md` in the working directory and each parent up to the
 *    repository root, nearest first. Only when pi trusts the project.
 * 4. Nested: `<subdir>/.claude/skills/<skill>/SKILL.md` below the working directory. Claude lists
 *    these to the model once it reads or edits a file in `<subdir>`.
 * 5. Plugins Claude loads for the project: a `SKILL.md` at the plugin root, `skills/<skill>/SKILL.md`,
 *    and the folders the manifest's `skills` key names.
 * 6. Command files, which Claude runs as skills: `~/.claude/commands/`, the project's
 *    `.claude/commands/` (trusted only), and plugins' `commands/` or manifest `commands`. A file in a
 *    subfolder is named with colons: `frontend/component.md` is `/frontend:component`. A skill with
 *    the same name wins. pi reads skills only from `SKILL.md` files with a valid name, so each command
 *    is handed over as a generated `SKILL.md` in `commandDir`, with the same body.
 * 7. Skills synced from claude.ai: `~/.claude/skills/synced/<account>/<skill>/SKILL.md`, except the
 *    ones built around tools only Claude Code has.
 *
 * pi names a skill by its frontmatter `name`, else its folder. Claude's qualified names
 * (`plugin:skill`, `anthropic-skills:skill`) are returned for the caller to register as commands.
 * When two skills share a name, the earlier source wins. The same file reached twice loads once.
 *
 * What the model sees follows `skillOverrides`, `Skill(...)` deny rules, `when_to_use` and `paths`.
 *
 * This module reads files and runs `git ls-files`; it never talks to pi.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaudeOptions, type ClaudePlugin, type ClaudeSetup, enabledPlugins, insidePlugin, isRecord, readClaudeSetup } from "../shared/claude.ts";
import { stringify as stringifyYaml } from "yaml";
import { listField, matchesPaths, splitFrontmatter } from "../shared/markdown.ts";

/** claude.ai skills written for tools only Claude Code has, such as its browser and connectors. */
export const CLAUDE_ONLY_SYNCED_SKILLS = new Set([
	"built-in-browser",
	"chrome-browser",
	"computer-use",
	"docs",
	"google-workspace",
	"import-memory",
	"morning",
]);

/** Claude truncates the description and `when_to_use` together at this length in the listing. */
const LISTING_LIMIT = 1536;

export type SkillSource = "managed" | "personal" | "project" | "nested" | "claude.ai" | `plugin ${string}`;

/** How the model sees a skill: Claude's `skillOverrides` states, plus deny rules. */
export type ModelVisibility = "full" | "name-only" | "hidden";

export interface ClaudeSkill {
	/** The name pi gives the skill: `/skill:<name>`. */
	name: string;
	/** Claude's qualified command names, such as `cloudflare:wrangler` or `anthropic-skills:pdf`. */
	qualifiedNames: string[];
	/** The `SKILL.md` path handed to pi. */
	file: string;
	/** The same file with symlinks resolved, to match what pi or a read reports. */
	realFile: string;
	/** `${CLAUDE_SKILL_DIR}`. */
	dir: string;
	source: SkillSource;
	frontmatter: Record<string, unknown>;
	/** `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`, for plugin skills. */
	plugin?: { root: string; dataDir: string };
	/** Claude Code never runs shell commands in skills synced from claude.ai. */
	shellAllowed: boolean;
	/** Whether you may invoke it by typing its name (`user-invocable`). */
	userInvocable: boolean;
	modelVisibility: ModelVisibility;
	/** Why the model doesn't see it, when it doesn't. */
	hiddenBecause?: string;
	/** The description listed to the model: `description`, then `when_to_use`. */
	listingDescription: string;
	/** Listed to the model only once a file under `dir`, or matching one of `paths`, is read or edited. */
	activation?: { dir?: string; paths?: string[] };
	/** Frontmatter fields Claude acts on that pi-homeport doesn't, as `field: why`. */
	unsupported: string[];
	/** For a command file: where it is, since `file` is the `SKILL.md` generated for pi. */
	commandFile?: string;
	/** Whether `/<name>` may be registered. Off for commands in subfolders, which Claude names
	 * only with colons. */
	bareName: boolean;
}

export interface SkippedSkill {
	name: string;
	source: SkillSource;
	file: string;
	reason: string;
}

export interface ClaudeSkillsOptions extends ClaudeOptions {
	/** Where to write the `SKILL.md` files generated for command files. Without it, commands
	 * aren't loaded. */
	commandDir?: string;
}

export interface ClaudeSkillsResult {
	skills: ClaudeSkill[];
	skipped: SkippedSkill[];
	setup: ClaudeSetup;
}

/** Claude's boolean frontmatter: also yes/no, on/off and 1/0, in any letter case. */
function booleanField(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	if (["true", "yes", "on", "1"].includes(text)) return true;
	if (["false", "no", "off", "0"].includes(text)) return false;
	return undefined;
}

/** pi's rule for skill names: lowercase letters, digits and single hyphens, up to 64 characters. */
function validPiName(name: string): boolean {
	return name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isFile(target: string): boolean {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

/** The `SKILL.md` files one level inside a skills folder, in name order. */
function skillFilesIn(dir: string, skip: (name: string, dir: string) => boolean = () => false): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir).sort();
	} catch {
		return [];
	}
	return names
		.filter((name) => !name.startsWith(".") && isDirectory(path.join(dir, name)) && !skip(name, path.join(dir, name)))
		.map((name) => path.join(dir, name, "SKILL.md"))
		.filter(isFile);
}

/** A managed, personal or project skill folder Claude Code skips: `synced`, `anthropic-skills…`,
 * and folders that are plugins of their own. */
function skippedByClaude(name: string, dir: string): boolean {
	return (
		name.toLowerCase() === "synced" ||
		name.startsWith("anthropic-skills") ||
		fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))
	);
}

/** `<subdir>/.claude/skills/<skill>/SKILL.md` files below the working directory that git tracks or
 * would track, nearest first. */
function nestedSkillFiles(cwd: string): string[] {
	const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*/.claude/skills/*/SKILL.md"], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return [];
	return [
		...new Set(
			result.stdout
				.split("\0")
				.filter((rel) => /^(?!\.claude\/)(.+)\/\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel))
				.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
		),
	].map((rel) => path.join(cwd, rel));
}

interface Candidate {
	file: string;
	source: SkillSource;
	plugin?: { root: string; dataDir: string; name: string };
	/** For a `SKILL.md` at a plugin root, which pi would otherwise name after the version folder. */
	atPluginRoot?: boolean;
	/** For a nested skill: the folder whose files activate it. */
	nestedDir?: string;
	/** For a command: Claude's name for it without the plugin prefix, inline content from a plugin
	 * manifest, and fields the manifest sets. */
	command?: { name: string; content?: string; fields?: Record<string, unknown> };
}

/** The `.md` files under a commands folder, with Claude's names: the path inside the folder, `/`
 * replaced by `:`, without `.md`. */
function commandFilesIn(dir: string): { file: string; name: string }[] {
	const found: { file: string; name: string }[] = [];
	const walk = (folder: string, prefix: string) => {
		let names: string[];
		try {
			names = fs.readdirSync(folder).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const entry = path.join(folder, name);
			if (isDirectory(entry)) walk(entry, `${prefix}${name}:`);
			else if (name.endsWith(".md") && isFile(entry)) found.push({ file: entry, name: `${prefix}${name.slice(0, -3)}` });
		}
	};
	walk(dir, "");
	return found;
}

/** A plugin's commands: the manifest's `commands` (a path, a list of paths, or a map of names to a
 * `source` file or inline `content`), else its `commands/` folder. */
function pluginCommands(root: string, declared: unknown): { file: string; name: string; content?: string; fields?: Record<string, unknown> }[] {
	const fromPath = (entry: string) => {
		const target = insidePlugin(root, entry);
		if (!target) return [];
		if (isFile(target)) return target.endsWith(".md") ? [{ file: target, name: path.basename(target, ".md") }] : [];
		return commandFilesIn(target);
	};
	if (declared === undefined) return commandFilesIn(path.join(root, "commands"));
	if (typeof declared === "string") return fromPath(declared);
	if (Array.isArray(declared)) return declared.flatMap((entry) => (typeof entry === "string" ? fromPath(entry) : []));
	if (!isRecord(declared)) return [];
	return Object.entries(declared).flatMap(([name, entry]) => {
		if (!isRecord(entry)) return [];
		const fields: Record<string, unknown> = {};
		if (typeof entry.description === "string") fields.description = entry.description;
		if (typeof entry.argumentHint === "string") fields["argument-hint"] = entry.argumentHint;
		if (typeof entry.model === "string") fields.model = entry.model;
		if (Array.isArray(entry.allowedTools)) fields["allowed-tools"] = entry.allowedTools;
		if (typeof entry.content === "string") return [{ file: path.join(root, ".claude-plugin", "plugin.json"), name, content: entry.content, fields }];
		const file = typeof entry.source === "string" ? insidePlugin(root, entry.source) : undefined;
		return file && isFile(file) ? [{ file, name, fields }] : [];
	});
}

function pluginCandidates(plugins: ClaudePlugin[]): Candidate[] {
	const candidates: Candidate[] = [];
	for (const plugin of plugins) {
		const source: SkillSource = `plugin ${plugin.id}`;
		const info = { root: plugin.root, dataDir: plugin.dataDir, name: plugin.name };
		const rootSkill = path.join(plugin.root, "SKILL.md");
		if (isFile(rootSkill)) candidates.push({ file: rootSkill, source, plugin: info, atPluginRoot: true });
		const files = skillFilesIn(path.join(plugin.root, "skills"));
		const declared = plugin.manifest.skills;
		for (const entry of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
			if (typeof entry !== "string") continue;
			const dir = insidePlugin(plugin.root, entry);
			if (!dir) continue;
			if (isFile(path.join(dir, "SKILL.md"))) files.push(path.join(dir, "SKILL.md"));
			else files.push(...skillFilesIn(dir));
		}
		for (const file of files) candidates.push({ file, source, plugin: info });
	}
	return candidates;
}

function pluginCommandCandidates(plugins: ClaudePlugin[]): Candidate[] {
	return plugins.flatMap((plugin) =>
		pluginCommands(plugin.root, plugin.manifest.commands).map(
			(entry): Candidate => ({
				file: entry.file,
				source: `plugin ${plugin.id}`,
				plugin: { root: plugin.root, dataDir: plugin.dataDir, name: plugin.name },
				command: { name: entry.name, ...(entry.content !== undefined ? { content: entry.content } : {}), ...(entry.fields ? { fields: entry.fields } : {}) },
			}),
		),
	);
}

/** The first non-empty line of a body: Claude's description when the frontmatter has none. */
function firstLine(body: string): string {
	return (
		body
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** Writes the `SKILL.md` pi loads for a command, unless it's already there, and returns its path. */
function writeCommandSkill(dir: string, name: string, frontmatter: Record<string, unknown>, body: string): string {
	const file = path.join(dir, name, "SKILL.md");
	const content = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
	let current: string | undefined;
	try {
		current = fs.readFileSync(file, "utf8");
	} catch {
		// Not written yet.
	}
	if (current !== content) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return file;
}

/** Removes generated command skills that no longer match a command. */
function pruneCommandSkills(dir: string, keep: Set<string>) {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

function syncedCandidates(personalDir: string): Candidate[] {
	const synced = path.join(personalDir, "synced");
	let accounts: string[] = [];
	try {
		accounts = fs.readdirSync(synced).filter((name) => !name.startsWith(".") && isDirectory(path.join(synced, name)));
	} catch {
		return [];
	}
	return accounts.flatMap((account) => skillFilesIn(path.join(synced, account)).map((file): Candidate => ({ file, source: "claude.ai" })));
}

/** Whether a `Skill` deny rule blocks one of a skill's names. `Skill` blocks every skill; `Skill(x)`
 * blocks the name `x`; `Skill(x *)` blocks `x` and the names in its namespace `x:…`;
 * `Skill(skill:x)` blocks the skill whatever it is called. */
export function deniedBy(rules: string[], names: string[]): string | undefined {
	for (const rule of rules) {
		if (rule === "Skill" || rule === "Skill(*)") return rule;
		const match = /^Skill\((.+)\)$/.exec(rule);
		if (!match) continue;
		const spec = (match[1] ?? "").trim();
		const prefix = spec.endsWith(" *") ? spec.slice(0, -2) : spec.endsWith(":*") ? spec.slice(0, -2) : undefined;
		const target = spec.startsWith("skill:") ? spec.slice(6) : (prefix ?? spec);
		if (names.some((name) => name === target || (prefix !== undefined && name.startsWith(`${prefix}:`)))) return rule;
	}
	return undefined;
}

export function claudeSkills(options: ClaudeSkillsOptions): ClaudeSkillsResult {
	const setup = readClaudeSetup(options);
	const personalDir = path.join(setup.configDir, "skills");
	const cwd = setup.dirs[0] ?? path.resolve(options.cwd);
	const candidates: Candidate[] = [
		...skillFilesIn(path.join(setup.managedDir, ".claude", "skills"), skippedByClaude).map((file): Candidate => ({ file, source: "managed" })),
		...skillFilesIn(personalDir, skippedByClaude).map((file): Candidate => ({ file, source: "personal" })),
		...(options.trusted
			? [
					...setup.dirs.flatMap((dir) => skillFilesIn(path.join(dir, ".claude", "skills"), skippedByClaude).map((file): Candidate => ({ file, source: "project" }))),
					...nestedSkillFiles(cwd).map(
						(file): Candidate => ({ file, source: "nested", nestedDir: path.dirname(path.dirname(path.dirname(path.dirname(file)))) }),
					),
				]
			: []),
		...pluginCandidates(enabledPlugins(setup)),
		...(options.commandDir
			? [
					...commandFilesIn(path.join(setup.configDir, "commands")).map((entry): Candidate => ({ file: entry.file, source: "personal", command: { name: entry.name } })),
					...(options.trusted
						? setup.dirs.flatMap((dir) =>
								commandFilesIn(path.join(dir, ".claude", "commands")).map((entry): Candidate => ({ file: entry.file, source: "project", command: { name: entry.name } })),
							)
						: []),
					...pluginCommandCandidates(enabledPlugins(setup)),
				]
			: []),
		...syncedCandidates(personalDir),
	];
	// Generated skills for this project's commands live in their own folder, so sessions in other
	// projects don't overwrite them.
	const commandDir = options.commandDir
		? path.join(options.commandDir, createHash("sha256").update(path.resolve(options.cwd)).digest("hex").slice(0, 16))
		: undefined;
	const written = new Set<string>();

	// skillOverrides, highest-precedence file last; and Skill deny rules from every settings file.
	const overrides = new Map<string, string>();
	for (const file of setup.settings) {
		if (!isRecord(file.skillOverrides)) continue;
		for (const [name, state] of Object.entries(file.skillOverrides)) if (typeof state === "string") overrides.set(name, state);
	}
	const denyRules = setup.settings.flatMap((file) =>
		isRecord(file.permissions) && Array.isArray(file.permissions.deny) ? file.permissions.deny.filter((rule): rule is string => typeof rule === "string") : [],
	);

	const skills: ClaudeSkill[] = [];
	const skipped: SkippedSkill[] = [];
	const byName = new Map<string, ClaudeSkill>();
	const seenFiles = new Set<string>();

	for (const candidate of candidates) {
		let realFile: string;
		let content: string;
		try {
			realFile = fs.realpathSync(candidate.file);
			content = candidate.command?.content ?? fs.readFileSync(candidate.file, "utf8");
		} catch {
			continue;
		}
		const command = candidate.command;
		const seenKey = command?.content !== undefined ? `${realFile}#${command.name}` : realFile;
		if (seenFiles.has(seenKey)) continue;
		seenFiles.add(seenKey);

		const dir = path.dirname(candidate.file);
		const split = splitFrontmatter(content);
		const frontmatter = command ? { ...split.frontmatter, ...command.fields } : split.frontmatter;
		if (command) {
			// Claude ignores these in command files; the name comes from the file.
			delete frontmatter.name;
			delete frontmatter.paths;
			if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
				const line = firstLine(split.body);
				if (line) frontmatter.description = line;
			}
		}
		const name = command
			? command.name.replaceAll(":", "-")
			: typeof frontmatter.name === "string" && frontmatter.name
				? frontmatter.name
				: path.basename(dir);
		const skip = (reason: string) => skipped.push({ name: command && !candidate.plugin ? command.name : name, source: candidate.source, file: candidate.file, reason });

		if (candidate.source === "claude.ai" && CLAUDE_ONLY_SYNCED_SKILLS.has(path.basename(dir))) {
			skip("it is written for tools only Claude Code has");
			continue;
		}
		if (candidate.atPluginRoot && typeof frontmatter.name !== "string") {
			skip("it has no name, and pi would name it after the plugin's version folder");
			continue;
		}
		if (!validPiName(name)) {
			skip("pi accepts only lowercase letters, digits and single hyphens in a skill name");
			continue;
		}
		if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
			skip(command ? "it's empty" : "it has no description field, which pi requires");
			continue;
		}
		if (command && !commandDir) continue;
		const override = candidate.plugin ? undefined : overrides.get(command?.name ?? name);
		if (override === "off") {
			skip("skillOverrides turns it off");
			continue;
		}
		const existing = byName.get(name);
		if (existing) {
			skip(`a skill with the same name loads from ${existing.source} (${existing.file})`);
			continue;
		}

		const claudeName = command?.name ?? name;
		const qualifiedNames = candidate.plugin
			? [`${candidate.plugin.name}:${claudeName}`]
			: candidate.source === "claude.ai"
				? [`anthropic-skills:${name}`]
				: command && claudeName !== name
					? [claudeName]
					: [];
		const denied = deniedBy(denyRules, [name, ...qualifiedNames]);
		const disabledForModel = booleanField(frontmatter["disable-model-invocation"]) === true;
		let modelVisibility: ModelVisibility = "full";
		let hiddenBecause: string | undefined;
		if (denied) {
			modelVisibility = "hidden";
			hiddenBecause = `the permission rule ${denied} denies it`;
		} else if (override === "user-invocable-only") {
			modelVisibility = "hidden";
			hiddenBecause = "skillOverrides makes it user-invocable only";
		} else if (override === "name-only") {
			modelVisibility = "name-only";
		} else if (disabledForModel) {
			hiddenBecause = "disable-model-invocation";
		}

		const whenToUse = typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use.trim() : "";
		const listingDescription = [frontmatter.description.trim(), whenToUse].filter(Boolean).join("\n").slice(0, LISTING_LIMIT);
		const paths = listField(frontmatter.paths);
		const activation = candidate.nestedDir || paths.length > 0 ? { ...(candidate.nestedDir ? { dir: candidate.nestedDir } : {}), ...(paths.length > 0 ? { paths } : {}) } : undefined;

		const unsupported: string[] = [];
		if (frontmatter.context !== undefined || frontmatter.agent !== undefined) unsupported.push("context/agent: runs the skill in a subagent, which needs pi-homeport's agents support");
		if (frontmatter.hooks !== undefined) unsupported.push("hooks: registers hooks, which needs pi-homeport's hooks support");
		if (frontmatter["argument-hint"] !== undefined) unsupported.push("argument-hint: pi's commands can't show argument hints");
		if (frontmatter.shell === "powershell" && process.platform === "win32") unsupported.push("shell: powershell: commands run with bash");

		let file = candidate.file;
		if (command && commandDir) {
			file = writeCommandSkill(commandDir, name, { ...frontmatter, name }, split.body);
			written.add(name);
			realFile = fs.realpathSync(file);
		}

		const skill: ClaudeSkill = {
			name,
			qualifiedNames,
			file,
			realFile,
			dir: command?.content !== undefined ? (candidate.plugin?.root ?? dir) : dir,
			source: candidate.source,
			frontmatter,
			...(candidate.plugin ? { plugin: { root: candidate.plugin.root, dataDir: candidate.plugin.dataDir } } : {}),
			shellAllowed: candidate.source !== "claude.ai",
			userInvocable: booleanField(frontmatter["user-invocable"]) !== false,
			modelVisibility,
			...(hiddenBecause ? { hiddenBecause } : {}),
			listingDescription,
			...(activation ? { activation } : {}),
			unsupported,
			...(command ? { commandFile: candidate.file } : {}),
			bareName: !command || candidate.plugin !== undefined || claudeName === name,
		};
		byName.set(name, skill);
		skills.push(skill);
	}

	if (commandDir) pruneCommandSkills(commandDir, written);
	return { skills, skipped, setup };
}

/** About how many tokens a skill takes in the listing pi gives the model: its name, description
 * and location, at roughly four characters a token. */
export function listingTokens(name: string, description: string, location: string): number {
	return Math.ceil((name.length + description.length + location.length + 60) / 4);
}

/** A skill or command a plugin would list. */
export interface PluginListingEntry {
	/** The skill's own name, and Claude's `plugin:skill` name. */
	name: string;
	qualifiedName: string;
	tokens: number;
}

/** The skills and commands a plugin would list, with about how many tokens each would take. */
export function pluginListing(plugin: ClaudePlugin): PluginListingEntry[] {
	const entries: PluginListingEntry[] = [];
	const seen = new Set<string>();
	for (const candidate of [...pluginCandidates([plugin]), ...pluginCommandCandidates([plugin])]) {
		let content: string;
		try {
			content = candidate.command?.content ?? fs.readFileSync(candidate.file, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = splitFrontmatter(content);
		const fields = { ...frontmatter, ...candidate.command?.fields };
		const description = typeof fields.description === "string" && fields.description.trim() ? fields.description : firstLine(body);
		if (!description) continue;
		const whenToUse = typeof fields.when_to_use === "string" ? fields.when_to_use : "";
		const name = candidate.command?.name ?? (typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(path.dirname(candidate.file)));
		if (seen.has(name)) continue;
		seen.add(name);
		entries.push({ name, qualifiedName: `${plugin.name}:${name}`, tokens: listingTokens(name, `${description}\n${whenToUse}`.trim().slice(0, LISTING_LIMIT), candidate.file) });
	}
	return entries;
}

/** The skills and commands a plugin would list, and about how many tokens they'd take. */
export function pluginListingCost(plugin: ClaudePlugin): { skills: number; tokens: number } {
	const entries = pluginListing(plugin);
	return { skills: entries.length, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0) };
}

/** Whether reading or editing `file` activates a skill: a file under a nested skill's folder, or a
 * file matching one of its `paths` patterns, relative to the working directory. */
export function activates(skill: ClaudeSkill, file: string, cwd: string): boolean {
	const activation = skill.activation;
	if (!activation) return false;
	const resolved = path.resolve(cwd, file);
	if (activation.dir && (resolved === activation.dir || resolved.startsWith(`${activation.dir}${path.sep}`))) return true;
	return activation.paths !== undefined && matchesPaths(resolved, cwd, activation.paths);
}
