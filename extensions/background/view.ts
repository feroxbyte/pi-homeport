/**
 * The pure parts of the job screens: reading the end of a log, scrolling through it, and moving
 * a selection down a list that reorders itself while it is open.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Key, matchesKey } from "@earendil-works/pi-tui";

/** The last `bytes` of a file as text, or "" when it can't be read. */
export function readTail(path: string, bytes: number): string {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, bytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export interface Window {
	lines: string[];
	/** How far the window sits above the newest line; 0 follows the log as it grows. */
	fromBottom: number;
	above: number;
	below: number;
}

/** The `height` lines ending `fromBottom` lines above the newest, clamped to what the log has. */
export function windowOf(lines: string[], height: number, fromBottom: number): Window {
	const furthest = Math.max(0, lines.length - height);
	const offset = Math.min(Math.max(0, fromBottom), furthest);
	const end = lines.length - offset;
	return { lines: lines.slice(Math.max(0, end - height), end), fromBottom: offset, above: Math.max(0, end - height), below: offset };
}

/** Where the window goes for a key: arrows by a line, page keys by a screen, g to the top, G to the newest line. */
export function scrolled(data: string, fromBottom: number, height: number, total: number): number | undefined {
	if (matchesKey(data, Key.up) || data === "k") return fromBottom + 1;
	if (matchesKey(data, Key.down) || data === "j") return Math.max(0, fromBottom - 1);
	if (matchesKey(data, Key.pageUp)) return fromBottom + height;
	if (matchesKey(data, Key.pageDown)) return Math.max(0, fromBottom - height);
	if (data === "g" || matchesKey(data, Key.home)) return total;
	if (data === "G" || matchesKey(data, Key.end)) return 0;
	return undefined;
}

/** The id selected after a key press in a list of ids: up and down move by one and stop at the ends. */
export function moved(data: string, ids: string[], selected: string | undefined): string | undefined {
	if (ids.length === 0) return undefined;
	const at = Math.max(0, ids.indexOf(selected ?? ""));
	if (matchesKey(data, Key.up) || data === "k") return ids[Math.max(0, at - 1)];
	if (matchesKey(data, Key.down) || data === "j") return ids[Math.min(ids.length - 1, at + 1)];
	return ids[at];
}
