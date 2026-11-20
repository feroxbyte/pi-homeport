import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import backgroundExtension from "../extensions/background/index.ts";

const REGISTRY = Symbol.for("pi-homeport.background.registry");
const registry = () => (globalThis as Record<symbol, any>)[REGISTRY];

/** A copy of the extension with a fake pi: what it registered, and what it told the session. */
function load() {
	const handlers = new Map<string, Array<(event: any) => unknown>>();
	const tools = new Map<string, any>();
	const messages: Array<{ content: string; details: any }> = [];
	const pi = {
		on: (name: string, handler: (event: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		getSettings: () => ({}),
		getAllTools: () => [],
		sendMessage: (message: any) => messages.push({ content: message.content, details: message.details }),
	};
	backgroundExtension(pi as never);
	return {
		messages,
		run: (command: string) => tools.get("bg_run").execute("call", { command }, undefined, undefined, { cwd: process.cwd() }),
		shutdown: async (reason: string) => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason });
		},
	};
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	for (const job of registry()?.jobs.values() ?? []) job.controller.abort();
	delete (globalThis as Record<symbol, unknown>)[REGISTRY];
});

describe("background jobs and /reload", () => {
	it("keeps a running job through a reload and lets the next copy report it", async () => {
		const first = load();
		await first.run("sleep 0.6; echo hello");
		await first.shutdown("reload");
		assert.equal(registry().jobs.get("bg1").status, "running");

		const second = load();
		await wait(1500);
		assert.equal(registry().jobs.get("bg1").status, "exited");
		assert.equal(second.messages.length, 1);
		assert.match(second.messages[0]!.content, /bg1 \[exit 0/);
		assert.match(second.messages[0]!.content, /hello/);
		assert.equal(first.messages.length, 0, "the old copy has nobody to tell");
	});

	it("numbers jobs on from before the reload", async () => {
		const first = load();
		await first.run("sleep 5");
		await first.shutdown("reload");
		const second = load();
		const started = await second.run("sleep 5");
		assert.match(started.content[0].text, /^Started bg2;/);
	});

	it("reports a job that ended between the shutdown and the next copy", async () => {
		const first = load();
		await first.run("echo quick");
		await first.shutdown("reload");
		await wait(500);
		assert.equal(registry().jobs.get("bg1").status, "exited");
		assert.equal(registry().unreported.length, 1);

		const second = load();
		assert.equal(second.messages.length, 1);
		assert.match(second.messages[0]!.content, /bg1 \[exit 0/);
		assert.equal(registry().unreported.length, 0);
	});

	it("doesn't report a stopped job into a new session that reuses its id", async () => {
		const first = load();
		await first.run("sleep 30");
		await first.shutdown("new");

		const second = load();
		await second.run("sleep 30");
		await wait(500);
		assert.equal(second.messages.length, 0);
		assert.equal(registry().jobs.get("bg1").status, "running");
	});

	for (const reason of ["quit", "new", "resume", "fork"]) {
		it(`stops its jobs and forgets them on ${reason}`, async () => {
			const first = load();
			await first.run("sleep 30");
			const job = registry().jobs.get("bg1");
			await first.shutdown(reason);
			assert.equal(registry().jobs.size, 0);
			await wait(500);
			assert.equal(job.status, "killed");
			assert.equal(first.messages.length, 0, "a stopped job doesn't wake a session that is gone");
			assert.equal(registry().unreported.length, 0);

			const next = load();
			const started = await next.run("echo again");
			assert.match(started.content[0].text, /^Started bg1;/, "numbering starts over in the new session");
		});
	}
});
