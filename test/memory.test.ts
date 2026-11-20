import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { indexState, loadedIndex, projectSlug, readAutoMemory, repositoryRoot, stampModified } from "../extensions/memory/auto.ts";
import { importsIn, Instructions, laterFileLimit, stripComments } from "../extensions/memory/instructions.ts";
import { readClaudeSetup } from "../extensions/shared/claude.ts";

let base: string;
let home: string;
let project: string;

function write(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function setup(options: { cwd?: string; env?: Record<string, string> } = {}) {
	return readClaudeSetup({ cwd: options.cwd ?? project, trusted: true, home, env: options.env ?? {}, managedSettingsDir: path.join(base, "managed") });
}

function load(cwd = project) {
	return new Instructions(setup({ cwd }), { cwd, home });
}

/** Loaded files as paths relative to the temporary folder. */
function paths(files: { path: string }[]) {
	return files.map((file) => path.relative(base, file.path));
}

function userSettings(value: unknown) {
	write(path.join(home, ".claude", "settings.json"), value);
}

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-memory-"));
	home = path.join(base, "home");
	project = path.join(base, "work", "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("instruction files at launch", () => {
	it("loads managed, user, then each folder from the top down, in Claude's order", () => {
		write(path.join(base, "managed", "CLAUDE.md"), "managed");
		write(path.join(base, "managed", "managed-settings.json"), { claudeMd: "managed key" });
		write(path.join(home, ".claude", "CLAUDE.md"), "user");
		write(path.join(home, ".claude", "rules", "style.md"), "user rule");
		write(path.join(base, "work", "CLAUDE.md"), "parent");
		write(path.join(project, "CLAUDE.local.md"), "local");
		write(path.join(project, "CLAUDE.md"), "project");
		write(path.join(project, ".claude", "CLAUDE.md"), "dot claude");
		write(path.join(project, ".claude", "rules", "b", "two.md"), "rule two");
		write(path.join(project, ".claude", "rules", "a.md"), "rule a");
		const result = load();
		assert.deepEqual(paths(result.files), [
			"managed/CLAUDE.md",
			"managed/managed-settings.json (claudeMd)",
			"home/.claude/CLAUDE.md",
			"home/.claude/rules/style.md",
			"work/CLAUDE.md",
			"work/project/CLAUDE.md",
			"work/project/.claude/CLAUDE.md",
			"work/project/.claude/rules/a.md",
			"work/project/.claude/rules/b/two.md",
			"work/project/CLAUDE.local.md",
		]);
	});

	it("reads AGENTS.md only when no CLAUDE.md is on the path, by default", () => {
		write(path.join(project, "AGENTS.md"), "agents");
		write(path.join(project, ".claude", "AGENTS.md"), "dot agents");
		assert.deepEqual(paths(load().files), ["work/project/AGENTS.md", "work/project/.claude/AGENTS.md"]);
		write(path.join(base, "work", "CLAUDE.local.md"), "local");
		assert.deepEqual(paths(load().files), ["work/CLAUDE.local.md"]);
	});

	it("follows Claude's Project instructions setting", () => {
		write(path.join(project, "AGENTS.md"), "agents");
		write(path.join(project, "CLAUDE.md"), "claude");
		const mode = (value: string) => userSettings({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: value } } } });
		mode("claude-md-and-agents-md");
		assert.deepEqual(paths(load().files), ["work/project/CLAUDE.md", "work/project/AGENTS.md"]);
		write(path.join(project, ".claude", "settings.json"), { pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md" } } } });
		assert.deepEqual(paths(load().files), ["work/project/CLAUDE.md", "work/project/AGENTS.md"], "project settings can't change it");
		mode("claude-md");
		fs.rmSync(path.join(project, "CLAUDE.md"));
		assert.deepEqual(paths(load().files), []);
		write(path.join(base, "managed", "CLAUDE.md"), "managed");
		write(path.join(project, "CLAUDE.md"), "claude");
		mode("managed-only");
		assert.deepEqual(paths(load().files), ["managed/CLAUDE.md"]);
	});

	it("treats ~/.claude as user scope when the project is inside home", () => {
		const inHome = path.join(home, "code", "app");
		fs.mkdirSync(path.join(inHome, ".git"), { recursive: true });
		write(path.join(home, ".claude", "CLAUDE.md"), "user");
		write(path.join(home, ".claude", "rules", "scoped.md"), "---\npaths: '*.ts'\n---\nScoped\n");
		write(path.join(inHome, "AGENTS.md"), "agents");
		const result = load(inHome);
		assert.deepEqual(paths(result.files), ["home/.claude/CLAUDE.md", "home/code/app/AGENTS.md"]);
		assert.deepEqual(result.waitingRules().length, 1);
	});

	it("loads a file reached twice once", () => {
		write(path.join(project, "AGENTS.md"), "shared");
		fs.symlinkSync("AGENTS.md", path.join(project, "CLAUDE.md"));
		userSettings({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } });
		assert.deepEqual(paths(load().files), ["work/project/CLAUDE.md"]);
	});

	it("skips files claudeMdExcludes names, but never the managed file", () => {
		write(path.join(base, "managed", "CLAUDE.md"), "managed");
		write(path.join(base, "work", "CLAUDE.md"), "parent");
		write(path.join(project, "CLAUDE.md"), "project");
		userSettings({ claudeMdExcludes: ["**/work/CLAUDE.md", "**/managed/CLAUDE.md"] });
		const result = load();
		assert.deepEqual(paths(result.files), ["managed/CLAUDE.md", "work/project/CLAUDE.md"]);
		assert.deepEqual(paths(result.skipped), ["work/CLAUDE.md"]);
	});

	it("drops block-level HTML comments outside code blocks", () => {
		assert.equal(stripComments("a\n<!-- note\nmore -->\nb <!-- inline -->\n```\n<!-- kept -->\n```\n"), "a\nb <!-- inline -->\n```\n<!-- kept -->\n```\n");
	});

	it("leaves rules with paths for later, and strips rule frontmatter", () => {
		write(path.join(project, ".claude", "rules", "api.md"), '---\npaths:\n  - "src/api/**/*.ts"\n---\n\nAPI rule\n');
		write(path.join(project, ".claude", "rules", "plain.md"), "---\nother: 1\n---\nPlain rule\n");
		const result = load();
		assert.deepEqual(paths(result.files), ["work/project/.claude/rules/plain.md"]);
		assert.equal(result.files[0]?.content, "Plain rule\n");
		assert.deepEqual(paths(result.waitingRules().map((file) => ({ path: file }))), ["work/project/.claude/rules/api.md"]);
	});
});

