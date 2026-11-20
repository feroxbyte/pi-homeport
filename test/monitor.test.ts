import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import backgroundExtension from "../extensions/background/index.ts";
import { createLineBatcher, DEFAULT_DEADLINE_MS, deadlineMs, eventGate, MAX_DEADLINE_MS, MAX_LINE_CHARS, tokenBucket } from "../extensions/monitor/events.ts";
import monitorExtension, { type MonitorLimits } from "../extensions/monitor/index.ts";

const REGISTRY = Symbol.for("pi-homeport.background.registry");
const MAILBOX = Symbol.for("pi-homeport.monitor.mailbox");
const registry = () => (globalThis as Record<symbol, any>)[REGISTRY];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until check() holds, or fails after a few seconds. */
async function until(check: () => boolean, what: string) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await wait(50);
	}
	assert.fail(`timed out waiting for ${what}`);
}

/** A copy of the background and monitor extensions sharing one fake pi. */
function load(options: { limits?: MonitorLimits; active?: string[]; hasUI?: boolean } = {}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const messages: Array<{ customType: string; content: string; details: any }> = [];
	let active = options.active ?? ["bash", "read", "monitor", "task_stop", "bg_run"];
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		getSettings: () => ({}),
		getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		sendMessage: (message: any) => messages.push({ customType: message.customType, content: message.content, details: message.details }),
	};
	backgroundExtension(pi as never);
	monitorExtension(pi as never, options.limits);
	const ctx = {
		cwd: process.cwd(),
		hasUI: options.hasUI ?? true,
		mode: "print",
		sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
	};
	const call = (name: string, params: any) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	const emit = async (name: string, event: any) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return {
		messages,
		monitorMessages: () => messages.filter((message) => message.customType === "monitor"),
		active: () => active,
		monitor: (command: string, timeout_ms?: number) => call("monitor", { description: "test watch", command, timeout_ms }),
		stop: (task_id: string) => call("task_stop", { task_id }),
		run: (command: string) => call("bg_run", { command }),
		start: () => emit("session_start", { type: "session_start", reason: "startup" }),
		shutdown: (reason: string) => emit("session_shutdown", { type: "session_shutdown", reason }),
	};
}

afterEach(() => {
	for (const job of registry()?.jobs.values() ?? []) job.controller.abort();
	delete (globalThis as Record<symbol, unknown>)[REGISTRY];
	delete (globalThis as Record<symbol, unknown>)[MAILBOX];
});

