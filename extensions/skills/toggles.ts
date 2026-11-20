/**
 * The `/claude-skills` and `/claude-plugins` screen: Claude's plugins and skills grouped by where
 * they load from, sorted by what they cost in context, folded and unfolded in place.
 *
 * Changes are written to Claude Code's own settings, so Claude Code follows them too, either for
 * this project (`.claude/settings.local.json`, not committed) or for all projects
 * (`~/.claude/settings.json`):
 *
 * - a plugin: `enabledPlugins`;
 * - your own skills and commands: `skillOverrides` (on, name-only, user-invocable-only, off);
 * - a plugin's or claude.ai's skills, which `skillOverrides` doesn't cover: a `Skill(name)` deny
 *   rule, which also stops you from running it.
 *
 * When a higher-precedence settings file still decides otherwise, the screen says which.
 */

import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ClaudeOptions, type ClaudeSetup, installedPlugins, isRecord, localSettingsFile, readClaudeSetup, updateSettingsFile } from "../shared/claude.ts";
import { buildCatalog, denyRules, effectiveOverride, type Group, OVERRIDE_STATES, type PluginRow, type SkillRow } from "./catalog.ts";
import { type ClaudeSkillsResult, deniedBy } from "./discover.ts";

export type Scope = "project" | "user";

export function settingsFile(setup: ClaudeSetup, scope: Scope): string {
	return scope === "project" ? localSettingsFile(setup.root) : path.join(setup.configDir, "settings.json");
}

/** Turns a plugin on or off in one settings file. */
export function savePlugin(file: string, id: string, on: boolean) {
	updateSettingsFile(file, (settings) => {
		settings.enabledPlugins = { ...(isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}), [id]: on };
	});
}

/** Sets a skill's `skillOverrides` entry in one settings file; `undefined` removes it. */
export function saveOverride(file: string, key: string, value: string | undefined) {
	updateSettingsFile(file, (settings) => {
		const overrides = isRecord(settings.skillOverrides) ? { ...settings.skillOverrides } : {};
		if (value === undefined) delete overrides[key];
		else overrides[key] = value;
		if (Object.keys(overrides).length > 0) settings.skillOverrides = overrides;
		else delete settings.skillOverrides;
	});
}

/** Adds or removes `Skill(<key>)` in one settings file's deny rules. Showing a skill also removes
 * the rule that hid it, when that rule is in this file. */
export function saveHidden(file: string, key: string, hidden: boolean, hiddenBy?: string) {
	const rule = `Skill(${key})`;
	updateSettingsFile(file, (settings) => {
		const permissions = isRecord(settings.permissions) ? { ...settings.permissions } : {};
		const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((entry): entry is string => typeof entry === "string") : [];
		const next = hidden ? (deny.includes(rule) ? deny : [...deny, rule]) : deny.filter((entry) => entry !== rule && entry !== hiddenBy);
		if (next.length > 0) permissions.deny = next;
		else delete permissions.deny;
		if (Object.keys(permissions).length > 0) settings.permissions = permissions;
		else delete settings.permissions;
	});
}

/** One line of the list: a group, a plugin, or a skill. */
interface Line {
	row: Group | PluginRow | SkillRow;
	depth: number;
	group: Group;
	/** In a search, where the row comes from. */
	context?: string;
}

const BAR_CELLS = 8;
const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const STATE_ICON: Record<string, string> = { on: "●", "name-only": "◐", "user-invocable-only": "◑", off: "○", hidden: "⊘", skipped: "·" };
const STATE_LABEL: Record<string, string> = { "name-only": "name only", "user-invocable-only": "you only", off: "off", hidden: "hidden" };

type Theme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];

class SkillsScreen implements Component {
	private groups: Group[];
	private expanded = new Set<string>(["global", "project", "claude.ai", "yours"]);
	private cursor = 0;
	private offset = 0;
	private query: string | undefined;
	private message: { text: string; level: "info" | "warning" } | undefined;
	scope: Scope;
	changed = false;

	private readonly theme: Theme;
	private readonly options: ClaudeOptions;
	private readonly result: ClaudeSkillsResult;
	private readonly done: () => void;
	private readonly maxRows: number;

	constructor(theme: Theme, options: ClaudeOptions, result: ClaudeSkillsResult, done: () => void, maxRows: number, focusPlugins: boolean) {
		this.theme = theme;
		this.options = options;
		this.result = result;
		this.done = done;
		this.maxRows = maxRows;
		const setup = readClaudeSetup(options);
		this.scope = setup.trusted ? "project" : "user";
		this.groups = buildCatalog(setup, result);
		// /claude-plugins starts on the first plugin.
		if (focusPlugins) this.cursor = this.lines().findIndex((line) => "kind" in line.row && line.row.kind === "plugin");
		if (this.cursor < 0) this.cursor = 0;
	}

