/**
 * How a monitor turns a command's output into events: lines that arrive within a short window go out
 * together, a line and an event are cut at fixed lengths, and a flood of events is throttled, counted
 * and finally stopped. Kept apart from the tool so tests can drive it with a fake clock.
 *
 * Based on pi-code's monitor extension by ilovepixelart (MIT; see THIRD_PARTY_NOTICES.md).
 */

/** "5 minutes by default". */
export const DEFAULT_DEADLINE_MS = 5 * 60_000;
/** "at most 30 minutes". */
export const MAX_DEADLINE_MS = 30 * 60_000;
/** Claude's schema takes no `timeout_ms` under one second. */
export const MIN_DEADLINE_MS = 1_000;

/** How long lines gather after the first one before they go out as one event. */
export const BATCH_WINDOW_MS = 200;
/** One line longer than this is cut. */
export const MAX_LINE_CHARS = 500;
/** One event longer than this is cut. */
export const MAX_EVENT_CHARS = 3_000;
/** How much of a line that has not ended yet is kept: its end. */
export const MAX_PARTIAL_CHARS = 1_048_576;

/** Events one monitor may send at once. */
export const FLOOD_BURST = 10;
/** How long until a monitor may send one more event. */
export const FLOOD_REFILL_MS = 2_000;
/** How long a monitor may be suppressed without a break before it is stopped. */
export const SUPPRESSION_LIMIT_MS = 30_000;

const TRUNCATED = "...(truncated)";

/** `capacity` uses at once, then one more every `refillMs`, never more than `capacity`. */
export function tokenBucket(capacity: number, refillMs: number, now: () => number = Date.now): { tryConsume: () => boolean; tokens: () => number } {
	let tokens = capacity;
	let refilledAt = now();
	const refill = (): void => {
		const gained = Math.floor((now() - refilledAt) / refillMs);
		// A clock that stepped back gains nothing: a negative count would never read as empty.
		if (gained <= 0) return;
		tokens = Math.min(capacity, tokens + gained);
		refilledAt += gained * refillMs;
	};
	return {
		tryConsume() {
			refill();
			if (tokens === 0) return false;
			tokens--;
			return true;
		},
		tokens() {
			refill();
			return tokens;
		},
	};
}

/** Claude's text counts "events" whatever the number, one included. */
export const suppressionNotice = (count: number): string =>
	`[${count} events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]`;

export interface EventGateOptions {
	send: (event: string) => void;
	/** Called once the monitor has been suppressed for too long, with the notice to end it on. */
	stop: (notice: string) => void;
	capacity?: number;
	refillMs?: number;
	suppressionLimitMs?: number;
	now?: () => number;
}

export interface EventGate {
	/** Spend a token on an event; the count of those suppressed before it is sent first. */
	admit: () => boolean;
	/** Send the event, or suppress it and stop a monitor suppressed for too long. */
	offer: (event: string) => void;
}

/** The allowance events are sent under. Suppression counts as unbroken until the monitor has been
 * quiet for three refills or its allowance is whole again. */
export function eventGate(options: EventGateOptions): EventGate {
	const capacity = options.capacity ?? FLOOD_BURST;
	const refillMs = options.refillMs ?? FLOOD_REFILL_MS;
	const suppressionLimitMs = options.suppressionLimitMs ?? SUPPRESSION_LIMIT_MS;
	const now = options.now ?? Date.now;
	const bucket = tokenBucket(capacity, refillMs, now);
	let suppressed = 0;
	let suppressedSince: number | undefined;
	let lastEventAt = now();

	const admit = (): boolean => {
		const at = now();
		if (at - lastEventAt > refillMs * 3 || bucket.tokens() === capacity) suppressedSince = undefined;
		lastEventAt = at;
		if (!bucket.tryConsume()) {
			suppressed++;
			suppressedSince ??= at;
			return false;
		}
		if (suppressed > 0) options.send(suppressionNotice(suppressed));
		suppressed = 0;
		return true;
	};

	return {
		admit,
		offer(event) {
			if (admit()) {
				options.send(event);
				return;
			}
			const lasted = now() - (suppressedSince ?? now());
			if (lasted > suppressionLimitMs) {
				options.stop(`[Monitor stopped: too much output (${suppressed} events suppressed over ${Math.round(lasted / 1000)}s). Restart with a more selective source.]`);
			}
		},
	};
}

export interface LineBatcher {
	/** Feed decoded output; complete lines are queued for the next event. */
	push: (text: string) => void;
	/** Take what is queued now, the unterminated last line included, and stop the timer. */
	drain: () => string | undefined;
}

export interface BatcherOptions {
	emit: (event: string) => void;
	windowMs?: number;
	now?: () => number;
}

const cut = (text: string, max: number, mark: string): string => (text.length > max ? `${text.slice(0, max)}${mark}` : text);

/** Splits output into lines and emits them as events: the first queued line opens a window, and the
 * lines queued when it closes are one event. */
export function createLineBatcher(options: BatcherOptions): LineBatcher {
	const windowMs = options.windowMs ?? BATCH_WINDOW_MS;
	const now = options.now ?? Date.now;

	let partial = "";
	let lines: string[] = [];
	let chars = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let openedAt = 0;

	const queue = (raw: string): void => {
		const line = cut(raw.trim(), MAX_LINE_CHARS, TRUNCATED);
		// An event already past its cut shows no later line: a command printing without pause must not
		// queue them without bound.
		if (line === "" || chars > MAX_EVENT_CHARS) return;
		lines.push(line);
		chars += line.length + (lines.length > 1 ? 1 : 0);
	};

	const take = (): string | undefined => {
		if (lines.length === 0) return undefined;
		const event = cut(lines.join("\n"), MAX_EVENT_CHARS, `\n${TRUNCATED}`);
		lines = [];
		chars = 0;
		return event;
	};

	const fire = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const event = take();
		if (event !== undefined) options.emit(event);
	};

	return {
		push(text) {
			// A command printing without pause can keep the event loop on its pipe, and no timer runs
			// meanwhile: a window the clock has closed is emitted from here.
			if (timer && now() - openedAt >= windowMs) fire();
			const parts = (partial + text).split("\n");
			partial = (parts.pop() ?? "").slice(-MAX_PARTIAL_CHARS);
			for (const part of parts) queue(part);
			if (timer || lines.length === 0) return;
			openedAt = now();
			timer = setTimeout(fire, windowMs);
			timer.unref?.();
		},
		drain() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			queue(partial);
			partial = "";
			return take();
		},
	};
}

/** The deadline a watch gets: the default when none is asked for, capped at the maximum. */
export function deadlineMs(requested: number | undefined, minMs: number = MIN_DEADLINE_MS): number {
	if (requested === undefined) return DEFAULT_DEADLINE_MS;
	if (!Number.isFinite(requested) || requested < minMs) {
		throw new Error(`timeout_ms must be a number of milliseconds, at least ${minMs} (a value over ${MAX_DEADLINE_MS} is capped)`);
	}
	return Math.min(Math.floor(requested), MAX_DEADLINE_MS);
}

/** `5-minute`, `1.5-second`: how a deadline reads in a notice. */
export function formatDeadline(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000}-minute`;
	return `${Math.round(ms / 100) / 10}-second`;
}
