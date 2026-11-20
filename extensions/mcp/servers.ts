/**
 * The MCP servers Claude Code would connect in a project, as configs for pi's built-in MCP.
 *
 * Follows Claude Code's documented rules (https://code.claude.com/docs/en/mcp.md and
 * https://code.claude.com/docs/en/managed-mcp.md):
 *
 * - Sources, highest precedence first: `managed-mcp.json`, `managedMcpServers` in managed settings,
 *   local scope (`~/.claude.json` → `projects[<path>]`), project scope (`.mcp.json`), user scope
 *   (`~/.claude.json` → `mcpServers`), then plugin servers. These match duplicates by name; plugin
 *   servers match by endpoint (URL or command). A `managed-mcp.json` takes exclusive control: only
 *   its servers and `managedMcpServers` load.
 * - A project `.mcp.json` server connects only when approved (`enabledMcpjsonServers` or
 *   `enableAllProjectMcpServers`) and not rejected (`disabledMcpjsonServers`).
 * - `disabledMcpServers` in the project's `~/.claude.json` entry turns servers off, and
 *   `allowedMcpServers` / `deniedMcpServers` filter every server (see `policy.ts`).
 * - `${VAR}` and `${VAR:-default}` expand; a plugin's `${user_config.KEY}` takes the value saved in
 *   `pluginConfigs`. `alwaysLoad` loads a server's tools up front; `timeout` (milliseconds) and
 *   `MCP_TOOL_TIMEOUT` become pi's per-request timeout.
 * - `headersHelper` runs once when the session starts, with Claude's working directory, its
 *   environment rules, and its trust rule for project and local servers.
 *
 * This module reads files and runs `headersHelper` commands; it never talks to pi, so it can be
 * tested on its own.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { type ClaudeOptions, type ClaudePlugin, enabledPlugins, insidePlugin, isRecord, type Json, type JsonReader, readClaudeSetup } from "../shared/claude.ts";
import { policyBlocks, readPolicy } from "./policy.ts";

/** A server config in the shape `pi.registerMcpServer` takes. */
export type PiServerConfig = (
	| { command: string; args?: string[]; env?: Record<string, string> }
	| {
			url: string;
			headers?: Record<string, string>;
			oauth?: { clientId?: string; callbackPort?: number; authServerMetadataUrl?: string; scope?: string };
	  }
) & {
	/** `direct` for Claude's `alwaysLoad`, else `deferred`, like Claude's tool search. */
	exposure: "deferred" | "direct";
	/** Per-request timeout in seconds. */
	timeout?: number;
};

export interface BridgedServer {
	/** The name pi registers, which also names the tools: `mcp__<name>__<tool>`. */
	name: string;
	config: PiServerConfig;
	/** Where Claude defines the server, such as `user`, `project` or `plugin cloudflare@claude-plugins-official`. */
	source: string;
}

export interface SkippedServer {
	name: string;
	source: string;
	reason: string;
}

export interface ClaudeMcpResult {
	servers: BridgedServer[];
	skipped: SkippedServer[];
	/** Things worth knowing that didn't stop a server, such as a `headersHelper` that didn't run. */
	notices: string[];
	/** Files that exist but could not be read as JSON. */
	unreadable: string[];
}

/** Runs a `headersHelper` command; resolves to its stdout, or an error message. */
export type HelperRunner = (command: string, cwd: string, env: Record<string, string | undefined>) => { ok: true; stdout: string } | { ok: false; error: string };

export interface ClaudeMcpOptions extends ClaudeOptions {
	runHelper?: HelperRunner;
}

type Scope = "managed" | "managed-provided" | "local" | "project" | "user" | "plugin";

/**
 * Variables Claude Code reads as empty in a remote server's `url` and `headers`, so a project or
 * plugin config can't send these credentials to a server it names. Claude's docs give these as
 * examples rather than a full list.
 */
const CREDENTIAL_VARIABLES = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"https_proxy",
	"http_proxy",
	"NPM_TOKEN",
]);

const HELPER_TIMEOUT_MS = 10_000;