	private setup(): ClaudeSetup {
		return readClaudeSetup(this.options);
	}

	private lines(): Line[] {
		if (this.query) {
			const all: Line[] = [];
			for (const group of this.groups) {
				for (const row of group.rows) {
					all.push({ row, depth: 0, group, context: group.title });
					if (row.kind === "plugin") for (const skill of row.skills) all.push({ row: skill, depth: 0, group, context: row.label });
				}
			}
			return fuzzyFilter(all, this.query, (line) => ("kind" in line.row ? `${line.row.label} ${line.context ?? ""}` : ""));
		}
		const lines: Line[] = [];
		for (const group of this.groups) {
			lines.push({ row: group, depth: 0, group });
			if (!this.expanded.has(group.id)) continue;
			for (const row of group.rows) {
				lines.push({ row, depth: 1, group });
				if (row.kind === "plugin" && this.expanded.has(row.id)) for (const skill of row.skills) lines.push({ row: skill, depth: 2, group });
			}
		}
		return lines;
	}

	private rebuild(selectedId?: string) {
		this.groups = buildCatalog(this.setup(), this.result);
		if (selectedId === undefined) return;
		const index = this.lines().findIndex((line) => line.row.id === selectedId);
		if (index >= 0) this.cursor = index;
	}

	private say(text: string, level: "info" | "warning" = "info") {
		this.message = { text, level };
	}

