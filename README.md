# pi-homeport

Use your Claude Code setup in [pi](https://pi.dev): the MCP servers, skills, instructions and
memories you already have, without configuring them twice.

pi-homeport is an independent project. It is not made by or affiliated with Anthropic.

## What it brings over

pi-homeport reads your Claude Code configuration and follows Claude Code's own rules for what loads
in each project: plugins installed for that project and turned on, project files only in folders pi
trusts, and Claude's settings precedence.

- **MCP servers** from your user, local and project configuration, your plugins, and your
  organization's managed MCP, connected through pi's built-in MCP. Claude's allowlists and
  denylists, `alwaysLoad`, timeouts, plugin options (`${user_config.*}`) and `headersHelper` apply.
  `/claude-mcp` lists what loaded and what didn't.
- **Skills** from the managed skills folder, `~/.claude/skills`, the project's `.claude/skills`
  (nested ones included), your plugins and claude.ai, loaded by pi's own skill loader. Skills
  written for tools only Claude Code has are left out.
  - Invoke them as in Claude Code (`/tdd`, `/cloudflare:wrangler`) or as pi does (`/skill:tdd`).
  - Arguments (`$ARGUMENTS`, `$0`), `${CLAUDE_*}` variables and injected commands (`` !`cmd` ``)
    work as in Claude Code; a command runs only if your Claude permission rules or the skill's
    `allowed-tools` allow it.
  - `skillOverrides`, `Skill(...)` deny rules, `when_to_use`, `paths`, `user-invocable`, and a typed
    skill's `model`, `effort` and `disallowed-tools` are honored.
  - `/claude-skills` switches skills on, off or to name only, and shows what each one costs in
    context. `/claude-plugins` does the same for plugins. Both write Claude Code's own settings
    (`skillOverrides`, `enabledPlugins`), for this project in `.claude/settings.local.json` or for all
    projects in `~/.claude/settings.json`, so Claude Code follows the change too.
- **Custom commands** from `~/.claude/commands/`, the project's `.claude/commands/` and your plugins,
  which Claude Code runs as skills: `frontend/component.md` is `/frontend:component`, and a skill
  with the same name wins. pi loads skills only from `SKILL.md` files, so pi-homeport writes one per
  command under `~/.pi/agent/pi-homeport/commands/`.
- **Instructions**: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/` and `AGENTS.md`, from your
  organization, `~/.claude` and every folder up to the project, in Claude's order and by Claude's
  rules: the Project instructions setting, `@path` imports, `claudeMdExcludes`, and rules with
  `paths`. A subfolder's instructions load when the model reads or edits a file there. pi's own
  context files in its agent folder still load; the ones it finds in your project are replaced.
- **Auto memory**: the same memory folder as Claude Code (`~/.claude/projects/<project>/memory`),
  so memories saved in either one carry over to the other. The model writes memories with pi's
  file tools, as Claude does. `autoMemoryEnabled`, `autoMemoryDirectory` and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` apply. `/claude-memory` lists what loaded, opens a file in your
  editor, and turns auto memory on or off.

It also replaces pi's footer with one line:

- the project, the model and effort, and the git branch with uncommitted changes (`*`) and commits
  ahead or behind (`↑2 ↓1`);
- a context bar with a mark (`┊`) where auto-compaction starts;
- the prompt cache hit rate of the last response, and the session's cost;
- `● working 12s · ~70 tok/s` during a turn, and `○ ready · 332 out · 94 tok/s` after it.

Statuses from other extensions follow when there's room. It's based on
[pi-context-bar](https://github.com/pringled/pi-extensions/tree/main/packages/pi-context-bar). To
keep pi's footer, or another one, leave it out: `{ "source": "npm:pi-homeport", "extensions":
["!extensions/footer/**"] }`.

It also draws the chat closer to Claude Code: each tool call is a `● Read(notes.txt)` row with
`⎿  Read 3 lines` under it, a shell command shows its first output lines, and edits and new files
show a highlighted diff, with ctrl+o to see everything. Your messages start with `>`, the model's
replies with `●`, and an orange line shows what pi is doing while it works. A typed skill shows as
`> /tdd fix the parser` with `⎿  Loaded skill tdd` under it; todos as a checklist; agents as
`Done (12 tool uses · 31.2k tokens · 1m 04s)`; hidden thinking as `∴ Thought`; Esc as
`⎿  Interrupted by user`; and compaction as one line. It's based on
[pi-polish](https://github.com/pringled/pi-extensions/tree/main/packages/pi-polish); don't use both.
Your messages and the model's replies are restyled through pi's internal components, so a pi update
can change them until pi-homeport catches up. To keep pi's own look, leave it out:
`"!extensions/chat/**"`.

Not supported, because pi can't do it: SSE and WebSocket MCP servers, MCP prompts as commands,
plugin options Claude keeps in your system's credential store, argument hints, Claude Code's
built-in skills, and instructions that load when a shell command such as `cat` reads a file. Imports
from outside a project load once you've approved them in Claude Code, since pi can't show that
prompt for it. Skills with `context: fork` or `hooks` load, but those fields wait for agents and
hooks support.

## Install

```sh
pi install npm:pi-homeport
```

pi's built-in MCP must be on: remove `"-builtin:mcp"` from `extensions` in `~/.pi/agent/settings.json`
if it's there. If you also use pi-code, turn off the extensions that do the same jobs, so nothing loads twice:

```json
{
  "source": "npm:pi-code",
  "extensions": [
    "!extensions/mcp/**",
    "!extensions/skills.ts",
    "!extensions/memory.ts",
    "!extensions/claude-rules.ts",
    "!extensions/context-imports.ts",
    "!extensions/commands.ts"
  ]
}
```

Remote MCP servers that sign in with OAuth need one sign-in in pi: `/mcp login <server>`.

## Develop

```sh
pnpm install
pnpm check
pnpm test
pi -e .   # try the working copy for one run
```

Extensions live in `extensions/` as TypeScript that pi loads without a build step.

## Release

Releases publish from GitHub Actions through npm's trusted publishing, without an npm token:

1. Set the new version in `package.json` and commit it.
2. Tag the commit `v<version>` and push the tag. The Release workflow checks, tests and stages the
   package on npm.
3. Approve the staged version on npmjs.com (Staged Packages) or with `npm stage approve`.
