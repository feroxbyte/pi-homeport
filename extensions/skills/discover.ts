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
 * 6. Skills synced from claude.ai: `~/.claude/skills/synced/<account>/<skill>/SKILL.md`, except the
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
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaudeOptions, type ClaudeSetup, enabledPlugins, insidePlugin, isRecord, readClaudeSetup } from "../shared/claude.ts";
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
}

export interface SkippedSkill {
	name: string;
	source: SkillSource;
	file: string;
	reason: string;
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
}

function pluginCandidates(setup: ClaudeSetup): Candidate[] {
	const candidates: Candidate[] = [];
	for (const plugin of enabledPlugins(setup)) {
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
function deniedBy(rules: string[], names: string[]): string | undefined {
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

export function claudeSkills(options: ClaudeOptions): ClaudeSkillsResult {
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
		...pluginCandidates(setup),
		...syncedCandidates(personalDir),
	];

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
			content = fs.readFileSync(candidate.file, "utf8");
		} catch {
			continue;
		}
		if (seenFiles.has(realFile)) continue;
		seenFiles.add(realFile);

		const dir = path.dirname(candidate.file);
		const { frontmatter } = splitFrontmatter(content);
		const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(dir);
		const skip = (reason: string) => skipped.push({ name, source: candidate.source, file: candidate.file, reason });

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
			skip("it has no description field, which pi requires");
			continue;
		}
		const override = candidate.plugin ? undefined : overrides.get(name);
		if (override === "off") {
			skip("skillOverrides turns it off");
			continue;
		}
		const existing = byName.get(name);
		if (existing) {
			skip(`a skill with the same name loads from ${existing.source} (${existing.file})`);
			continue;
		}

		const qualifiedNames = candidate.plugin
			? [`${candidate.plugin.name}:${name}`]
			: candidate.source === "claude.ai"
				? [`anthropic-skills:${name}`]
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

		const skill: ClaudeSkill = {
			name,
			qualifiedNames,
			file: candidate.file,
			realFile,
			dir,
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
		};
		byName.set(name, skill);
		skills.push(skill);
	}

	return { skills, skipped, setup };
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
