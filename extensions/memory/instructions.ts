/**
 * The instruction files Claude Code loads: CLAUDE.md files, rules and AGENTS.md, with their
 * `@path` imports, following https://code.claude.com/docs/en/memory.md.
 *
 * At launch, in Claude's order:
 *
 * 1. Managed: `CLAUDE.md` in the managed settings folder, then the managed settings' `claudeMd`.
 * 2. User: `~/.claude/CLAUDE.md`, then the rules in `~/.claude/rules/` without `paths`.
 * 3. Each folder from the filesystem root down to the working directory: `CLAUDE.md`,
 *    `.claude/CLAUDE.md`, the rules in `.claude/rules/` without `paths`, then `CLAUDE.local.md`.
 *    `AGENTS.md` and `.claude/AGENTS.md` load as Claude's Project instructions setting says.
 *
 * Later, as files are read, written or edited:
 *
 * - A subfolder's `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/`, once a file in it is touched.
 *   Its `AGENTS.md` when one is read and the folder has no CLAUDE.md files of its own.
 * - Rules with `paths`, once a matching file is touched.
 *
 * Imports load before the file that imports them, up to four hops deep, each file once. An import
 * from a project file that leaves the working directory loads only if you approved external imports
 * for the project in Claude Code. `claudeMdExcludes` skips files, block-level HTML comments are
 * dropped, and a file over 4 MiB is skipped. Files that load later are cut at a size that depends
 * on the model's context window, with a note to read the rest.
 *
 * This module reads files; it never talks to pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ClaudeSetup, isRecord, listSetting } from "../shared/claude.ts";
import { listField, matchesPaths, splitFrontmatter } from "../shared/markdown.ts";

export type InstructionMode = "claude-md-or-agents-md" | "claude-md-and-agents-md" | "claude-md" | "managed-only";

const MODES = new Set<string>(["claude-md-or-agents-md", "claude-md-and-agents-md", "claude-md", "managed-only"]);

/** Claude skips an instruction file over this size. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** How many imports deep Claude follows. */
const MAX_IMPORT_HOPS = 4;

/** The ids Claude reads the Project instructions setting under, newest first. */
const AGENTS_PLUGIN_IDS = ["cc-plugin-agents-md@builtin", "agents-md@builtin"];

export type InstructionKind = "managed" | "user" | "user rule" | "project" | "project rule" | "local" | "agents" | "import";

export interface InstructionFile {
	/** The path the file was found at. */
	path: string;
	kind: InstructionKind;
	/** The text handed to the model: frontmatter and block-level HTML comments removed. */
	content: string;
}

export interface SkippedInstruction {
	path: string;
	reason: string;
}

interface Rule {
	path: string;
	realPath: string;
	/** The folder `paths` globs are read from. */
	base: string;
	patterns: string[];
	user: boolean;
	content: string;
}

function realPath(file: string): string | undefined {
	try {
		return fs.realpathSync(file);
	} catch {
		return undefined;
	}
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function inside(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The working directory and every folder above it, root first. */
function ancestors(cwd: string): string[] {
	const dirs: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		dirs.unshift(dir);
		if (path.dirname(dir) === dir) return dirs;
	}
}

/** Drops block-level HTML comments outside code blocks, with the line break after each. */
export function stripComments(text: string): string {
	return splitFences(text)
		.map((part) => (part.code ? part.text : part.text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, "")))
		.join("");
}

/** Text split into fenced code blocks and the rest. */
function splitFences(text: string): { text: string; code: boolean }[] {
	const parts: { text: string; code: boolean }[] = [];
	let current = "";
	let fence: string | undefined;
	for (const line of text.split(/(?<=\n)/)) {
		const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === undefined && marker) {
			if (current) parts.push({ text: current, code: false });
			current = line;
			fence = marker;
		} else if (fence !== undefined && marker && marker[0] === fence[0] && marker.length >= fence.length) {
			parts.push({ text: current + line, code: true });
			current = "";
			fence = undefined;
		} else current += line;
	}
	if (current) parts.push({ text: current, code: fence !== undefined });
	return parts;
}

