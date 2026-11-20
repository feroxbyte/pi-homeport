/**
 * What the `/claude-skills` screen shows: Claude's plugins and skills grouped by where they load
 * from, each with its state, how it's switched, and about how many tokens it adds to the model's
 * skill listing. States come from the settings files, so the catalog can be rebuilt after a change
 * without reloading.
 */

import * as path from "node:path";
import { type ClaudePlugin, type ClaudeSetup, installedPlugins, isRecord, listSetting, type PluginDecidedBy } from "../shared/claude.ts";
import { type ClaudeSkillsResult, deniedBy, listingTokens, pluginListing } from "./discover.ts";

/** Claude's `skillOverrides` states; `on` means no entry. */
export const OVERRIDE_STATES = ["on", "name-only", "user-invocable-only", "off"] as const;
export type OverrideState = (typeof OVERRIDE_STATES)[number];

export interface SkillRow {
	kind: "skill";
	id: string;
	label: string;
	/**
	 * How it's switched: `override` cycles `skillOverrides` (your own skills); `deny` hides it with a
	 * `Skill(...)` deny rule (plugin and claude.ai skills, which `skillOverrides` doesn't cover);
	 * `none` when it can't be switched.
	 */
	control: "override" | "deny" | "none";
	/** The `skillOverrides` key, or the name a deny rule uses. */
	key: string;
	/** For `override`: its state. For `deny`: `on` or `hidden`. */
	state: OverrideState | "hidden" | "skipped";
	/** The deny rule that hides it, when one does. */
	deniedBy?: string;
	/** Tokens it adds now, and what it would add listed in full. */
	tokens: number;
	fullTokens: number;
	note?: string;
}

export interface PluginRow {
	kind: "plugin";
	id: string;
	label: string;
	enabled: boolean;
	decidedBy: PluginDecidedBy;
	skills: SkillRow[];
	/** Tokens its listed skills add now: none while it's off. */
	tokens: number;
	/** Tokens all its skills would add, on and shown. */
	fullTokens: number;
}

export interface Group {
	id: "global" | "project" | "claude.ai" | "yours";
	title: string;
	rows: (PluginRow | SkillRow)[];
	tokens: number;
	/** Shown when the group is empty. */
	empty: string;
}

/** The `skillOverrides` value in effect for a name: the highest-precedence file that sets it. */
export function effectiveOverride(setup: ClaudeSetup, name: string): string {
	let value = "on";
	for (const file of setup.settings) {
		const overrides = isRecord(file.skillOverrides) ? file.skillOverrides : {};
		if (typeof overrides[name] === "string") value = overrides[name];
	}
	return value;
}

export function denyRules(setup: ClaudeSetup): string[] {
	return listSetting(setup, (file) => (isRecord(file.permissions) ? file.permissions.deny : undefined));
}

function pluginRow(plugin: ClaudePlugin, rules: string[]): PluginRow {
	const skills = pluginListing(plugin)
		.map((entry): SkillRow => {
			const denied = deniedBy(rules, [entry.name, entry.qualifiedName]);
			return {
				kind: "skill",
				id: `${plugin.id}/${entry.name}`,
				label: entry.name,
				control: "deny",
				key: entry.qualifiedName,
				state: denied ? "hidden" : "on",
				...(denied ? { deniedBy: denied } : {}),
				tokens: denied || !plugin.enabled ? 0 : entry.tokens,
				fullTokens: entry.tokens,
			};
		})
		.sort((a, b) => b.fullTokens - a.fullTokens || a.label.localeCompare(b.label));
	return {
		kind: "plugin",
		id: plugin.id,
		label: plugin.name,
		enabled: plugin.enabled,
		decidedBy: plugin.decidedBy,
		skills,
		tokens: skills.reduce((sum, skill) => sum + skill.tokens, 0),
		fullTokens: skills.reduce((sum, skill) => sum + skill.fullTokens, 0),
	};
}

/** Most expensive first, by what a row costs when it's on, so switching a row never moves it. */
const byCost = <T extends { fullTokens: number; label: string }>(a: T, b: T) => b.fullTokens - a.fullTokens || a.label.localeCompare(b.label);

