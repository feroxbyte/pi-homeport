import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactionPoint, formatElapsed, formatTokens, outputTokensSince, parseGitStatus, usageTotals } from "../extensions/footer/parts.ts";

describe("footer", () => {
	it("reads branch, changes and ahead/behind from git status", () => {
		assert.deepEqual(parseGitStatus("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n"), {
			branch: "main",
			dirty: false,
			ahead: 2,
			behind: 1,
		});
		assert.deepEqual(parseGitStatus("# branch.head (detached)\n1 .M N... 100644 100644 100644 a b src/a.ts\n? new.ts\n"), {
			branch: null,
			dirty: true,
			ahead: 0,
			behind: 0,
		});
	});

	it("formats tokens and elapsed time", () => {
		assert.deepEqual([formatTokens(999), formatTokens(12_345), formatTokens(1_000_000)], ["999", "12.3k", "1.0M"]);
		assert.deepEqual([formatElapsed(12_400), formatElapsed(185_000), formatElapsed(3_720_000)], ["12s", "3m 05s", "1h 02m"]);
	});

	it("sums the cost and rates the cache from the last response", () => {
		const reply = (input: number, cacheRead: number, cacheWrite: number, total: number) => ({
			type: "message",
			message: { role: "assistant", usage: { input, cacheRead, cacheWrite, cost: { total } } },
		});
		const entries = [reply(1000, 0, 9000, 0.05), { type: "message", message: { role: "user" } }, reply(500, 9000, 500, 0.01)];
		const totals = usageTotals(entries);
		assert.equal(totals.cost.toFixed(2), "0.06");
		assert.equal(totals.cacheRate, 90);
		assert.equal(usageTotals([]).cacheRate, undefined);
	});

	it("places the compaction mark where auto-compaction starts", () => {
		assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: 16_384 }), (200_000 - 16_384) / 200_000);
		assert.equal(compactionPoint(200_000, { enabled: false, reserveTokens: 16_384 }), undefined);
		assert.equal(compactionPoint(0, { enabled: true, reserveTokens: 16_384 }), undefined);
	});

	it("counts the output tokens of the running turn", () => {
		const reply = (output: number) => ({ type: "message", message: { role: "assistant", usage: { output } } });
		assert.equal(outputTokensSince([reply(500), { type: "message", message: { role: "user" } }, reply(120), reply(80)], 1), 200);
	});
});
