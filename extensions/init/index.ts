/**
 * Init: `/init` has the model study the project and write a CLAUDE.md for it, as Claude Code's `/init`
 * does (https://code.claude.com/docs/en/memory.md): the build and test commands, the architecture
 * and the conventions it finds. When the folder already has a CLAUDE.md, the model improves it
 * instead of replacing it. Cursor rules and Copilot instructions are folded in, as Claude's `/init`
 * does. A folder that relies on AGENTS.md keeps it: the new CLAUDE.md imports it with `@AGENTS.md`,
 * since Claude reads AGENTS.md only where there's no CLAUDE.md.
 *
 * The command doesn't analyze anything itself: it hands the model one prompt, and the model explores
 * the project and writes the file with its tools, in the conversation, as Claude's does. Claude's
 * interactive flow (`CLAUDE_CODE_NEW_INIT=1`) and its offer to import Codex or Gemini CLI settings
 * aren't here.
 *
 * Based on pi-code's init extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), which wrote
 * AGENTS.md, the file pi prefers, at the repository root.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How long the command waits for the turn it asked for to start. */
const START_TIMEOUT_MS = 10_000;

export interface ProjectFiles {
	/** The folder's CLAUDE.md (`CLAUDE.md` or `.claude/CLAUDE.md`), relative to it, when it has one. */
	claudeMd?: string;
	/** Whether the folder has an AGENTS.md. */
	agentsMd: boolean;
	/** Whether it has Cursor rules: `.cursor/rules/` or `.cursorrules`. */
	cursorRules: boolean;
	/** Whether it has `.github/copilot-instructions.md`. */
	copilotInstructions: boolean;
}

function stat(file: string): fs.Stats | undefined {
	try {
		return fs.statSync(file);
	} catch {
		return undefined;
	}
}

/** The instruction files `/init` looks at in a folder. */
export function projectFiles(dir: string): ProjectFiles {
	const isFile = (...parts: string[]) => stat(path.join(dir, ...parts))?.isFile() === true;
	const claudeMd = [["CLAUDE.md"], [".claude", "CLAUDE.md"]].find((parts) => isFile(...parts));
	return {
		...(claudeMd ? { claudeMd: path.join(...claudeMd) } : {}),
		agentsMd: isFile("AGENTS.md") || isFile(".claude", "AGENTS.md"),
		cursorRules: stat(path.join(dir, ".cursor", "rules"))?.isDirectory() === true || isFile(".cursorrules"),
		copilotInstructions: isFile(".github", "copilot-instructions.md"),
	};
}

/** The prompt `/init` sends for a folder. */
export function initPrompt(dir: string, files: ProjectFiles): string {
	const parts = [
		files.claudeMd
			? `Please analyze this codebase and improve its CLAUDE.md, ${path.join(dir, files.claudeMd)}, which future coding sessions in this repository read first.`
			: `Please analyze this codebase and create a CLAUDE.md file at ${path.join(dir, "CLAUDE.md")}. Future coding sessions in this repository read it first.`,
		[
			"It should hold what they need to work here:",
			"- Commands to build, lint and test, including how to run a single test.",
			"- The big-picture architecture: how the parts fit together, the things that take reading several files to see.",
			"- Conventions the code follows that a newcomer wouldn't guess, such as naming, formatting, error handling and where things go.",
		].join("\n"),
		"Leave out generic advice, anything obvious from a glance at the code, and lists of every file. Don't invent sections or details the code doesn't back up. Keep it under 200 lines.",
	];
	if (files.claudeMd) {
		parts.push(
			"The file already exists, so suggest improvements rather than rewriting it: read it, then fix what's outdated and add what's missing with targeted edits that keep its structure and voice, and summarize what you changed.",
		);
	} else if (files.agentsMd) {
		parts.push(
			"This project has an AGENTS.md, which Claude Code reads only where there's no CLAUDE.md. Start CLAUDE.md with an `@AGENTS.md` line, so AGENTS.md keeps loading through it, and write only what AGENTS.md doesn't already cover.",
		);
	}
	if (files.cursorRules) parts.push("Cursor rules are in .cursor/rules/ or .cursorrules. Read them and fold in the parts that still apply.");
	if (files.copilotInstructions) parts.push("Copilot instructions are in .github/copilot-instructions.md. Read them and fold in the parts that still apply.");
	return parts.join("\n\n");
}

export default function initExtension(pi: ExtensionAPI) {
	/** Commands waiting for the turn they asked for to start. */
	const startWaiters: (() => void)[] = [];

	pi.on("agent_start", async () => {
		for (const resolve of startWaiters.splice(0)) resolve();
	});

	pi.registerCommand("init", {
		description: "Have the model study the project and write its CLAUDE.md, or improve the one it has",
		handler: async (_args, ctx) => {
			const prompt = initPrompt(ctx.cwd, projectFiles(ctx.cwd));
			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				return;
			}
			// pi starts the turn without waiting for it; stay until it has started and ended, so a
			// print run (`pi -p /init`) doesn't exit before the file is written.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const started = new Promise<void>((resolve) => {
				startWaiters.push(resolve);
				timer = setTimeout(resolve, START_TIMEOUT_MS);
			});
			pi.sendUserMessage(prompt);
			await started;
			clearTimeout(timer);
			await ctx.waitForIdle();
		},
	});
}
