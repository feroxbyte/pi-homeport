/**
 * The checkpoint store behind `/rewind`: file snapshots kept in a shadow git repository, one per
 * project, under `~/.pi/agent/pi-homeport/checkpoints/`. The project's own repository is only read
 * (to find its root and its ignore rules); every snapshot lives in the shadow, and every file a
 * restore writes or deletes goes through the checks in `plan` and `apply` here, never through a git
 * checkout.
 *
 * A checkpoint is a commit whose tree holds the files tracked at that point, and whose message lists
 * the tracked files that didn't exist then. A file is tracked once pi's edit or write tool touches it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A file's content at a checkpoint, or null when it didn't exist. */
export type FileState = { blob: string; executable: boolean } | null;
export type Snapshot = Map<string, FileState>;

export interface Plan {
	/** Files to write back, by project-relative path. */
	writes: { rel: string; blob: string; executable: boolean }[];
	/** Files created after the checkpoint, to remove. */
	deletes: string[];
	/** Paths left alone: a link, a non-regular file, or a directory in the way. */
	skipped: string[];
}

export interface Applied {
	written: number;
	deleted: number;
	skipped: string[];
	failed: string[];
}

export const REF_PREFIX = "refs/pi-homeport/rewind";
const ABSENT_MARK = "absent ";
const BATCH = 200;

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

/** Git's environment without the variables that point it at another repository or index. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

export function runGit(args: string[], options: { cwd: string; input?: string | Buffer; env?: Record<string, string> }): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd: options.cwd, env: gitEnv(options.env), stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8").trim() }));
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** The root of the git repository holding `cwd`, resolved through symlinks, or undefined outside one. */
export async function findProject(cwd: string): Promise<string | undefined> {
	const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
	const root = result.stdout.toString("utf8").trim();
	if (result.code !== 0 || !root) return undefined;
	try {
		return fs.realpathSync(root);
	} catch {
		return undefined;
	}
}

/** `file` relative to `root` with forward slashes, or undefined when it's outside the project or
 * inside a `.git` folder. The folder holding it is resolved through symlinks, so a link that leads
 * out of the project doesn't count as inside; the file itself is not, so a symlink stays a symlink. */
export function projectPath(root: string, file: string): string | undefined {
	let dir = path.dirname(path.resolve(file));
	const rest = [path.basename(path.resolve(file))];
	for (;;) {
		try {
			dir = fs.realpathSync(dir);
			break;
		} catch {
			if (path.dirname(dir) === dir) return undefined;
			rest.unshift(path.basename(dir));
			dir = path.dirname(dir);
		}
	}
	const rel = path.relative(root, path.join(dir, ...rest));
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
	const parts = rel.split(path.sep);
	if (parts.some((part) => part.toLowerCase() === ".git" || part === "" || part === "." || part === "..")) return undefined;
	return parts.join("/");
}

type Found = { kind: "missing" } | { kind: "file"; executable: boolean; links: number } | { kind: "other" } | { kind: "unsafe" };

/** What sits at `rel`, walking from the root without following links: a folder on the way that's a
 * link or not a folder makes the path unsafe, since writing there could land outside the project. */
export function inspect(root: string, rel: string): Found {
	const parts = rel.split("/");
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
			return { kind: "unsafe" };
		}
		if (i < parts.length - 1) {
			if (!stat.isDirectory()) return stat.isSymbolicLink() ? { kind: "unsafe" } : { kind: "missing" };
			continue;
		}
		if (stat.isFile()) return { kind: "file", executable: (stat.mode & 0o111) !== 0, links: stat.nlink };
		return { kind: "other" };
	}
	return { kind: "unsafe" };
}

function chunks<T>(items: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
	return out;
}

function storeName(root: string): string {
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
	return `${path.basename(root).replace(/[^\w.-]+/g, "_") || "root"}-${hash}`;
}

/** Remove the stores of projects not used for `days` days, keeping `keep`. Housekeeping only: an
 * error leaves the store in place. */
