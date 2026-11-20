/**
 * Reading Claude Code's configuration: its files, the project's settings chain, and the plugins
 * installed and enabled for a project. Shared by the extensions that bring Claude's setup to pi.
 *
 * Rules follow Claude Code's documentation:
 * - Settings precedence, lowest first: user, project, project local, managed
 *   (https://code.claude.com/docs/en/settings.md).
 * - A plugin loads when it's installed for the project (user scope, or project or local scope
 *   recorded for this project in `installed_plugins.json`) and enabled: `enabledPlugins` merged
 *   key by key, else the manifest's `defaultEnabled`, which defaults to true
 *   (https://code.claude.com/docs/en/plugins/loading.md).
 *
 * Project files are read only when pi trusts the project.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads JSON files, remembering the ones that exist but aren't valid JSON objects. */
export class JsonReader {
	readonly unreadable: string[] = [];

	read(file: string): Json | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Reported through `unreadable`.
		}
		this.unreadable.push(file);
		return undefined;
	}
}

export interface ClaudeOptions {
	cwd: string;
	/** Whether pi trusts the project. Project files are ignored when it doesn't. */
	trusted: boolean;
	home?: string;
	env?: Record<string, string | undefined>;
	/** The folder holding Claude Code's managed settings files. Defaults to the platform's. */
	managedSettingsDir?: string;
}

/**
 * Where Claude Code reads file-based managed settings on each platform
 * (https://code.claude.com/docs/en/managed-settings.md). Managed settings delivered by MDM, the
 * Windows registry or claude.ai aren't files, so they aren't read here.
 */
export function defaultManagedSettingsDir(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
	if (platform === "win32") return path.win32.join("C:\\Program Files", "ClaudeCode");
	return "/etc/claude-code";
}

/** `managed-settings.json`, then each `*.json` in `managed-settings.d/` in alphabetical order,
 * skipping hidden files: the order Claude Code merges them in. */
function managedSettingsFiles(dir: string): string[] {
	let dropIns: string[] = [];
	try {
		dropIns = fs
			.readdirSync(path.join(dir, "managed-settings.d"))
			.filter((name) => name.endsWith(".json") && !name.startsWith("."))
			.sort()
			.map((name) => path.join(dir, "managed-settings.d", name));
	} catch {
		// No drop-in folder.
	}
	return [path.join(dir, "managed-settings.json"), ...dropIns];
}

export interface ClaudeSetup {
	trusted: boolean;
	env: Record<string, string | undefined>;
	reader: JsonReader;
	/** `~/.claude`, or `CLAUDE_CONFIG_DIR`. */
	configDir: string;
	/** `~/.claude.json`. */
	claudeJson: Json | undefined;
	/** The working directory and its ancestors up to the repository root, nearest first. */
	dirs: string[];
	/** The repository root, or the working directory outside a repository. */
	root: string;
	/** The project's entry in `~/.claude.json`. */
	projectEntry: Json;
	/** Settings files that exist, lowest precedence first. */
	settings: Json[];
	/** `~/.claude/settings.json`, if it exists. */
	userSettings: Json | undefined;
	/** The managed settings files that exist, in merge order. */
	managedSettings: Json[];
	/** The folder holding Claude Code's managed files: settings, `managed-mcp.json`, skills. */
	managedDir: string;
}

/** The working directory and its ancestors up to the repository root, nearest first. Outside a
 * repository, the working directory alone. */
function projectDirs(cwd: string): string[] {
	const start = path.resolve(cwd);
	const dirs: string[] = [];
	for (let dir = start; ; dir = path.dirname(dir)) {
		dirs.push(dir);
		if (fs.existsSync(path.join(dir, ".git"))) return dirs;
		if (path.dirname(dir) === dir) return [start];
	}
}