const defaultRunHelper: HelperRunner = (command, cwd, env) => {
	const result = spawnSync("bash", ["-c", command], { cwd, env, timeout: HELPER_TIMEOUT_MS, encoding: "utf8" });
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) return { ok: false, error: `exited with code ${result.status}: ${result.stderr.trim()}` };
	return { ok: true, stdout: result.stdout };
};

/** The environment a repository's or plugin's `headersHelper` gets: without variables whose names
 * look like credentials, except Git's `GIT_CONFIG_KEY_<n>`. */
function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => /^GIT_CONFIG_KEY_\d+$/.test(name) || !(/token|secret|password|key|auth/i.test(name) || name === "ANTHROPIC_CUSTOM_HEADERS")),
	);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return Object.fromEntries(entries);
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them. An unset variable without a
 * default stays as written. In a remote server's `url` and `headers`, credentials read as empty. */
function expand(value: string, variables: Record<string, string | undefined>, remote: boolean): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole: string, name: string, fallback?: string) => {
		if (remote && CREDENTIAL_VARIABLES.has(name)) return "";
		const set = variables[name];
		if (set !== undefined) return set;
		return fallback ?? whole;
	});
}

function expandRecord(
	values: Record<string, string> | undefined,
	variables: Record<string, string | undefined>,
	remote: boolean,
): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value, variables, remote)]));
}

/** pi runs an `env` or `headers` value that starts with `!` as a shell command. Claude doesn't, so
 * such a value would mean something else under pi. */
function startsWithBang(values: Record<string, string> | undefined): string | undefined {
	return Object.entries(values ?? {}).find(([, value]) => value.startsWith("!"))?.[0];
}

/** A plugin's saved options: the manifest's defaults, then `pluginConfigs` in user and managed
 * settings, then the server's own entry. */
interface PluginOptions {
	values: Record<string, string>;
	sensitive: Set<string>;
}

function pluginOptions(plugin: ClaudePlugin, configs: Json[], serverName: string): PluginOptions {
	const values: Record<string, string> = {};
	const sensitive = new Set<string>();
	const declared = isRecord(plugin.manifest.userConfig) ? plugin.manifest.userConfig : {};
	const asString = (value: unknown) => (Array.isArray(value) ? value.map(String).join(",") : String(value));
	for (const [key, field] of Object.entries(declared)) {
		if (!isRecord(field)) continue;
		if (field.sensitive === true) sensitive.add(key);
		if (field.default !== undefined) values[key] = asString(field.default);
	}
	for (const file of configs) {
		const entry = isRecord(file.pluginConfigs) ? file.pluginConfigs[plugin.id] : undefined;
		if (!isRecord(entry)) continue;
		const layers = [entry.options, isRecord(entry.mcpServers) ? entry.mcpServers[serverName] : undefined];
		for (const layer of layers) {
			if (!isRecord(layer)) continue;
			for (const [key, value] of Object.entries(layer)) if (value !== undefined && value !== null) values[key] = asString(value);
		}
	}
	return { values, sensitive };
}

/** Fills `${user_config.KEY}` in every string of a server entry. Returns why it can't, if an option
 * is missing. */
function fillUserConfig(raw: Json, options: PluginOptions): Json | string {
	let missing: string | undefined;
	const fill = (value: unknown): unknown => {
		if (typeof value === "string") {
			return value.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
				const set = options.values[key];
				if (set !== undefined) return set;
				missing ??= options.sensitive.has(key)
					? `it needs the plugin option ${key}, which Claude keeps in your system's credential store`
					: `the plugin option ${key} isn't set in Claude`;
				return whole;
			});
		}
		if (Array.isArray(value)) return value.map(fill);
		if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
		return value;
	};
	const filled = fill(raw) as Json;
	return missing ?? filled;
}

interface Candidate {
	/** Claude's name for the server. */
	claudeName: string;
	/** The name pi registers. */
	name: string;
	raw: unknown;
	scope: Scope;
	source: string;
	plugin?: ClaudePlugin;
	/** Names `disabledMcpServers` may list it under. */
	displayNames: string[];
}

interface Context {
	env: Record<string, string | undefined>;
	trusted: boolean;
	root: string;
	configDir: string;
	pluginConfigs: Json[];
	runHelper: HelperRunner;
	notices: string[];
}

