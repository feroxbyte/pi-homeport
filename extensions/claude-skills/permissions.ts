/**
 * Whether Claude Code would run a skill's injected shell command (`` !`cmd` `` or a ` ```! ` block)
 * without asking: https://code.claude.com/docs/en/skills.md#permission-checks-on-injected-commands.
 *
 * Claude checks each command against its permission rules: a deny or ask rule that matches any part
 * of the command aborts the skill, and every part must be allowed, by an allow rule, the skill's
 * `allowed-tools`, or Claude's built-in set of read-only commands. Anything else aborts too.
 *
 * Claude's analysis is larger than this one (https://code.claude.com/docs/en/permissions.md#bash).
 * This one errs toward refusing: it never allows a command Claude would refuse, but it refuses some
 * Claude would allow, such as any command with a subshell, a file redirect or a variable assignment.
 */

/** Claude's read-only commands that run without approval, minus the ones whose flags can write,
 * delete or run programs (`find`, `git`, `sort`, `sed` and others), which need Claude's finer
 * analysis. */
const READ_ONLY_COMMANDS = new Set(["cat", "diff", "du", "echo", "grep", "head", "ls", "pwd", "stat", "tail", "wc", "which"]);

/** Wrappers Claude strips before matching: the rule for `npm test` also matches `timeout 30 npm test`. */
const WRAPPERS = new Set(["time", "nohup", "builtin", "noglob"]);

export interface BashRules {
	/** `Bash` or `Bash(*)` among the allow rules. */
	allowAll: boolean;
	allow: string[];
	/** Deny and ask rules, which both abort an injected command. */
	block: string[];
	/** `Bash` or `Bash(*)` among the deny or ask rules. */
	blockAll: boolean;
}

/** Splits an `allowed-tools` value or a rules list into rules. A string is separated by spaces or
 * commas outside parentheses, so `Bash(git log *) Read` is two rules. */
export function splitRules(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").flatMap(splitRules);
	if (typeof value !== "string") return [];
	const rules: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of value) {
		if (char === "(") depth++;
		if (char === ")") depth = Math.max(0, depth - 1);
		if (depth === 0 && (char === " " || char === ",")) {
			if (current.trim()) rules.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	if (current.trim()) rules.push(current.trim());
	return rules;
}

/** The specifier of a `Bash` rule: `*` for `Bash`, the text inside `Bash(...)`, else undefined. */
function bashSpecifier(rule: string): string | undefined {
	if (rule === "Bash") return "*";
	const match = /^Bash\((.*)\)$/s.exec(rule);
	return match ? match[1] : undefined;
}

export function bashRules(allow: string[], block: string[]): BashRules {
	const allowSpecs = allow.map(bashSpecifier).filter((spec): spec is string => spec !== undefined);
	const blockSpecs = block.map(bashSpecifier).filter((spec): spec is string => spec !== undefined);
	return {
		allowAll: allowSpecs.includes("*"),
		allow: allowSpecs,
		block: blockSpecs,
		blockAll: blockSpecs.includes("*"),
	};
}

/** Whether a command matches a rule's specifier, with Claude's wildcard rules: `*` matches any text,
 * a trailing `:*` means ` *`, and a trailing ` *` that is the only wildcard also matches the bare
 * command. */
export function matchesRule(command: string, specifier: string): boolean {
	const spec = specifier.endsWith(":*") ? `${specifier.slice(0, -2)} *` : specifier;
	const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const wildcards = spec.split("*").length - 1;
	if (wildcards === 1 && spec.endsWith(" *")) {
		return new RegExp(`^${escape(spec.slice(0, -2))}( .*)?$`, "s").test(command);
	}
	return new RegExp(`^${spec.split("*").map(escape).join(".*")}$`, "s").test(command);
}

/**
 * Splits a command into its simple commands at `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, outside
 * quotes. Returns undefined for a command this module won't judge: unbalanced quotes, subshells,
 * command substitution, process substitution, file redirects, a dangling operator, or a leading
 * variable assignment.
 */
export function splitCommand(command: string): string[] | undefined {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		const next = command[i + 1];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && (char === "`" || (char === "$" && next === "("))) return undefined;
			else if (quote === '"' && char === "\\") {
				current += char + (next ?? "");
				i++;
				continue;
			}
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if (char === "\\") {
			current += char + (next ?? "");
			i++;
		} else if (char === "`" || char === "(" || char === ")" || (char === "$" && next === "(")) {
			return undefined;
		} else if (char === "<" || char === ">") {
			// Only discarded output and stream merges: 2>/dev/null, >/dev/null, 2>&1.
			const rest = command.slice(i);
			const redirect = /^(>|>>)\s*\/dev\/null\b|^>&[12]\b/.exec(rest);
			const fd = /\d$/.test(current) ? current.slice(-1) : "";
			if (!redirect || (fd !== "" && fd !== "1" && fd !== "2")) return undefined;
			current = fd ? current.slice(0, -1) : current;
			i += redirect[0].length - 1;
		} else if (char === "&" || char === "|" || char === ";" || char === "\n") {
			const operator = (char === "&" && next === "&") || (char === "|" && (next === "|" || next === "&")) ? char + next : char;
			i += operator.length - 1;
			if (current.trim() === "") return undefined;
			parts.push(current.trim());
			current = "";
			if (command.slice(i + 1).trim() === "" && operator !== "&" && operator !== ";" && operator !== "\n") return undefined;
		} else {
			current += char;
		}
	}
	if (quote) return undefined;
	if (current.trim()) parts.push(current.trim());
	if (parts.some((part) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part))) return undefined;
	return parts;
}

