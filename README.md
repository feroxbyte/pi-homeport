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
- the prompt cache hit rate of the last response, how long the cache has left, and the session's cost;
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

Long commands run in the background (based on
[pi-background](https://github.com/pringled/pi-extensions/tree/main/packages/pi-background)): the
model starts them with `bg_run`, a shell command still running after 2 minutes moves there on its
own, and ctrl+b moves one sooner. While jobs run, the line under a turn adds `2 background jobs ·
↓ to manage`: press ↓ in an empty input (or type `/bg`) for the list, ↑ ↓ to select, enter to open
a job's output, `x` to stop it, and esc to go back. In a job, ↑ ↓, page up and down, `g` and `G`
scroll through its log. A `/reload` leaves running jobs alone and the reloaded session reports on
them; quitting, `/new`, `/resume` and `/fork` stop them.

The model can also watch something while you keep working, as Claude Code's Monitor does (based on
the monitor extension of [pi-code](https://github.com/ilovepixelart/pi-code)): `monitor` runs a
command in the background and each line it prints arrives as an event, so it can tail a log, follow
a CI run or react to file changes. A watch ends after 5 minutes unless the model asks for more (at
most 30) and says so once; lines that arrive together come as one event, and a command that prints
too fast is throttled and then stopped. Monitors show in the jobs line and in `/bg` next to
background jobs, and `task_stop` stops either one (`bg1`, `mon1`). Leave it out with
`"!extensions/monitor/**"`.

The model keeps a todo list you can
see above the input (based on
[rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)); `/todos` lists
it. Don't install those packages next to pi-homeport.

When pi finishes and waits for you while you're away from the terminal, it notifies you as Claude
Code does (based on [pi-notify](https://github.com/ferologics/pi-notify)), following Claude's
`preferredNotifChannel`: by default a desktop notification in iTerm2, Kitty, Ghostty, WezTerm and
Windows Terminal, and nothing elsewhere; `"terminal_bell"` rings the bell in any terminal, such as
the VS Code one. You count as away when the terminal reports it lost focus, or can't report focus at
all; pressing Esc never notifies. Leave it out with `"!extensions/notify/**"`, and don't install
pi-notify next to it.

Before each prompt, pi saves the files it has edited in the session as a checkpoint, as Claude Code
does (based on the git-checkpoint extension of [pi-code](https://github.com/ilovepixelart/pi-code)).
`/rewind` (or `/undo`) lists your prompts; pick one to restore the code and the conversation, only
the conversation, or only the code, or to summarize the conversation from there on. Edited and
deleted files are put back and files created since are removed; the prompt comes back into the
editor. Picking a prompt in `/tree` (Esc Esc) or `/fork` offers to restore the code too. Only files
pi's edit and write tools touched are tracked, never files your git ignores or files outside the
repository, and symlinks and hard-linked files are skipped. Each code restore can be undone from the
top of the `/rewind` list. Checkpoints need a git repository, are kept in
`~/.pi/agent/pi-homeport/checkpoints/` for `cleanupPeriodDays` (30 days by default), and
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1` turns them off. Leave it out with
`"!extensions/rewind/**"`.

`web_search` and `web_fetch` need no API key (based on the web extension of
[pi-code](https://github.com/ilovepixelart/pi-code)). Search reads DuckDuckGo's results page, with
allowed and blocked domains. Fetch works as Claude Code's WebFetch does: http becomes https, a
redirect to another host is reported instead of followed, private and local addresses are refused,
HTML becomes Markdown, each page is cached for 15 minutes (`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`), and
a `prompt` makes the current model answer from the page. Because DuckDuckGo can limit or change its
page, a failed search says so and the model can fetch a known URL instead. Leave it out with
`"!extensions/web/**"`, for example to use [pi-web-access](https://www.npmjs.com/package/pi-web-access)
and its paid search providers.

Plan mode works as in Claude Code (based on the plan-mode extension of
[pi-code](https://github.com/ilovepixelart/pi-code)): `/plan` turns it on, `/plan fix the auth bug`
also starts that task, and ctrl+alt+p turns it on or off (Shift+Tab is pi's thinking-level key, which
extensions can't take). `pi --plan` starts in plan mode, and so does `"defaultMode": "plan"` in
Claude's `permissions`. While planning, the model sees only read-only tools: edits are blocked,
Claude's read-only shell commands run, and anything else asks you first. When the plan is ready the
model presents it, and you start, edit the plan first, or keep planning and say what to change;
starting turns plan mode off and the model gets to work in the same turn. Leave it out with
`"!extensions/plan/**"`.

`/goal all tests in test/auth pass` keeps pi working until the condition holds (based on the goal
extension of pi-code). After each turn a separate check on the current model (or
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, when pi has that model) reads the conversation and says whether the
goal is met; if not, its reason starts the next turn. `/goal` shows how it's going, `/goal clear`
stops it, and the footer shows `◎ /goal active`. As in Claude, a goal pauses after 8 turns in a row
without a tool call (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), clears on an error you have to fix, retries
or pauses on others, waits while a pi-subagents run or a background command is still going (with a
check-in after `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`), survives a resume, and is unavailable when
Claude's `disableAllHooks` or `allowManagedHooksOnly` is set. `pi -p "/goal ..."` runs until the goal
resolves. Leave it out with `"!extensions/goal/**"`.

`/context` shows what fills the context window, as Claude Code's does (based on the context-usage
extension of [pi-code](https://github.com/ilovepixelart/pi-code)): the system prompt, system and MCP
tools, memory files, skills, messages, free space and the auto-compaction buffer, then the
instruction and memory files that loaded, with a warning that names `/compact` when the conversation
is over the window. The total is pi's own count, the one in the footer; the categories are estimates.
Leave it out with `"!extensions/context/**"`.

A session you don't name gets a title from its first prompt, as in Claude Code (based on the
session-title extension of pi-code), and the title shows in `/resume` and in the terminal's title. A
name you set with `--name` or `/name` wins. The model `ANTHROPIC_DEFAULT_HAIKU_MODEL` names writes the
title when pi has it, the session's model otherwise; print runs get none, and
`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` turns titles off. Leave it out with `"!extensions/title/**"`.

pi-homeport draws the tools of these packages the same way, and works well with them:
[pi-subagents](https://www.npmjs.com/package/pi-subagents) for subagents,
[pi-web-access](https://www.npmjs.com/package/pi-web-access) for more search providers, and
[rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) for
questions to you.

Not supported, because pi can't do it: SSE and WebSocket MCP servers, MCP prompts as commands,
"Summarize up to here" in `/rewind` (pi only compacts up to a point it chooses),
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
    "!extensions/commands.ts",
    "!extensions/status-line.ts",
    "!extensions/plugins.ts",
    "!extensions/todo.ts",
    "!extensions/notify.ts",
    "!extensions/web.ts",
    "!extensions/background-bash.ts",
    "!extensions/monitor.ts",
    "!extensions/git-checkpoint.ts",
    "!extensions/plan-mode/**",
    "!extensions/goal.ts",
    "!extensions/context-usage.ts",
    "!extensions/session-title.ts"
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