/** Claude's server entry as a pi config, or why it can't be one. */
function toPiConfig(candidate: Candidate, context: Context): PiServerConfig | string {
	if (!isRecord(candidate.raw)) return "the entry is not an object";
	let raw: Json = candidate.raw;
	const plugin = candidate.plugin;
	if (plugin) {
		if (typeof raw.headersHelper === "string" && raw.headersHelper.includes("${user_config.")) {
			return "its headersHelper uses ${user_config.*}, which Claude refuses because the helper runs through a shell";
		}
		const filled = fillUserConfig(raw, pluginOptions(plugin, context.pluginConfigs, candidate.claudeName));
		if (typeof filled === "string") return filled;
		raw = filled;
	}
	const variables: Record<string, string | undefined> = {
		...context.env,
		...(candidate.scope === "project" || plugin ? { CLAUDE_PROJECT_DIR: context.root } : {}),
		...(plugin ? { CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: plugin.dataDir } : {}),
	};
	const type = typeof raw.type === "string" ? raw.type : undefined;
	if (type === "sse") return "it uses the SSE transport, which pi doesn't support";
	if (type === "ws") return "it uses the WebSocket transport, which pi doesn't support";

	const exposure = raw.alwaysLoad === true ? "direct" : "deferred";
	const timeoutMs = typeof raw.timeout === "number" && raw.timeout >= 1000 ? raw.timeout : Number(context.env.MCP_TOOL_TIMEOUT);
	const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? { timeout: Math.ceil(timeoutMs / 1000) } : {};

	if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
		const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined;
		const env = expandRecord(stringRecord(raw.env), variables, false);
		const bang = startsWithBang(env);
		if (bang) return `its env value ${bang} starts with "!", which pi would run as a command`;
		return {
			command: expand(raw.command, variables, false),
			...(args ? { args: args.map((arg) => expand(arg, variables, false)) } : {}),
			...(env ? { env } : {}),
			exposure,
			...timeout,
		};
	}

	if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		const url = expand(raw.url, variables, true);
		let headers = expandRecord(stringRecord(raw.headers), variables, true);
		if (typeof raw.headersHelper === "string") {
			const needsTrust = candidate.scope === "project" || candidate.scope === "local";
			if (needsTrust && !context.trusted) {
				context.notices.push(`${candidate.name}: its headersHelper didn't run because pi doesn't trust this project; it connects with its static headers only.`);
			} else {
				const cwd = plugin ? plugin.root : needsTrust ? context.root : context.configDir;
				const base = candidate.scope === "project" || plugin ? scrubbedEnv(context.env) : context.env;
				const env = {
					...base,
					CLAUDE_CODE_MCP_SERVER_NAME: candidate.claudeName,
					CLAUDE_CODE_MCP_SERVER_URL: url,
					...(plugin ? { CLAUDE_PLUGIN_ROOT: plugin.root } : {}),
				};
				const run = context.runHelper(expand(raw.headersHelper, plugin ? { ...variables, ...env } : variables, false), cwd, env);
				if (!run.ok) return `its headersHelper failed: ${run.error}`;
				let parsed: unknown;
				try {
					parsed = JSON.parse(run.stdout);
				} catch {
					parsed = undefined;
				}
				const dynamic = stringRecord(parsed);
				if (!dynamic || !isRecord(parsed) || Object.keys(dynamic).length !== Object.keys(parsed).length) {
					return "its headersHelper didn't print a JSON object of strings";
				}
				headers = { ...headers, ...dynamic };
			}
		}
		const bang = startsWithBang(headers);
		if (bang) return `its header ${bang} starts with "!", which pi would run as a command`;
		const oauth = isRecord(raw.oauth) ? raw.oauth : undefined;
		const piOauth = oauth && {
			...(typeof oauth.clientId === "string" ? { clientId: oauth.clientId } : {}),
			...(typeof oauth.callbackPort === "number" ? { callbackPort: oauth.callbackPort } : {}),
			...(typeof oauth.authServerMetadataUrl === "string" ? { authServerMetadataUrl: oauth.authServerMetadataUrl } : {}),
			...(typeof oauth.scopes === "string" ? { scope: oauth.scopes } : {}),
		};
		return {
			url,
			...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			...(piOauth && Object.keys(piOauth).length > 0 ? { oauth: piOauth } : {}),
			exposure,
			...timeout,
		};
	}

	return type === undefined ? "it has neither a command nor a url" : `its type "${type}" doesn't match its fields`;
}