/** The command with Claude's stripped wrappers removed: `timeout 30 npm test` → `npm test`. */
export function stripWrappers(command: string): string {
	let words = command.split(/\s+/);
	for (;;) {
		const [first, second] = words;
		if (first === undefined) break;
		if (WRAPPERS.has(first)) words = words.slice(1);
		else if (first === "command" && second !== "-v" && second !== "-V") words = words.slice(1);
		else if (first === "timeout" && second !== undefined) words = words.slice(2);
		else if (first === "nice" && second === "-n") words = words.slice(3);
		else if (first === "nice" && /^-\d+$/.test(second ?? "")) words = words.slice(2);
		else if (first === "nice") words = words.slice(1);
		else if (first === "stdbuf") {
			words = words.slice(1);
			while (words[0]?.startsWith("-")) words = words.slice(1);
		} else if (first === "xargs" && second !== undefined && !second.startsWith("-")) words = words.slice(1);
		else break;
	}
	return words.join(" ");
}

function readOnly(command: string): boolean {
	const [program, ...args] = command.split(/\s+/);
	if (program === undefined || !READ_ONLY_COMMANDS.has(program)) return false;
	// `which` reads alias and function definitions with some flags.
	if (program === "which") return args.every((arg) => !arg.startsWith("-") || arg === "-a");
	return true;
}

export type Verdict = { allowed: true } | { allowed: false; reason: string };

export function checkCommand(command: string, rules: BashRules): Verdict {
	const parts = splitCommand(command.trim());
	if (!parts || parts.length === 0) {
		return rules.allowAll && !rules.blockAll && rules.block.length === 0
			? { allowed: true }
			: { allowed: false, reason: "the command is too complex to check against your rules" };
	}
	const commands = parts.map(stripWrappers);
	for (const part of commands) {
		if (rules.blockAll || rules.block.some((spec) => matchesRule(part, spec))) {
			return { allowed: false, reason: `a deny or ask rule matches "${part}"` };
		}
	}
	for (const part of commands) {
		if (rules.allowAll || readOnly(part) || rules.allow.some((spec) => matchesRule(part, spec))) continue;
		return { allowed: false, reason: `no allow rule matches "${part}"` };
	}
	return { allowed: true };
}
