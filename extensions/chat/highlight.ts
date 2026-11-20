/**
 * Code highlighting and diff views for the chat extension's tool rows.
 *
 * From pi-polish by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md).
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import bash from "@shikijs/langs/shellscript";
import css from "@shikijs/langs/css";
import c from "@shikijs/langs/c";
import diff from "@shikijs/langs/diff";
import docker from "@shikijs/langs/docker";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import lua from "@shikijs/langs/lua";
import make from "@shikijs/langs/make";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import { diffWordsWithSpace } from "diff";
import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const MARK = "●";

// Some models default to shell heredocs and sed even with pi's built-in guidance; these make the file tools the default
export const FILE_TOOL_GUIDELINES: Record<string, string[]> = {
	read: ["Use read to view file contents instead of cat, head, tail or sed -n in bash."],
	edit: [
		"Use edit to change existing files instead of bash: never modify files with sed -i, perl -pi, python or node scripts, or shell redirection.",
	],
	write: [
		"Use write to create new files or fully rewrite small ones instead of bash: never create files with cat <<EOF, echo or printf redirection, tee, or python scripts.",
		"write creates missing parent directories itself, so call it directly instead of combining mkdir -p with a heredoc in bash.",
	],
};

export const DIFF_PREVIEW_LINES = 16;
const BG_RESET = "\x1b[49m";
const FG_RESET = "\x1b[39m";

export type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };

export function resultText(result: Result): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

export function shortPath(path: unknown, cwd: string): string {
	const p = String(path ?? "?");
	const rel = relative(cwd, p);
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : p;
}

export function expandedBody(theme: any, text: string, maxLines = 60): string {
	const lines = text.split("\n");
	const shown = lines.slice(0, maxLines).join("\n");
	const extra = lines.length > maxLines ? `\n${theme.fg("dim", `... ${lines.length - maxLines} more lines`)}` : "";
	return "  " + theme.fg("toolOutput", shown).replace(/\n/g, "\n  ") + extra;
}

// Shiki (TextMate grammars, as in VS Code) with Dark+ or Light+, matching Neovim's vscode.nvim.
// C++ is left out: its grammar takes ~0.5s to compile on first use and would freeze the screen; pi's highlighter covers it.
const SHIKI_LANGS = [bash, css, c, diff, docker, go, html, ini, java, javascript, json, jsonc, jsx, lua, make, markdown, python, rust, sql, toml, tsx, typescript, xml, yaml];
const EXT_TO_LANG: Record<string, string> = {
	sh: "shellscript", bash: "shellscript", zsh: "shellscript", css: "css", c: "c", h: "c", diff: "diff", patch: "diff",
	go: "go", html: "html", htm: "html", ini: "ini", cfg: "ini", conf: "ini", java: "java", js: "javascript",
	mjs: "javascript", cjs: "javascript", json: "json", jsonc: "jsonc", jsx: "jsx", lua: "lua", mk: "make",
	md: "markdown", py: "python", pyi: "python", rs: "rust", sql: "sql", toml: "toml", tsx: "tsx", ts: "typescript",
	mts: "typescript", cts: "typescript", xml: "xml", yml: "yaml", yaml: "yaml",
};
const FILE_TO_LANG: Record<string, string> = { Dockerfile: "docker", Makefile: "make", makefile: "make" };
// Dark+ and Light+ leave Python calls and attributes uncolored because VS Code gets those from Pylance
const withPythonRules = (theme: any, name: string, call: string, attribute: string) => ({
	...theme,
	name,
	tokenColors: [
		...theme.tokenColors,
		{ scope: ["meta.function-call.generic"], settings: { foreground: call } },
		{ scope: ["meta.attribute"], settings: { foreground: attribute } },
	],
});
const SHIKI_THEMES = [withPythonRules(darkPlus, "dark-plus-pi", "#DCDCAA", "#9CDCFE"), withPythonRules(lightPlus, "light-plus-pi", "#795E26", "#001080")];
let shiki: HighlighterCore | undefined;

/** Slightly brighter and more saturated than stock Dark+, which reads as muddy on the terminal background. */
function brighten(hex: string): [number, number, number] {
	// Plain code text is Dark+'s gray foreground; saturation can't lift a gray, so it maps straight to near-white
	if (hex.toUpperCase().startsWith("#D4D4D4")) return [238, 238, 238];
	const n = Number.parseInt(hex.slice(1, 7), 16);
	let [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	let l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	s = Math.min(1, s * 1.4);
	// Lightening an already light color (function yellow, variable blue) washes it out to near-white, so only darker ones get it
	if (l < 0.65) l = Math.min(0.72, l * 1.12);
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hue = (t: number) => {
		const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
	};
	[r, g, b] = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const rgb = (hex: string): [number, number, number] => {
	const n = Number.parseInt(hex.slice(1, 7), 16);
	return [n >> 16, (n >> 8) & 255, n & 255];
};

/** Colors for dark and light pi themes: Dark+ or Light+ code, and diff bands that suit the background. */
const PALETTES = {
	dark: {
		shikiTheme: "dark-plus-pi",
		adjust: brighten,
		defaultFg: "#D4D4D4",
		typeFg: "#4EC9B0",
		variableFg: "#9CDCFE",
		addedBg: "\x1b[48;2;13;46;16m",
		removedBg: "\x1b[48;2;63;12;16m",
		// Brighter bands for the words that changed within a replaced line
		addedWordBg: "\x1b[48;2;31;95;38m",
		removedWordBg: "\x1b[48;2;122;30;36m",
		// Line numbers and +/- signs tinted to match their band, like Claude Code, instead of dim gray
		addedGutter: "\x1b[38;2;120;200;120m",
		removedGutter: "\x1b[38;2;230;120;120m",
	},
	light: {
		shikiTheme: "light-plus-pi",
		adjust: rgb,
		defaultFg: "#000000",
		typeFg: "#267F99",
		variableFg: "#001080",
		addedBg: "\x1b[48;2;230;255;236m",
		removedBg: "\x1b[48;2;255;235;233m",
		addedWordBg: "\x1b[48;2;171;242;188m",
		removedWordBg: "\x1b[48;2;255;206;203m",
		addedGutter: "\x1b[38;2;26;127;55m",
		removedGutter: "\x1b[38;2;207;34;46m",
	},
};
type Palette = (typeof PALETTES)["dark"];

const paletteFor = (theme: any): Palette => (theme?.appearance === "light" ? PALETTES.light : PALETTES.dark);
const PY_BUILTIN_TYPES = new Set(["bool", "bytearray", "bytes", "complex", "dict", "float", "frozenset", "int", "list", "object", "set", "str", "tuple", "type"]);

/** Imported module names and aliases, from the snippet and the file on disk, so they can be colored as modules. */
function pythonModules(code: string, path: string): Set<string> {
	let source = code;
	try {
		source += `\n${readFileSync(resolve(path), "utf8")}`;
	} catch {}
	const names = new Set<string>();
	for (const m of source.matchAll(/^\s*import\s+([\w., ]+)/gm)) {
		for (const item of m[1].split(",")) {
			const [mod, alias] = item.trim().split(/\s+as\s+/);
			if (mod) names.add(alias ?? mod.split(".")[0]);
		}
	}
	for (const m of source.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) names.add(m[1].split(".")[0]);
	return names;
}

/** Highlights code with Shiki when the file type is covered; undefined lets pi's own highlighter take over. */
function shikiLines(code: string, path: string, palette: Palette): string[] | undefined {
	const name = path.split("/").pop() ?? "";
	const lang = FILE_TO_LANG[name] ?? EXT_TO_LANG[name.split(".").pop()?.toLowerCase() ?? ""];
	if (!lang) return undefined;
	try {
		shiki ??= createHighlighterCoreSync({ themes: SHIKI_THEMES, langs: SHIKI_LANGS, engine: createJavaScriptRegexEngine() });
		const modules = lang === "python" ? pythonModules(code, path) : undefined;
		const paint = (hex: string, text: string, italic = false) => {
			const [r, g, b] = palette.adjust(hex);
			return `\x1b[38;2;${r};${g};${b}m${italic ? "\x1b[3m" : ""}${text}${italic ? "\x1b[23m" : ""}\x1b[39m`;
		};
		const { defaultFg, typeFg, variableFg } = palette;
		return shiki.codeToTokensBase(code, { lang, theme: palette.shikiTheme }).map((line) =>
			line
				.map((t) => {
					const color = t.color ?? defaultFg;
					// Python names the grammar leaves unscoped: color them like Neovim's tree-sitter + LSP does
					if (modules && color.toUpperCase().startsWith(defaultFg)) {
						return t.content.replace(/[A-Za-z_]\w*|[^A-Za-z_]+/g, (part) => {
							if (!/^[A-Za-z_]/.test(part)) return paint(defaultFg, part);
							if (modules.has(part) || PY_BUILTIN_TYPES.has(part)) return paint(typeFg, part);
							return paint(variableFg, part);
						});
					}
					return paint(color, t.content, Boolean((t.fontStyle ?? 0) & 1));
				})
				.join(""),
		);
	} catch {
		return undefined;
	}
}

type Span = [number, number];

/**
 * The changed words of a replaced line, as column spans on each side (jsdiff word diff). Changes separated only by
 * whitespace merge into one span. Undefined when the lines share too little for word highlighting to mean anything.
 */
function changedSpans(before: string, after: string): [Span[], Span[]] | undefined {
	const removed: Span[] = [];
	const added: Span[] = [];
	let [b, a, same] = [0, 0, 0];
	const push = (spans: Span[], start: number, end: number) => {
		const last = spans[spans.length - 1];
		if (last && /^\s*$/.test((spans === removed ? before : after).slice(last[1], start))) last[1] = end;
		else spans.push([start, end]);
	};
	for (const part of diffWordsWithSpace(before, after)) {
		const n = part.value.length;
		if (part.removed) push(removed, b, (b += n));
		else if (part.added) push(added, a, (a += n));
		else {
			b += n;
			a += n;
			same += part.value.trim().length;
		}
	}
	if (same < 0.3 * Math.max(before.trim().length, after.trim().length)) return undefined;
	return [removed, added];
}

/** Puts a background on the given visible column spans of an ANSI-colored line, surviving color resets inside them. */
function withBackground(line: string, spans: Span[], on: string, off: string): string {
	const marked = (col: number) => spans.some(([start, end]) => col >= start && col < end);
	let out = "";
	let col = 0;
	let inside = false;
	for (let i = 0; i < line.length; ) {
		const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
		if (esc) {
			out += esc[0] + (inside && /^\x1b\[0?m$/.test(esc[0]) ? on : "");
			i += esc[0].length;
			continue;
		}
		const want = marked(col);
		if (want !== inside) {
			out += want ? on : off;
			inside = want;
		}
		out += line[i++];
		col++;
	}
	return inside ? out + off : out;
}

/**
 * Renders pi's "+12 text" / "-12 text" / " 12 text" diff lines with syntax highlighting, added and
 * removed lines as full-width colored bands.
 */
export class DiffView implements Component {
	private highlighted: string[];
	private palette: Palette;

	private lines: string[];
	private theme: any;
	private footer: string | undefined;

	constructor(lines: string[], theme: any, footer?: string, path = "") {
		this.lines = lines;
		this.theme = theme;
		this.footer = footer;
		const palette = (this.palette = paletteFor(theme));
		// Highlight all bodies as one snippet so multi-line strings and docstrings color correctly
		const bodies = lines.map((line) => (/^[+\- ]\s*\d*\s(.*)$/.exec(line)?.[1] ?? line.slice(1)).replace(/\t/g, "    "));
		let highlighted: string[] = [];
		try {
			const code = bodies.join("\n");
			const lang = getLanguageFromPath(path);
			highlighted = shikiLines(code, path, palette) ?? (lang ? highlightCode(code, lang) : []);
		} catch {
			highlighted = [];
		}
		this.highlighted = highlighted.length === bodies.length ? highlighted : bodies.map((b) => theme.fg("toolTitle", b));

		// Pair each run of removed lines with the added run right after it, line by line, and mark the changed words
		for (let i = 0; i < lines.length; ) {
			if (lines[i][0] !== "-") {
				i++;
				continue;
			}
			let removedEnd = i;
			while (removedEnd < lines.length && lines[removedEnd][0] === "-") removedEnd++;
			let addedEnd = removedEnd;
			while (addedEnd < lines.length && lines[addedEnd][0] === "+") addedEnd++;
			for (let k = 0; k < Math.min(removedEnd - i, addedEnd - removedEnd); k++) {
				const [r, a] = [i + k, removedEnd + k];
				const spans = changedSpans(bodies[r], bodies[a]);
				if (!spans) continue;
				this.highlighted[r] = withBackground(this.highlighted[r], spans[0], palette.removedWordBg, palette.removedBg);
				this.highlighted[a] = withBackground(this.highlighted[a], spans[1], palette.addedWordBg, palette.addedBg);
			}
			i = addedEnd;
		}
	}

	render(width: number): string[] {
		const { addedBg, removedBg, addedGutter, removedGutter } = this.palette;
		const out = this.lines.map((line, i) => {
			const sign = line[0];
			const num = /^[+\- ](\s*\d*)\s/.exec(line)?.[1] ?? "";
			const gutterText = `     ${num} ${sign === " " ? " " : sign} `;
			const gutter = sign === "+" ? addedGutter + gutterText + FG_RESET : sign === "-" ? removedGutter + gutterText + FG_RESET : this.theme.fg("dim", gutterText);
			// Bands stop two columns short of the right edge, like Claude Code's
			const inner = Math.max(10, width - 2);
			const text = truncateToWidth(gutter + this.highlighted[i], inner);
			if (sign === " ") return text;
			const bg = sign === "+" ? addedBg : removedBg;
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
			// Highlighter resets would end the band early, so restore the background after each one
			return `${bg}${text.replace(/\x1b\[0?m/g, (m) => m + bg)}${pad}${BG_RESET}`;
		});
		if (this.footer) out.push(truncateToWidth(this.footer, width));
		return out;
	}

	invalidate(): void {}
}

export function lineCount(n: number): string {
	return `${n} line${n === 1 ? "" : "s"}`;
}

export function empty() {
	return new Container();
}

