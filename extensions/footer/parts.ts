/** The footer's calculations, kept apart from rendering so they can be tested. */

export interface GitState {
	branch: string | null;
	/** Whether there are changes not committed yet, untracked files included. */
	dirty: boolean;
	/** Commits ahead of and behind the upstream, as of the last fetch. */
	ahead: number;
	behind: number;
}

/** Reads `git status --porcelain=v2 --branch`. */
export function parseGitStatus(output: string): GitState {
	const state: GitState = { branch: null, dirty: false, ahead: 0, behind: 0 };
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			const head = line.slice(14).trim();
			state.branch = head === "(detached)" ? null : head;
		} else if (line.startsWith("# branch.ab ")) {
			const match = /\+(\d+) -(\d+)/.exec(line);
			state.ahead = Number(match?.[1] ?? 0);
			state.behind = Number(match?.[2] ?? 0);
		} else if (line.trim() !== "" && !line.startsWith("#")) state.dirty = true;
	}
	return state;
}

export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `12s`, `3m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface UsageLike {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

/**
 * The session's cost so far, and the share of the last response's input that came from the prompt
 * cache. Tokens written to the cache count as misses: they were sent in full.
 */
export function usageTotals(entries: readonly unknown[]): { cost: number; cacheRate: number | undefined } {
	let cost = 0;
	let last: UsageLike | undefined;
	for (const entry of entries) {
		const message = (entry as { type?: string; message?: { role?: string; usage?: UsageLike } }).message;
		if ((entry as { type?: string }).type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		cost += message.usage.cost?.total ?? 0;
		last = message.usage;
	}
	const read = last?.cacheRead ?? 0;
	const total = (last?.input ?? 0) + read + (last?.cacheWrite ?? 0);
	return { cost, cacheRate: total > 0 ? (read / total) * 100 : undefined };
}

/** Where auto-compaction starts, as a share of the context window, or undefined when it's off. */
export function compactionPoint(contextWindow: number, settings: { enabled: boolean; reserveTokens: number } | undefined): number | undefined {
	if (!settings?.enabled || contextWindow <= 0) return undefined;
	return Math.max(0, Math.min(1, (contextWindow - settings.reserveTokens) / contextWindow));
}

/** Output tokens since a turn started: the assistant messages in `entries` from `start` on. */
export function outputTokensSince(entries: readonly unknown[], start: number): number {
	let total = 0;
	for (const entry of entries.slice(start)) {
		const message = (entry as { type?: string; message?: { role?: string; usage?: { output?: number } } }).message;
		if ((entry as { type?: string }).type === "message" && message?.role === "assistant") total += message.usage?.output ?? 0;
	}
	return total;
}
