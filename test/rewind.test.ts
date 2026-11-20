import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import rewindExtension, { describePlan, promptSnippet, resolveTarget, retentionDays, toolTarget } from "../extensions/rewind/index.ts";
import { findProject, projectPath, Store } from "../extensions/rewind/store.ts";

const VARS = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING"];
const savedEnv = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
let base: string;
let project: string;
let outside: string;

function write(rel: string, content: string | Buffer, root = project) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function read(rel: string, root = project): string | undefined {
	try {
		return fs.readFileSync(path.join(root, rel), "utf8");
	} catch {
		return undefined;
	}
}

beforeEach(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-test-")));
	project = path.join(base, "project");
	outside = path.join(base, "outside");
	fs.mkdirSync(project);
	fs.mkdirSync(outside);
	execFileSync("git", ["init", "--quiet", project]);
	process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
	process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
	delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING;
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Entry = { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: unknown } };

/** Loads the extension with a fake pi and session, and drives it the way pi does. */
async function start(cwd = project, resumed: Entry[] = []) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const entries: Entry[] = resumed;
	let branch: Entry[] = [...resumed];
	const notes: { message: string; level: string }[] = [];
	const answers: (string | ((options: string[]) => string | undefined) | undefined)[] = [];
	const asked: { title: string; options: string[] }[] = [];
	const navigations: { entryId: string; summarize: boolean }[] = [];
	let navigationResult: "ok" | "cancel" | "throw" = "ok";
	let seq = resumed.length;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options.handler),
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", id: `e${++seq}`, customType, data };
			entries.push(entry);
			branch.push(entry);
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
		},
		ui: {
			notify: (message: string, level: string) => notes.push({ message, level }),
			select: async (title: string, options: string[]) => {
				asked.push({ title, options });
				const answer = answers.shift();
				if (typeof answer === "function") return answer(options);
				return answer;
			},
		},
		navigateTree: async (entryId: string, options: { summarize?: boolean }) => {
			if (navigationResult === "throw") throw new Error("no model");
			navigations.push({ entryId, summarize: options.summarize === true });
			if (navigationResult === "cancel") return { cancelled: true };
			const index = branch.findIndex((entry) => entry.id === entryId);
			branch = branch.slice(0, index);
			return { cancelled: false };
		},
	};
	rewindExtension(pi as never);
	async function emit(name: string, event: unknown = {}) {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
	await emit("session_start", { reason: "startup" });
	return {
		ctx,
		entries,
		notes,
		answers,
		asked,
		navigations,
		emit,
		setNavigation: (result: "ok" | "cancel" | "throw") => (navigationResult = result),
		/** A prompt: the user message, then one turn in which the model's tools edit files. */
		async prompt(text: string, work: () => Promise<void> | void) {
			await emit("before_agent_start", { prompt: text });
			await emit("agent_start");
			const user = { type: "message", id: `e${++seq}`, message: { role: "user", content: [{ type: "text", text }] } };
			await emit("turn_start");
			entries.push(user);
			branch.push(user);
			await work();
			await emit("turn_end");
		},
		/** A file tool call, as pi fires it before the tool writes. */
		async tool(toolName: string, file: string, content?: string) {
			await emit("tool_call", { toolName, input: { path: file } });
			if (content !== undefined) write(file, content, path.isAbsolute(file) ? "/" : cwd);
		},
		async rewind(...picks: (string | ((options: string[]) => string | undefined) | undefined)[]) {
			answers.push(...picks);
			const handler = commands.get("rewind");
			assert.ok(handler);
			await handler("", ctx);
		},
	};
}

/** Picks the menu row that contains `text`. */
const row = (text: string) => (options: string[]) => options.find((option) => option.includes(text));