describe("imports", () => {
	it("finds imports outside code, with escaped spaces, and leaves quoted paths", () => {
		assert.deepEqual(importsIn('See @README and @docs/a.md.\n`@skip` "@quoted"\n```\n@fenced\n```\n- @Design\\ Docs/x.md\n@"no"\n'), [
			"README",
			"docs/a.md.",
			"Design Docs/x.md",
		]);
	});

	it("loads imports before the importer, relative to it, up to four hops", () => {
		write(path.join(project, "CLAUDE.md"), "@docs/one.md\nProject");
		write(path.join(project, "docs", "one.md"), "@two.md");
		write(path.join(project, "docs", "two.md"), "@three.md");
		write(path.join(project, "docs", "three.md"), "@four.md");
		write(path.join(project, "docs", "four.md"), "@five.md");
		write(path.join(project, "docs", "five.md"), "too deep");
		assert.deepEqual(paths(load().files), [
			"work/project/docs/four.md",
			"work/project/docs/three.md",
			"work/project/docs/two.md",
			"work/project/docs/one.md",
			"work/project/CLAUDE.md",
		]);
	});

	it("tolerates punctuation after an import", () => {
		write(path.join(project, "CLAUDE.md"), "Read @notes.md, then start.");
		write(path.join(project, "notes.md"), "notes");
		assert.deepEqual(paths(load().files), ["work/project/notes.md", "work/project/CLAUDE.md"]);
	});

	it("loads a project file's import from outside the working directory only once Claude approved it", () => {
		write(path.join(project, "CLAUDE.md"), "@~/mine.md");
		write(path.join(home, "mine.md"), "mine");
		const blocked = load();
		assert.deepEqual(paths(blocked.files), ["work/project/CLAUDE.md"]);
		assert.match(blocked.skipped[0]?.reason ?? "", /not approved/);
		write(path.join(home, ".claude.json"), { projects: { [project]: { hasClaudeMdExternalIncludesApproved: true } } });
		assert.deepEqual(paths(load().files), ["home/mine.md", "work/project/CLAUDE.md"]);
	});

	it("lets the user's own file import from anywhere", () => {
		write(path.join(home, ".claude", "CLAUDE.md"), "@~/mine.md");
		write(path.join(home, "mine.md"), "mine");
		assert.deepEqual(paths(load().files), ["home/mine.md", "home/.claude/CLAUDE.md"]);
	});
});

