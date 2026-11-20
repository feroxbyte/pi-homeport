/**
 * A real pi session for the plan and goal tests, on pi's faux provider: scripted model replies, no
 * network, and pi's agent folder, Claude's config folder and the project all in a temp folder.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionFactory, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface FakeUI {
	select?: (title: string, options: string[]) => string | undefined;
	editor?: (title: string, prefill?: string) => string | undefined;
	confirm?: (title: string, message: string) => boolean;
}

export async function fauxSession(extensions: ExtensionFactory[], responses: FauxResponseStep[], ui?: FakeUI) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-"));
	const agentDir = path.join(dir, "agent");
	const cwd = path.join(dir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const saved = { agent: process.env.PI_CODING_AGENT_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");

	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1000 }] });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: extensions,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	const errors: string[] = [];
	const notes: string[] = [];
	const uiContext = ui && {
		select: async (title: string, options: string[]) => ui.select?.(title, options),
		confirm: async (title: string, message: string) => ui.confirm?.(title, message) ?? false,
		input: async () => undefined,
		editor: async (title: string, prefill?: string) => ui.editor?.(title, prefill),
		notify: (message: string) => notes.push(message),
		setStatus: () => {},
		setWidget: () => {},
		setWorkingMessage: () => {},
		onTerminalInput: () => () => {},
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	};
	await session.bindExtensions({ uiContext, mode: ui ? "rpc" : "print", onError: (error: { error: string }) => errors.push(error.error) } as never);
	faux.setResponses(responses);
	return {
		session,
		faux,
		errors,
		notes,
		/** The custom entries and messages on the branch, as `type:customType`. */
		customs: () =>
			session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" || entry.type === "custom_message")
				.map((entry) => entry as { type: string; customType: string; content?: unknown; data?: unknown }),
		dispose() {
			session.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
			for (const [key, value] of [
				["PI_CODING_AGENT_DIR", saved.agent],
				["CLAUDE_CONFIG_DIR", saved.claude],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}
