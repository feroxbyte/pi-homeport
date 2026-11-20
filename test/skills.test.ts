import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCatalog } from "../extensions/skills/catalog.ts";
import { activates, claudeSkills, pluginListingCost } from "../extensions/skills/discover.ts";
import { saveHidden, saveOverride } from "../extensions/skills/toggles.ts";
import { DISABLED_NOTICE, type ExpandOptions, expandSkill, readsWholeFile, splitArguments } from "../extensions/skills/expand.ts";
import { bashRules, checkCommand, matchesRule, splitCommand, splitRules, stripWrappers } from "../extensions/skills/permissions.ts";
import { defaultManagedSettingsDir, installedPlugins, readClaudeSetup, updateSettingsFile } from "../extensions/shared/claude.ts";

let base: string;
let home: string;
let project: string;

function write(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function skill(dir: string, name: string, extra = "") {
	write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n${extra}---\n\nDo ${name}.\n`);
}

function discover(trusted = true) {
	return claudeSkills({ cwd: project, trusted, home, env: {}, managedSettingsDir: path.join(base, "managed") });
}

function names(result: ReturnType<typeof discover>) {
	return result.skills.map((entry) => `${entry.name} (${entry.source})`);
}

function installPlugin(id: string, record: { scope: string; projectPath?: string }, files: Record<string, unknown>) {
	const [name, marketplace] = id.split("@") as [string, string];
	const installPath = path.join(home, ".claude", "plugins", "cache", marketplace, name, "1.0.0");
	for (const [file, value] of Object.entries(files)) write(path.join(installPath, file), value);
	const indexFile = path.join(home, ".claude", "plugins", "installed_plugins.json");
	const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : { version: 2, plugins: {} };
	index.plugins[id] = [...(index.plugins[id] ?? []), { ...record, installPath }];
	write(indexFile, index);
	return installPath;
}

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skills-"));
	home = path.join(base, "home");
	project = path.join(base, "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("managed settings", () => {
	it("uses each platform's folder", () => {
		assert.equal(defaultManagedSettingsDir("darwin"), "/Library/Application Support/ClaudeCode");
		assert.equal(defaultManagedSettingsDir("linux"), "/etc/claude-code");
		assert.equal(defaultManagedSettingsDir("win32"), "C:\\Program Files\\ClaudeCode");
	});

	it("merges managed-settings.json, then managed-settings.d in alphabetical order, above the user's settings", () => {
		const managed = path.join(base, "managed");
		write(path.join(home, ".claude", "settings.json"), { key: "user" });
		write(path.join(managed, "managed-settings.json"), { key: "file" });
		write(path.join(managed, "managed-settings.d", "20-b.json"), { key: "20" });
		write(path.join(managed, "managed-settings.d", "10-a.json"), { key: "10" });
		write(path.join(managed, "managed-settings.d", ".hidden.json"), { key: "hidden" });
		const setup = readClaudeSetup({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: managed });
		assert.deepEqual(
			setup.settings.map((file) => file.key),
			["user", "file", "10", "20"],
		);
	});
});

describe("discovering skills", () => {
	it("loads personal, project, plugin and claude.ai skills in Claude's order", () => {
		skill(path.join(home, ".claude", "skills", "mine"), "mine");
		skill(path.join(project, ".claude", "skills", "ours"), "ours");
		installPlugin("tools@m", { scope: "user" }, { "skills/wrangler/SKILL.md": "---\nname: wrangler\ndescription: Wrangler\n---\nUse it." });
		skill(path.join(home, ".claude", "skills", "synced", "account", "pdf"), "pdf");
		assert.deepEqual(names(discover()), ["mine (personal)", "ours (project)", "wrangler (plugin tools@m)", "pdf (claude.ai)"]);
	});

	it("reads project skills from parent folders up to the repository root", () => {
		skill(path.join(project, ".claude", "skills", "root"), "root");
		const sub = path.join(project, "packages", "app");
		skill(path.join(sub, ".claude", "skills", "nested"), "nested");
		const result = claudeSkills({ cwd: sub, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") });
		assert.deepEqual(names(result), ["nested (project)", "root (project)"]);
	});

	it("ignores project skills when pi doesn't trust the project", () => {
		skill(path.join(project, ".claude", "skills", "ours"), "ours");
		assert.deepEqual(names(discover(false)), []);
	});

	it("lets a personal skill win over a project skill with the same name", () => {
		skill(path.join(home, ".claude", "skills", "deploy"), "deploy");
		skill(path.join(project, ".claude", "skills", "deploy"), "deploy");
		const result = discover();
		assert.deepEqual(names(result), ["deploy (personal)"]);
		assert.match(result.skipped[0]?.reason ?? "", /same name loads from personal/);
	});

	it("loads a symlinked skill once", () => {
		const target = path.join(base, "agents", "shared");
		skill(target, "shared");
		fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
		fs.mkdirSync(path.join(project, ".claude", "skills"), { recursive: true });
		fs.symlinkSync(target, path.join(home, ".claude", "skills", "shared"));
		fs.symlinkSync(target, path.join(project, ".claude", "skills", "shared"));
		const result = discover();
		assert.deepEqual(names(result), ["shared (personal)"]);
		assert.deepEqual(result.skipped, []);
	});

	it("skips folders Claude skips: synced at the top level, anthropic-skills, plugin folders", () => {
		const skills = path.join(home, ".claude", "skills");
		skill(path.join(skills, "anthropic-skills-x"), "anthropic-skills-x");
		skill(path.join(skills, "with-plugin"), "with-plugin");
		write(path.join(skills, "with-plugin", ".claude-plugin", "plugin.json"), { name: "p" });
		assert.deepEqual(names(discover()), []);
	});

	it("skips claude.ai skills built around Claude-only tools", () => {
		const synced = path.join(home, ".claude", "skills", "synced", "account");
		skill(path.join(synced, "computer-use"), "computer-use");
		skill(path.join(synced, "xlsx"), "xlsx");
		const result = discover();
		assert.deepEqual(names(result), ["xlsx (claude.ai)"]);
		assert.match(result.skipped[0]?.reason ?? "", /only Claude Code has/);
	});

	it("skips plugins installed only for another project", () => {
		installPlugin("expo@m", { scope: "project", projectPath: path.join(base, "other") }, { "skills/expo-ui/SKILL.md": "---\nname: expo-ui\ndescription: x\n---\n" });
		assert.deepEqual(names(discover()), []);
	});

	it("reads the folders a plugin manifest names, whether a skill or a folder of skills", () => {
		installPlugin("matt@m", { scope: "user" }, {
			".claude-plugin/plugin.json": { name: "matt", skills: ["./skills/engineering/tdd", "./more"] },
			"skills/engineering/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\n---\n",
			"skills/deprecated/old/SKILL.md": "---\nname: old\ndescription: Not declared\n---\n",
			"more/extra/SKILL.md": "---\nname: extra\ndescription: Extra\n---\n",
		});
		assert.deepEqual(names(discover()), ["tdd (plugin matt@m)", "extra (plugin matt@m)"]);
	});

	it("loads a SKILL.md at a plugin root only when it has a name", () => {
		installPlugin("one@m", { scope: "user" }, { "SKILL.md": "---\nname: one-skill\ndescription: One\n---\n" });
		installPlugin("two@m", { scope: "user" }, { "SKILL.md": "---\ndescription: Two\n---\n" });
		const result = discover();
		assert.deepEqual(names(result), ["one-skill (plugin one@m)"]);
		assert.match(result.skipped[0]?.reason ?? "", /version folder/);
	});

	it("skips names pi can't take and skills without a description", () => {
		skill(path.join(home, ".claude", "skills", "a"), "tools:deploy");
		write(path.join(home, ".claude", "skills", "b", "SKILL.md"), "---\nname: b\n---\nBody only.\n");
		const result = discover();
		assert.deepEqual(names(result), []);
		assert.deepEqual(
			result.skipped.map((entry) => entry.name),
			["tools:deploy", "b"],
		);
	});

	it("lists Claude fields pi-homeport doesn't act on", () => {
		skill(path.join(home, ".claude", "skills", "fork"), "fork", "context: fork\nmodel: opus\nargument-hint: '[issue]'\n");
		assert.deepEqual(discover().skills[0]?.unsupported, [
			"context/agent: runs the skill in a subagent, which needs pi-homeport's agents support",
			"argument-hint: pi's commands can't show argument hints",
		]);
	});

	it("loads managed skills first", () => {
		skill(path.join(base, "managed", ".claude", "skills", "deploy"), "deploy");
		skill(path.join(home, ".claude", "skills", "deploy"), "deploy");
		assert.deepEqual(names(discover()), ["deploy (managed)"]);
	});

	it("finds nested skills below the working directory, waiting for a file there", () => {
		skill(path.join(project, ".claude", "skills", "root"), "root");
		skill(path.join(project, "apps", "web", ".claude", "skills", "web-deploy"), "web-deploy");
		spawnSync("git", ["init", "-q"], { cwd: project });
		const result = discover();
		assert.deepEqual(names(result), ["root (project)", "web-deploy (nested)"]);
		const nested = result.skills[1];
		assert.equal(nested?.activation?.dir, path.join(project, "apps", "web"));
		assert.ok(nested && activates(nested, path.join(project, "apps", "web", "src", "a.ts"), project));
		assert.ok(nested && !activates(nested, path.join(project, "apps", "api", "a.ts"), project));
	});

	it("activates a paths skill for matching files only", () => {
		skill(path.join(home, ".claude", "skills", "sql"), "sql", "paths:\n  - 'db/**/*.sql'\n  - '*.prisma'\n");
		const sql = discover().skills[0];
		assert.ok(sql);
		assert.equal(activates(sql, path.join(project, "db", "migrations", "1.sql"), project), true);
		assert.equal(activates(sql, path.join(project, "prisma", "schema.prisma"), project), true);
		assert.equal(activates(sql, path.join(project, "src", "a.ts"), project), false);
	});

	it("follows skillOverrides, except for plugin skills", () => {
		const skills = path.join(home, ".claude", "skills");
		for (const name of ["gone", "user-only", "short", "plain"]) skill(path.join(skills, name), name);
		installPlugin("tools@m", { scope: "user" }, { "skills/gone/SKILL.md": "---\nname: gone\ndescription: Plugin gone\n---\n" });
		write(path.join(home, ".claude", "settings.json"), { skillOverrides: { gone: "off", "user-only": "user-invocable-only", short: "name-only" } });
		const result = discover();
		const visibility = Object.fromEntries(result.skills.map((entry) => [`${entry.name} (${entry.source})`, entry.modelVisibility]));
		assert.deepEqual(visibility, { "plain (personal)": "full", "short (personal)": "name-only", "user-only (personal)": "hidden", "gone (plugin tools@m)": "full" });
		assert.match(result.skipped[0]?.reason ?? "", /skillOverrides turns it off/);
	});

	it("hides skills a Skill deny rule names, by name, namespace or parameter form", () => {
		const skills = path.join(home, ".claude", "skills");
		for (const name of ["deploy", "review", "keep"]) skill(path.join(skills, name), name);
		skill(path.join(home, ".claude", "skills", "synced", "account", "pdf"), "pdf");
		installPlugin("tools@m", { scope: "user" }, { "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lint\n---\n" });
		write(path.join(home, ".claude", "settings.json"), {
			permissions: { deny: ["Skill(deploy *)", "Skill(skill:review)", "Skill(anthropic-skills *)", "Skill(tools:lint)"] },
		});
		const hidden = discover()
			.skills.filter((entry) => entry.modelVisibility === "hidden")
			.map((entry) => entry.name);
		assert.deepEqual(hidden, ["deploy", "review", "lint", "pdf"]);
	});

	it("adds when_to_use to the listed description and gives Claude's qualified names", () => {
		installPlugin("tools@m", { scope: "user" }, { "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lint code\nwhen_to_use: Before a commit\nuser-invocable: no\n---\n" });
		skill(path.join(home, ".claude", "skills", "synced", "account", "pdf"), "pdf");
		const [lint, pdf] = discover().skills;
		assert.equal(lint?.listingDescription, "Lint code\nBefore a commit");
		assert.deepEqual(lint?.qualifiedNames, ["tools:lint"]);
		assert.equal(lint?.userInvocable, false);
		assert.deepEqual(pdf?.qualifiedNames, ["anthropic-skills:pdf"]);
	});
});

describe("expanding skills", () => {
	const ran: string[] = [];
	function options(body: string, extra: Partial<ExpandOptions> = {}): ExpandOptions {
		return {
			body,
			args: undefined,
			argumentNames: [],
			variables: { CLAUDE_SKILL_DIR: "/skills/x", CLAUDE_SESSION_ID: "s1" },
			shell: "run",
			runCommand: async (command) => {
				ran.push(command);
				return { ok: true, output: `<${command}>` };
			},
			...extra,
		};
	}
	beforeEach(() => {
		ran.length = 0;
	});

	it("fills in $ARGUMENTS, $ARGUMENTS[N] and $N", async () => {
		const result = await expandSkill(options("Fix $ARGUMENTS. Move $ARGUMENTS[0] from $1 to $2.", { args: 'Search "Java Script" TS' }));
		assert.deepEqual(result, { ok: true, changed: true, text: 'Fix Search "Java Script" TS. Move Search from Java Script to TS.' });
	});

	it("fills in named arguments, and an empty string for a missing one", async () => {
		const result = await expandSkill(options("Issue $issue on $branch.", { args: "42", argumentNames: ["issue", "branch"] }));
		assert.equal(result.ok && result.text, "Issue 42 on .");
	});

	it("keeps an indexed placeholder without an argument, and appends ARGUMENTS when nothing received them", async () => {
		const result = await expandSkill(options("Costs $3.", { args: "x" }));
		assert.equal(result.ok && result.text, "Costs $3.\n\nARGUMENTS: x");
	});

	it("keeps \\$1 literal and never expands text that came from an argument", async () => {
		const result = await expandSkill(options("Price \\$1, say $0", { args: '"$ARGUMENTS ${CLAUDE_SESSION_ID}"' }));
		assert.equal(result.ok && result.text, "Price $1, say $ARGUMENTS ${CLAUDE_SESSION_ID}");
	});

	it("fills in ${CLAUDE_*} variables and leaves unknown ones", async () => {
		const result = await expandSkill(options("Run ${CLAUDE_SKILL_DIR}/x.sh in ${CLAUDE_OTHER}"));
		assert.equal(result.ok && result.text, "Run /skills/x/x.sh in ${CLAUDE_OTHER}");
	});

	it("runs inline and fenced commands once, with arguments filled in, and doesn't rescan output", async () => {
		const body = "Diff: !`gh pr diff $0`\nKEY=!`skipped`\n```!\nnode --version\ngit status\n```\nDone";
		const result = await expandSkill(
			options(body, {
				args: "7",
				runCommand: async (command) => {
					ran.push(command);
					return { ok: true, output: "!`nested`" };
				},
			}),
		);
		assert.deepEqual(ran, ["gh pr diff 7", "node --version\ngit status"]);
		assert.equal(result.ok && result.text, "Diff: !`nested`\nKEY=!`skipped`\n!`nested`\nDone");
	});

	it("never turns an argument into a command", async () => {
		await expandSkill(options("Say $ARGUMENTS", { args: "!`rm -rf x`" }));
		assert.deepEqual(ran, []);
	});

	it("aborts the whole skill when a command fails", async () => {
		const result = await expandSkill(options("A !`ok` B !`bad`", { runCommand: async (command) => (command === "bad" ? { ok: false, message: "failed" } : { ok: true, output: "" }) }));
		assert.deepEqual(result, { ok: false, message: "failed" });
	});

	it("replaces commands with Claude's notice when shell execution is disabled, and leaves them in claude.ai skills", async () => {
		assert.equal(((await expandSkill(options("A !`ls`", { shell: "disabled" }))) as { text: string }).text, `A ${DISABLED_NOTICE}`);
		assert.equal(((await expandSkill(options("A !`ls`", { shell: "never" }))) as { text: string }).text, "A !`ls`");
		assert.deepEqual(ran, []);
	});

	it("reports no change for a skill without placeholders or commands", async () => {
		assert.deepEqual(await expandSkill(options("Plain text with a ! and `code`.")), { ok: true, changed: false, text: "Plain text with a ! and `code`." });
	});

	it("expands a read only when it returns the whole skill", () => {
		assert.equal(readsWholeFile(undefined, undefined, 10), true);
		assert.equal(readsWholeFile(1, 200, 10), true);
		assert.equal(readsWholeFile(1, 10, 10), true);
		assert.equal(readsWholeFile(1, 5, 10), false);
		assert.equal(readsWholeFile(3, undefined, 10), false);
	});

	it("splits arguments like a shell", () => {
		assert.deepEqual(splitArguments(`a "b c" 'd e' f\\ g ""`), ["a", "b c", "d e", "f g", ""]);
	});
});

describe("permission checks", () => {
	it("matches Claude's wildcard examples", () => {
		const cases: [string, string, boolean][] = [
			["npm run build", "npm run build", true],
			["npm run build --watch", "npm run build", false],
			["npm run test --watch", "npm run *", true],
			["npm run", "npm run *", true],
			["npm install", "npm run *", false],
			["git log --oneline main", "git log * main", true],
			["git log main", "git log * main", false],
			["node --version", "* --version", true],
			["ls", "ls *", true],
			["lsof", "ls *", false],
			["lsof", "ls*", true],
			["npm --help", "* --help *", false],
			["ls -la", "ls:*", true],
		];
		for (const [command, rule, expected] of cases) assert.equal(matchesRule(command, rule), expected, `${rule} vs ${command}`);
	});

	it("splits allowed-tools on spaces and commas outside parentheses", () => {
		assert.deepEqual(splitRules("Bash(git log *) Read, Bash(gh pr *)"), ["Bash(git log *)", "Read", "Bash(gh pr *)"]);
		assert.deepEqual(splitRules(["Bash(a *)", "Grep"]), ["Bash(a *)", "Grep"]);
	});

	it("splits compound commands and refuses ones it can't judge", () => {
		assert.deepEqual(splitCommand("git status && npm test | head -5; echo done"), ["git status", "npm test", "head -5", "echo done"]);
		assert.deepEqual(splitCommand("grep x f 2>/dev/null"), ["grep x f"]);
		assert.deepEqual(splitCommand("echo 'a && b'"), ["echo 'a && b'"]);
		for (const command of ["echo $(whoami)", "echo `id`", "ls > out.txt", "FOO=1 npm test", "npm test &&", "(cd x)", "echo 'open"]) {
			assert.equal(splitCommand(command), undefined, command);
		}
	});

	it("strips Claude's wrappers", () => {
		assert.equal(stripWrappers("timeout 30 nice -n 5 nohup npm test"), "npm test");
		assert.equal(stripWrappers("command -v node"), "command -v node");
		assert.equal(stripWrappers("xargs grep x"), "grep x");
		assert.equal(stripWrappers("xargs -n1 grep x"), "xargs -n1 grep x");
	});

	it("allows read-only commands and allow-rule matches, and requires every part to be allowed", () => {
		const rules = bashRules(["Bash(npm test *)", "Read"], []);
		assert.deepEqual(checkCommand("ls -la | wc -l", rules), { allowed: true });
		assert.deepEqual(checkCommand("timeout 10 npm test", rules), { allowed: true });
		assert.equal(checkCommand("npm test && rm -rf build", rules).allowed, false);
		assert.equal(checkCommand("git status", rules).allowed, false);
	});

	it("refuses anything a deny or ask rule matches, even with Bash allowed", () => {
		const rules = bashRules(["Bash"], ["Bash(git push *)"]);
		assert.equal(checkCommand("git status && git push origin main", rules).allowed, false);
		assert.deepEqual(checkCommand("git status", rules), { allowed: true });
		assert.equal(checkCommand("echo $(git push)", rules).allowed, false);
	});

	it("allows a command too complex to split only when Bash is allowed outright and nothing is denied", () => {
		assert.deepEqual(checkCommand("echo $(date)", bashRules(["Bash(*)"], [])), { allowed: true });
		assert.equal(checkCommand("echo $(date)", bashRules(["Bash(echo *)"], [])).allowed, false);
	});
});

describe("commands", () => {
	function withCommands(trusted = true) {
		return claudeSkills({ cwd: project, trusted, home, env: {}, managedSettingsDir: path.join(base, "managed"), commandDir: path.join(base, "generated") });
	}

	it("hands command files to pi as generated skills with Claude's names", () => {
		write(path.join(home, ".claude", "commands", "review.md"), "---\ndescription: Review code\nname: ignored\npaths: '*.ts'\n---\n\nReview $ARGUMENTS\n");
		write(path.join(project, ".claude", "commands", "frontend", "component.md"), "\n# Make a component\n\nBuild it.\n");
		const result = withCommands();
		const review = result.skills.find((entry) => entry.name === "review");
		assert.ok(review);
		assert.equal(review.commandFile, path.join(home, ".claude", "commands", "review.md"));
		assert.deepEqual(review.qualifiedNames, []);
		assert.equal(review.bareName, true);
		assert.equal(review.activation, undefined, "commands have no paths");
		assert.equal(fs.readFileSync(review.file, "utf8"), "---\ndescription: Review code\nname: review\n---\n\nReview $ARGUMENTS\n");
		const component = result.skills.find((entry) => entry.name === "frontend-component");
		assert.ok(component);
		assert.deepEqual(component.qualifiedNames, ["frontend:component"]);
		assert.equal(component.bareName, false);
		assert.equal(component.listingDescription, "# Make a component", "the first non-empty line describes it");
		assert.equal(component.source, "project");
	});

	it("lets a skill with the same name win, and skips project commands in an untrusted project", () => {
		write(path.join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Skill\n---\nSkill\n");
		write(path.join(home, ".claude", "commands", "deploy.md"), "Command\n");
		write(path.join(project, ".claude", "commands", "local.md"), "Local\n");
		const result = withCommands(false);
		assert.deepEqual(names(result), ["deploy (personal)"]);
		assert.match(result.skipped[0]?.reason ?? "", /same name/);
	});

	it("reads a plugin's commands folder, or its manifest's commands instead", () => {
		installPlugin("tools@market", { scope: "user" }, {
			".claude-plugin/plugin.json": { name: "tools" },
			"commands/status.md": "Show status\n",
		});
		installPlugin("other@market", { scope: "user" }, {
			".claude-plugin/plugin.json": {
				name: "other",
				commands: { about: { content: "Explain the plugin.", description: "About other" }, run: { source: "./extra/run.md", model: "opus" } },
			},
			"commands/ignored.md": "Ignored\n",
			"extra/run.md": "Run it\n",
		});
		const result = withCommands();
		assert.deepEqual(
			result.skills.map((entry) => entry.qualifiedNames[0]),
			["tools:status", "other:about", "other:run"],
		);
		const run = result.skills.find((entry) => entry.name === "run");
		assert.equal(run?.frontmatter.model, "opus");
		const about = result.skills.find((entry) => entry.name === "about");
		assert.equal(about?.listingDescription, "About other");
		assert.match(fs.readFileSync(about?.file ?? "", "utf8"), /Explain the plugin\.$/);
	});

	it("removes generated skills for commands that are gone", () => {
		write(path.join(home, ".claude", "commands", "old.md"), "Old\n");
		const first = withCommands().skills[0];
		assert.ok(first && fs.existsSync(first.file));
		fs.rmSync(path.join(home, ".claude", "commands", "old.md"));
		withCommands();
		assert.equal(fs.existsSync(first.file), false);
	});
});

describe("plugin and skill switches", () => {
	it("says which settings file turns each installed plugin on or off", () => {
		installPlugin("a@m", { scope: "user" }, { ".claude-plugin/plugin.json": { name: "a" } });
		installPlugin("b@m", { scope: "user" }, { ".claude-plugin/plugin.json": { name: "b", defaultEnabled: false } });
		installPlugin("c@m", { scope: "user" }, { ".claude-plugin/plugin.json": { name: "c" } });
		write(path.join(home, ".claude", "settings.json"), { enabledPlugins: { "c@m": true } });
		write(path.join(project, ".claude", "settings.local.json"), { enabledPlugins: { "c@m": false } });
		const setup = readClaudeSetup({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") });
		assert.deepEqual(
			installedPlugins(setup).map((plugin) => [plugin.id, plugin.enabled, plugin.decidedBy]),
			[
				["a@m", true, "default"],
				["b@m", false, "default"],
				["c@m", false, "local"],
			],
		);
	});

	it("estimates what a plugin's skills and commands cost, on or off", () => {
		installPlugin("p@m", { scope: "user" }, {
			".claude-plugin/plugin.json": { name: "p" },
			"skills/one/SKILL.md": "---\nname: one\ndescription: First skill\n---\nBody\n",
			"commands/two.md": "Second command\n",
		});
		write(path.join(home, ".claude", "settings.json"), { enabledPlugins: { "p@m": false } });
		const setup = readClaudeSetup({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") });
		const [plugin] = installedPlugins(setup);
		assert.ok(plugin);
		const cost = pluginListingCost(plugin);
		assert.equal(cost.skills, 2);
		assert.ok(cost.tokens > 40 && cost.tokens < 200);
	});

	it("changes one key of a settings file and keeps the rest", () => {
		const file = path.join(project, ".claude", "settings.local.json");
		updateSettingsFile(file, (settings) => (settings.skillOverrides = { tdd: "off" }));
		updateSettingsFile(file, (settings) => (settings.enabledPlugins = { "p@m": false }));
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { skillOverrides: { tdd: "off" }, enabledPlugins: { "p@m": false } });
		write(file, "[1]");
		assert.throws(() => updateSettingsFile(file, () => {}), /isn't a JSON object/);
		assert.equal(fs.readFileSync(file, "utf8"), "[1]");
	});
});

describe("skills screen", () => {
	function catalog() {
		const setup = readClaudeSetup({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") });
		const result = claudeSkills({ cwd: project, trusted: true, home, env: {}, managedSettingsDir: path.join(base, "managed") });
		return buildCatalog(setup, result);
	}

	it("groups plugins by install scope and your skills apart, sorted by cost", () => {
		installPlugin("big@m", { scope: "user" }, {
			".claude-plugin/plugin.json": { name: "big" },
			"skills/a/SKILL.md": `---\nname: a\ndescription: ${"long ".repeat(40)}\n---\n`,
			"skills/b/SKILL.md": "---\nname: b\ndescription: short\n---\n",
		});
		installPlugin("small@m", { scope: "user" }, { ".claude-plugin/plugin.json": { name: "small" }, "skills/c/SKILL.md": "---\nname: c\ndescription: c\n---\n" });
		installPlugin("local@m", { scope: "local", projectPath: project }, { ".claude-plugin/plugin.json": { name: "local" } });
		skill(path.join(home, ".claude", "skills", "mine"), "mine");
		write(path.join(home, ".claude", "settings.json"), { permissions: { deny: ["Skill(big:b)"] }, skillOverrides: { mine: "name-only" } });
		const groups = catalog();
		const [global, projectGroup, , yours] = groups;
		assert.deepEqual(global?.rows.map((row) => row.label), ["big", "small"]);
		assert.deepEqual(projectGroup?.rows.map((row) => row.label), ["local"]);
		const big = global?.rows[0];
		assert.ok(big?.kind === "plugin");
		assert.deepEqual(big.skills.map((entry) => [entry.label, entry.state]), [["a", "on"], ["b", "hidden"]]);
		assert.equal(big.tokens, big.skills[0]?.tokens, "a hidden skill costs nothing");
		const mine = yours?.rows[0];
		assert.ok(mine?.kind === "skill");
		assert.equal(mine.state, "name-only");
		assert.ok(mine.tokens < mine.fullTokens);
	});

	it("hides and shows a skill with a deny rule, and keeps other rules", () => {
		const file = path.join(project, ".claude", "settings.local.json");
		write(file, { permissions: { deny: ["Bash(rm *)"], allow: ["Read"] } });
		saveHidden(file, "big:b", true);
		saveHidden(file, "big:b", true);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm *)", "Skill(big:b)"], allow: ["Read"] });
		saveHidden(file, "big:b", false);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm *)"], allow: ["Read"] });
	});

	it("sets and clears a skill override", () => {
		const file = path.join(project, ".claude", "settings.local.json");
		saveOverride(file, "tdd", "off");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { skillOverrides: { tdd: "off" } });
		saveOverride(file, "tdd", undefined);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
	});
});
