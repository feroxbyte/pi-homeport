import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withBackground } from "../extensions/chat/turn.ts";
import { moved, readTail, scrolled, windowOf } from "../extensions/background/view.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

test("the window follows the newest line until you scroll", () => {
	const view = windowOf(lines, 10, 0);
	assert.equal(view.lines[0], "line 41");
	assert.equal(view.lines.at(-1), "line 50");
	assert.equal(view.above, 40);
	assert.equal(view.below, 0);
});

test("scrolling stops at both ends of the log", () => {
	assert.equal(windowOf(lines, 10, 999).fromBottom, 40);
	assert.equal(windowOf(lines, 10, 999).lines[0], "line 1");
	assert.equal(windowOf(lines, 10, -5).fromBottom, 0);
	assert.deepEqual(windowOf(["a", "b"], 10, 3).lines, ["a", "b"]);
	assert.equal(windowOf([], 10, 0).lines.length, 0);
});

test("arrows scroll by a line, page keys by a screen, g and G jump", () => {
	assert.equal(scrolled(UP, 0, 10, 50), 1);
	assert.equal(scrolled("k", 4, 10, 50), 5);
	assert.equal(scrolled(DOWN, 3, 10, 50), 2);
	assert.equal(scrolled(DOWN, 0, 10, 50), 0);
	assert.equal(scrolled(PAGE_UP, 0, 10, 50), 10);
	assert.equal(scrolled(PAGE_DOWN, 4, 10, 50), 0);
	assert.equal(scrolled("g", 0, 10, 50), 50);
	assert.equal(scrolled("G", 20, 10, 50), 0);
	assert.equal(scrolled("z", 7, 10, 50), undefined);
});

test("the selection moves by one and stops at the ends of the list", () => {
	const ids = ["bg3", "bg2", "bg1"];
	assert.equal(moved(DOWN, ids, "bg3"), "bg2");
	assert.equal(moved(DOWN, ids, "bg1"), "bg1");
	assert.equal(moved(UP, ids, "bg3"), "bg3");
	assert.equal(moved(UP, ids, "bg1"), "bg2");
	assert.equal(moved("j", ids, "bg3"), "bg2");
});

test("the selection falls back to the first job when its job left the list", () => {
	assert.equal(moved(DOWN, ["bg2", "bg1"], "bg9"), "bg1");
	assert.equal(moved("x", ["bg2", "bg1"], "bg1"), "bg1");
	assert.equal(moved(DOWN, [], "bg1"), undefined);
});

test("only the end of a long log is read", () => {
	const dir = mkdtempSync(join(tmpdir(), "homeport-bg-"));
	try {
		const file = join(dir, "log");
		writeFileSync(file, `${"a".repeat(1000)}\nthe end\n`);
		assert.equal(readTail(file, 20), "aaaaaaaaaaaaaaaaaa\nthe end\n".slice(-20));
		assert.equal(readTail(file, 1_000_000).startsWith("aaaa"), true);
		assert.equal(readTail(join(dir, "missing"), 20), "");
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("running jobs are added to the turn line, and nothing is when none run", () => {
	const line = "✻ Worked for 7s · done 4:19 PM";
	assert.equal(withBackground(line, 0), line);
	assert.equal(withBackground(line, 1), `${line} · 1 background job · ↓ to manage`);
	assert.equal(withBackground(line, 3), `${line} · 3 background jobs · ↓ to manage`);
	assert.equal(withBackground(undefined, 0), undefined);
	assert.equal(withBackground(undefined, 2), "✻ 2 background jobs · ↓ to manage");
});