describe("store", () => {
	it("finds the repository root and nothing outside one", async () => {
		fs.mkdirSync(path.join(project, "sub"));
		assert.equal(await findProject(path.join(project, "sub")), project);
		assert.equal(await findProject(outside), undefined);
		assert.equal(await Store.open(outside, path.join(base, "stores")), undefined);
		assert.equal(fs.existsSync(path.join(base, "stores")), false);
	});

	it("names project files and refuses everything else", () => {
		fs.mkdirSync(path.join(project, "src"));
		fs.symlinkSync(outside, path.join(project, "escape"));
		assert.equal(projectPath(project, path.join(project, "src", "a.ts")), "src/a.ts");
		assert.equal(projectPath(project, path.join(project, "new", "deep", "b.ts")), "new/deep/b.ts");
		assert.equal(projectPath(project, path.join(outside, "x.txt")), undefined);
		assert.equal(projectPath(project, path.join(project, "escape", "x.txt")), undefined);
		assert.equal(projectPath(project, path.join(project, ".git", "config")), undefined);
		assert.equal(projectPath(project, path.join(project, "..", "outside", "x.txt")), undefined);
		assert.equal(projectPath(project, project), undefined);
	});

	it("keeps binary content and the executable bit byte for byte", async () => {
		const store = await Store.open(project, path.join(base, "stores"));
		assert.ok(store);
		const bytes = Buffer.from([0, 1, 2, 13, 10, 255, 254, 0, 10]);
		write("bin.dat", bytes);
		write("run.sh", "#!/bin/sh\r\necho hi\r\n");
		fs.chmodSync(path.join(project, "run.sh"), 0o755);
		const ref = await store.checkpoint(["bin.dat", "run.sh", "missing.txt"]);
		assert.ok(ref);
		write("bin.dat", "changed");
		fs.rmSync(path.join(project, "run.sh"));
		write("missing.txt", "created later");
		const snapshot = await store.load(ref);
		assert.ok(snapshot);
		assert.equal(snapshot.get("missing.txt"), null);
		const plan = await store.plan(snapshot);
		assert.deepEqual(plan.deletes, ["missing.txt"]);
		const applied = await store.apply(plan);
		assert.equal(applied.written, 2);
		assert.equal(applied.deleted, 1);
		assert.deepEqual(fs.readFileSync(path.join(project, "bin.dat")), bytes);
		assert.equal(read("run.sh"), "#!/bin/sh\r\necho hi\r\n");
		assert.notEqual(fs.statSync(path.join(project, "run.sh")).mode & 0o111, 0);
		assert.equal(fs.existsSync(path.join(project, "missing.txt")), false);
		assert.equal((await store.plan(snapshot)).writes.length, 0);
	});

	it("skips symlinks, hard links and links in the way, and never writes outside", async () => {
		const store = await Store.open(project, path.join(base, "stores"));
		assert.ok(store);
		write("linked.txt", "L0");
		write("hard.txt", "H0");
		write("dir/inner.txt", "I0");
		write("plain.txt", "P0");
		const ref = await store.checkpoint(["linked.txt", "hard.txt", "dir/inner.txt", "plain.txt"]);
		assert.ok(ref);
		write("target.txt", "outside content", outside);
		fs.rmSync(path.join(project, "linked.txt"));
		fs.symlinkSync(path.join(outside, "target.txt"), path.join(project, "linked.txt"));
		fs.writeFileSync(path.join(project, "hard.txt"), "H1");
		fs.linkSync(path.join(project, "hard.txt"), path.join(outside, "hard-copy.txt"));
		fs.rmSync(path.join(project, "dir"), { recursive: true });
		fs.symlinkSync(outside, path.join(project, "dir"));
		write("plain.txt", "P1");
		const snapshot = await store.load(ref);
		assert.ok(snapshot);
		const plan = await store.plan(snapshot);
		assert.deepEqual(plan.skipped.sort(), ["dir/inner.txt", "hard.txt", "linked.txt"]);
		const applied = await store.apply(plan);
		assert.equal(applied.written, 1);
		assert.equal(read("plain.txt"), "P0");
		assert.equal(read("target.txt", outside), "outside content");
		assert.equal(read("hard-copy.txt", outside), "H1");
		assert.equal(fs.existsSync(path.join(outside, "inner.txt")), false);
	});

	it("drops ignored paths from a restore", async () => {
		const store = await Store.open(project, path.join(base, "stores"));
		assert.ok(store);
		write(".gitignore", "*.log\n");
		write("app.log", "A0");
		const ref = await store.save(new Map([["app.log", null]]), "checkpoint");
		assert.ok(ref);
		const snapshot = await store.load(ref);
		assert.ok(snapshot);
		const plan = await store.plan(snapshot);
		assert.deepEqual(plan, { writes: [], deletes: [], skipped: [] });
		assert.deepEqual([...(await store.ignored(["app.log", "src/a.ts"]))], ["app.log"]);
	});

	it("prunes old checkpoints", async () => {
		const store = await Store.open(project, path.join(base, "stores"));
		assert.ok(store);
		write("a.txt", "A");
		const ref = await store.checkpoint(["a.txt"]);
		assert.ok(ref);
		assert.equal(await store.prune(30), 0);
		assert.ok(await store.load(ref));
		assert.equal(await store.prune(-1), 1);
		assert.equal(await store.load(ref), undefined);
	});
});

