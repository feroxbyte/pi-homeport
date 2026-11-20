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
  - `/claude-skills` lists what loaded, what didn't, and why.
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
