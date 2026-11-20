import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { matchesUrl } from "../extensions/mcp/policy.ts";
import { claudeMcpServers, type HelperRunner } from "../extensions/mcp/servers.ts";

let base: string;
let home: string;
let project: string;

function write(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function run(options: { trusted?: boolean; env?: Record<string, string>; cwd?: string; runHelper?: HelperRunner } = {}) {
	return claudeMcpServers({
		cwd: options.cwd ?? project,
		trusted: options.trusted ?? true,
		home,
		env: options.env ?? {},
		managedSettingsDir: path.join(base, "managed"),
		...(options.runHelper ? { runHelper: options.runHelper } : {}),
	});
}

function names(result: ReturnType<typeof run>) {
	return result.servers.map((server) => server.name).sort();
}

/** Installs a plugin into the fake Claude home: its files, and its record in installed_plugins.json. */
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
	base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-"));
	home = path.join(base, "home");
	project = path.join(base, "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("scopes", () => {
	it("takes user servers from ~/.claude.json", () => {
		write(path.join(home, ".claude.json"), { mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } });
		const [server] = run().servers;
		assert.deepEqual(server, {
			name: "docs",
			source: "user",
			config: { url: "https://docs.example.com/mcp", exposure: "deferred" },
		});
	});

	it("lets local scope replace project scope, and project scope replace user scope", () => {
		write(path.join(home, ".claude.json"), {
			mcpServers: { a: { url: "https://user.example.com/a" }, b: { url: "https://user.example.com/b" } },
			projects: { [project]: { mcpServers: { a: { url: "https://local.example.com/a" } } } },
		});
		write(path.join(project, ".mcp.json"), { mcpServers: { a: { url: "https://project.example.com/a" }, b: { url: "https://project.example.com/b" } } });
		write(path.join(project, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true });
		const result = run();
		const url = (name: string) => {
			const config = result.servers.find((server) => server.name === name)?.config;
			return config && "url" in config ? config.url : undefined;
		};
		assert.equal(url("a"), "https://local.example.com/a");
		assert.equal(url("b"), "https://project.example.com/b");
	});

	it("finds the project's ~/.claude.json entry from a subfolder of the repository", () => {
		write(path.join(home, ".claude.json"), { projects: { [project]: { mcpServers: { local: { command: "local-server" } } } } });
		fs.mkdirSync(path.join(project, "packages", "app"), { recursive: true });
		assert.deepEqual(names(run({ cwd: path.join(project, "packages", "app") })), ["local"]);
	});

	it("skips servers turned off in Claude's /mcp", () => {
		write(path.join(home, ".claude.json"), {
			mcpServers: { docs: { url: "https://docs.example.com/mcp" } },
			projects: { [project]: { disabledMcpServers: ["docs"] } },
		});
		const result = run();
		assert.deepEqual(names(result), []);
		assert.match(result.skipped[0]?.reason ?? "", /disabledMcpServers/);
	});
});

describe("project .mcp.json approval", () => {
	beforeEach(() => {
		write(path.join(project, ".mcp.json"), { mcpServers: { one: { command: "one" }, two: { command: "two" } } });
	});

	it("waits for approval when Claude hasn't approved a server", () => {
		const result = run();
		assert.deepEqual(names(result), []);
		assert.deepEqual(
			result.skipped.map((server) => server.reason),
			["it is waiting for approval in Claude", "it is waiting for approval in Claude"],
		);
	});

	it("connects the servers listed in enabledMcpjsonServers", () => {
		write(path.join(home, ".claude.json"), { projects: { [project]: { enabledMcpjsonServers: ["one"] } } });
		assert.deepEqual(names(run()), ["one"]);
	});

	it("connects every server with enableAllProjectMcpServers, except rejected ones", () => {
		write(path.join(project, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true });
		write(path.join(home, ".claude", "settings.json"), { disabledMcpjsonServers: ["two"] });
		assert.deepEqual(names(run()), ["one"]);
	});

	it("ignores project files when pi doesn't trust the project", () => {
		write(path.join(project, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true });
		assert.deepEqual(names(run({ trusted: false })), []);
	});
});

