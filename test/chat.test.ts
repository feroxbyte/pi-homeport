import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callLabel, resultSummary } from "../extensions/chat/tools.ts";

describe("chat tool rows", () => {
	const cwd = "/work/app";

	it("writes calls as Claude Code does", () => {
		const label = (tool: string, args: unknown) => {
			const { name, argument } = callLabel(tool, args, cwd);
			return argument ? `${name}(${argument})` : name;
		};
		assert.equal(label("read", { path: "/work/app/src/a.ts" }), "Read(src/a.ts)");
		assert.equal(label("read", { path: "a.ts", offset: 10, limit: 5 }), "Read(a.ts · lines 10-14)");
		assert.equal(label("bash", { command: "cd /work/app && npm test\necho done" }), "Bash(npm test)");
		assert.equal(label("grep", { pattern: "tide", path: "/work/app/docs" }), 'Search(pattern: "tide", path: "docs")');
		assert.equal(label("edit", { path: "/work/app/notes.txt" }), "Update(notes.txt)");
		assert.equal(label("write", { path: "/elsewhere/x.md" }), "Write(/elsewhere/x.md)");
		assert.equal(label("mcp__cloudflare__search", { query: "workers kv" }), 'cloudflare - search (MCP)(query: "workers kv")');
		assert.equal(label("ls", {}), "List(.)");
	});

	it("sums up a finished call in one line", () => {
		assert.equal(resultSummary("read", "a\nb\nc\n"), "Read 3 lines");
		assert.equal(resultSummary("read", "a"), "Read 1 line");
		assert.equal(resultSummary("grep", "a.ts:1:x\nb.ts:2:y"), "Found 2 lines");
		assert.equal(resultSummary("grep", "No matches found"), "No matches");
		assert.equal(resultSummary("find", "a.ts\nb.ts"), "Found 2 files");
		assert.equal(resultSummary("ls", "a\nb/"), "Listed 2 paths");
		assert.equal(resultSummary("mcp__x__y", ""), "(No output)");
		assert.equal(resultSummary("mcp__x__y", "first\nsecond\nthird"), "first … +2 lines");
	});
});
