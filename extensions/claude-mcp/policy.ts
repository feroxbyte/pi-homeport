/**
 * Claude Code's MCP allowlist and denylist (`allowedMcpServers`, `deniedMcpServers`):
 * https://code.claude.com/docs/en/managed-mcp.md#policy-based-control-with-allowlists-and-denylists
 *
 * - Entries match by `serverName` (exact), `serverCommand` (the exact command and arguments) or
 *   `serverUrl` (with `*` wildcards; without a port, a host written out in full matches the
 *   scheme's default port only, and a host with a `*` matches any port).
 * - Denylists merge from every settings file, and a match blocks the server outright.
 * - Allowlists merge from every settings file, or come from managed settings alone when managed
 *   settings set `allowManagedMcpServersOnly`. Unset allows everything; an empty list allows
 *   nothing. A remote server must match a `serverUrl` entry, a stdio server a `serverCommand`
 *   entry; a `serverName` match counts only when the list has no entries of that kind.
 */

import { type ClaudeSetup, isRecord, type Json } from "../shared/claude.ts";

export interface PolicyEntry {
	serverName?: string;
	serverCommand?: string[];
	serverUrl?: string;
}

export interface McpPolicy {
	/** Undefined when no settings file sets `allowedMcpServers`. */
	allow: PolicyEntry[] | undefined;
	deny: PolicyEntry[];
}

export type PolicyServer = { name: string } & ({ command: string; args?: string[] } | { url: string });

function entries(value: unknown): PolicyEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map((entry) => ({
		...(typeof entry.serverName === "string" ? { serverName: entry.serverName } : {}),
		...(Array.isArray(entry.serverCommand) ? { serverCommand: entry.serverCommand.map(String) } : {}),
		...(typeof entry.serverUrl === "string" ? { serverUrl: entry.serverUrl } : {}),
	}));
}

export function readPolicy(setup: ClaudeSetup): McpPolicy {
	const deny = setup.settings.flatMap((file) => entries(file.deniedMcpServers));
	const managedOnly = setup.managedSettings.some((file) => file.allowManagedMcpServersOnly === true);
	const sources: Json[] = managedOnly ? setup.managedSettings : setup.settings;
	const setting = sources.filter((file) => Array.isArray(file.allowedMcpServers));
	return { allow: setting.length > 0 ? setting.flatMap((file) => entries(file.allowedMcpServers)) : undefined, deny };
}

/** `${VAR}` and `${VAR:-default}` in a policy entry, from the environment Claude Code started with. */
function expandEntry(value: string, env: Record<string, string | undefined>): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole: string, name: string, fallback?: string) => env[name] ?? fallback ?? whole);
}

function wildcard(pattern: string, flags = ""): RegExp {
	return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, flags);
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" };

/** Whether a server URL matches a `serverUrl` pattern, with Claude's port rules. */
export function matchesUrl(url: string, pattern: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const match = /^([^:/]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
	if (!match) return false;
	const [, scheme = "", hostPort = "", pathPattern] = match;
	if (scheme !== "*" && `${scheme.toLowerCase()}:` !== parsed.protocol) return false;
	const portMatch = /^(.*):(\*|\d+)$/.exec(hostPort);
	const hostPattern = (portMatch ? portMatch[1] : hostPort)?.replace(/\.$/, "") ?? "";
	const host = parsed.hostname.replace(/\.$/, "");
	if (!wildcard(hostPattern, "i").test(host)) return false;
	const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || "";
	const portPattern = portMatch?.[2];
	if (portPattern !== undefined) {
		if (portPattern !== "*" && portPattern !== port) return false;
	} else if (!hostPattern.includes("*") && parsed.port !== "") {
		return false;
	}
	if (pathPattern === undefined) return true;
	return wildcard(pathPattern).test(`${parsed.pathname}${parsed.search}`);
}

function matches(server: PolicyServer, entry: PolicyEntry, env: Record<string, string | undefined>): boolean {
	if (entry.serverName !== undefined && entry.serverName === server.name) return true;
	if (entry.serverCommand && "command" in server) {
		const wanted = entry.serverCommand.map((part) => expandEntry(part, env));
		const actual = [server.command, ...(server.args ?? [])];
		if (wanted.length === actual.length && wanted.every((part, index) => part === actual[index])) return true;
	}
	if (entry.serverUrl !== undefined && "url" in server) return matchesUrl(server.url, expandEntry(entry.serverUrl, env));
	return false;
}

/** Why the policy blocks a server, or undefined when it may load. `skipAllowlist` is for the
 * organization's own servers, which need no allowlist entry. */
export function policyBlocks(server: PolicyServer, policy: McpPolicy, env: Record<string, string | undefined>, skipAllowlist: boolean): string | undefined {
	if (policy.deny.some((entry) => matches(server, entry, env))) return "Claude's deniedMcpServers blocks it";
	if (skipAllowlist || policy.allow === undefined) return undefined;
	const kind = "url" in server ? "serverUrl" : "serverCommand";
	const specific = policy.allow.filter((entry) => entry[kind] !== undefined);
	const candidates = specific.length > 0 ? specific : policy.allow.filter((entry) => entry.serverName !== undefined);
	return candidates.some((entry) => matches(server, entry, env)) ? undefined : "it isn't in Claude's allowedMcpServers";
}