describe("monitor events", () => {
	it("lets a burst through, then one event per refill", () => {
		let now = 0;
		const bucket = tokenBucket(3, 1000, () => now);
		assert.deepEqual([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()], [true, true, true, false]);
		now = 1000;
		assert.equal(bucket.tryConsume(), true);
		assert.equal(bucket.tryConsume(), false);
	});

	it("counts suppressed events, reports the count with the next one, and stops a long flood", () => {
		let now = 0;
		const sent: string[] = [];
		const stops: string[] = [];
		const gate = eventGate({ send: (event) => sent.push(event), stop: (notice) => stops.push(notice), capacity: 2, refillMs: 1000, suppressionLimitMs: 5000, now: () => now });
		for (const event of ["a", "b", "c", "d"]) gate.offer(event);
		assert.deepEqual(sent, ["a", "b"]);
		now = 1000;
		gate.offer("e");
		assert.deepEqual(sent, ["a", "b", "[2 events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]", "e"]);
		// Nonstop output from here on: suppressed for longer than the limit stops it
		for (let t = 1000; t <= 8000 && stops.length === 0; t += 100) {
			now = t;
			gate.offer("flood");
		}
		assert.equal(stops.length, 1);
		assert.match(stops[0]!, /^\[Monitor stopped: too much output \(\d+ events suppressed over \d+s\)/);
	});

	it("batches lines that arrive together, skips blank ones and cuts long ones", async () => {
		const events: string[] = [];
		const batcher = createLineBatcher({ emit: (event) => events.push(event), windowMs: 30 });
		batcher.push("one\n\n  two  \nthr");
		batcher.push("ee\n");
		await wait(80);
		batcher.push(`${"x".repeat(MAX_LINE_CHARS + 10)}\nno newline`);
		assert.deepEqual(events, ["one\ntwo\nthree"]);
		const rest = batcher.drain()!;
		assert.equal(rest.split("\n")[0], `${"x".repeat(MAX_LINE_CHARS)}...(truncated)`);
		assert.equal(rest.split("\n")[1], "no newline");
	});

	it("gives a watch 5 minutes by default and at most 30", () => {
		assert.equal(deadlineMs(undefined), DEFAULT_DEADLINE_MS);
		assert.equal(deadlineMs(60 * 60_000), MAX_DEADLINE_MS);
		assert.equal(deadlineMs(2500.7), 2500);
		assert.throws(() => deadlineMs(10), /at least 1000/);
	});
});

describe("monitor tool", () => {
	it("delivers stdout lines as events, keeps stderr in the file, and reports the exit", async () => {
		const pi = load({ limits: { windowMs: 50 } });
		await pi.start();
		const started = await pi.monitor("echo first; echo hidden >&2; sleep 0.3; echo second");
		assert.match(started.content[0].text, /^Monitor started with ID: mon1\. .* 5-minute deadline/);
		await until(() => pi.monitorMessages().some((message) => /ended/.test(message.content)), "the end notice");
		const texts = pi.monitorMessages().map((message) => message.content);
		assert.equal(texts[0], 'Monitor mon1 ("test watch") output:\nfirst');
		assert.match(texts.at(-1)!, /second\n.*Monitor mon1 \("test watch"\) ended: the command exited with code 0\. Full output: /s);
		assert.ok(!texts.join("\n").includes("hidden"), "stderr is not an event");
		const job = registry().jobs.get("mon1");
		assert.equal(job.status, "exited");
		assert.match(readFileSync(job.log, "utf8"), /hidden/);
		assert.equal(pi.monitorMessages().at(-1)!.details.ended, "ok");
	});

	it("ends a watch at its deadline with one notice", async () => {
		const pi = load({ limits: { windowMs: 20, minDeadlineMs: 1 } });
		await pi.start();
		await pi.monitor("sleep 30", 300);
		await until(() => pi.monitorMessages().length > 0, "the deadline notice");
		await wait(100);
		assert.equal(pi.monitorMessages().length, 1);
		assert.match(pi.monitorMessages()[0]!.content, /mon1 \("test watch"\) reached its 0\.3-second deadline and stopped\. Start it again/);
		assert.equal(registry().jobs.get("mon1").status, "killed");
	});

	it("stops a flooding watch with one notice", async () => {
		const pi = load({ limits: { windowMs: 5, floodBurst: 2, floodRefillMs: 1000, suppressionLimitMs: 200 } });
		await pi.start();
		await pi.monitor("while true; do echo spam; sleep 0.01; done");
		await until(() => registry().jobs.get("mon1").status !== "running" && pi.monitorMessages().some((message) => /too much output/.test(message.content)), "the flood stop");
		const texts = pi.monitorMessages().map((message) => message.content);
		assert.equal(texts.filter((content) => /output:\nspam/.test(content)).length, 2);
		assert.match(texts.at(-1)!, /\[Monitor stopped: too much output/);
	});

	it("is refused without a UI and when bash is off", async () => {
		const headless = load({ hasUI: false });
		await assert.rejects(headless.monitor("echo hi"), /without a UI/);
		const readOnly = load({ active: ["read", "monitor"] });
		await readOnly.start();
		assert.ok(!readOnly.active().includes("monitor"), "monitor goes away with bash");
		await assert.rejects(readOnly.monitor("echo hi"), /bash is off/);
	});

	it("keeps watching through a reload and reports to the next copy", async () => {
		const first = load({ limits: { windowMs: 20 } });
		await first.start();
		await first.monitor("sleep 0.5; echo after reload");
		await first.shutdown("reload");
		const second = load({ limits: { windowMs: 20 } });
		await second.start();
		await until(() => second.monitorMessages().some((message) => /ended/.test(message.content)), "the end notice");
		assert.match(second.monitorMessages()[0]!.content, /after reload/);
		assert.equal(first.monitorMessages().length, 0);
	});

	it("stops its watches when the session ends", async () => {
		const pi = load();
		await pi.start();
		await pi.monitor("sleep 30");
		const job = registry().jobs.get("mon1");
		await pi.shutdown("new");
		await until(() => job.status !== "running", "the stop");
		await wait(100);
		assert.equal(pi.monitorMessages().length, 0);
	});
});

describe("task_stop", () => {
	it("stops a monitor without a notice and a bg_run job", async () => {
		const pi = load();
		await pi.start();
		await pi.run("sleep 30");
		await pi.monitor("sleep 30");
		assert.ok(registry().jobs.has("bg1") && registry().jobs.has("mon1"), "both live in the one job registry");

		assert.match((await pi.stop("mon1")).content[0].text, /Stopped the monitor mon1/);
		assert.match((await pi.stop("BG1")).content[0].text, /Stopped the background job bg1/);
		await until(() => registry().jobs.get("mon1").status === "killed" && registry().jobs.get("bg1").status === "killed", "both stopped");
		await wait(100);
		assert.equal(pi.monitorMessages().length, 0, "a monitor stopped on request says nothing more");
		assert.match((await pi.stop("mon1")).content[0].text, /not running \(killed\)/);
	});

	it("lists what is running when the ID is unknown", async () => {
		const pi = load();
		await pi.start();
		await pi.run("sleep 30");
		await assert.rejects(pi.stop("mon9"), /No background task with ID mon9\. Running: bg1 \(sleep 30\)/);
		await assert.rejects(pi.stop(""), /task_id is required/);
	});

	it("numbers monitors on from the ones still registered", async () => {
		const pi = load();
		await pi.start();
		await pi.monitor("sleep 30");
		const second = await pi.monitor("sleep 30");
		assert.match(second.content[0].text, /ID: mon2\./);
		await until(() => existsSync(registry().jobs.get("mon2").log), "the output file");
	});
});