describe("plugins", () => {
	const cloudflare = { ".mcp.json": { mcpServers: { cloudflare: { type: "http", url: "https://mcp.cloudflare.com/mcp" } } } };

	it("names a plugin server plugin_<plugin>_<server>, like Claude", () => {
		installPlugin("cloudflare@official", { scope: "user" }, cloudflare);
		assert.deepEqual(names(run()), ["plugin_cloudflare_cloudflare"]);
	});

	it("skips a plugin installed only for another project", () => {
		installPlugin("expo@official", { scope: "project", projectPath: path.join(base, "other") }, cloudflare);
		assert.deepEqual(names(run()), []);
	});

	it("loads a plugin installed for this project", () => {
		installPlugin("expo@official", { scope: "project", projectPath: project }, cloudflare);
		assert.deepEqual(names(run()), ["plugin_expo_cloudflare"]);
	});

	it("skips a plugin a project enables but that isn't installed for it", () => {
		installPlugin("svelte@svelte", { scope: "project", projectPath: path.join(base, "other") }, cloudflare);
		write(path.join(project, ".claude", "settings.json"), { enabledPlugins: { "svelte@svelte": true } });
		assert.deepEqual(names(run()), []);
	});

	it("merges enabledPlugins key by key, local settings over project over user", () => {
		installPlugin("a@m", { scope: "user" }, { ".mcp.json": { s: { command: "a" } } });
		installPlugin("b@m", { scope: "user" }, { ".mcp.json": { s: { command: "b" } } });
		write(path.join(home, ".claude", "settings.json"), { enabledPlugins: { "a@m": false, "b@m": false } });
		write(path.join(project, ".claude", "settings.json"), { enabledPlugins: { "a@m": true, "b@m": true } });
		write(path.join(project, ".claude", "settings.local.json"), { enabledPlugins: { "b@m": false } });
		assert.deepEqual(names(run()), ["plugin_a_s"]);
	});

	it("follows defaultEnabled when no settings file mentions the plugin", () => {
		installPlugin("off@m", { scope: "user" }, { ".claude-plugin/plugin.json": { name: "off", defaultEnabled: false }, ".mcp.json": { s: { command: "x" } } });
		assert.deepEqual(names(run()), []);
	});

	it("reads manifest servers inline and from a JSON path, after .mcp.json", () => {
		installPlugin("p@m", { scope: "user" }, {
			".mcp.json": { mcpServers: { first: { command: "from-root" }, shared: { command: "from-root" } } },
			"servers.json": { mcpServers: { second: { command: "from-file" } } },
			".claude-plugin/plugin.json": { name: "p", mcpServers: ["./servers.json", { shared: { command: "from-manifest" } }] },
		});
		const result = run();
		assert.deepEqual(names(result), ["plugin_p_first", "plugin_p_second", "plugin_p_shared"]);
		const shared = result.servers.find((server) => server.name === "plugin_p_shared")?.config;
		assert.equal(shared && "command" in shared ? shared.command : undefined, "from-manifest");
	});

	it("fills ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA}", () => {
		const root = installPlugin("db@m", { scope: "user" }, {
			".mcp.json": { db: { command: "${CLAUDE_PLUGIN_ROOT}/server", args: ["--data", "${CLAUDE_PLUGIN_DATA}"] } },
		});
		assert.deepEqual(run().servers[0]?.config, {
			command: `${root}/server`,
			args: ["--data", path.join(home, ".claude", "plugins", "data", "db-m")],
			exposure: "deferred",
		});
	});

	it("skips a plugin server that points at the same endpoint as a configured server", () => {
		write(path.join(home, ".claude.json"), { mcpServers: { cf: { url: "https://MCP.cloudflare.com:443/mcp/" } } });
		installPlugin("cloudflare@official", { scope: "user" }, cloudflare);
		const result = run();
		assert.deepEqual(names(result), ["cf"]);
		assert.match(result.skipped[0]?.reason ?? "", /same endpoint/);
	});
});

