/**
 * Claude Code's skill content features (https://code.claude.com/docs/en/skills.md):
 *
 * - Arguments: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` and named `$name` from the `arguments` field.
 *   Values go in as plain text and are never expanded again. `\$1` stays a literal `$1`. When
 *   arguments were given and no placeholder received them, `ARGUMENTS: <value>` is appended.
 * - Variables: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`,
 *   `${CLAUDE_EFFORT}`, and `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in plugin skills.
 * - Injected commands: `` !`cmd` `` at the start of a line or after whitespace, and ` ```! ` blocks.
 *   Each runs once and its output replaces it; the output is not scanned again. A command that is
 *   refused or fails aborts the whole skill.
 *
 * Commands are found in the skill as written, before arguments go in, so an argument can never
 * become a command of its own.
 *
 * This module has no I/O of its own: the caller checks and runs commands.
 */

export interface ExpandOptions {
	/** The skill body, without frontmatter. */
	body: string;
	/** What followed `/skill:name`, or undefined when the skill was loaded without arguments. */
	args: string | undefined;
	/** The `arguments` frontmatter field. */
	argumentNames: string[];
	/** Values for `${CLAUDE_*}` variables. A variable without a value stays as written. */
	variables: Record<string, string | undefined>;
	/**
	 * What to do with injected commands: `run` them through `runCommand`, replace them with Claude's
	 * policy notice (`disabled`, for `disableSkillShellExecution`), or leave them as written (`never`,
	 * for claude.ai skills, whose commands Claude Code never runs).
	 */
	shell: "run" | "disabled" | "never";
	/** Checks and runs one command; resolves to its output, or to why the skill must abort. */
	runCommand: (command: string, pattern: string) => Promise<{ ok: true; output: string } | { ok: false; message: string }>;
}

export type ExpandResult = { ok: true; text: string; changed: boolean } | { ok: false; message: string };

export const DISABLED_NOTICE = "[shell command execution disabled by policy]";

/** Whether a `read` with pi's 1-indexed `offset` and `limit` returns the whole file, which is when
 * a skill read can be expanded: a part of a skill could split a command in two. */
export function readsWholeFile(offset: unknown, limit: unknown, lineCount: number): boolean {
	const start = offset === undefined ? 1 : offset;
	if (typeof start !== "number" || start > 1) return false;
	return limit === undefined || (typeof limit === "number" && limit >= lineCount);
}

/** Splits arguments the way a shell would: spaces separate, quotes group, backslashes escape. */
export function splitArguments(args: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < args.length; i++) {
		const char = args[i] as string;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && i + 1 < args.length) current += args[++i];
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && i + 1 < args.length) {
			current += args[++i];
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
		} else {
			current += char;
			inWord = true;
		}
	}
	if (inWord) words.push(current);
	return words;
}

type Segment = { kind: "text"; text: string } | { kind: "command"; command: string; pattern: string };

/** The body as text and command segments: ` ```! ` blocks, then inline `` !`cmd` `` that starts a
 * line or follows whitespace. */
function segments(body: string): Segment[] {
	const result: Segment[] = [];
	const pushText = (text: string) => {
		if (!text) return;
		const inline = /(^|[ \t\n])!`([^`\n]+)`/g;
		let last = 0;
		for (const match of text.matchAll(inline)) {
			const start = (match.index ?? 0) + (match[1] ?? "").length;
			result.push({ kind: "text", text: text.slice(last, start) });
			result.push({ kind: "command", command: match[2] ?? "", pattern: `!\`${match[2]}\`` });
			last = start + 3 + (match[2] ?? "").length;
		}
		result.push({ kind: "text", text: text.slice(last) });
	};
	const fenced = /^```!\s*\n([\s\S]*?)^```[ \t]*$/gm;
	let last = 0;
	for (const match of body.matchAll(fenced)) {
		pushText(body.slice(last, match.index));
		const command = (match[1] ?? "").replace(/\n$/, "");
		result.push({ kind: "command", command, pattern: match[0] });
		last = (match.index ?? 0) + match[0].length;
	}
	pushText(body.slice(last));
	return result.filter((segment) => segment.kind === "command" || segment.text !== "");
}

/** Fills in arguments and variables, once, left to right. Returns whether a placeholder received
 * the arguments. */
function substitute(text: string, options: ExpandOptions, words: string[], received: { value: boolean }): string {
	const names = options.argumentNames.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort((a, b) => b.length - a.length);
	const named = names.length > 0 ? `|\\$(?<name>${names.join("|")})(?![A-Za-z0-9_])` : "";
	const pattern = new RegExp(
		`(?<slashes>\\\\*)(?<token>\\$ARGUMENTS\\[(?<index>\\d+)\\]|\\$ARGUMENTS(?![A-Za-z0-9_\\[])|\\$(?<digit>\\d+)(?![0-9])${named}|\\$\\{(?<variable>CLAUDE_[A-Z_]+)\\})`,
		"g",
	);
	return text.replace(pattern, (...match: unknown[]) => {
		const whole = match[0] as string;
		const { slashes = "", token = "", index, digit, name, variable } = match.at(-1) as Record<string, string | undefined>;
		if (variable !== undefined) {
			const value = options.variables[variable];
			return value === undefined ? whole : slashes + value;
		}
		// One backslash right before the token keeps it literal; two leave both and expand.
		if (slashes.length === 1) return token;
		const position = index ?? digit;
		if (position !== undefined) {
			const value = words[Number(position)];
			if (value === undefined) return whole;
			received.value = true;
			return slashes + value;
		}
		if (name !== undefined) {
			received.value = true;
			return slashes + (words[options.argumentNames.indexOf(name)] ?? "");
		}
		received.value = true;
		return slashes + (options.args ?? "");
	});
}

export async function expandSkill(options: ExpandOptions): Promise<ExpandResult> {
	const words = options.args === undefined ? [] : splitArguments(options.args);
	const received = { value: false };
	let changed = false;
	let text = "";
	for (const segment of segments(options.body)) {
		if (segment.kind === "text") {
			const filled = substitute(segment.text, options, words, received);
			changed ||= filled !== segment.text;
			text += filled;
			continue;
		}
		if (options.shell === "never") {
			text += segment.pattern;
			continue;
		}
		changed = true;
		if (options.shell === "disabled") {
			text += DISABLED_NOTICE;
			continue;
		}
		const command = substitute(segment.command, options, words, received);
		const result = await options.runCommand(command, segment.pattern);
		if (!result.ok) return { ok: false, message: result.message };
		text += result.output;
	}
	if (options.args && !received.value) {
		text = `${text.replace(/\s+$/, "")}\n\nARGUMENTS: ${options.args}`;
		changed = true;
	}
	return { ok: true, text, changed };
}
