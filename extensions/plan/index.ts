/**
 * Plan mode, as in Claude Code (https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode):
 * the model researches and proposes a plan without changing anything, and edits wait until you
 * approve the plan.
 *
 * - `/plan` turns plan mode on; `/plan <task>` turns it on and starts that task. ctrl+alt+p turns
 *   it on or off (Claude uses Shift+Tab, which is pi's thinking-level key and closed to extensions).
 *   `pi --plan` starts a session in plan mode, and so does `"defaultMode": "plan"` under `permissions`
 *   in Claude's settings for an interactive one. The footer shows `⏸ plan mode on`.
 * - While planning, the model sees only read-only tools. Edits and writes are blocked. Claude's
 *   built-in read-only shell commands run; any other command, or a tool outside the read-only set,
 *   asks you first, and is blocked when there's no one to ask (`pi -p`).
 * - The model presents its plan with `exit_plan_mode`, and you choose: start, edit the plan first
 *   (Claude's ctrl+g), or keep planning and say what to change. Approving turns plan mode off and
 *   the model starts on the plan in the same turn, and names the session after the plan unless it
 *   already has a name.
 *
 * Based on pi-code's plan-mode extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md), itself
 * from pi's plan-mode example by Mario Zechner. Changed to follow Claude: approval happens in the
 * tool call the way Claude's ExitPlanMode asks, a command outside the read-only set asks instead of
 * failing, and the `[DONE:n]` step tracking and plan parsing are gone (the model keeps its todo list
 * with the todo tool, as Claude does). The instructions ride in a system prompt section rather than
 * a hidden message per prompt.
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Key, Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isRecord, readClaudeSetup } from "../shared/claude.ts";
import { isSafeCommand } from "./bash.ts";

export const EXIT_TOOL = "exit_plan_mode";

/** Tools the model keeps while planning. Each one only reads, asks you something, or keeps the
 * model's todo list; bash is further limited to read-only commands. A name pi doesn't have is skipped. */
export const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "web_search", "web_fetch", "todo", "ask_user_question", "questionnaire", "question", EXIT_TOOL];

/** Tools that change files: blocked outright while planning, as in Claude. */
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "notebook_edit"]);

/** The session entry plan mode's state persists under. pi-code used the same name, so a session
 * started there resumes here. */
const STATE_ENTRY = "plan-mode";

/** pi-code's hooks report Claude's `permission_mode` from this event, so they keep working. */
export const PLAN_MODE_CHANNEL = "pi-code:plan-mode";

/** The system prompt section that carries the plan mode instructions. */
const SECTION = "plan_mode";

export const PLAN_PROMPT = `Plan mode is on: the user wants you to research and propose a plan before anything changes.
- Explore with read-only tools: read files, search, and run read-only shell commands. Don't edit or write files, and don't run commands that change anything. Edits are blocked, and the user is asked before any shell command outside a read-only set runs.
- If something important is unclear, ask the user (with ask_user_question when it's available).
- When the plan is ready, call ${EXIT_TOOL} with the whole plan in Markdown: what you'll change, in which files, in what order, and how you'll verify it. The user approves it or asks for changes. Approval turns plan mode off, so start implementing as soon as ${EXIT_TOOL} says the plan is approved.
- If the user only asked a question, answer it without calling ${EXIT_TOOL}.`;

const APPROVE = "Yes, start";
const EDIT_FIRST = "Yes, after I edit the plan";
const KEEP_PLANNING = "No, keep planning";

interface PlanState {
	enabled?: boolean;
	savedTools?: string[];
}

/** A persisted plan-mode entry, keeping only fields of the expected shape: the session file is data
 * on disk, and `savedTools` feeds the active tool set. */
export function restoredPlanState(data: unknown): PlanState {
	if (!isRecord(data)) return {};
	const state: PlanState = {};
	if (typeof data.enabled === "boolean") state.enabled = data.enabled;
	if (Array.isArray(data.savedTools) && data.savedTools.every((tool) => typeof tool === "string")) state.savedTools = data.savedTools;
	return state;
}

/** Claude's starting permission mode: `permissions.defaultMode` from the highest-precedence settings file. */
export function defaultMode(settings: Record<string, unknown>[]): string | undefined {
	let mode: string | undefined;
	for (const file of settings) {
		const permissions = file.permissions;
		if (isRecord(permissions) && typeof permissions.defaultMode === "string") mode = permissions.defaultMode;
	}
	return mode;
}