describe("helpers", () => {
	it("reads cleanupPeriodDays", () => {
		assert.equal(retentionDays([]), 30);
		assert.equal(retentionDays([{ cleanupPeriodDays: 7 }, { other: 1 }]), 7);
		assert.equal(retentionDays([{ cleanupPeriodDays: 0 }]), 30);
		assert.equal(retentionDays([{ cleanupPeriodDays: "9" }]), 30);
	});

	it("reads tool paths as pi does", () => {
		assert.equal(toolTarget({ path: "@src/a.ts" }), "src/a.ts");
		assert.equal(toolTarget({ file_path: "b.ts" }), "b.ts");
		assert.equal(toolTarget({ path: "~/x" }), path.join(os.homedir(), "x"));
		assert.equal(toolTarget({ path: "file:///tmp/y" }), "/tmp/y");
		assert.equal(toolTarget({}), undefined);
	});

	it("labels prompts and plans", () => {
		assert.equal(promptSnippet([{ type: "text", text: "fix\n  the   parser" }]), "fix the parser");
		assert.equal(promptSnippet("x".repeat(70)), `${"x".repeat(60)}…`);
		assert.equal(describePlan({ writes: [{ rel: "a", blob: "b", executable: false }], deletes: ["c", "d"], skipped: [] }), "1 file to put back, 2 new files to remove");
	});

	it("takes a file first touched later from the later checkpoint", () => {
		const a = { blob: "a", executable: false };
		const b = { blob: "b", executable: false };
		const target = resolveTarget(new Map([["x", a]]), [
			new Map([
				["x", b],
				["y", null],
			]),
			new Map([["y", b]]),
		]);
		assert.deepEqual(
			[...target],
			[
				["x", a],
				["y", null],
			],
		);
	});
});

