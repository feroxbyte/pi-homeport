/**
 * Claude MCP: hands the MCP servers Claude Code would connect in this project to pi's built-in
 * MCP, which connects them, signs in, and exposes their tools.
 *
 * Which servers, and why, is decided in `servers.ts`. `/claude-mcp` lists what was handed over and
 * what was skipped.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ClaudeMcpResult, claudeMcpServers } from "./servers.ts";

export default function claudeMcp(pi: ExtensionAPI) {
	const registered = new Set<string>();
	let last: ClaudeMcpResult | undefined;
	const failed: string[] = [];

	function sync(ctx: ExtensionContext) {
		const result = claudeMcpServers({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		last = result;
		failed.length = 0;
		const wanted = new Set(result.servers.map((server) => server.name));
		for (const name of registered) {
			if (wanted.has(name)) continue;
			pi.unregisterMcpServer(name);
			registered.delete(name);
		}
		for (const server of result.servers) {
			try {
				pi.registerMcpServer(server.name, server.config);
				registered.add(server.name);
			} catch (error) {
				failed.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const problems = [
			...result.unreadable.map((file) => `Claude MCP: couldn't read ${file} as JSON.`),
			...failed.map((line) => `Claude MCP: pi refused ${line}`),
		];
		if (problems.length > 0 && ctx.hasUI) ctx.ui.notify(problems.join("\n"), "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		sync(ctx);
	});

	pi.registerCommand("claude-mcp", {
		description: "List the MCP servers taken from your Claude Code setup, and the ones skipped",
		handler: async (_args, ctx) => {
			if (!last) {
				ctx.ui.notify("Claude MCP: no session has started yet.", "info");
				return;
			}
			const lines = [
				"Handed to pi:",
				...(last.servers.length > 0 ? last.servers.map((server) => `  ${server.name}  (${server.source})`) : ["  none"]),
			];
			if (last.skipped.length > 0) {
				lines.push("Skipped:", ...last.skipped.map((server) => `  ${server.name}  (${server.source}): ${server.reason}`));
			}
			if (failed.length > 0) lines.push("Refused by pi:", ...failed.map((line) => `  ${line}`));
			if (last.notices.length > 0) lines.push("Notes:", ...last.notices.map((line) => `  ${line}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