/** The identity Claude Code uses to match a plugin server against other servers: its URL, with
 * scheme and host case, a default port and a trailing slash ignored, or its command and arguments. */
function endpoint(config: PiServerConfig): string {
	if ("command" in config) return JSON.stringify(["stdio", config.command, ...(config.args ?? [])]);
	try {
		const url = new URL(config.url);
		const pathname = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host}${pathname}${url.search}`;
	} catch {
		return config.url;
	}
}

/** pi accepts letters, digits, `_` and `-` in server names. */
function piName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** A server map from a `.mcp.json`-shaped object, with or without the `mcpServers` wrapper. */
function serverMap(json: Json | undefined): Json {
	if (!json) return {};
	return isRecord(json.mcpServers) ? json.mcpServers : json;
}

/** A plugin's servers in Claude's load order: `.mcp.json` at the root, then each `mcpServers`
 * entry of the manifest. A name declared later replaces an earlier one. */
function pluginServerMap(root: string, manifest: Json, reader: JsonReader, unsupported: string[]): Json {
	const servers: Json = { ...serverMap(reader.read(path.join(root, ".mcp.json"))) };
	const declared = manifest.mcpServers;
	for (const item of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
		if (isRecord(item)) {
			Object.assign(servers, serverMap(item));
		} else if (typeof item === "string" && item.endsWith(".json")) {
			const file = insidePlugin(root, item);
			if (file) Object.assign(servers, serverMap(reader.read(file)));
		} else if (typeof item === "string") {
			unsupported.push(item);
		}
	}
	return servers;
}

/** Why Claude drops a `managedMcpServers` entry, or undefined when it loads. */
function invalidProvided(name: string, raw: unknown): string | undefined {
	if (!isRecord(raw)) return "the entry is not an object";
	const type = raw.type ?? "http";
	if (type !== "http" && type !== "streamable-http" && type !== "sse") return `managedMcpServers accepts only http and sse servers`;
	if (typeof raw.url !== "string" || !raw.url.startsWith("https://")) return "managedMcpServers needs an https:// URL";
	if (["command", "args", "env", "headersHelper"].some((key) => key in raw)) return "managedMcpServers can't hold command, args, env or headersHelper";
	if (JSON.stringify(raw).includes("${")) return "managedMcpServers doesn't expand ${VAR}";
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return "managedMcpServers names allow only letters, digits, hyphens and underscores";
	return undefined;
}

/** Whether a server entry uses `${VAR}` outside `env`, which puts a `managed-mcp.json` server back
 * under the allowlist. */
function expandsOutsideEnv(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	const { env: _env, ...rest } = raw;
	return JSON.stringify(rest).includes("${");
}

export function claudeMcpServers(options: ClaudeMcpOptions): ClaudeMcpResult {
	const setup = readClaudeSetup(options);
	const { env, claudeJson, projectEntry, root, reader } = setup;
	const skipped: SkippedServer[] = [];
	const notices: string[] = [];
	const policy = readPolicy(setup);
	const context: Context = {
		env,
		trusted: options.trusted,
		root,
		configDir: setup.configDir,
		pluginConfigs: [setup.userSettings, ...setup.managedSettings].filter((file): file is Json => file !== undefined),
		runHelper: options.runHelper ?? defaultRunHelper,
		notices,
	};
	const disabled = new Set(Array.isArray(projectEntry.disabledMcpServers) ? projectEntry.disabledMcpServers.map(String) : []);

	// Named sources, lowest precedence first: a later one replaces an earlier one with the same name.
	const named = new Map<string, Candidate>();
	const add = (claudeName: string, raw: unknown, scope: Scope, source: string) => {
		named.set(claudeName, { claudeName, name: piName(claudeName), raw, scope, source, displayNames: [claudeName] });
	};
	const managedFile = reader.read(path.join(setup.managedDir, "managed-mcp.json"));
	const exclusive = managedFile !== undefined;
	if (exclusive) {
		notices.push("Claude's managed-mcp.json is in place, so only its servers and managedMcpServers load.");
	} else {
		for (const [name, raw] of Object.entries(isRecord(claudeJson?.mcpServers) ? claudeJson.mcpServers : {})) add(name, raw, "user", "user");
		if (options.trusted) {
			const rejected = new Set<string>();
			const approved = new Set<string>();
			let approveAll: boolean | undefined;
			for (const file of [projectEntry, ...setup.settings]) {
				for (const name of Array.isArray(file.disabledMcpjsonServers) ? file.disabledMcpjsonServers : []) rejected.add(String(name));
				for (const name of Array.isArray(file.enabledMcpjsonServers) ? file.enabledMcpjsonServers : []) approved.add(String(name));
				if (typeof file.enableAllProjectMcpServers === "boolean") approveAll = file.enableAllProjectMcpServers;
			}
			for (const [name, raw] of Object.entries(serverMap(reader.read(path.join(root, ".mcp.json"))))) {
				if (rejected.has(name)) skipped.push({ name: piName(name), source: "project", reason: "Claude rejects it (disabledMcpjsonServers)" });
				else if (approveAll === true || approved.has(name)) add(name, raw, "project", "project");
				else skipped.push({ name: piName(name), source: "project", reason: "it is waiting for approval in Claude" });
			}
		}
		for (const [name, raw] of Object.entries(isRecord(projectEntry.mcpServers) ? projectEntry.mcpServers : {})) add(name, raw, "local", "local");
	}
	for (const file of setup.managedSettings) {
		for (const [name, raw] of Object.entries(isRecord(file.managedMcpServers) ? file.managedMcpServers : {})) {
			const invalid = invalidProvided(name, raw);
			if (invalid) skipped.push({ name: piName(name), source: "managedMcpServers", reason: invalid });
			else add(name, raw, "managed-provided", "managedMcpServers");
		}
	}
	for (const [name, raw] of Object.entries(serverMap(managedFile))) add(name, raw, "managed", "managed-mcp.json");

	const servers = new Map<string, BridgedServer>();
	const accept = (candidate: Candidate): BridgedServer | undefined => {
		const reject = (reason: string) => skipped.push({ name: candidate.name, source: candidate.source, reason });
		if (candidate.displayNames.some((display) => disabled.has(display))) {
			reject("it is turned off in Claude's /mcp (disabledMcpServers)");
			return undefined;
		}
		const config = toPiConfig(candidate, context);
		if (typeof config === "string") {
			reject(config);
			return undefined;
		}
		const skipAllowlist = candidate.scope === "managed-provided" || (candidate.scope === "managed" && !expandsOutsideEnv(candidate.raw));
		const blocked = policyBlocks({ name: candidate.claudeName, ...config }, policy, env, skipAllowlist);
		if (blocked) {
			reject(blocked);
			return undefined;
		}
		return { name: candidate.name, config, source: candidate.source };
	};
	for (const candidate of named.values()) {
		const server = accept(candidate);
		if (server) servers.set(server.name, server);
	}

	// Plugin servers, skipped when they point at the same endpoint as a server above.
	if (!exclusive) {
		const taken = new Set([...servers.values()].map((server) => endpoint(server.config)));
		for (const plugin of enabledPlugins(setup)) {
			const source = `plugin ${plugin.id}`;
			const unsupported: string[] = [];
			for (const [serverName, raw] of Object.entries(pluginServerMap(plugin.root, plugin.manifest, reader, unsupported))) {
				const name = piName(`plugin_${plugin.name}_${serverName}`);
				if (servers.has(name)) continue;
				const scoped = `plugin:${plugin.name}:${serverName}`;
				const server = accept({ claudeName: scoped, name, raw, scope: "plugin", source, plugin, displayNames: [name, scoped] });
				if (!server) continue;
				const key = endpoint(server.config);
				if (taken.has(key)) {
					skipped.push({ name, source, reason: "another configured server already points at the same endpoint" });
				} else {
					taken.add(key);
					servers.set(name, server);
				}
			}
			for (const item of unsupported) {
				skipped.push({ name: piName(`plugin_${plugin.name}`), source, reason: `it declares ${item}, an MCP bundle or URL that pi can't load` });
			}
		}
	}

	return { servers: [...servers.values()], skipped, notices, unreadable: reader.unreadable };
}