describe("/rewind", () => {
	/** Two prompts: the first edits, creates and touches ignored and outside files; the second edits
	 * again, deletes a tracked file, creates a nested one, and the user changes an untracked file. */
	async function scenario() {
		write(".gitignore", "*.log\n");
		write("a.txt", "A0");
		write("gone.txt", "G0");
		write("keep.txt", "K0");
		write("secret.log", "S0");
		write("outside.txt", "O0", outside);
		const session = await start();
		await session.prompt("first prompt", async () => {
			await session.tool("edit", "a.txt", "A1");
			await session.tool("edit", "gone.txt", "G1");
			await session.tool("write", "new.txt", "N1");
			await session.tool("write", "secret.log", "S1");
			await session.tool("write", path.join(outside, "outside.txt"), "O1");
		});
		await session.prompt("second prompt", async () => {
			fs.rmSync(path.join(project, "gone.txt"));
			await session.tool("edit", "a.txt", "A2");
			await session.tool("write", "sub/deep/d.txt", "D2");
			write("keep.txt", "K1");
		});
		return session;
	}

	it("restores the code to before the first prompt: edited, deleted and created files", async () => {
		const session = await scenario();
		await session.rewind(row("first prompt"), "Restore code");
		assert.equal(read("a.txt"), "A0");
		assert.equal(read("gone.txt"), "G0");
		assert.equal(read("new.txt"), undefined);
		assert.equal(read("sub/deep/d.txt"), undefined);
		// Untouched by the session, ignored, or outside the project: left alone.
		assert.equal(read("keep.txt"), "K1");
		assert.equal(read("secret.log"), "S1");
		assert.equal(read("outside.txt", outside), "O1");
		assert.deepEqual(session.navigations, []);
		assert.match(session.notes.at(-1)?.message ?? "", /Restored 4 files/);
		const actions = session.asked[1].options;
		assert.deepEqual(actions, ["Restore code and conversation", "Restore conversation", "Restore code", "Summarize from here", "Never mind"]);
	});

	it("restores the code to before the second prompt", async () => {
		const session = await scenario();
		await session.rewind(row("second prompt"), "Restore code");
		assert.equal(read("a.txt"), "A1");
		assert.equal(read("gone.txt"), "G1");
		assert.equal(read("new.txt"), "N1");
		assert.equal(read("sub/deep/d.txt"), undefined);
		assert.equal(read("keep.txt"), "K1");
	});

	it("undoes a code restore", async () => {
		const session = await scenario();
		await session.rewind(row("first prompt"), "Restore code");
		await session.rewind(row("Undo the code restore"), "Restore code");
		assert.equal(read("a.txt"), "A2");
		assert.equal(read("gone.txt"), undefined);
		assert.equal(read("new.txt"), "N1");
		assert.equal(read("sub/deep/d.txt"), "D2");
	});

	it("moves the conversation through pi's tree navigation, then the code", async () => {
		const session = await scenario();
		const first = session.entries.find((entry) => entry.type === "message")?.id;
		await session.rewind(row("first prompt"), "Restore code and conversation");
		assert.deepEqual(session.navigations, [{ entryId: first, summarize: false }]);
		assert.equal(read("a.txt"), "A0");
	});

	it("leaves the files alone when the conversation can't move", async () => {
		const session = await scenario();
		session.setNavigation("cancel");
		await session.rewind(row("first prompt"), "Restore code and conversation");
		assert.equal(read("a.txt"), "A2");
		session.setNavigation("throw");
		await session.rewind(row("first prompt"), "Restore code and conversation");
		assert.equal(read("a.txt"), "A2");
		assert.match(session.notes.at(-1)?.message ?? "", /Couldn't restore the conversation/);
	});

	it("summarizes from a prompt without touching files", async () => {
		const session = await scenario();
		await session.rewind(row("second prompt"), "Summarize from here");
		assert.equal(session.navigations[0]?.summarize, true);
		assert.equal(read("a.txt"), "A2");
	});

	it("offers only the conversation when there are no file changes to restore", async () => {
		const session = await start();
		write("a.txt", "A0");
		await session.prompt("just a question", () => {});
		await session.rewind(row("just a question"), "Never mind", undefined);
		assert.deepEqual(session.asked[1].options, ["Restore conversation", "Summarize from here", "Never mind"]);
		assert.match(session.asked[1].title, /no file changes to restore/);
	});

	it("says there's nothing to rewind in a new session", async () => {
		const session = await start();
		await session.rewind();
		assert.match(session.notes.at(-1)?.message ?? "", /Nothing to rewind/);
	});

	it("refuses outside a git repository and keeps no checkpoints", async () => {
		write("a.txt", "A0", outside);
		const session = await start(outside);
		await session.prompt("edit", async () => {
			await session.tool("edit", path.join(outside, "a.txt"), "A1");
		});
		await session.rewind();
		assert.match(session.notes.at(-1)?.message ?? "", /needs a git repository/);
		assert.equal(session.entries.filter((entry) => entry.type === "custom").length, 0);
		assert.equal(read("a.txt", outside), "A1");
		assert.equal(fs.existsSync(path.join(base, "agent", "pi-homeport", "checkpoints")), false);
	});

	it("keeps no checkpoints when CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1", async () => {
		process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = "1";
		const session = await start();
		await session.prompt("edit", async () => {
			await session.tool("write", "a.txt", "A1");
		});
		await session.rewind();
		assert.match(session.notes.at(-1)?.message ?? "", /Checkpoints are off/);
		assert.equal(read("a.txt"), "A1");
	});

	it("picks up the tracked files again after a restart", async () => {
		const first = await scenario();
		// A new extension instance over the same session entries, as after /resume.
		const session = await start(project, first.entries);
		await session.prompt("third prompt", async () => {
			fs.rmSync(path.join(project, "new.txt"));
		});
		await session.rewind(row("third prompt"), "Restore code");
		assert.equal(read("new.txt"), "N1");
	});

	it("offers the code restore when /tree goes back to a prompt", async () => {
		const session = await scenario();
		const second = session.entries.filter((entry) => entry.type === "message")[1]?.id;
		session.answers.push("Restore the code to before this prompt");
		await session.emit("session_before_tree", { preparation: { targetId: second } });
		assert.equal(read("a.txt"), "A2");
		await session.emit("session_tree", { newLeafId: "x" });
		assert.equal(read("a.txt"), "A1");
		session.answers.push("Keep the current code");
		await session.emit("session_before_tree", { preparation: { targetId: second } });
		await session.emit("session_tree", { newLeafId: "x" });
		assert.equal(read("new.txt"), "N1");
	});

	it("offers the code restore when /fork goes back to a prompt", async () => {
		const session = await scenario();
		const first = session.entries.find((entry) => entry.type === "message")?.id;
		session.answers.push("Restore the code to before this prompt");
		await session.emit("session_before_fork", { entryId: first, position: "before" });
		assert.equal(read("a.txt"), "A0");
		assert.equal(read("new.txt"), undefined);
	});

	it("reports a checkpoint whose snapshot was pruned", async () => {
		const session = await scenario();
		const store = await Store.open(project, path.join(base, "agent", "pi-homeport", "checkpoints"));
		assert.ok(store);
		await store.prune(-1);
		await session.rewind(row("first prompt"), "Never mind", undefined);
		assert.match(session.asked[1].title, /snapshots are gone/);
		assert.equal(read("a.txt"), "A2");
	});
});
