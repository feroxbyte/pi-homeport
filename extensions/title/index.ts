/**
 * Title: names a session from its first prompt, as Claude Code titles a session you don't name
 * (https://code.claude.com/docs/en/sessions.md#name-your-sessions). When the first prompt starts, a
 * request in the background asks the model for a short summary of it, and pi shows that as the
 * session's name in `/resume` and in the terminal's title.
 *
 * As in Claude Code, a name you set (`--name`, `/name`) wins and is never replaced, a print or JSON
 * run (`pi -p`) gets no title, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` turns titles off. Claude
 * writes the title with its small, fast model, the one `ANTHROPIC_DEFAULT_HAIKU_MODEL` names; that
 * model writes it here too when pi can use it, and the session's model otherwise, thinking as little
 * as the model allows. Subagent sessions (`PI_SUBAGENT_CHILD=1`) get none.
 *
 * Based on pi-code's session-title extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md),
 * which asked for the title after the first run ended.
 */

import { type Api, type AssistantMessage, type Context, getSupportedThinkingLevels, type Model, type ModelsSimpleStreamOptions, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE_SYSTEM =
	"You name a coding session from its first user message. Reply with a terse 3 to 6 word title in Title Case that captures the task. No quotes, no surrounding punctuation, no trailing period. Output the title only, nothing else.";
/** Room for a model that always thinks to think a little before the few words of the title. */
const TITLE_MAX_TOKENS = 1024;
/** Only the opening of a long first message is needed to name the session. */
const MAX_PROMPT_CHARS = 1000;
/** Claude Code's limit for a session name. */
const MAX_TITLE_CHARS = 200;
const TITLE_TIMEOUT_MS = 60_000;

/** pi's skill block, which a typed skill sends ahead of what you typed. */
const SKILL_BLOCK = /^<skill name="[^"]*"[^>]*>[\s\S]*?<\/skill>\s*/;
const WRAPPING = "\"'`“”‘’*";
const TRAILING = ".,;:!?";

/** Whether an on/off environment variable is on, read as Claude Code reads them. */
function envOn(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** The text of a prompt, without the skill block a typed skill puts ahead of what you typed. */
export function promptText(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
						.map((part) => part.text)
						.join(" ")
				: "";
	return text.replace(SKILL_BLOCK, "").trim();
}

/** The first prompt in a session branch that has text. */
export function firstPrompt(entries: readonly unknown[]): string {
	for (const entry of entries) {
		const { type, message } = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (type !== "message" || message?.role !== "user") continue;
		const text = promptText(message.content);
		if (text) return text;
	}
	return "";
}

/** Strips `chars` from both ends of `value`, scanning instead of using a regex that backtracks. */
function trimEnds(value: string, chars: string, leading: boolean): string {
	let start = 0;
	let end = value.length;
	while (leading && start < end && chars.includes(value[start] ?? "")) start++;
	while (end > start && chars.includes(value[end - 1] ?? "")) end--;
	return value.slice(start, end);
}

/** The model's reply as a bare title: its first line, without a `Title:` label, wrapping quotes or a
 * trailing period, with control and invisible characters turned into spaces as Claude does. */
export function cleanTitle(raw: string): string {
	const line = raw
		.split("\n")
		.map((part) => part.trim())
		.find(Boolean);
	let title = (line ?? "")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	let previous: string;
	do {
		previous = title;
		title = trimEnds(trimEnds(title, WRAPPING, true), TRAILING, false)
			.replace(/^(?:#+|title:)\s*/i, "")
			.trim();
	} while (title !== previous);
	return title.slice(0, MAX_TITLE_CHARS).trim();
}

/** The session's model registry, narrowed to the one call made here. */
export interface TitleRegistry {
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> };
}

/** Asks the model for a title. Throws when the request fails, so the session keeps no name. */
export async function requestTitle(registry: TitleRegistry, model: Model<Api>, prompt: string, signal?: AbortSignal): Promise<string> {
	// A model that can't turn thinking off thinks at its lowest level.
	const levels = getSupportedThinkingLevels(model);
	const reasoning = levels.includes("off") ? undefined : (levels[0] as ThinkingLevel | undefined);
	const context: Context = {
		systemPrompt: TITLE_SYSTEM,
		messages: [{ role: "user", content: `First user message of a new coding session:\n\n${prompt.slice(0, MAX_PROMPT_CHARS)}`, timestamp: Date.now() }],
	};
	const message = await registry.streamSimple(model, context, { maxTokens: TITLE_MAX_TOKENS, signal, ...(reasoning ? { reasoning } : {}) }).result();
	// pi-ai reports a failed or cancelled request by resolving with this stop reason, not by throwing.
	if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `title request ${message.stopReason}`);
	return cleanTitle(
		message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(""),
	);
}

/** The model that writes the title: `ANTHROPIC_DEFAULT_HAIKU_MODEL` when it names a model pi can use
 * (`id` or `provider/id`), as Claude runs background work on it, else the session's model. */
export function titleModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, haiku = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()): Model<Api> | undefined {
	if (haiku) {
		const match = ctx.modelRegistry.getAvailable().find((model) => model.id === haiku || `${model.provider}/${model.id}` === haiku);
		if (match) return match;
	}
	return ctx.model;
}

/** Whether this session should get a title: not a print or JSON run, not turned off, not a subagent's. */
export function titlesWanted(mode: ExtensionContext["mode"], env: Record<string, string | undefined> = process.env): boolean {
	if (mode !== "tui" && mode !== "rpc") return false;
	return !envOn(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE) && env.PI_SUBAGENT_CHILD !== "1";
}

export default function titleExtension(pi: ExtensionAPI) {
	/** One request per session, even when it fails. */
	let requested = false;
	/** Counts sessions, so a title that arrives after the session changed is dropped. */
	let generation = 0;
	let pending: AbortController | undefined;

	const cancel = () => {
		pending?.abort();
		pending = undefined;
	};

	pi.on("session_start", async () => {
		cancel();
		requested = false;
		generation++;
	});
	pi.on("session_shutdown", async () => cancel());

	pi.on("before_agent_start", async (event, ctx) => {
		if (requested || event.messageType !== "user" || !titlesWanted(ctx.mode) || pi.getSessionName()) return undefined;
		const model = titleModel(ctx);
		if (!model) return undefined;
		// A resumed session that was never named is titled from its own first prompt.
		const prompt = firstPrompt(ctx.sessionManager.getBranch()) || promptText(event.prompt);
		if (!prompt) return undefined;
		requested = true;
		const started = generation;
		const controller = new AbortController();
		pending = controller;
		const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
		// The title never keeps pi running.
		timer.unref?.();
		// Not awaited: the prompt runs while the title is written.
		void requestTitle(ctx.modelRegistry, model, prompt, controller.signal)
			.then((title) => {
				// A name set meanwhile wins. A replaced session's pi throws, which the catch takes.
				if (title && generation === started && !pi.getSessionName()) pi.setSessionName(title);
			})
			.catch(() => {
				// No title: the request failed or was cancelled, or the session is gone.
			})
			.finally(() => {
				clearTimeout(timer);
				if (pending === controller) pending = undefined;
			});
		return undefined;
	});
}