describe("server entries", () => {
	function single(entry: unknown, env: Record<string, string> = {}) {
		write(path.join(home, ".claude.json"), { mcpServers: { s: entry } });
		return run({ env });
	}

	it("expands ${VAR} and ${VAR:-default}, keeping unset variables as written", () => {
		const result = single({ command: "${BIN:-server}", args: ["${SET}", "${UNSET}"], env: { KEY: "${SET}" } }, { SET: "value" });
		assert.deepEqual(result.servers[0]?.config, { command: "server", args: ["value", "${UNSET}"], env: { KEY: "value" }, exposure: "deferred" });
	});

	it("reads credential variables as empty in a remote server's url and headers", () => {
		const result = single(
			{ url: "https://x.example.com/mcp", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}", Team: "${TEAM}" } },
			{ ANTHROPIC_API_KEY: "secret", TEAM: "core" },
		);
		assert.deepEqual(result.servers[0]?.config, {
			url: "https://x.example.com/mcp",
			headers: { Authorization: "Bearer ", Team: "core" },
			exposure: "deferred",
		});
	});

	it("maps Claude's oauth fields to pi's", () => {
		const result = single({ url: "https://x.example.com/mcp", oauth: { clientId: "id", callbackPort: 8080, scopes: "read write" } });
		assert.deepEqual(result.servers[0]?.config, {
			url: "https://x.example.com/mcp",
			oauth: { clientId: "id", callbackPort: 8080, scope: "read write" },
			exposure: "deferred",
		});
	});

	for (const [label, entry, reason] of [
		["SSE", { type: "sse", url: "https://x.example.com/sse" }, /SSE/],
		["WebSocket", { type: "ws", url: "wss://x.example.com" }, /WebSocket/],
		["headersHelper", { url: "https://x.example.com/mcp", headersHelper: "./auth.sh" }, /headersHelper/],
		["a header pi would run", { url: "https://x.example.com/mcp", headers: { Authorization: "!cat token" } }, /would run as a command/],
		["neither command nor url", { type: "stdio" }, /doesn't match/],
	] as const) {
		it(`skips ${label}`, () => {
			const result = single(entry);
			assert.deepEqual(names(result), []);
			assert.match(result.skipped[0]?.reason ?? "", reason);
		});
	}

	it("reports a settings file that isn't valid JSON", () => {
		write(path.join(home, ".claude", "settings.json"), "{ not json");
		assert.deepEqual(run().unreadable, [path.join(home, ".claude", "settings.json")]);
	});
});

describe("managed MCP", () => {
	const managed = () => path.join(base, "managed");

	it("loads only managed-mcp.json and managedMcpServers when managed-mcp.json exists", () => {
		write(path.join(home, ".claude.json"), { mcpServers: { mine: { command: "mine" } } });
		installPlugin("cloudflare@official", { scope: "user" }, { ".mcp.json": { cf: { url: "https://cf.example.com/mcp" } } });
		write(path.join(managed(), "managed-mcp.json"), { mcpServers: { corp: { command: "corp-server" } } });
		write(path.join(managed(), "managed-settings.json"), { managedMcpServers: { search: { type: "http", url: "https://search.example.com/mcp" } } });
		const result = run();
		assert.deepEqual(names(result), ["corp", "search"]);
		assert.match(result.notices[0] ?? "", /managed-mcp.json/);
	});

	it("lets managedMcpServers replace a user server with the same name", () => {
		write(path.join(home, ".claude.json"), { mcpServers: { search: { url: "https://mine.example.com/mcp" } } });
		write(path.join(managed(), "managed-settings.json"), { managedMcpServers: { search: { type: "http", url: "https://search.example.com/mcp" } } });
		const config = run().servers[0]?.config;
		assert.equal(config && "url" in config ? config.url : undefined, "https://search.example.com/mcp");
	});

	it("drops managedMcpServers entries Claude drops", () => {
		write(path.join(managed(), "managed-settings.json"), {
			managedMcpServers: {
				plain: { type: "http", url: "http://x.example.com/mcp" },
				stdio: { type: "http", url: "https://x.example.com/mcp", command: "x" },
				vars: { type: "http", url: "https://${HOST}/mcp" },
			},
		});
		const result = run();
		assert.deepEqual(names(result), []);
		assert.deepEqual(
			result.skipped.map((server) => server.name),
			["plain", "stdio", "vars"],
		);
	});

	it("ignores managedMcpServers outside managed settings", () => {
		write(path.join(home, ".claude", "settings.json"), { managedMcpServers: { search: { type: "http", url: "https://search.example.com/mcp" } } });
		assert.deepEqual(names(run()), []);
	});
});

describe("allowlists and denylists", () => {
	beforeEach(() => {
		write(path.join(home, ".claude.json"), {
			mcpServers: { remote: { url: "https://mcp.example.com/api" }, local: { command: "npx", args: ["-y", "server"] } },
		});
	});

	it("blocks a server any denylist entry matches, by name, command or URL", () => {
		write(path.join(home, ".claude", "settings.json"), { deniedMcpServers: [{ serverName: "remote" }, { serverCommand: ["npx", "-y", "server"] }] });
		assert.deepEqual(names(run()), []);
	});

	it("allows only servers an allowlist matches, by URL for remote and command for stdio", () => {
		write(path.join(home, ".claude", "settings.json"), { allowedMcpServers: [{ serverUrl: "https://mcp.example.com/*" }] });
		assert.deepEqual(names(run()), ["remote"]);
	});

	it("counts a name match only when the list has no entries of the server's kind", () => {
		write(path.join(home, ".claude", "settings.json"), { allowedMcpServers: [{ serverName: "remote" }, { serverName: "local" }, { serverUrl: "https://other.example.com/*" }] });
		assert.deepEqual(names(run()), ["local"]);
	});

	it("allows nothing with an empty allowlist", () => {
		write(path.join(home, ".claude", "settings.json"), { allowedMcpServers: [] });
		assert.deepEqual(names(run()), []);
	});

	it("uses only managed allowlists with allowManagedMcpServersOnly", () => {
		write(path.join(home, ".claude", "settings.json"), { allowedMcpServers: [{ serverName: "remote" }, { serverName: "local" }] });
		write(path.join(base, "managed", "managed-settings.json"), { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverCommand: ["npx", "-y", "server"] }] });
		assert.deepEqual(names(run()), ["local"]);
	});

	it("matches URLs with Claude's port and wildcard rules", () => {
		const cases: [string, string, boolean][] = [
			["https://mcp.example.com/api", "https://mcp.example.com/*", true],
			["https://mcp.example.com:8443/api", "https://mcp.example.com/*", false],
			["https://mcp.example.com/api", "https://mcp.example.com", true],
			["https://mcp.example.com:8443/api", "https://mcp.example.com:8443/*", true],
			["https://mcp.example.com:8443/api", "https://mcp.example.com:*/*", true],
			["https://a.example.com:9000/x", "https://*.example.com/*", true],
			["http://mcp.example.com/x", "*://mcp.example.com/*", true],
			["https://Mcp.Example.com/api", "https://mcp.example.com/*", true],
			["https://mcp.example.com/API", "https://mcp.example.com/api", false],
		];
		for (const [url, pattern, expected] of cases) assert.equal(matchesUrl(url, pattern), expected, `${pattern} vs ${url}`);
	});
});

