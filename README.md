# pi-homeport

Use your Claude Code setup in [pi](https://pi.dev): the MCP servers, skills and agents you already
have, without configuring them twice.

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

Not supported, because pi can't do it: SSE and WebSocket MCP servers, MCP prompts as commands,
plugin options Claude keeps in your system's credential store, argument hints, and Claude Code's
built-in skills. Skills with `context: fork` or `hooks` load, but those fields wait for agents and
hooks support.

## Install

```sh
pi install npm:pi-homeport
```

pi's built-in MCP must be on: remove `"-builtin:mcp"` from `extensions` in `~/.pi/agent/settings.json`
if it's there. If you also use pi-code, turn off its MCP and skills extensions so the two don't load
the same servers and skills twice:

```json
{ "source": "npm:pi-code", "extensions": ["!extensions/mcp/**", "!extensions/skills.ts"] }
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
