/**
 * Which shell commands plan mode runs without asking: a built-in set of read-only commands, like
 * Claude Code's (https://code.claude.com/docs/en/permissions.md#read-only-commands). Every
 * subcommand of a compound command must be read-only, and a redirection that writes a file, a
 * command substitution, or a flag that makes a reader write or run something takes a command out
 * of the set. Anything else asks you first.
 *
 * Based on pi-code's plan-mode/utils.ts by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), itself
 * from pi's plan-mode example, without the plan-step parsing: the plan comes whole from the
 * `exit_plan_mode` tool.
 */

import { hasAnsiCNumericEscape, hasSubstitution, type Quote, quoteCloser, quoteEscapes, quoteOpensAt, shellWords, splitSegments } from "./shell-split.ts";

// Destructive commands blocked in plan mode. Tested against the segment's command word,
// the one word that runs: an allowlisted head never executes its arguments, so `code`
// in a path, `touch` in a quoted pattern or `cp` in a file name is not a command.
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\bnpm\s+audit\s+fix\b/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-d|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
].map((pattern) => new RegExp(String.raw`^\s*(?:${pattern.source})`, pattern.flags));

/** Claude Code asks about any command longer than this. */
const MAX_ANALYZED_CHARS = 10_000;

// A redirect writes wherever it points, from any position in the segment, and `<>` opens
// its target for reading and writing, creating it.
const REDIRECT_PATTERNS = [/(^|[^<])>(?!>)/, />>/, /<>/];

// Redirections that write nothing: onto /dev/null, and a descriptor duplicated onto
// another (`2>&1`, `>&2`, `>&-`). `>&file` is not one: it writes the file. Every run is
// bounded: the text is chosen by the model, and an unbounded `\d*` in front of an
// unanchored match backtracks quadratically (40,000 digits took over a second).
const DEV_NULL_REDIRECT = /(?:&|\d{0,3})>>?[ \t]{0,8}\/dev\/null(?=\s|$)/g;
const DESCRIPTOR_REDIRECT = /\d{0,3}>&(?:\d{1,3}|-)(?=\s|$)/g;

// Safe read-only commands allowed in plan mode. Deliberately excludes env/printenv
// (secret disclosure, and env is an exec wrapper), curl/wget (fetch plus -o writes),
// awk (system()) and sed (w/W/e write even under -n).
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*cd(\s|$)/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|blame|describe|shortlog)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

// find is allowlisted for traversal only; these actions run commands, delete or write.
const FIND_ACTIONS = /\s-(exec|execdir|ok|okdir|delete|fls|fprint|fprint0|fprintf)\b/;

// Flags that turn an allowlisted read into a write or an execution, per command.
const UNSAFE_FLAGS: ReadonlyArray<readonly [head: RegExp, flag: RegExp]> = [
	[/^\s*find\b/, FIND_ACTIONS],
	// -o ends a cluster of value-less flags (-ro); in -to, o is -t's separator.
	[/^\s*sort\b/, /\s(-[bdfghiMnRrsVcCmuz]*o|--output\b|--compress-program\b)/],
	[/^\s*tree\b/, /\s-[a-zA-Z]*o/],
	[/^\s*rg\b/, /\s--(pre|hostname-bin)\b/],
	[/^\s*git\s/, /\s--output(=|\s|$)/],
	// -x/--exec runs a command per result, -X/--exec-batch once for all; it may end a cluster
	// of value-less flags (-Hx), while in -tx or -etsx the x is the value of -t or -e.
	[/^\s*fd\b/, /\s(-[HIusigFaLlpq0]*[xX](?=\s|$)|--exec(-batch)?(?==|\s|$))/],
	// --pager names the program bat runs when it pages.
	[/^\s*bat\b/, /\s--pager(?==|\s|$)/],
];

/** `segment` with its quoted spans removed, so a `>` or a flag inside a pattern reads as
 * text. Follows splitSegments: a backslash outside quotes escapes the next character,
 * and inside "..." and $'...' too, while '...' has no escapes. */