describe("server options", () => {
	function single(entry: unknown, env: Record<string, string> = {}) {
		write(path.join(home, ".claude.json"), { mcpServers: { s: entry } });
		return run({ env });
	}

	it("loads an alwaysLoad server's tools up front", () => {
		assert.equal(single({ url: "https://x.example.com/mcp", alwaysLoad: true }).servers[0]?.config.exposure, "direct");
	});

	it("turns a timeout in milliseconds into pi's seconds, falling back to MCP_TOOL_TIMEOUT", () => {
		assert.equal(single({ command: "x", timeout: 90_500 }).servers[0]?.config.timeout, 91);
		assert.equal(single({ command: "x", timeout: 500 }, { MCP_TOOL_TIMEOUT: "30000" }).servers[0]?.config.timeout, 30);
		assert.equal(single({ command: "x" }).servers[0]?.config.timeout, undefined);
	});
});

describe("plugin options", () => {
	const plugin = (userConfig: unknown) => ({
		".claude-plugin/plugin.json": { name: "deployer", userConfig },
		".mcp.json": { api: { url: "${user_config.endpoint}/mcp", headers: { "X-Team": "${user_config.team}" } } },
	});

	it("fills ${user_config.KEY} from pluginConfigs and the manifest defaults", () => {
		installPlugin("deployer@acme", { scope: "user" }, plugin({ endpoint: { type: "string" }, team: { type: "string", default: "core" } }));
		write(path.join(home, ".claude", "settings.json"), { pluginConfigs: { "deployer@acme": { options: { endpoint: "https://api.acme.com" } } } });
		assert.deepEqual(run().servers[0]?.config, { url: "https://api.acme.com/mcp", headers: { "X-Team": "core" }, exposure: "deferred" });
	});

	it("skips a server that needs a sensitive option Claude keeps in the credential store", () => {
		installPlugin("deployer@acme", { scope: "user" }, plugin({ endpoint: { type: "string", sensitive: true }, team: { type: "string", default: "core" } }));
		const result = run();
		assert.deepEqual(names(result), []);
		assert.match(result.skipped[0]?.reason ?? "", /credential store/);
	});
});