describe("instruction files that load later", () => {
	it("loads a subfolder's files once a file in it is touched, outer folders first", () => {
		write(path.join(project, "apps", "CLAUDE.md"), "apps");
		write(path.join(project, "apps", "web", "CLAUDE.local.md"), "web local");
		write(path.join(project, "apps", "web", ".claude", "rules", "r.md"), "web rule");
		const result = load();
		assert.deepEqual(paths(result.touched(path.join(project, "apps", "web", "src", "a.ts"), "edit", 40_000)), [
			"work/project/apps/CLAUDE.md",
			"work/project/apps/web/.claude/rules/r.md",
			"work/project/apps/web/CLAUDE.local.md",
		]);
		assert.deepEqual(result.touched(path.join(project, "apps", "web", "b.ts"), "read", 40_000), []);
	});

	it("loads a rule with paths when a matching file is touched", () => {
		write(path.join(project, ".claude", "rules", "api.md"), '---\npaths: "src/api/**/*.ts, /*.md"\n---\nAPI rule\n');
		write(path.join(home, ".claude", "rules", "tests.md"), "---\npaths:\n  - '*.test.ts'\n---\nTest rule\n");
		const result = load();
		assert.deepEqual(result.touched(path.join(project, "src", "web", "a.ts"), "read", 40_000), []);
		assert.deepEqual(paths(result.touched(path.join(project, "README.md"), "read", 40_000)), ["work/project/.claude/rules/api.md"]);
		assert.deepEqual(result.touched(path.join(project, "docs", "x.md"), "read", 40_000), [], "/*.md matches the top folder only");
		assert.deepEqual(paths(result.touched(path.join(project, "lib", "a.test.ts"), "read", 40_000)), ["home/.claude/rules/tests.md"]);
	});

	it("reads a subfolder's AGENTS.md on a read, when the folder has no CLAUDE.md", () => {
		write(path.join(project, "AGENTS.md"), "root");
		write(path.join(project, "a", "AGENTS.md"), "a");
		write(path.join(project, "b", "AGENTS.md"), "b");
		write(path.join(project, "b", "CLAUDE.md"), "b claude");
		write(path.join(project, "c", "AGENTS.md"), "c");
		const result = load();
		assert.deepEqual(paths(result.touched(path.join(project, "a", "x.ts"), "read", 40_000)), ["work/project/a/AGENTS.md"]);
		assert.deepEqual(paths(result.touched(path.join(project, "b", "x.ts"), "read", 40_000)), ["work/project/b/CLAUDE.md"]);
		assert.deepEqual(result.touched(path.join(project, "c", "x.ts"), "write", 40_000), []);
	});

	it("cuts a long file with a note to read the rest", () => {
		write(path.join(project, "big", "CLAUDE.md"), "x".repeat(50));
		const [file] = load().touched(path.join(project, "big", "a.ts"), "read", 10);
		assert.match(file?.content ?? "", /^x{10}\n\n\[This file is longer than what loads automatically\. Read .*big\/CLAUDE\.md for the rest\.\]$/);
		assert.equal(laterFileLimit(200_000), 40_000);
		assert.equal(laterFileLimit(1_000_000), 150_000);
	});
});