function withoutQuoted(segment: string): string {
	let bare = "";
	let quote: Quote | undefined;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote !== undefined) {
			if (ch === "\\" && quoteEscapes(quote)) i++;
			else if (ch === quoteCloser(quote)) quote = undefined;
			continue;
		}
		const opened = quoteOpensAt(segment, i);
		if (opened !== undefined) {
			quote = opened.quote;
			i += opened.length - 1;
		} else if (ch === "\\") {
			i++;
		} else {
			bare += ch;
		}
	}
	return bare;
}

function writesThroughRedirect(segment: string): boolean {
	const bare = withoutQuoted(segment).replace(DEV_NULL_REDIRECT, " ").replace(DESCRIPTOR_REDIRECT, " ");
	return REDIRECT_PATTERNS.some((pattern) => pattern.test(bare));
}

/** uniq [INPUT [OUTPUT]] writes its second operand. An option's value (-f N, -s N, -w N)
 * is not an operand. */
function uniqWrites(args: string[]): boolean {
	let operands = 0;
	for (let i = 0; i < args.length; i++) {
		if (["-f", "-s", "-w"].includes(args[i])) i++;
		else if (!args[i].startsWith("-")) operands++;
	}
	return operands >= 2;
}

const BRANCH_LISTS = /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
const BRANCH_WRITE_LONG_FLAGS = new Set([
	"--delete",
	"--move",
	"--copy",
	"--force",
	"--unset-upstream",
	"--set-upstream-to",
	"--edit-description",
	"--track",
	"--no-track",
	"--create-reflog",
]);

/** A `git branch` flag that changes a branch: -d -D -m -M -c -C -u -f -t, alone or in a
 * cluster, or the long form of one. */
function isBranchWriteFlag(arg: string): boolean {
	if (arg.startsWith("--")) return BRANCH_WRITE_LONG_FLAGS.has(arg.split("=")[0]);
	return arg.startsWith("-") && /[dDmMcCuft]/.test(arg);
}

/** `git branch` lists unless it is given a name to create or a flag that changes one. */
function gitBranchWrites(args: string[]): boolean {
	if (args.some(isBranchWriteFlag)) return true;
	return args.some((arg) => !arg.startsWith("-")) && !args.some((arg) => BRANCH_LISTS.test(arg));
}

/** `git remote` lists and shows; every other subcommand edits the configuration. */
function gitRemoteWrites(args: string[]): boolean {
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	return subcommand !== undefined && !["show", "get-url"].includes(subcommand);
}

/** Whether an allowlisted command carries a flag or operand that makes it write. */
function writesThroughOperands(segment: string): boolean {
	// Flags are read from the words the command receives: bash removes quotes first, so a
	// quoted '-delete' is the flag itself, while a flag-like run inside a quoted argument
	// ("x -delete") is not a word of its own.
	const words = shellWords(segment);
	// A flag is the start of a word: text inside a quoted value ("%h --output x") is not.
	const flagged = (flag: RegExp): boolean => words.some((word) => word.startsWith("-") && flag.exec(` ${word}`)?.index === 0);
	if (UNSAFE_FLAGS.some(([head, flag]) => head.test(segment) && flagged(flag))) return true;
	const [command = "", subcommand = "", ...rest] = words;
	if (command === "uniq") return uniqWrites([subcommand, ...rest].filter(Boolean));
	if (command !== "git") return false;
	if (subcommand === "branch") return gitBranchWrites(rest);
	return subcommand === "remote" && gitRemoteWrites(rest);
}

function isSafeSegment(segment: string): boolean {
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment))) return false;
	if (writesThroughRedirect(segment)) return false;
	if (!SAFE_PATTERNS.some((pattern) => pattern.test(segment))) return false;
	return !writesThroughOperands(segment);
}

/**
 * Whether plan mode should let this bash command run.
 *
 * Model steering, not a sandbox: an allowlisted interpreter can still read and write
 * whatever the user can, so this narrows the blast radius of a wrong turn rather than
 * containing a determined one. Only OS-level isolation would be a boundary.
 */
export function isSafeCommand(command: string): boolean {
	// Claude Code always asks about a command longer than its analysis parses.
	if (command.length > MAX_ANALYZED_CHARS) return false;
	if (hasSubstitution(command) || hasAnsiCNumericEscape(command)) return false;
	const segments = splitSegments(command);
	return segments.length > 0 && segments.every(isSafeSegment);
}