export function readClaudeSetup(options: ClaudeOptions): ClaudeSetup {
	const home = options.home ?? os.homedir();
	const env = options.env ?? process.env;
	const reader = new JsonReader();
	const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
	const claudeJson = reader.read(env.CLAUDE_CONFIG_DIR ? path.join(configDir, ".claude.json") : path.join(home, ".claude.json"));
	const dirs = projectDirs(options.cwd);
	const root = dirs.at(-1) ?? path.resolve(options.cwd);
	const projects = isRecord(claudeJson?.projects) ? claudeJson.projects : {};
	const projectEntry = dirs.map((dir) => projects[dir]).find(isRecord) ?? {};
	const managedDir = options.managedSettingsDir ?? defaultManagedSettingsDir();
	const userSettings = reader.read(path.join(configDir, "settings.json"));
	const managedSettings = managedSettingsFiles(managedDir)
		.map((file) => reader.read(file))
		.filter((file): file is Json => file !== undefined);
	const settings = [
		userSettings,
		...(options.trusted
			? [reader.read(path.join(root, ".claude", "settings.json")), reader.read(path.join(root, ".claude", "settings.local.json"))]
			: []),
		...managedSettings,
	].filter((file): file is Json => file !== undefined);
	return { trusted: options.trusted, env, reader, configDir, claudeJson, dirs, root, projectEntry, settings, userSettings, managedSettings, managedDir };
}

/** The value of a boolean setting from the highest-precedence file that sets it. */
export function booleanSetting(setup: ClaudeSetup, key: string): boolean | undefined {
	let value: boolean | undefined;
	for (const file of setup.settings) if (typeof file[key] === "boolean") value = file[key];
	return value;
}

/** A string list setting, merged across every settings file as Claude merges lists. */
export function listSetting(setup: ClaudeSetup, read: (file: Json) => unknown): string[] {
	return setup.settings.flatMap((file) => {
		const value = read(file);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	});
}

export interface ClaudePlugin {
	/** `name@marketplace`, the key in `enabledPlugins`. */
	id: string;
	/** The plugin's name: the manifest's, else the id's. */
	name: string;
	root: string;
	manifest: Json;
	/** `${CLAUDE_PLUGIN_DATA}`. */
	dataDir: string;
}

/** Plugins installed for this project and enabled, as Claude Code decides both. */
export function enabledPlugins(setup: ClaudeSetup): ClaudePlugin[] {
	const enabled = new Map<string, boolean>();
	for (const file of setup.settings) {
		if (!isRecord(file.enabledPlugins)) continue;
		for (const [id, value] of Object.entries(file.enabledPlugins)) if (typeof value === "boolean") enabled.set(id, value);
	}
	const installed = setup.reader.read(path.join(setup.configDir, "plugins", "installed_plugins.json"));
	const records = isRecord(installed?.plugins) ? installed.plugins : {};
	const plugins: ClaudePlugin[] = [];
	for (const [id, entry] of Object.entries(records)) {
		const installs = (Array.isArray(entry) ? entry : [entry]).filter(isRecord);
		const here = installs.find(
			(record) =>
				(record.scope === "project" || record.scope === "local") &&
				typeof record.projectPath === "string" &&
				setup.dirs.includes(path.resolve(record.projectPath)),
		);
		const chosen = here ?? installs.find((record) => record.scope === "user");
		if (!chosen || typeof chosen.installPath !== "string" || !fs.existsSync(chosen.installPath)) continue;
		const root = chosen.installPath;
		const manifest = setup.reader.read(path.join(root, ".claude-plugin", "plugin.json")) ?? {};
		if (!(enabled.get(id) ?? manifest.defaultEnabled !== false)) continue;
		const name = typeof manifest.name === "string" && manifest.name ? manifest.name : (id.split("@")[0] ?? id);
		const dataDir = path.join(setup.configDir, "plugins", "data", id.replace(/[^A-Za-z0-9_-]/g, "-"));
		plugins.push({ id, name, root, manifest, dataDir });
	}
	return plugins;
}

/** A path a plugin declares, if it stays inside the plugin root. */
export function insidePlugin(root: string, declared: string): string | undefined {
	const resolved = path.resolve(root, declared);
	const relative = path.relative(root, resolved);
	return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : resolved;
}