export function pruneStores(dir: string, days: number, keep?: string): void {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const store = path.join(dir, name);
		if (keep && path.resolve(store) === path.resolve(keep)) continue;
		try {
			const stamp = path.join(store, "last-used");
			if (!fs.existsSync(path.join(store, "HEAD"))) continue;
			if (fs.statSync(fs.existsSync(stamp) ? stamp : store).mtimeMs >= cutoff) continue;
			fs.rmSync(store, { recursive: true, force: true });
		} catch {
			// Left for the next sweep.
		}
	}
}

export class Store {
	readonly root: string;
	readonly gitDir: string;
	private seq = 0;

	constructor(root: string, gitDir: string) {
		this.root = root;
		this.gitDir = gitDir;
	}

	/** The store for the project holding `cwd`, created on first use; undefined outside a git repository. */
	static async open(cwd: string, storesDir: string): Promise<Store | undefined> {
		const root = await findProject(cwd);
		if (!root) return undefined;
		const gitDir = path.join(storesDir, storeName(root));
		if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
			fs.mkdirSync(gitDir, { recursive: true });
			const init = await runGit(["init", "--quiet", "--bare", gitDir], { cwd: storesDir });
			if (init.code !== 0) throw new Error(init.stderr || "git init failed");
			// Nothing here is reachable from a branch, so git must never collect it on its own.
			await runGit(["--git-dir", gitDir, "config", "gc.auto", "0"], { cwd: storesDir });
			fs.writeFileSync(path.join(gitDir, "project"), `${root}\n`);
		}
		// The stamp the sweep in pruneStores reads.
		fs.writeFileSync(path.join(gitDir, "last-used"), "");
		return new Store(root, gitDir);
	}

	private git(args: string[], input?: string | Buffer, env?: Record<string, string>): Promise<GitResult> {
		return runGit(["--git-dir", this.gitDir, ...args], { cwd: this.root, input, env });
	}

	/** Paths the project's own git ignores (its `.gitignore` files, `info/exclude` and the global
	 * excludes; files it tracks are never ignored). A path git can't judge, such as one inside a
	 * nested repository, counts as ignored, so it's never tracked or restored. */
	async ignored(rels: string[]): Promise<Set<string>> {
		const ignored = new Set<string>();
		for (const batch of chunks(rels)) {
			const result = await runGit(["check-ignore", "-z", "--stdin"], { cwd: this.root, input: `${batch.join("\0")}\0` });
			if (result.code === 0) for (const rel of result.stdout.toString("utf8").split("\0")) if (rel) ignored.add(rel);
			if (result.code === 0 || result.code === 1) continue;
			for (const rel of batch) {
				const one = await runGit(["check-ignore", "-q", "--", rel], { cwd: this.root });
				if (one.code !== 1) ignored.add(rel);
			}
		}
		return ignored;
	}

	/** Blob ids of files on disk; `write` stores them in the shadow. Read raw, without git's filters. */
	private async hash(rels: string[], write: boolean): Promise<string[] | undefined> {
		const ids: string[] = [];
		for (const batch of chunks(rels)) {
			const args = ["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--", ...batch.map((rel) => path.join(this.root, rel))];
			const result = await this.git(args);
			if (result.code !== 0) return undefined;
			ids.push(...result.stdout.toString("utf8").split("\n").filter(Boolean));
		}
		return ids.length === rels.length ? ids : undefined;
	}

	/** The current state of these files, stored in the shadow. Links and other non-regular files are left out. */
	async read(rels: string[]): Promise<Snapshot | undefined> {
		const states: Snapshot = new Map();
		const files: { rel: string; executable: boolean }[] = [];
		for (const rel of rels) {
			const found = inspect(this.root, rel);
			if (found.kind === "missing") states.set(rel, null);
			else if (found.kind === "file") files.push({ rel, executable: found.executable });
		}
		const ids = await this.hash(
			files.map((file) => file.rel),
			true,
		);
		if (!ids) return undefined;
		files.forEach((file, i) => states.set(file.rel, { blob: ids[i], executable: file.executable }));
		return states;
	}

	/** Save a snapshot as a commit under a new ref (or `ref`, moving it), and return the ref. */
	async save(snapshot: Snapshot, kind: string, ref?: string): Promise<string | undefined> {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-"));
		try {
			const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
			const entries: string[] = [];
			const absent: string[] = [];
			for (const [rel, state] of snapshot) {
				if (state) entries.push(`${state.executable ? "100755" : "100644"} ${state.blob}\t${rel}\0`);
				else absent.push(rel);
			}
			if (entries.length > 0 && (await this.git(["update-index", "-z", "--index-info"], entries.join(""), env)).code !== 0) return undefined;
			const tree = await this.git(["write-tree"], undefined, env);
			if (tree.code !== 0) return undefined;
			const date = new Date().toISOString();
			const who = { GIT_AUTHOR_NAME: "pi-homeport", GIT_AUTHOR_EMAIL: "rewind@pi-homeport", GIT_COMMITTER_NAME: "pi-homeport", GIT_COMMITTER_EMAIL: "rewind@pi-homeport" };
			const message = [kind, "", ...absent.map((rel) => `${ABSENT_MARK}${JSON.stringify(rel)}`), ""].join("\n");
			const commit = await this.git(["-c", "commit.gpgsign=false", "commit-tree", tree.stdout.toString("utf8").trim()], message, {
				...who,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			});
			if (commit.code !== 0) return undefined;
			const name = ref ?? `${REF_PREFIX}/${Date.now().toString(36)}-${process.pid.toString(36)}-${(++this.seq).toString(36)}`;
			const update = await this.git(["update-ref", name, commit.stdout.toString("utf8").trim()]);
			return update.code === 0 ? name : undefined;
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	/** Snapshot the files as they are now, under a new ref. */
	async checkpoint(rels: string[], kind = "checkpoint"): Promise<string | undefined> {
		const snapshot = await this.read(rels);
		return snapshot ? this.save(snapshot, kind) : undefined;
	}

	/** The snapshot a ref holds, or undefined when the ref is gone (pruned, or from another project). */
	async load(ref: string): Promise<Snapshot | undefined> {
		const commit = await this.git(["cat-file", "commit", `${ref}^{commit}`]);
		if (commit.code !== 0) return undefined;
		const tree = await this.git(["ls-tree", "-r", "-z", ref]);
		if (tree.code !== 0) return undefined;
		const snapshot: Snapshot = new Map();
		for (const record of tree.stdout.toString("utf8").split("\0")) {
			const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(record);
			if (match) snapshot.set(match[3], { blob: match[2], executable: match[1] === "100755" });
		}
		const text = commit.stdout.toString("utf8");
		for (const line of text.slice(text.indexOf("\n\n") + 2).split("\n")) {
			if (!line.startsWith(ABSENT_MARK)) continue;
			try {
				const rel: unknown = JSON.parse(line.slice(ABSENT_MARK.length));
				if (typeof rel === "string" && !snapshot.has(rel)) snapshot.set(rel, null);
			} catch {
				// A line this version didn't write.
			}
		}
		return snapshot;
	}

	/** Add a file's state before its first edit to the checkpoint `ref` stands for, when the ref
	 * doesn't hold it yet: the file was untouched until now, so this is its state at the checkpoint. */
	async extend(ref: string, rel: string): Promise<boolean> {
		const snapshot = await this.load(ref);
		if (!snapshot) return false;
		if (snapshot.has(rel)) return true;
		const now = await this.read([rel]);
		const state = now?.get(rel);
		if (state === undefined) return false;
		snapshot.set(rel, state);
		return (await this.save(snapshot, "checkpoint", ref)) !== undefined;
	}

	/** What restoring `target` would change on disk now. Paths ignored by the project's git are
	 * dropped; links, hard-linked files, non-regular files and paths through a link are skipped, as
	 * Claude Code does. */
	async plan(target: Snapshot): Promise<Plan> {
		const plan: Plan = { writes: [], deletes: [], skipped: [] };
		// A path that no longer leads to the same place inside the project (a folder on the way became a
		// link) is skipped, never followed.
		const valid: string[] = [];
		for (const rel of target.keys()) {
			if (projectPath(this.root, path.join(this.root, ...rel.split("/"))) === rel) valid.push(rel);
			else plan.skipped.push(rel);
		}
		const ignored = await this.ignored(valid);
		const compare: { rel: string; blob: string; executable: boolean; found: Found & { kind: "file" } }[] = [];
		for (const rel of valid) {
			if (ignored.has(rel)) continue;
			const state = target.get(rel) ?? null;
			const found = inspect(this.root, rel);
			if (found.kind === "unsafe" || found.kind === "other") plan.skipped.push(rel);
			else if (found.kind === "missing") {
				if (state) plan.writes.push({ rel, ...state });
			} else if (!state) {
				if (found.links > 1) plan.skipped.push(rel);
				else plan.deletes.push(rel);
			} else compare.push({ rel, ...state, found });
		}
		const ids = await this.hash(
			compare.map((item) => item.rel),
			false,
		);
		compare.forEach((item, i) => {
			if (ids && ids[i] === item.blob && item.found.executable === item.executable) return;
			if (item.found.links > 1 || !ids) plan.skipped.push(item.rel);
			else plan.writes.push({ rel: item.rel, blob: item.blob, executable: item.executable });
		});
		return plan;
	}

	/** Carry out a plan. Each path is checked again right before it's touched, and written without
	 * following a link, so nothing outside the project is ever written or deleted. */
	async apply(plan: Plan): Promise<Applied> {
		const applied: Applied = { written: 0, deleted: 0, skipped: [...plan.skipped], failed: [] };
		for (const rel of plan.deletes) {
			const found = inspect(this.root, rel);
			if (found.kind === "missing") continue;
			if (found.kind !== "file" || found.links > 1) {
				applied.skipped.push(rel);
				continue;
			}
			try {
				fs.unlinkSync(path.join(this.root, ...rel.split("/")));
				applied.deleted++;
			} catch {
				applied.failed.push(rel);
			}
		}
		for (const write of plan.writes) {
			const content = await this.git(["cat-file", "blob", write.blob]);
			if (content.code !== 0) {
				applied.failed.push(write.rel);
				continue;
			}
			const result = this.writeFile(write.rel, content.stdout, write.executable);
			if (result === "written") applied.written++;
			else applied[result].push(write.rel);
		}
		return applied;
	}

	private writeFile(rel: string, content: Buffer, executable: boolean): "written" | "skipped" | "failed" {
		const parts = rel.split("/");
		let dir = this.root;
		for (const part of parts.slice(0, -1)) {
			dir = path.join(dir, part);
			try {
				const stat = fs.lstatSync(dir);
				if (!stat.isDirectory()) return "skipped";
			} catch {
				try {
					fs.mkdirSync(dir);
				} catch {
					return "failed";
				}
			}
		}
		const file = path.join(dir, parts[parts.length - 1]);
		const found = inspect(this.root, rel);
		if (found.kind === "unsafe" || found.kind === "other" || (found.kind === "file" && found.links > 1)) return "skipped";
		let fd: number | undefined;
		try {
			const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);
			fd = fs.openSync(file, flags, executable ? 0o755 : 0o644);
			fs.writeSync(fd, content);
			const mode = fs.fstatSync(fd).mode & 0o7777;
			const wanted = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
			if (wanted !== mode) fs.fchmodSync(fd, wanted);
			return "written";
		} catch {
			return "failed";
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	/** Delete checkpoints older than `days` days, then drop what no checkpoint needs any more. */
	async prune(days: number): Promise<number> {
		const listed = await this.git(["for-each-ref", "--format=%(refname) %(committerdate:unix)", REF_PREFIX]);
		if (listed.code !== 0) return 0;
		const cutoff = Date.now() / 1000 - days * 24 * 60 * 60;
		const stale = listed.stdout
			.toString("utf8")
			.split("\n")
			.map((line) => line.split(" "))
			.filter(([ref, time]) => ref && Number(time) < cutoff)
			.map(([ref]) => ref);
		if (stale.length === 0) return 0;
		await this.git(["update-ref", "--stdin"], stale.map((ref) => `delete ${ref}\n`).join(""));
		// Objects younger than a day stay: another session may be writing a checkpoint right now.
		await this.git(["gc", "--quiet", "--prune=1.day.ago"]);
		return stale.length;
	}
}
