/**
 * Rewind: Claude Code's checkpoints and `/rewind` (https://code.claude.com/docs/en/checkpointing.md).
 *
 * Before each prompt, the files pi's edit and write tools have touched in this session are saved as a
 * checkpoint. `/rewind` (or `/undo`) lists the prompts of the conversation; for the one you pick it
 * restores the code and the conversation, the conversation only, or the code only, or summarizes the
 * conversation from there on. Files created after the checkpoint are removed, edited and deleted ones
 * are put back. The conversation side is pi's own tree navigation, the same as `/tree`, so the prompt
 * comes back into the editor. Picking a prompt in `/tree` (or with Esc Esc) or `/fork` offers to
 * restore the code as well.
 *
 * Only files inside the project's git repository are tracked, never what its git ignores, and a
 * restore skips symlinks and hard-linked files, as Claude does. Outside a git repository there are no
 * checkpoints. Each code restore first saves the files it changes, so the next `/rewind` can undo it.
 * Checkpoints are kept for `cleanupPeriodDays` (30 by default); `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1`
 * turns them off.
 *
 * Based on pi-code's git-checkpoint extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md):
 * its run and turn bookkeeping, prompt labels and retention are kept. Changed: one shadow repository
 * per project instead of per session (forks and resumes share it), files created after a checkpoint
 * are removed on restore instead of left in place, restores are written file by file with link checks instead
 * of a git checkout, Claude's menu and its "Summarize from here", the `/tree` offer, and an undo
 * point before each code restore.
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readClaudeSetup } from "../shared/claude.ts";
import { type Plan, type Snapshot, Store, projectPath, pruneStores } from "./store.ts";

const ENTRY_TYPE = "pi-homeport-rewind";
/** pi's tools that change a file. Like Claude, shell commands aren't tracked. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
/** Claude keeps the 100 most recent checkpoints of a session. */
export const MAX_CHECKPOINTS = 100;
/** Claude's default `cleanupPeriodDays`. */
export const RETENTION_DAYS = 30;
const PROMPT_LENGTH = 60;

const CODE_AND_CONVERSATION = "Restore code and conversation";
const CONVERSATION = "Restore conversation";
const CODE = "Restore code";
const SUMMARIZE = "Summarize from here";
const NEVER_MIND = "Never mind";
const KEEP_CODE = "Keep the current code";
const RESTORE_CODE = "Restore the code to before this prompt";

/** A checkpoint: the files as they were right before the user message `entryId` ran. */
export interface Checkpoint {
	entryId: string;
	ref: string;
	prompt: string;
	createdAt: string;
}

/** The files a code restore changed, as they were right before it. */
interface UndoPoint {
	undo: true;
	ref: string;
	createdAt: string;
}

type Entry = Checkpoint | UndoPoint;

/** `cleanupPeriodDays` from Claude's settings, when it's a positive number. */
export function retentionDays(settings: Record<string, unknown>[]): number {
	let days = RETENTION_DAYS;
	for (const file of settings) {
		const value = file.cleanupPeriodDays;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) days = value;
	}
	return days;
}

/** The path an edit or write call names, read the way pi's tools read it: a leading @ dropped, ~
 * expanded, a file:// URL decoded, unicode spaces folded. From pi-code's tool-target helper. */