	private toggle(line: Line) {
		const { row } = line;
		if (!("kind" in row)) {
			this.fold(row.id);
			return;
		}
		const setup = this.setup();
		const file = settingsFile(setup, this.scope);
		try {
			if (row.kind === "plugin") {
				if (row.decidedBy === "managed") return this.say(`Managed settings decide ${row.id}; it can't be changed here.`, "warning");
				const on = !row.enabled;
				savePlugin(file, row.id, on);
				const fresh = installedPlugins(this.setup()).find((plugin) => plugin.id === row.id);
				if (fresh && fresh.enabled !== on) this.say(`Saved, but ${fresh.decidedBy} settings still turn ${row.label} ${fresh.enabled ? "on" : "off"}.`, "warning");
				else this.say(`${row.label} ${on ? "on" : "off"} · saved to ${file}`);
			} else if (row.control === "override") {
				const index = OVERRIDE_STATES.indexOf(row.state as (typeof OVERRIDE_STATES)[number]);
				const next = OVERRIDE_STATES[(index + 1) % OVERRIDE_STATES.length] ?? "on";
				// `on` is Claude's default, so it's saved by removing the entry, unless a lower-precedence
				// file sets something else and this one has to say `on` to win.
				saveOverride(file, row.key, next === "on" ? undefined : next);
				if (next === "on" && effectiveOverride(this.setup(), row.key) !== "on") saveOverride(file, row.key, "on");
				const effective = effectiveOverride(this.setup(), row.key);
				if (effective !== next) this.say(`Saved, but a higher-precedence settings file sets ${row.key} to ${effective}.`, "warning");
				else this.say(`${row.key}: ${STATE_LABEL[next] ?? "on"} · saved to ${file}`);
			} else if (row.control === "deny") {
				const hide = row.state !== "hidden";
				saveHidden(file, row.key, hide, row.deniedBy);
				const still = deniedBy(denyRules(this.setup()), [row.label, row.key]);
				if (!hide && still) this.say(`Saved, but the deny rule ${still} in another settings file still hides ${row.key}.`, "warning");
				else this.say(`${row.key} ${hide ? "hidden: the model can't use it and you can't run it" : "shown"} · saved to ${file}`);
			} else {
				return this.say(row.note ?? "This one can't be switched.", "warning");
			}
		} catch (error) {
			return this.say(`Couldn't save to ${file}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		this.changed = true;
		this.rebuild(row.id);
	}

	private fold(id: string, open?: boolean) {
		const isOpen = this.expanded.has(id);
		if (open ?? !isOpen) this.expanded.add(id);
		else this.expanded.delete(id);
	}

	handleInput(data: string): void {
		const lines = this.lines();
		const line = lines[this.cursor];
		const move = (to: number) => {
			this.cursor = Math.max(0, Math.min(lines.length - 1, to));
		};
		if (this.query !== undefined && !matchesKey(data, "up") && !matchesKey(data, "down") && !matchesKey(data, "space") && !matchesKey(data, "tab")) {
			if (matchesKey(data, "escape")) this.query = undefined;
			else if (matchesKey(data, "backspace")) this.query = this.query.slice(0, -1) || undefined;
			else if (matchesKey(data, "enter")) {
				if (line) this.toggle(line);
			} else if (data.length === 1 && data >= " ") this.query += data;
			this.cursor = 0;
			return;
		}
		if (matchesKey(data, "escape")) return this.done();
		if (matchesKey(data, "up")) return move(this.cursor - 1);
		if (matchesKey(data, "down")) return move(this.cursor + 1);
		if (matchesKey(data, "pageUp")) return move(this.cursor - this.maxRows);
		if (matchesKey(data, "pageDown")) return move(this.cursor + this.maxRows);
		if (matchesKey(data, "home")) return move(0);
		if (matchesKey(data, "end")) return move(lines.length - 1);
		if (matchesKey(data, "tab")) {
			const setup = this.setup();
			if (!setup.trusted) return this.say("pi doesn't trust this project, so changes go to your user settings.", "warning");
			this.scope = this.scope === "project" ? "user" : "project";
			return this.say(`Changes now go to ${settingsFile(setup, this.scope)}`);
		}
		if (data === "/") {
			this.query = "";
			this.cursor = 0;
			return;
		}
		if (!line) return;
		const foldable = !("kind" in line.row) || (line.row.kind === "plugin" && line.row.skills.length > 0);
		if (matchesKey(data, "right")) {
			if (foldable) this.fold(line.row.id, true);
			return;
		}
		if (matchesKey(data, "left")) {
			if (foldable && this.expanded.has(line.row.id)) return this.fold(line.row.id, false);
			// Go to the parent row.
			for (let index = this.cursor - 1; index >= 0; index--) {
				if ((lines[index]?.depth ?? 0) < line.depth) return move(index);
			}
			return;
		}
		if (matchesKey(data, "enter")) {
			if (foldable) this.fold(line.row.id);
			else this.toggle(line);
			return;
		}
		if (matchesKey(data, "space")) this.toggle(line);
	}

	invalidate(): void {}

	render(fullWidth: number): string[] {
		const { theme } = this;
		// Wider than this, the costs drift too far from the names to read across.
		const width = Math.min(fullWidth, 100);
		const lines = this.lines();
		this.cursor = Math.max(0, Math.min(this.cursor, lines.length - 1));
		if (this.cursor < this.offset) this.offset = this.cursor;
		if (this.cursor >= this.offset + this.maxRows) this.offset = this.cursor - this.maxRows + 1;
		const total = this.groups.reduce((sum, group) => sum + group.tokens, 0);
		const largest = Math.max(1, ...this.groups.flatMap((group) => group.rows.map((row) => (row.kind === "plugin" ? row.tokens : row.fullTokens))));

		const bar = (tokens: number) => {
			const eighths = Math.round((tokens / largest) * BAR_CELLS * 8);
			const cells = Math.min(BAR_CELLS * 8, eighths);
			const plain = "█".repeat(Math.floor(cells / 8)) + (PARTIAL[cells % 8] ?? "");
			return theme.fg("accent", plain) + " ".repeat(BAR_CELLS - plain.length);
		};
		const tokens = (count: number) => (count > 0 ? `~${count.toLocaleString("en-US")}` : "");
		const rightAlign = (left: string, right: string) => {
			const room = width - visibleWidth(right) - 1;
			const cut = truncateToWidth(left, Math.max(0, room));
			return cut + " ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right))) + right;
		};

		const out: string[] = [];
		const project = path.basename(this.options.cwd);
		out.push(rightAlign(theme.bold(`Claude skills · ${project}`), theme.fg("muted", `in context ${tokens(total) || "0"} tokens`)));
		const scope = (value: Scope, label: string) => (this.scope === value ? theme.fg("accent", `▸${label}◂`) : theme.fg("dim", ` ${label} `));
		out.push(`${theme.fg("muted", "Save to:")} ${scope("project", "this project")} ${scope("user", "all projects")} ${theme.fg("dim", "(tab)")}`);
		out.push(this.query !== undefined ? `${theme.fg("accent", "/")}${this.query}${theme.fg("accent", "▏")}` : "");

		for (let index = this.offset; index < Math.min(lines.length, this.offset + this.maxRows); index++) {
			const line = lines[index];
			if (!line) continue;
			const selected = index === this.cursor;
			const pointer = selected ? theme.fg("accent", "›") : " ";
			const indent = "  ".repeat(line.depth);
			const { row } = line;
			let left: string;
			let right: string;
			if (!("kind" in row)) {
				const fold = this.expanded.has(row.id) ? "▾" : "▸";
				const title = theme.bold(row.title.toUpperCase());
				left = `${pointer} ${fold} ${selected ? theme.fg("accent", title) : title}${row.rows.length === 0 ? theme.fg("dim", `  ${row.empty}`) : ""}`;
				right = theme.fg("muted", tokens(row.tokens).padStart(8)) + " ".repeat(BAR_CELLS + 1);
			} else if (row.kind === "plugin") {
				const fold = row.skills.length === 0 ? " " : this.expanded.has(row.id) ? "▾" : "▸";
				const icon = row.enabled ? theme.fg("success", "●") : theme.fg("dim", "○");
				const label = selected ? theme.fg("accent", row.label) : row.enabled ? row.label : theme.fg("dim", row.label);
				const hidden = row.skills.filter((skill) => skill.state === "hidden").length;
				const detail = row.skills.length === 0 ? "no skills" : `${row.skills.length} skill${row.skills.length === 1 ? "" : "s"}${hidden ? `, ${hidden} hidden` : ""}`;
				left = `${pointer} ${indent}${fold} ${icon} ${label}  ${theme.fg("dim", row.enabled ? detail : `off · ${detail}`)}${line.context ? theme.fg("dim", ` · ${line.context}`) : ""}`;
				right = row.enabled ? `${theme.fg("muted", tokens(row.tokens).padStart(8))} ${bar(row.tokens)}` : theme.fg("dim", `~${row.skills.reduce((sum, skill) => sum + skill.fullTokens, 0).toLocaleString("en-US")} if on`.padStart(8 + BAR_CELLS + 1));
			} else {
				const active = row.state === "on";
				const icon = row.state === "on" ? theme.fg("success", STATE_ICON.on ?? "●") : theme.fg(row.state === "hidden" ? "warning" : "dim", STATE_ICON[row.state] ?? "·");
				const label = selected ? theme.fg("accent", row.label) : active ? row.label : theme.fg("dim", row.label);
				const status = STATE_LABEL[row.state];
				const notes = [status, row.deniedBy && row.state !== "hidden" ? `hidden by ${row.deniedBy}` : undefined, row.note, line.context].filter(Boolean).join(" · ");
				left = `${pointer} ${indent}  ${icon} ${label}${notes ? theme.fg("dim", `  ${notes}`) : ""}`;
				right = theme.fg("muted", tokens(row.tokens).padStart(8)) + " ".repeat(BAR_CELLS + 1);
			}
			out.push(rightAlign(left, right));
		}
		if (lines.length === 0) out.push(theme.fg("dim", "  nothing matches"));
		const above = this.offset;
		const below = Math.max(0, lines.length - this.offset - this.maxRows);
		out.push(theme.fg("dim", above || below ? `  ${above ? `↑ ${above} more` : ""}${above && below ? " · " : ""}${below ? `↓ ${below} more` : ""}` : ""));
		out.push(this.message ? theme.fg(this.message.level === "warning" ? "warning" : "muted", truncateToWidth(this.message.text, width)) : "");
		out.push(
			theme.fg(
				"dim",
				truncateToWidth(
					this.query !== undefined
						? "type to search · ↑↓ move · space switch · esc end search"
						: "↑↓ move · → open · ← close · space switch · / search · tab where to save · esc close",
					width,
				),
			),
		);
		return out;
	}
}

/** Shows the screen until it's closed, then offers to reload when something changed. */
export async function showSkillsScreen(ctx: ExtensionCommandContext, options: ClaudeOptions, result: ClaudeSkillsResult, focus: "skills" | "plugins") {
	let screen: SkillsScreen | undefined;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const rows = Math.max(8, (process.stdout.rows || 30) - 10);
		screen = new SkillsScreen(theme, options, result, () => done(), rows, focus === "plugins");
		return {
			render: (width: number) => screen?.render(width) ?? [],
			invalidate: () => screen?.invalidate(),
			handleInput: (data: string) => {
				screen?.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (!screen?.changed) return;
	if (await ctx.ui.confirm("Reload now?", "Skill and plugin changes apply when pi reloads.")) await ctx.reload();
	else ctx.ui.notify("Saved. Run /reload to apply.", "info");
}