export function buildCatalog(setup: ClaudeSetup, result: ClaudeSkillsResult): Group[] {
	const rules = denyRules(setup);
	const plugins = installedPlugins(setup).map((plugin) => ({ plugin, row: pluginRow(plugin, rules) }));
	const pluginGroup = (scope: (plugin: ClaudePlugin) => boolean) =>
		plugins
			.filter(({ plugin }) => scope(plugin))
			.map(({ row }) => row)
			.sort(byCost);

	const claudeAi: SkillRow[] = [];
	const yours: SkillRow[] = [];
	for (const skill of result.skills) {
		if (skill.plugin) continue;
		const full = listingTokens(skill.name, skill.listingDescription, skill.file);
		if (skill.source === "claude.ai") {
			const denied = deniedBy(rules, [skill.name, ...skill.qualifiedNames]);
			claudeAi.push({
				kind: "skill",
				id: skill.file,
				label: skill.name,
				control: "deny",
				key: skill.qualifiedNames[0] ?? skill.name,
				state: denied ? "hidden" : "on",
				...(denied ? { deniedBy: denied } : {}),
				tokens: denied ? 0 : full,
				fullTokens: full,
			});
			continue;
		}
		const key = skill.commandFile ? (skill.qualifiedNames[0] ?? skill.name) : skill.name;
		const denied = deniedBy(rules, [skill.name, ...skill.qualifiedNames]);
		const value = effectiveOverride(setup, key);
		const state: OverrideState = (OVERRIDE_STATES as readonly string[]).includes(value) ? (value as OverrideState) : "on";
		const nameOnly = listingTokens(skill.name, "", skill.file);
		yours.push({
			kind: "skill",
			id: skill.file,
			label: key,
			control: "override",
			key,
			state,
			...(denied ? { deniedBy: denied } : {}),
			tokens: denied || skill.activation ? 0 : state === "on" ? full : state === "name-only" ? nameOnly : 0,
			fullTokens: full,
			note: [skill.commandFile ? `${skill.source} command` : skill.source, ...(skill.activation ? ["listed once a matching file is touched"] : [])].join(" · "),
		});
	}
	// Skills that can't load are folded into one row per group and reason; ones turned off stay
	// switchable rows.
	const notLoaded = new Map<string, { names: string[]; group: SkillRow[]; reason: string }>();
	for (const skipped of result.skipped) {
		if (skipped.source.startsWith("plugin ")) continue;
		const target = skipped.source === "claude.ai" ? claudeAi : yours;
		if (skipped.reason === "skillOverrides turns it off") {
			target.push({ kind: "skill", id: skipped.file, label: skipped.name, control: "override", key: skipped.name, state: "off", tokens: 0, fullTokens: 0, note: skipped.source });
			continue;
		}
		const bucket = `${skipped.source}\u0000${skipped.reason}`;
		const entry = notLoaded.get(bucket) ?? { names: [], group: target, reason: skipped.reason };
		entry.names.push(skipped.name);
		notLoaded.set(bucket, entry);
	}
	for (const [bucket, { names, group, reason }] of notLoaded) {
		group.push({
			kind: "skill",
			id: `not-loaded\u0000${bucket}`,
			label: names.length === 1 ? (names[0] ?? "") : `${names.length} skills not loaded`,
			control: "none",
			key: "",
			state: "skipped",
			tokens: 0,
			fullTokens: 0,
			note: names.length === 1 ? reason : `${reason}: ${names.join(", ")}`,
		});
	}

	const groups: Group[] = [
		{ id: "global", title: "Global plugins", rows: pluginGroup((plugin) => plugin.installScope === "user"), tokens: 0, empty: "none installed" },
		{
			id: "project",
			title: "Project plugins",
			rows: pluginGroup((plugin) => plugin.installScope !== "user"),
			tokens: 0,
			empty: `none installed for ${path.basename(setup.root)}`,
		},
		{ id: "claude.ai", title: "claude.ai", rows: claudeAi.sort(byCost), tokens: 0, empty: "no synced skills" },
		{ id: "yours", title: "Your skills and commands", rows: yours.sort(byCost), tokens: 0, empty: "none" },
	];
	for (const group of groups) group.tokens = group.rows.reduce((sum, row) => sum + (row.kind === "plugin" ? (row.enabled ? row.tokens : 0) : row.tokens), 0);
	return groups;
}
