/**
 * Markdown helpers shared by the extensions that read Claude Code's files: YAML frontmatter, list
 * fields, and the `paths` globs that skills and rules use.
 */

import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { isRecord } from "./claude.ts";

/** A file's YAML frontmatter and the text after it. Frontmatter that doesn't parse is dropped
 * and reads as empty. */
export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };
	const body = normalized.slice(end + 4).replace(/^[^\n]*\n?/, "");
	try {
		const parsed: unknown = parseYaml(normalized.slice(4, end));
		return { frontmatter: isRecord(parsed) ? parsed : {}, body };
	} catch {
		return { frontmatter: {}, body };
	}
}

/** A list field: a YAML list, or a string separated by commas (and spaces, when `spaces`). */
export function listField(value: unknown, spaces = false): string[] {
	if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
	if (typeof value !== "string") return [];
	return value
		.split(spaces ? /[\s,]+/ : /,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Whether `file` matches one of Claude's `paths` globs, read relative to `base`
 * (https://code.claude.com/docs/en/memory.md#path-specific-rules): `*.md` matches at any depth,
 * `/*.md` only directly in `base`, and `src/*.tsx` only directly in `base/src`. Files outside
 * `base` never match.
 */
export function matchesPaths(file: string, base: string, patterns: string[]): boolean {
	const relative = path.relative(base, path.resolve(base, file));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	return patterns.some((pattern) => {
		const clean = pattern.trim().replace(/^\.\//, "");
		if (clean.startsWith("/")) return path.matchesGlob(relative, clean.slice(1));
		if (!clean.includes("/")) return path.matchesGlob(relative, clean) || path.matchesGlob(path.basename(relative), clean);
		return path.matchesGlob(relative, clean);
	});
}
