import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentSummary, callLabel, formatDuration, readText, resultSummary, wasInterrupted } from "../extensions/chat/tools.ts";

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
		assert.equal(label("web_search", { query: "svelte runes" }), 'Web Search("svelte runes")');
		assert.equal(label("web_search", { queries: ["a", "b"] }), 'Web Search("a", "b")');
		assert.equal(label("fetch_content", { url: "https://svelte.dev/docs" }), "Fetch(https://svelte.dev/docs)");
		assert.equal(label("fetch_content", { urls: ["https://a", "https://b"] }), "Fetch(2 URLs)");
	});

	it("sums up a finished call in one line", () => {
		assert.equal(resultSummary("read", "a\nb\nc\n"), "Read 3 lines");
		assert.equal(resultSummary("read", "a"), "Read 1 line");
		assert.equal(resultSummary("grep", "a.ts:1:x\nb.ts:2:y"), "Found 2 lines");
		assert.equal(resultSummary("grep", "No matches found"), "No matches");
		assert.equal(resultSummary("find", "a.ts\nb.ts"), "Found 2 files");
		assert.equal(resultSummary("ls", "a\nb/"), "Listed 2 paths");
		assert.equal(resultSummary("fetch_content", "x".repeat(2048)), "Received 2.0KB");
		assert.equal(resultSummary("mcp__x__y", ""), "(No output)");
		assert.equal(resultSummary("mcp__x__y", "first\nsecond\nthird"), "first … +2 lines");
	});

	it("counts only the file in a read, not what extensions append or pi's closing note", () => {
		const result = {
			content: [
				{ type: "text", text: "line one\nline two\n\n[Showing lines 1-2 of 90. Use offset=3 to continue.]" },
				{ type: "text", text: "\n\nThese instructions apply to files here:\n\n<project_instructions>…</project_instructions>" },
			],
		};
		assert.equal(readText(result), "line one\nline two");
		assert.equal(resultSummary("read", readText(result)), "Read 2 lines");
	});

	it("tells an interruption from an error", () => {
		assert.equal(wasInterrupted("Operation aborted"), true);
		assert.equal(wasInterrupted("Request was aborted."), true);
		assert.equal(wasInterrupted("Command aborted"), true);
		assert.equal(wasInterrupted("Command exited with code 1"), false);
	});

	it("sums up an agent run as Claude Code does", () => {
		const run = {
			agent: "Explore",
			exitCode: 0,
			messages: [
				{ role: "assistant", content: [{ type: "toolCall" }, { type: "toolCall" }, { type: "text" }] },
				{ role: "toolResult", content: [{ type: "toolCall" }] },
				{ role: "assistant", content: [{ type: "toolCall" }] },
			],
			usage: { input: 20_000, output: 1_200, cacheRead: 10_000, cacheWrite: 0 },
		};
		assert.equal(agentSummary(run, 64_000), "Done (3 tool uses · 31.2k tokens · 1m 04s)");
		assert.equal(agentSummary({ ...run, exitCode: 1, errorMessage: "maxTurns reached\nmore" }, undefined), "Failed (3 tool uses · 31.2k tokens): maxTurns reached");
		assert.equal(formatDuration(4_400), "4s");
	});
});