/** The `@path` imports in a file, in order: not inside code blocks or code spans, spaces escaped
 * with a backslash, and quoted paths left alone. */
export function importsIn(text: string): string[] {
	const found: string[] = [];
	for (const part of splitFences(text)) {
		if (part.code) continue;
		const prose = part.text.replace(/(`+)[\s\S]*?\1/g, " ");
		for (const match of prose.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
			const raw = match[1] ?? "";
			if (raw.startsWith('"') || raw.startsWith("'")) continue;
			found.push(raw.replace(/\\ /g, " "));
		}
	}
	return found;
}

/** Claude's Project instructions setting, from user and managed settings only. */
export function instructionMode(setup: ClaudeSetup): InstructionMode {
	let mode: InstructionMode = "claude-md-or-agents-md";
	for (const file of [setup.userSettings, ...setup.managedSettings]) {
		const configs = isRecord(file?.pluginConfigs) ? file.pluginConfigs : {};
		for (const id of [...AGENTS_PLUGIN_IDS].reverse()) {
			const entry = configs[id];
			const value = isRecord(entry) && isRecord(entry.options) ? entry.options.instructionFiles : undefined;
			if (typeof value === "string" && MODES.has(value)) mode = value as InstructionMode;
		}
	}
	return mode;
}

export interface InstructionsOptions {
	cwd: string;
	home?: string;
}

/** The instruction files for a session: those loaded at launch, and the ones that load later. */
export class Instructions {
	readonly files: InstructionFile[] = [];
	readonly skipped: SkippedInstruction[] = [];
	/** Files loaded after launch, in load order. */
	readonly loadedLater: InstructionFile[] = [];
	readonly mode: InstructionMode;
	/** Whether AGENTS.md files are read in this session. */
	readonly readsAgents: boolean;

	private readonly cwd: string;
	/** The working directory with symlinks resolved, for comparing real paths. */
	private readonly realCwd: string;
	private readonly home: string;
	private readonly excludes: string[];
	private readonly externalApproved: boolean;
	private readonly seen = new Set<string>();
	/** Claude's config folder, which is user scope even where it sits in a folder on the path. */
	private readonly configDir: string;
	private readonly scopedRules: Rule[] = [];
	private readonly visitedDirs = new Set<string>();

	constructor(setup: ClaudeSetup, options: InstructionsOptions) {
		this.cwd = path.resolve(options.cwd);
		this.realCwd = realPath(this.cwd) ?? this.cwd;
		this.configDir = realPath(setup.configDir) ?? path.resolve(setup.configDir);
		this.home = options.home ?? os.homedir();
		this.excludes = listSetting(setup, (file) => file.claudeMdExcludes);
		this.externalApproved = setup.projectEntry.hasClaudeMdExternalIncludesApproved === true;
		this.mode = instructionMode(setup);

		const dirs = ancestors(this.cwd);
		const hasClaudeMd = dirs.some((dir) => this.claudeMdFiles(dir).some(isFile));
		this.readsAgents = this.mode === "claude-md-and-agents-md" || (this.mode === "claude-md-or-agents-md" && !hasClaudeMd);

		this.add(this.load(path.join(setup.managedDir, "CLAUDE.md"), "managed", { managed: true }));
		const managedText = [...setup.managedSettings].reverse().find((file) => typeof file.claudeMd === "string")?.claudeMd;
		if (typeof managedText === "string" && managedText.trim()) {
			this.files.push({ path: path.join(setup.managedDir, "managed-settings.json (claudeMd)"), kind: "managed", content: managedText });
		}
		for (const dir of dirs) this.visitedDirs.add(dir);
		if (this.mode === "managed-only") {
			// Only path-scoped rules, which still load when a matching file is touched.
			this.rules(path.join(setup.configDir, "rules"), this.cwd, true, { scopedOnly: true });
			for (const dir of dirs) {
				const dotClaude = this.dotClaude(dir);
				if (dotClaude) this.rules(path.join(dotClaude, "rules"), dir, false, { scopedOnly: true });
			}
			return;
		}

		this.add(this.load(path.join(setup.configDir, "CLAUDE.md"), "user", { user: true }));
		this.add(this.rules(path.join(setup.configDir, "rules"), this.cwd, true));
		for (const dir of dirs) this.add(this.dirFiles(dir, { agents: this.readsAgents }));
	}

	private add(files: InstructionFile[]) {
		this.files.push(...files);
	}

	/** A folder's `.claude`, unless it's Claude's config folder (`~/.claude` seen from home). */
	private dotClaude(dir: string): string | undefined {
		const folder = path.join(dir, ".claude");
		return (realPath(folder) ?? folder) === this.configDir ? undefined : folder;
	}

	/** The files that make a folder a CLAUDE.md folder. */
	private claudeMdFiles(dir: string): string[] {
		const dotClaude = this.dotClaude(dir);
		return [path.join(dir, "CLAUDE.md"), ...(dotClaude ? [path.join(dotClaude, "CLAUDE.md")] : []), path.join(dir, "CLAUDE.local.md")];
	}

	/** A folder's files in Claude's order: CLAUDE.md, .claude/CLAUDE.md, rules, CLAUDE.local.md,
	 * then AGENTS.md when it's read. */
	private dirFiles(dir: string, options: { agents: boolean; limit?: number }): InstructionFile[] {
		const dotClaude = this.dotClaude(dir);
		const files = [
			...this.load(path.join(dir, "CLAUDE.md"), "project", options),
			...(dotClaude ? this.load(path.join(dotClaude, "CLAUDE.md"), "project", options) : []),
			...(dotClaude ? this.rules(path.join(dotClaude, "rules"), dir, false, { limit: options.limit }) : []),
			...this.load(path.join(dir, "CLAUDE.local.md"), "local", options),
		];
		if (options.agents) {
			files.push(...this.load(path.join(dir, "AGENTS.md"), "agents", options));
			if (dotClaude) files.push(...this.load(path.join(dotClaude, "AGENTS.md"), "agents", options));
		}
		return files;
	}

	private excluded(...paths: string[]): boolean {
		return this.excludes.some((pattern) => paths.some((file) => path.matchesGlob(file, pattern)));
	}

	/**
	 * A file and its imports, imports first. `user` and `managed` files import from anywhere;
	 * project files import from outside the working directory only with Claude's approval.
	 */
	private load(
		file: string,
		kind: InstructionKind,
		options: { user?: boolean; managed?: boolean; limit?: number; hops?: number; rule?: string; raw?: string },
	): InstructionFile[] {
		const real = realPath(file);
		if (!real || !isFile(real) || this.seen.has(real)) return [];
		if (!options.managed && this.excluded(file, real)) {
			this.skipped.push({ path: file, reason: "claudeMdExcludes" });
			return [];
		}
		if (fs.statSync(real).size > MAX_FILE_BYTES) {
			this.skipped.push({ path: file, reason: "over 4 MiB" });
			return [];
		}
		this.seen.add(real);
		const text = options.raw ?? fs.readFileSync(real, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
		const content = stripComments(text);
		const hops = options.hops ?? 0;
		const imported: InstructionFile[] = [];
		if (hops < MAX_IMPORT_HOPS) {
			for (const target of importsIn(content)) imported.push(...this.importFile(target, file, options, hops + 1));
		}
		return [...imported, { path: file, kind, content: this.cut(content, file, options.limit) }];
	}

	private importFile(target: string, importer: string, options: { user?: boolean; managed?: boolean; limit?: number }, hops: number): InstructionFile[] {
		const resolve = (value: string) =>
			value.startsWith("~/") ? path.join(this.home, value.slice(2)) : path.resolve(path.dirname(importer), value);
		let file = resolve(target);
		if (!isFile(file)) {
			const trimmed = target.replace(/[.,;:!?)\]]+$/, "");
			if (trimmed === target || !isFile(resolve(trimmed))) return [];
			file = resolve(trimmed);
		}
		const real = realPath(file) ?? file;
		if (!options.user && !options.managed && !inside(real, this.realCwd) && !this.externalApproved) {
			this.skipped.push({ path: file, reason: `external import from ${importer}, not approved in Claude Code` });
			return [];
		}
		return this.load(file, "import", { ...options, hops });
	}

	private cut(content: string, file: string, limit: number | undefined): string {
		if (limit === undefined || content.length <= limit) return content;
		return `${content.slice(0, limit)}\n\n[This file is longer than what loads automatically. Read ${file} for the rest.]`;
	}

	/** Rule files under a rules folder, recursively, following symlinks once. Rules without
	 * `paths` load now; the others wait for a matching file. */
	private rules(dir: string, base: string, user: boolean, options: { limit?: number; scopedOnly?: boolean } = {}): InstructionFile[] {
		const files: InstructionFile[] = [];
		const walk = (folder: string, visited: Set<string>) => {
			let entries: string[];
			try {
				entries = fs.readdirSync(folder).sort();
			} catch {
				return;
			}
			for (const name of entries) {
				const entry = path.join(folder, name);
				const real = realPath(entry);
				if (!real) continue;
				if (fs.statSync(real).isDirectory()) {
					if (visited.has(real)) continue;
					walk(entry, new Set([...visited, real]));
					continue;
				}
				if (!name.endsWith(".md") || this.seen.has(real)) continue;
				const external = !user && !inside(real, this.realCwd);
				if (external && !this.externalApproved) {
					this.skipped.push({ path: entry, reason: "rule links outside the working directory, not approved in Claude Code" });
					continue;
				}
				const { frontmatter, body } = splitFrontmatter(fs.readFileSync(real, "utf8"));
				const patterns = listField(frontmatter.paths);
				if (patterns.length > 0) {
					if (!external) this.scopedRules.push({ path: entry, realPath: real, base, patterns, user, content: body });
					continue;
				}
				if (!options.scopedOnly) files.push(...this.load(entry, user ? "user rule" : "project rule", { user, limit: options.limit, raw: body }));
			}
		};
		const root = realPath(dir);
		if (root) walk(dir, new Set([root]));
		return files;
	}

	/**
	 * What loads because the model touched `file` with `tool`: CLAUDE.md files and rules of the
	 * subfolders between the working directory and the file, then rules whose `paths` match it.
	 * `limit` is the size, in characters, a file that loads later is cut at.
	 */
	touched(file: string, tool: "read" | "write" | "edit", limit: number): InstructionFile[] {
		let target = path.resolve(this.cwd, file);
		if (!inside(target, this.cwd)) {
			// The same file reached through the working directory's real path.
			const real = realPath(target);
			if (real && inside(real, this.realCwd)) target = path.join(this.cwd, path.relative(this.realCwd, real));
		}
		const loaded: InstructionFile[] = [];
		const dirs: string[] = [];
		for (let dir = path.dirname(target); inside(dir, this.cwd) && dir !== this.cwd; dir = path.dirname(dir)) dirs.unshift(dir);
		for (const dir of dirs) {
			if (this.visitedDirs.has(dir)) continue;
			this.visitedDirs.add(dir);
			const ownClaudeMd = this.claudeMdFiles(dir).some(isFile);
			const agents = this.mode === "claude-md-and-agents-md" || (this.readsAgents && tool === "read" && !ownClaudeMd);
			loaded.push(...this.dirFiles(dir, { agents, limit }));
		}
		for (const rule of this.scopedRules) {
			if (this.seen.has(rule.realPath) || !matchesPaths(target, rule.base, rule.patterns)) continue;
			loaded.push(...this.load(rule.path, rule.user ? "user rule" : "project rule", { user: rule.user, limit, raw: rule.content }));
		}
		this.loadedLater.push(...loaded);
		return loaded;
	}

	/** Rules that wait for a matching file, not loaded yet. */
	waitingRules(): string[] {
		return this.scopedRules.filter((rule) => !this.seen.has(rule.realPath)).map((rule) => rule.path);
	}
}

/** Claude's limit, in characters, for an instruction file that loads after launch: 40,000 with a
 * 200K context window, 150,000 with a 1M window. */
export function laterFileLimit(contextWindow: number | undefined): number {
	return contextWindow !== undefined && contextWindow >= 1_000_000 ? 150_000 : 40_000;
}
