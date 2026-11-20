/**
 * Claude Code's auto memory (https://code.claude.com/docs/en/memory.md#auto-memory): a folder of
 * memory files per repository, with a `MEMORY.md` index whose first 200 lines or 25KB load into
 * every session. The model writes the files with its usual file tools; this module finds the
 * folder, writes the prompt, and does what Claude Code does after a write: it stamps a `modified`
 * time into the frontmatter and checks the index against its load limits.
 *
 * This module reads files; it never talks to pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { booleanSetting, type ClaudeSetup } from "../shared/claude.ts";

export const INDEX_FILE = "MEMORY.md";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;

/** Claude cuts a project folder name at this length and adds a hash of the path. */
const SLUG_MAX = 200;

export interface AutoMemory {
	enabled: boolean;
	/** Why it's off, when it is. */
	disabledBy?: string;
	dir: string;
	/** The part of `MEMORY.md` that loads, if the file exists. */
	index?: string;
	/** Whether `MEMORY.md` goes past what loads. */
	truncated: boolean;
}

/** The repository a folder belongs to, shared by all its worktrees: the main worktree's root.
 * Outside a repository, the folder itself. */
export function repositoryRoot(cwd: string): string {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const dotGit = path.join(dir, ".git");
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(dotGit);
		} catch {
			// Not here.
		}
		if (stat?.isDirectory()) return dir;
		if (stat?.isFile()) {
			// A linked worktree: `.git` points at `<main>/.git/worktrees/<name>`, whose `commondir`
			// points back at `<main>/.git`.
			try {
				const gitDir = path.resolve(dir, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
				const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
				return path.dirname(common);
			} catch {
				return dir;
			}
		}
		if (path.dirname(dir) === dir) return path.resolve(cwd);
	}
}

/** Java's string hash, which Claude uses for long project folder names. */
function stringHash(text: string): number {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
	return hash;
}

/** The folder name Claude Code gives a project under `~/.claude/projects`: every character that
 * isn't an ASCII letter or digit becomes a dash. */
export function projectSlug(root: string): string {
	const normalized = root.normalize("NFC");
	const slug = normalized.replace(/[^a-zA-Z0-9]/g, "-");
	if (slug.length <= SLUG_MAX) return slug;
	return `${slug.slice(0, SLUG_MAX)}-${Math.abs(stringHash(normalized)).toString(36)}`;
}

/** The highest-precedence `autoMemoryDirectory` that's absolute or starts with `~/`. */
function directorySetting(setup: ClaudeSetup, home: string): string | undefined {
	let value: string | undefined;
	for (const file of setup.settings) {
		const setting = typeof file.autoMemoryDirectory === "string" ? file.autoMemoryDirectory.trim() : "";
		if (setting.startsWith("~/")) value = path.join(home, setting.slice(2));
		else if (path.isAbsolute(setting)) value = setting;
	}
	return value;
}

/** The part of an index that loads: the first 200 lines or 25KB, whichever comes first. */
export function loadedIndex(text: string): { text: string; truncated: boolean } {
	const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(0, INDEX_MAX_LINES)) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > INDEX_MAX_BYTES) break;
		kept.push(line);
		bytes += size;
	}
	return { text: kept.join("\n"), truncated: kept.length < lines.length };
}

/** Where an index stands against its load limits: within 10% of one is near. */
export function indexState(text: string): "ok" | "near" | "over" {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const lines = normalized === "" ? 0 : normalized.split("\n").length;
	const bytes = Buffer.byteLength(normalized, "utf8");
	if (lines > INDEX_MAX_LINES || bytes > INDEX_MAX_BYTES) return "over";
	if (lines > INDEX_MAX_LINES * 0.9 || bytes > INDEX_MAX_BYTES * 0.9) return "near";
	return "ok";
}