describe("auto memory", () => {
	it("keeps memories in Claude's folder for the repository", () => {
		const memory = readAutoMemory(setup({ cwd: path.join(project, "src") }), path.join(project, "src"), home);
		assert.equal(memory.enabled, true);
		assert.equal(memory.dir, path.join(home, ".claude", "projects", projectSlug(project), "memory"));
		assert.equal(projectSlug("/Users/me/Projects/sohedra/sohedra"), "-Users-me-Projects-sohedra-sohedra");
		assert.match(projectSlug(`/${"a".repeat(250)}`), /^-a{199}-[0-9a-z]+$/);
	});

	it("shares one folder across a repository's worktrees", () => {
		const worktree = path.join(base, "worktree");
		const gitDir = path.join(project, ".git", "worktrees", "feature");
		write(path.join(gitDir, "commondir"), "../..\n");
		write(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
		assert.equal(repositoryRoot(path.join(worktree, "src")), project);
	});

	it("follows autoMemoryDirectory, autoMemoryEnabled and CLAUDE_CODE_DISABLE_AUTO_MEMORY", () => {
		userSettings({ autoMemoryDirectory: "~/notes", autoMemoryEnabled: false });
		assert.deepEqual(readAutoMemory(setup(), project, home), { enabled: false, disabledBy: "autoMemoryEnabled: false", dir: path.join(home, "notes"), truncated: false });
		assert.equal(readAutoMemory(setup({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } }), project, home).enabled, true);
		userSettings({ autoMemoryDirectory: "relative/ignored" });
		assert.equal(readAutoMemory(setup({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } }), project, home).disabledBy, "CLAUDE_CODE_DISABLE_AUTO_MEMORY");
		assert.equal(readAutoMemory(setup(), project, home).dir, path.join(home, ".claude", "projects", projectSlug(project), "memory"));
	});

	it("loads the first 200 lines or 25KB of the index", () => {
		const lines = Array.from({ length: 250 }, (_, i) => `- line ${i}`).join("\n");
		const loaded = loadedIndex(lines);
		assert.equal(loaded.text.split("\n").length, 200);
		assert.equal(loaded.truncated, true);
		assert.equal(loadedIndex("x".repeat(30_000)).text, "");
		assert.equal(indexState(lines), "over");
		assert.equal(indexState(Array.from({ length: 185 }, () => "-").join("\n")), "near");
		assert.equal(indexState("- one\n"), "ok");
	});

	it("reads the index from the memory folder", () => {
		write(path.join(home, ".claude", "projects", projectSlug(project), "memory", "MEMORY.md"), "- [A](a.md) — a\n");
		assert.equal(readAutoMemory(setup(), project, home).index, "- [A](a.md) — a");
	});

	it("stamps modified inside metadata, at the top level, or where it already is", () => {
		assert.equal(
			stampModified("---\nname: a\nmetadata:\n  type: user\n---\nbody", "T"),
			"---\nname: a\nmetadata:\n  type: user\n  modified: T\n---\nbody",
		);
		assert.equal(stampModified("---\nname: a\n---\nbody", "T"), "---\nname: a\nmodified: T\n---\nbody");
		assert.equal(stampModified("---\nmetadata:\n  modified: old\n  type: x\n---\n", "T"), "---\nmetadata:\n  modified: T\n  type: x\n---\n");
		assert.equal(stampModified("no frontmatter", "T"), "no frontmatter");
	});
});