describe("headersHelper", () => {
	const helped = { url: "https://x.example.com/mcp", headers: { A: "static", B: "static" }, headersHelper: "./auth.sh" };

	it("merges the helper's headers over static ones, running it from the config folder for user servers", () => {
		const calls: { command: string; cwd: string; env: Record<string, string | undefined> }[] = [];
		write(path.join(home, ".claude.json"), { mcpServers: { s: helped } });
		const result = run({
			env: { MY_TOKEN: "secret" },
			runHelper: (command, cwd, env) => {
				calls.push({ command, cwd, env });
				return { ok: true, stdout: '{"B":"dynamic"}' };
			},
		});
		assert.deepEqual(result.servers[0]?.config, { url: "https://x.example.com/mcp", headers: { A: "static", B: "dynamic" }, exposure: "deferred" });
		assert.equal(calls[0]?.cwd, path.join(home, ".claude"));
		assert.equal(calls[0]?.env.CLAUDE_CODE_MCP_SERVER_NAME, "s");
		assert.equal(calls[0]?.env.MY_TOKEN, "secret");
	});

	it("runs a project server's helper from the project, without credential-like variables", () => {
		const calls: { cwd: string; env: Record<string, string | undefined> }[] = [];
		write(path.join(project, ".mcp.json"), { mcpServers: { s: helped } });
		write(path.join(project, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true });
		run({
			env: { MY_TOKEN: "secret", GIT_CONFIG_KEY_0: "x", PATH: "/bin" },
			runHelper: (_command, cwd, env) => {
				calls.push({ cwd, env });
				return { ok: true, stdout: "{}" };
			},
		});
		assert.equal(calls[0]?.cwd, project);
		assert.equal(calls[0]?.env.MY_TOKEN, undefined);
		assert.equal(calls[0]?.env.GIT_CONFIG_KEY_0, "x");
		assert.equal(calls[0]?.env.PATH, "/bin");
	});

	it("doesn't run a local server's helper in an untrusted project", () => {
		write(path.join(home, ".claude.json"), { projects: { [project]: { mcpServers: { s: helped } } } });
		let ran = false;
		const result = run({
			trusted: false,
			runHelper: () => {
				ran = true;
				return { ok: true, stdout: "{}" };
			},
		});
		assert.equal(ran, false);
		assert.deepEqual(names(result), ["s"]);
		assert.match(result.notices[0] ?? "", /doesn't trust/);
	});

	it("skips the server when the helper fails or prints something other than string headers", () => {
		write(path.join(home, ".claude.json"), { mcpServers: { s: helped } });
		assert.match(run({ runHelper: () => ({ ok: false, error: "boom" }) }).skipped[0]?.reason ?? "", /failed: boom/);
		assert.match(run({ runHelper: () => ({ ok: true, stdout: '{"A":1}' }) }).skipped[0]?.reason ?? "", /JSON object of strings/);
	});

	it("refuses a plugin helper that uses ${user_config.*}", () => {
		installPlugin("p@m", { scope: "user" }, { ".mcp.json": { s: { url: "https://x.example.com/mcp", headersHelper: "auth ${user_config.key}" } } });
		assert.match(run({ runHelper: () => ({ ok: true, stdout: "{}" }) }).skipped[0]?.reason ?? "", /user_config/);
	});
});