export function readAutoMemory(setup: ClaudeSetup, cwd: string, home: string = os.homedir()): AutoMemory {
	const env = setup.env;
	const named = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CODE_PROJECT_DIR_NAME;
	const project = named && /^[A-Za-z0-9_-]{1,64}$/.test(named) ? named : projectSlug(repositoryRoot(cwd));
	const dir = directorySetting(setup, home) ?? path.join(setup.configDir, "projects", project, "memory");

	const flag = (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? "").trim().toLowerCase();
	let disabledBy: string | undefined;
	if (flag === "1" || flag === "true") disabledBy = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
	else if (flag !== "0" && flag !== "false" && booleanSetting(setup, "autoMemoryEnabled") === false) disabledBy = "autoMemoryEnabled: false";
	if (disabledBy) return { enabled: false, disabledBy, dir, truncated: false };

	let raw: string | undefined;
	try {
		raw = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
	} catch {
		// No index yet.
	}
	if (raw === undefined) return { enabled: true, dir, truncated: false };
	const { text, truncated } = loadedIndex(raw);
	return { enabled: true, dir, index: text, truncated };
}

/** The prompt section that tells the model about auto memory, with the loaded index. */
export function memoryPrompt(memory: AutoMemory): string {
	const index = memory.index?.trim()
		? `Your ${INDEX_FILE} as of this session's start:\n\n${memory.index}${memory.truncated ? `\n\n[${INDEX_FILE} goes on past the part that loads. Shorten it.]` : ""}`
		: `${INDEX_FILE} is empty or doesn't exist yet.`;
	return `You have a persistent memory folder at \`${memory.dir}\`. It carries what you learn about the user and their work into future sessions, and Claude Code sessions in this project use the same folder.

Save a memory when you learn something a future session would need that the code, the git history and the instruction files don't already say:
- user: who the user is, their expertise and how they like to work
- feedback: corrections the user gives you and approaches they confirm, with the reason
- project: ongoing work, goals, deadlines and decisions; write dates as absolute dates
- reference: where to find information outside the project, such as a tracker or dashboard

Not every session needs a memory. When the user asks you to remember something, save it here; when they ask for it in CLAUDE.md, edit that file instead.

Each memory is its own markdown file in the folder, written with your file tools:

\`\`\`markdown
---
name: <short-kebab-case-name>
description: <one line, used to decide whether the memory is relevant>
metadata:
  type: <user | feedback | project | reference>
---

<the memory>
\`\`\`

Then add one line to \`${INDEX_FILE}\` in the same folder: \`- [Title](file.md) — one-line hook\`. Only the index loads at the start of a session, and only its first ${INDEX_MAX_LINES} lines or 25KB, so keep one short line per memory. Read a memory file when its line looks relevant. Before saving, check for a memory that already covers the fact and update it instead; delete memories that turn out to be wrong, along with their index line.

${index}`;
}

/** A memory file with its frontmatter's `modified` time set: an existing field is replaced where it
 * is, a new one goes inside `metadata:` when the frontmatter has that block, else at the top level.
 * A file without frontmatter is returned unchanged. */
export function stampModified(content: string, iso: string): string {
	const match = /^---(\r?\n)([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return content;
	const eol = match[1] ?? "\n";
	const lines = (match[2] ?? "").split(/\r?\n/);
	const existing = /^(\s*)modified\s*:.*$/;
	let next: string[];
	if (lines.some((line) => existing.test(line))) {
		next = lines.map((line) => line.replace(existing, (_all, indent: string) => `${indent}modified: ${iso}`));
	} else {
		const metadata = lines.findIndex((line) => /^metadata:\s*(#.*)?$/.test(line));
		if (metadata === -1) next = [...lines, `modified: ${iso}`];
		else {
			let end = metadata + 1;
			while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end++;
			const indent = /^\s+/.exec(lines[metadata + 1] ?? "")?.[0] ?? "  ";
			next = [...lines.slice(0, end), `${indent}modified: ${iso}`, ...lines.slice(end)];
		}
	}
	return `---${eol}${next.join(eol)}${eol}---${content.slice(match[0].length)}`;
}