/** A session name from a plan: its first line, without Markdown marks, cut to 60 characters. */
export function planTitle(plan: string): string | undefined {
	const line = plan
		.split("\n")
		.map((text) =>
			text
				.replace(/^\s*(?:#+|[-*+]|\d+[.)])\s*/, "")
				.replace(/[*_`]/g, "")
				.trim(),
		)
		.find(Boolean);
	if (!line) return undefined;
	const title = line.replace(/^plan:\s*/i, "").replace(/[.:]$/, "");
	return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

export default function planExtension(pi: ExtensionAPI): void {
	let planning = false;
	let savedTools: string[] = [];
	/** Every tool registered when the set was saved, active or not: a tool outside it was registered
	 * later (an MCP server that connected late) and stays active when the set is restored. */
	let toolsAtSave = new Set<string>();

	const registeredTools = () => new Set(pi.getAllTools().map((tool) => tool.name));

	function restrictTools(): void {
		toolsAtSave = registeredTools();
		pi.setActiveTools(PLAN_TOOLS.filter((name) => name === EXIT_TOOL || savedTools.includes(name)));
	}

	function restoreTools(): void {
		if (savedTools.length === 0) return;
		const late = pi.getActiveTools().filter((name) => !toolsAtSave.has(name) && !savedTools.includes(name) && name !== EXIT_TOOL);
		pi.setActiveTools([...savedTools.filter((name) => name !== EXIT_TOOL), ...late]);
	}

	function persist(): void {
		// The tool set from before plan mode has to survive with the state that shrank it: a /reload
		// rebuilds this extension while pi keeps the restricted set.
		pi.appendEntry(STATE_ENTRY, { enabled: planning, savedTools } satisfies PlanState);
	}

	function showStatus(ctx: ExtensionContext): void {
		// Print mode has no footer, and no theme to color one with.
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("plan-mode", planning ? ctx.ui.theme.fg("warning", "⏸ plan mode on") : undefined);
	}

	function setPlanning(ctx: ExtensionContext, on: boolean): void {
		if (on === planning) return;
		planning = on;
		if (on) {
			savedTools = pi.getActiveTools();
			restrictTools();
		} else restoreTools();
		persist();
		pi.events.emit(PLAN_MODE_CHANNEL, { active: planning });
		showStatus(ctx);
	}

	pi.registerFlag("plan", { description: "Start in plan mode (read-only exploration)", type: "boolean", default: false });

	pi.registerCommand("plan", {
		description: "Enter plan mode; a description starts that task in plan mode",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!planning) {
				setPlanning(ctx, true);
				ctx.ui.notify("Plan mode on: the model explores and proposes a plan before it edits anything. ctrl+alt+p leaves it.", "info");
			} else if (!task) ctx.ui.notify("Already in plan mode.", "info");
			if (task) pi.sendUserMessage(task, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Turn plan mode on or off",
		handler: async (ctx) => {
			setPlanning(ctx, !planning);
			ctx.ui.notify(planning ? "Plan mode on." : "Plan mode off.", "info");
		},
	});

	pi.registerTool({
		name: EXIT_TOOL,
		label: "Exit plan mode",
		description:
			"Present your finished plan to the user for approval while in plan mode. Pass the whole plan in Markdown. If the user approves, plan mode ends and you start implementing; otherwise you get their feedback and keep planning. Only call it in plan mode, when the plan is ready.",
		parameters: Type.Object({ plan: Type.String({ description: "The plan, in Markdown" }) }),
		// Offered to the model only while planning.
		defaultActive: false,
		renderCall(args, theme) {
			const plan = typeof args?.plan === "string" ? args.plan.trim() : "";
			const head = theme.fg("toolTitle", theme.bold("Plan"));
			const body = new Markdown(plan || "…", 0, 0, getMarkdownTheme());
			return { invalidate: () => body.invalidate(), render: (width: number) => [head, ...body.render(width)] };
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!planning) return { content: text("Plan mode is off; there is nothing to approve. Go ahead with the work."), details: {} };
			const plan = params.plan.trim();
			if (!ctx.hasUI) {
				return { content: text("There is no one to approve the plan in this session, so plan mode stays on. End your turn with the plan."), details: {}, terminate: true };
			}
			const choice = await ctx.ui.select("Would you like to proceed?", [APPROVE, EDIT_FIRST, KEEP_PLANNING], { signal });
			let approved: string | undefined;
			if (choice === APPROVE) approved = plan;
			else if (choice === EDIT_FIRST) approved = (await ctx.ui.editor("Edit the plan, then save to approve it", plan))?.trim() || undefined;
			if (approved !== undefined) {
				setPlanning(ctx, false);
				const title = planTitle(approved);
				if (title && !pi.getSessionName()) pi.setSessionName(title);
				const edited = approved === plan ? "" : " The user edited it before approving; follow this version.";
				return {
					content: text(`The user approved the plan.${edited} Plan mode is off and every tool is available again: start implementing it now.\n\nApproved plan:\n${approved}`),
					details: { approved: true },
				};
			}
			if (choice === KEEP_PLANNING) {
				const feedback = (await ctx.ui.editor("What should change in the plan?", ""))?.trim();
				if (feedback)
					return {
						content: text(`The user wants changes before approving:\n${feedback}\n\nStay in plan mode, revise the plan, and call ${EXIT_TOOL} again.`),
						details: { approved: false },
					};
			}
			return { content: text("The user didn't approve the plan. Stay in plan mode and wait for their next message."), details: { approved: false }, terminate: true };
		},
	});

	/** Ask before a call outside the read-only set; without a UI there's no one to ask, so it's blocked. */
	async function ask(ctx: ExtensionContext, title: string, detail: string): Promise<ToolCallEventResult | undefined> {
		if (!ctx.hasUI) return { block: true, reason: `Plan mode: only read-only tools and commands run while planning, and there is no one to approve this one.\n${detail}` };
		const allowed = await ctx.ui.confirm(title, detail, { signal: ctx.signal });
		return allowed
			? undefined
			: { block: true, reason: "Plan mode: the user declined this while planning. Stick to read-only tools and commands, or make the step part of the plan." };
	}

	// Checked at call time too, not only through the active tool set: pi activates a tool registered
	// after the restriction (an MCP server connecting late), so the set alone can let one through.
	pi.on("tool_call", async (event, ctx) => {
		if (!planning || event.toolName === EXIT_TOOL) return undefined;
		if (WRITE_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Plan mode: ${event.toolName} is blocked until the user approves a plan. Present the plan with ${EXIT_TOOL}.` };
		}
		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			return isSafeCommand(command) ? undefined : ask(ctx, "Plan mode: run this command?", command);
		}
		if (PLAN_TOOLS.includes(event.toolName)) return undefined;
		return ask(ctx, `Plan mode: use ${event.toolName}?`, JSON.stringify(event.input).slice(0, 500));
	});

	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (planning) options.sections = { ...options.sections, [SECTION]: PLAN_PROMPT };
		else if (options.sections) delete options.sections[SECTION];
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// RPC mode can reuse one instance across sessions, so nothing carries over, and a set the
		// previous session restricted is put back below.
		const previous = planning ? savedTools : undefined;
		planning = false;
		savedTools = [];
		// The current branch only: after a rewind past a plan, the abandoned state must not come back.
		const branch = ctx.sessionManager.getBranch();
		let entry: { data?: unknown } | undefined;
		for (let i = branch.length - 1; i >= 0 && !entry; i--) {
			const candidate = branch[i];
			if (candidate.type === "custom" && candidate.customType === STATE_ENTRY) entry = candidate;
		}
		const restored = restoredPlanState(entry?.data);
		const startsPlanning = () => {
			if (pi.getFlag("plan") === true) return true;
			if (!ctx.hasUI) return false;
			return defaultMode(readClaudeSetup({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }).settings) === "plan";
		};
		planning = entry ? restored.enabled === true : startsPlanning();
		if (planning) {
			// Restoring into plan mode is the one case the recorded set is for: the active set may be
			// the restriction pi carried across a /reload.
			savedTools = restored.savedTools ?? pi.getActiveTools();
			restrictTools();
			if (!entry) persist();
		} else if (previous) {
			savedTools = previous;
			restoreTools();
			savedTools = [];
		}
		pi.events.emit(PLAN_MODE_CHANNEL, { active: planning });
		showStatus(ctx);
	});
}