export function toolTarget(input: unknown): string | undefined {
	const value = (input as { path?: unknown; file_path?: unknown } | undefined) ?? {};
	const raw = typeof value.path === "string" ? value.path : value.file_path;
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	const folded = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	const bare = folded.startsWith("@") ? folded.slice(1) : folded;
	if (bare === "~") return os.homedir();
	if (bare.startsWith("~/")) return path.join(os.homedir(), bare.slice(2));
	if (!bare.startsWith("file://")) return bare;
	try {
		return fileURLToPath(bare);
	} catch {
		return bare;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join(" ");
}

export function promptSnippet(content: unknown): string {
	const text = textOf(content).replace(/\s+/g, " ").trim();
	return text.length <= PROMPT_LENGTH ? text : `${text.slice(0, PROMPT_LENGTH)}…`;
}

/** A checkpoint's files: its own snapshot, plus, for each file first touched later, its state before
 * that first edit, which is also its state at this checkpoint. */
export function resolveTarget(at: Snapshot, later: Snapshot[]): Snapshot {
	const target = new Map(at);
	for (const snapshot of later) for (const [rel, state] of snapshot) if (!target.has(rel)) target.set(rel, state);
	return target;
}

export function describePlan(plan: Plan): string {
	const parts: string[] = [];
	if (plan.writes.length > 0) parts.push(`${plan.writes.length} file${plan.writes.length === 1 ? "" : "s"} to put back`);
	if (plan.deletes.length > 0) parts.push(`${plan.deletes.length} new file${plan.deletes.length === 1 ? "" : "s"} to remove`);
	if (plan.skipped.length > 0) parts.push(`${plan.skipped.length} skipped`);
	return parts.join(", ");
}

function changes(plan: Plan | undefined): number {
	return plan ? plan.writes.length + plan.deletes.length : 0;
}

function time(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function rewindExtension(pi: ExtensionAPI) {
	let store: Store | undefined;
	let unavailable = "Rewind isn't ready yet.";
	/** Project-relative paths the edit tools touched in this session. */
	const tracked = new Set<string>();
	/** Ignored files, and files whose state before their first edit couldn't be saved. */
	const untrackable = new Set<string>();
	let pending: { ref: string; createdAt: string } | undefined;
	// One snapshot per run (one prompt), however many turns it takes: agent_start arms it, the first
	// turn_start takes it, turn_end records it against the prompt's user message.
	let runNeedsSnapshot = true;
	/** Whether the run about to start came from a prompt, not a retry or a queued follow-up. */
	let promptedRun = false;
	/** The checkpoint of the run in flight, which first edits are folded into. */
	let runRef: string | undefined;
	/** Set while /rewind moves the conversation, so the /tree hook doesn't ask about the code again. */
	let navigating = false;
	let treeRestore: Checkpoint | undefined;
	// Store changes run one at a time: two first edits in parallel tool calls would otherwise each
	// fold into the same checkpoint and one would be lost.
	let queue: Promise<unknown> = Promise.resolve();
	function serial<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task, task);
		queue = next.catch(() => undefined);
		return next;
	}

	function entries(ctx: ExtensionContext): { checkpoints: Checkpoint[]; undo?: UndoPoint } {
		const checkpoints: Checkpoint[] = [];
		let undo: UndoPoint | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Entry | undefined;
			if (!data?.ref) continue;
			if ("undo" in data) undo = data;
			else if (data.entryId) checkpoints.push(data);
		}
		return { checkpoints, undo };
	}

	function lastUserMessage(ctx: ExtensionContext): { entryId: string; prompt: string } | undefined {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message.role === "user") return { entryId: entry.id, prompt: promptSnippet(entry.message.content) };
		}
		return undefined;
	}

	function checkpointFor(ctx: ExtensionContext, entryId: string): Checkpoint | undefined {
		const recent = entries(ctx).checkpoints.slice(-MAX_CHECKPOINTS);
		return recent.find((checkpoint) => checkpoint.entryId === entryId);
	}

	/** What restoring the code to `checkpoint` would change, or undefined when its snapshot is gone. */
	async function planFor(ctx: ExtensionContext, checkpoint: Checkpoint): Promise<Plan | undefined> {
		if (!store) return undefined;
		const all = entries(ctx).checkpoints;
		const at = await store.load(checkpoint.ref);
		if (!at) return undefined;
		const later: Snapshot[] = [];
		for (const next of all.slice(all.indexOf(checkpoint) + 1)) {
			const snapshot = await store.load(next.ref);
			if (snapshot) later.push(snapshot);
		}
		return store.plan(resolveTarget(at, later));
	}

	/** Restore files, saving their current state first so the next /rewind can undo it. */
	async function restoreCode(ctx: ExtensionContext, plan: Plan): Promise<boolean> {
		if (!store) return false;
		const current = store;
		return serial(async () => {
			const createdAt = new Date().toISOString();
			const undoRef = await current.checkpoint([...plan.writes.map((write) => write.rel), ...plan.deletes], "before-rewind");
			if (!undoRef) {
				ctx.ui.notify("Couldn't save the current files before restoring them, so nothing was changed.", "error");
				return false;
			}
			const applied = await current.apply(plan);
			pi.appendEntry<UndoPoint>(ENTRY_TYPE, { undo: true, ref: undoRef, createdAt });
			const done = applied.written + applied.deleted;
			const left = [...applied.skipped, ...applied.failed];
			const list = left.slice(0, 5).join(", ") + (left.length > 5 ? ", …" : "");
			if (done === 0 && applied.failed.length > 0) {
				ctx.ui.notify(`No files were restored: ${applied.failed.length} failed (${list}).`, "error");
				return false;
			}
			if (left.length > 0)
				ctx.ui.notify(`Restored the code, but skipped ${left.length} file${left.length === 1 ? "" : "s"}: ${list}. They keep their current contents.`, "warning");
			else ctx.ui.notify(`Restored ${done} file${done === 1 ? "" : "s"}.`, "info");
			return true;
		});
	}

	/** Move the conversation to before the prompt, as /tree does: the prompt comes back into the editor. */
	async function restoreConversation(ctx: ExtensionCommandContext, entryId: string, summarize: boolean): Promise<boolean> {
		navigating = true;
		try {
			const result = await ctx.navigateTree(entryId, { summarize });
			return !result.cancelled;
		} catch (error) {
			ctx.ui.notify(`Couldn't restore the conversation: ${errorText(error)}`, "error");
			return false;
		} finally {
			navigating = false;
		}
	}

	async function rewind(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (!store) {
			ctx.ui.notify(unavailable, "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current response to finish, then run /rewind again.", "warning");
			return;
		}
		const { checkpoints, undo } = entries(ctx);
		const recent = new Map(checkpoints.slice(-MAX_CHECKPOINTS).map((checkpoint) => [checkpoint.entryId, checkpoint]));
		const prompts: { entryId: string; prompt: string; checkpoint?: Checkpoint }[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user")
				prompts.unshift({ entryId: entry.id, prompt: promptSnippet(entry.message.content), checkpoint: recent.get(entry.id) });
		}
		if (prompts.length === 0 && !undo) {
			ctx.ui.notify("Nothing to rewind yet.", "info");
			return;
		}
		const undoLabel = undo ? `↶ Undo the code restore at ${time(undo.createdAt)}` : undefined;
		const labels = prompts.map(
			(item, i) => `${i + 1}. ${item.checkpoint ? `${time(item.checkpoint.createdAt)}  ` : ""}${item.prompt || "(empty prompt)"}${item.checkpoint ? "" : "  (no code restore)"}`,
		);
		for (;;) {
			const choice = await ctx.ui.select("Rewind to before which prompt?", undoLabel ? [undoLabel, ...labels] : labels);
			if (!choice) return;
			if (choice === undoLabel && undo) {
				const snapshot = await store.load(undo.ref);
				const plan = snapshot ? await store.plan(snapshot) : undefined;
				if (!plan || changes(plan) === 0) {
					ctx.ui.notify(plan ? "Nothing to undo: the files already match." : "That restore can't be undone any more.", "info");
					continue;
				}
				const action = await ctx.ui.select(`Undo the code restore at ${time(undo.createdAt)} · ${describePlan(plan)}`, [CODE, NEVER_MIND]);
				if (action === CODE) {
					await restoreCode(ctx, plan);
					return;
				}
				continue;
			}
			const item = prompts[labels.indexOf(choice)];
			if (!item) return;
			const plan = item.checkpoint ? await planFor(ctx, item.checkpoint) : undefined;
			const hasCode = changes(plan) > 0;
			const note = hasCode && plan ? describePlan(plan) : item.checkpoint ? (plan ? "no file changes to restore" : "its file snapshots are gone") : "no code restore";
			const actions = hasCode ? [CODE_AND_CONVERSATION, CONVERSATION, CODE, SUMMARIZE, NEVER_MIND] : [CONVERSATION, SUMMARIZE, NEVER_MIND];
			const action = await ctx.ui.select(`${item.prompt || "(empty prompt)"} · ${note}`, actions);
			if (!action || action === NEVER_MIND) continue;
			// The conversation moves first: it's the step that can be refused (a model missing for the
			// summary, a cancelled summary), and then the files stay as they are.
			if (action !== CODE && !(await restoreConversation(ctx, item.entryId, action === SUMMARIZE))) return;
			if ((action === CODE || action === CODE_AND_CONVERSATION) && plan) await restoreCode(ctx, plan);
			return;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		store = undefined;
		tracked.clear();
		untrackable.clear();
		pending = undefined;
		runNeedsSnapshot = true;
		promptedRun = false;
		runRef = undefined;
		treeRestore = undefined;
		if (process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING === "1") {
			unavailable = "Checkpoints are off (CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1). Use /tree to go back in the conversation.";
			return;
		}
		const storesDir = path.join(getAgentDir(), "pi-homeport", "checkpoints");
		try {
			store = await Store.open(ctx.cwd, storesDir);
		} catch (error) {
			unavailable = `Checkpoints are off: ${errorText(error)}`;
			if (ctx.hasUI) ctx.ui.notify(unavailable, "warning");
			return;
		}
		if (!store) {
			unavailable = "Rewind needs a git repository, and this project isn't in one. Use /tree to go back in the conversation.";
			return;
		}
		const days = retentionDays(readClaudeSetup({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }).settings);
		pruneStores(storesDir, days, store.gitDir);
		const current = store;
		void serial(() => current.prune(days)).catch(() => undefined);
		const last = entries(ctx).checkpoints.at(-1);
		const snapshot = last ? await store.load(last.ref) : undefined;
		for (const rel of snapshot?.keys() ?? []) tracked.add(rel);
	});

	// agent_start begins a run, including a retry or a queued follow-up through agent.continue().
	pi.on("agent_start", () => {
		runNeedsSnapshot = true;
	});

	// Only a prompt fires before_agent_start.
	pi.on("before_agent_start", () => {
		promptedRun = true;
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!runNeedsSnapshot || !store) return;
		runNeedsSnapshot = false;
		const prompted = promptedRun;
		promptedRun = false;
		// A run that continued without a new prompt keeps the checkpoint its prompt already has, unless
		// a queued message is about to arrive, which needs its own.
		if (!prompted && !ctx.hasPendingMessages()) {
			const target = lastUserMessage(ctx);
			const recorded = target && entries(ctx).checkpoints.find((checkpoint) => checkpoint.entryId === target.entryId);
			if (recorded) {
				runRef = recorded.ref;
				return;
			}
		}
		const current = store;
		const createdAt = new Date().toISOString();
		const ref = await serial(() => current.checkpoint([...tracked])).catch(() => undefined);
		pending = ref ? { ref, createdAt } : undefined;
		runRef = ref;
	});

	// A file joins the checkpoints on its first edit. Its content right before that edit is its
	// state at the run's checkpoint, so it's folded into it before the tool writes.
	pi.on("tool_call", async (event, ctx) => {
		if (!store || !EDIT_TOOLS.has(event.toolName)) return;
		const target = toolTarget(event.input);
		if (!target) return;
		const current = store;
		const rel = projectPath(current.root, path.resolve(ctx.cwd, target));
		if (!rel || tracked.has(rel) || untrackable.has(rel)) return;
		// Without its state before this edit, a later checkpoint would pass the edited content off as
		// the original, so a file whose first state can't be saved is never tracked in this session.
		untrackable.add(rel);
		try {
			const ref = runRef;
			if (!ref || (await current.ignored([rel])).has(rel)) return;
			if (!(await serial(() => current.extend(ref, rel)))) return;
			untrackable.delete(rel);
			tracked.add(rel);
		} catch {
			// A checkpoint must never stop an edit.
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		const snap = pending;
		pending = undefined;
		if (!snap || !store) return;
		const target = lastUserMessage(ctx);
		if (!target) return;
		const recorded = entries(ctx).checkpoints.find((checkpoint) => checkpoint.entryId === target.entryId);
		if (recorded) {
			// A retry took a fresh snapshot for a prompt that already has a checkpoint. Keep the recorded
			// one, with the first edits this turn folded into the fresh one carried over.
			const current = store;
			await serial(async () => {
				const extra = await current.load(snap.ref);
				const base = await current.load(recorded.ref);
				if (!extra || !base) return;
				let added = false;
				for (const [rel, state] of extra) {
					if (base.has(rel)) continue;
					base.set(rel, state);
					added = true;
				}
				if (added) await current.save(base, "checkpoint", recorded.ref);
			}).catch(() => undefined);
			runRef = recorded.ref;
			return;
		}
		pi.appendEntry<Checkpoint>(ENTRY_TYPE, { entryId: target.entryId, ref: snap.ref, prompt: target.prompt, createdAt: snap.createdAt });
	});

	// /tree and Esc Esc: picking a prompt with file changes since offers to restore the code too.
	// The answer is acted on in session_tree, once the move has happened.
	pi.on("session_before_tree", async (event, ctx) => {
		treeRestore = undefined;
		if (navigating || !store || !ctx.hasUI) return;
		const checkpoint = checkpointFor(ctx, event.preparation.targetId);
		if (!checkpoint) return;
		const plan = await planFor(ctx, checkpoint);
		if (!plan || changes(plan) === 0) return;
		const choice = await ctx.ui.select(`Restore the code too? ${describePlan(plan)}`, [KEEP_CODE, RESTORE_CODE]);
		if (choice === RESTORE_CODE) treeRestore = checkpoint;
	});

	pi.on("session_tree", async (_event, ctx) => {
		const checkpoint = treeRestore;
		treeRestore = undefined;
		if (!checkpoint) return;
		const plan = await planFor(ctx, checkpoint);
		if (plan && changes(plan) > 0) await restoreCode(ctx, plan);
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (event.position !== "before" || !store || !ctx.hasUI) return;
		const checkpoint = checkpointFor(ctx, event.entryId);
		if (!checkpoint) return;
		const plan = await planFor(ctx, checkpoint);
		if (!plan || changes(plan) === 0) return;
		const choice = await ctx.ui.select(`Restore the code too? ${describePlan(plan)}`, [KEEP_CODE, RESTORE_CODE]);
		if (choice === RESTORE_CODE) await restoreCode(ctx, plan);
	});

	for (const name of ["rewind", "undo"]) {
		pi.registerCommand(name, {
			description: name === "rewind" ? "Restore the code and/or conversation to before an earlier prompt" : "Alias of /rewind",
			handler: async (_args, ctx) => rewind(ctx),
		});
	}
}
