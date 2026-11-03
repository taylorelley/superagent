# Superagent on Claude Code

Superagent runs on [Claude Code](https://code.claude.com) as a plugin with a
hooks module (a *mod*). It is the same agent team as the OpenCode plugin —
the same skills, roster, prompts, routing table, job board, council, presets,
commands and panel — built on Claude Code's own extension points. Everything
in [docs/superagent.md](superagent.md) about *what* the team does applies here;
this page covers *how* it lands in Claude Code and where the two hosts differ.

Requires Claude Code **2.1.287 or later** (mods are on by default from that
version). Verified against **2.1.317**.

## Install

From the marketplace this repository publishes:

```text
/plugin marketplace add taylorelley/superagent
/plugin install superagent@superagent
```

or, from your shell, `claude plugin marketplace add taylorelley/superagent`
then `claude plugin install superagent@superagent`. Run `/reload-plugins` in a
session that is already open.

To try it from a clone without installing:

```bash
git clone https://github.com/taylorelley/superagent.git
claude --plugin-dir ./superagent
```

Check it loaded: `/plugin` shows `1 mod active · superagent`, the Agent
tool lists the `superagent:*` agent types, and in a wide terminal the
Superagent pane opens beside the transcript.

## What you get

| Superagent feature | OpenCode 2 | Claude Code |
|---|---|---|
| Skills | registered by the plugin | the plugin's `skills/` folder, loaded natively as `superagent:<skill>` |
| Specialist roster | `ctx.agent.transform` | agent types registered at session start (`$.agent.register`), named `superagent:<name>` |
| Orchestrator as the default agent | `editor.default("superagent")` | the orchestrator role added to the main thread's system prompt; its routed model applied to the main thread's requests |
| Per-agent permissions | agent permission rules | tools withheld per agent, plus a `tool.check` guard for path- and pattern-scoped rules |
| Bootstrap + routing table | the session `context` hook | the conversation's first-message context (`prompt.context`) |
| Job board | the session `context` hook | attached to each prompt the main thread receives (`prompt.submit`) |
| Dispatch tracking + ownership check | `subagent` tool hooks | `agent.spawn` (records the dispatch, prepends the conflict notice), `turn.complete` (settles it with the subagent's answer) |
| Council | councillor agents | councillor agent types, sealed the same way |
| `/preset` `/board` `/update` `/council` | plugin commands | plugin commands (`$.command.register`) |
| Sidebar panel | TUI `sidebar.content` slot | a pane beside the transcript, toggled with `/superagent` |
| Update check | GitHub, cached to a file | GitHub, cached in the plugin store |

The roster is the ten agents of [the roster table](superagent.md#the-roster).
The nine specialists are agent types you dispatch with the `Agent` tool —
`superagent:implementer`, `superagent:task-reviewer`, `superagent:oracle`, and
so on — and the orchestrator is the main conversation itself, exactly as it is
OpenCode's default agent. Claude Code's built-in `Explore` and
`general-purpose` stand in for OpenCode's `explore` and `general`.

### Tool mapping

Skills speak in actions; this is how they map onto Claude Code's tools. The
bootstrap carries the same list.

<!-- BEGIN GENERATED CLAUDE TOOL MAP — source: core/tool-map.js -->

- Create or update todos → `TaskCreate`, `TaskUpdate` (or `TodoWrite`)
- `Subagent (general-purpose):` → `Agent` with `subagent_type: "general-purpose"`
- Invoke a skill → Claude Code's `Skill` tool
- Read files → `Read`
- Create, edit, or delete files → `Edit`, `Write`
- Run shell commands → `Bash`
- Search files → `Grep`, `Glob`
- Fetch a URL → `WebFetch`

For read-only codebase exploration, prefer `subagent_type: "Explore"`.
To continue a subagent, send it a `SendMessage` addressed to the agent id it returned.
Superagent skills are named `superagent:<skill>`; load them with the `Skill` tool.

<!-- END GENERATED CLAUDE TOOL MAP -->

## Configuration

The same `superagent.json`, with the same keys, presets and merge order as on
OpenCode (see [Configuration](superagent.md#configuration)), read from Claude
Code's directories:

| Layer | OpenCode | Claude Code |
|---|---|---|
| user | `~/.config/opencode/superagent.json` | `~/.claude/superagent.json` (honours `CLAUDE_CONFIG_DIR`) |
| project | `<project>/.opencode/superagent.json` | `<project>/.claude/superagent.json` |
| saved preset | `~/.config/opencode/superagent.state.json` | `~/.claude/superagent.state.json` |

`SUPERAGENT_PRESET`, `SUPERAGENT_DISABLE=1` and `SUPERAGENT_DEBUG=1` work the
same way. Comments and trailing commas are allowed, and a `.jsonc` spelling is
read too.

### Model routing

Per-slot routing works as on OpenCode, with one rule: **Claude Code runs Claude
models.** A slot takes an alias (`opus`, `sonnet`, `haiku`, `fable`), a full
id (`claude-opus-5-5`), a cloud-provider id (`us.anthropic.claude-…`), or
`inherit`:

```json
{
  "agents": {
    "models": {
      "implementer": "haiku",
      "reviewer": "sonnet",
      "deepReviewer": "opus",
      "oracle": "claude-opus-5-5#high"
    }
  }
}
```

- `provider/model` values written for OpenCode keep working when the model is
  a Claude one: `anthropic/claude-opus-5-5` is read as `claude-opus-5-5`.
- A `#variant` naming an effort level (`low`, `medium`, `high`, `xhigh`,
  `max`) becomes the agent's effort.
- A model that is not a Claude model (`openai/gpt-5`) is dropped with a
  warning, and the agent inherits the session model — the same thing OpenCode
  does with an unavailable model. It is never silently replaced with another.
- `models.orchestrator` routes the main thread: Superagent sets the model of
  the main conversation's requests to it.
- An unrouted slot leaves the agent's model unset, so it follows Claude Code's
  own default (`CLAUDE_CODE_SUBAGENT_MODEL`, else the session model).

The council works the same way, and needs at least two members on **distinct**
Claude models, for example `opus` and `sonnet`.

### Permissions

The roster's permission rules are the same rules OpenCode uses, and
`permissionOverrides` take the same shape. On Claude Code:

- An action an agent's rules deny outright (the last rule denies `*`) is
  withheld: the tool is not offered to that agent at all. Workers have no
  `Agent` tool; reviewers and advisors have no `Edit`, `Write` or
  `NotebookEdit`; councillors also have no `Bash`.
- Anything finer — a path-scoped edit, a command pattern, an `ask` — is
  enforced on each call. A denied call is refused with a reason naming the
  agent's role; an `ask` asks you.
- The orchestrator may write only under `.superagent/`, as on OpenCode. Its
  shell and read access are unchanged.
- An `allow` rule never approves a call on your behalf: Claude Code's own
  permission settings still decide those. Installing Superagent never widens
  what runs without asking.

Action names map onto Claude Code's tools: `edit` → `Edit`, `Write`,
`NotebookEdit`; `subagent` (or `task`) → `Agent`; `shell` (or `bash`) → `Bash`,
`PowerShell`; `read` → `Read`, `Glob`, `Grep`; `webfetch` → `WebFetch`;
`websearch` → `WebSearch`; `skill` → `Skill`.

## The job board

The board, the ownership marker and the conflict notice are the same:

```text
<!-- superagent-ownership: write=src/api/**; read=src/** -->
```

Every `Agent` dispatch is recorded when it starts. A dispatch whose write
claim overlaps a running one has the conflict notice prepended to its prompt
before the subagent sees it. A dispatch settles when the subagent's run ends —
foreground or background, Claude Code reports both the same way — with its
answer as the result, and a subagent resumed with `SendMessage` runs again
under the record that started it.

The board snapshot rides along with each prompt the main thread receives,
including the notifications background subagents send when they finish. Under
`checkpoint` it is attached only when it changed; under `latest`, every time.
Claude Code keeps what a prompt carried in the conversation, so `latest` cannot
strip the previous snapshots the way OpenCode's per-request hook does — each
new one supersedes the last.

`/board` prints the board straight into the transcript, without a model turn.

## Commands

| Command | What it does |
|---|---|
| `/preset [name] [--persist]` | Show, list, or save and apply a preset |
| `/board` | Print the job board |
| `/update [install]` | Show the update check's result, or install the update |
| `/council <question>` | Convene the council (with the `council` preset) |
| `/superagent` | Show or hide the Superagent pane |

A command whose name you already use is left alone, and Superagent's is not
registered — yours wins, as on OpenCode. `/board`, `/preset` and `/update`
answer in the plugin, so they cost no model turn. `/council` submits its
instruction to the model as the next prompt.

`/preset <name> --persist` saves the preset and re-registers the agents and
commands, so new dispatches use the new roster from the next turn. As on
OpenCode, **the running session keeps what it started with** — the
orchestrator role, its write guard and its model, and the bootstrap in its
context; new sessions get the new preset in full. A command the new preset
switches off is hidden, and says so if typed.

`/update install` pulls a git checkout in place (a `--plugin-dir` clone), or
runs `claude plugin update superagent` for an installed plugin. Either way it
takes effect after `/reload-plugins` or in a new session.

## The panel

The same panel as OpenCode's sidebar — plan progress, what the main thread is
doing and in which skill, each subagent with its live tool call, ownership,
conflicts, timer and result, the update notice and the footer — drawn by the
same layout code (`core/panel.js`) into a pane beside the transcript, sized to
the pane. The footer toggles the roster; `+N more` pages through long lists.

The pane opens at session start when the terminal is wide enough (Claude Code
places an unrequested pane from 144 columns); `/superagent` shows or hides it
at any width. It is drawn in the terminal, the Desktop app and the VS Code
extension. `{"tui": {"enabled": false}}` turns it off.

## Differences from OpenCode

| | OpenCode | Claude Code |
|---|---|---|
| Models | any `provider/model` | Claude models only; others inherit with a warning |
| Per-slot `temperature` | applied per request | **not applied**: Claude Code has no temperature control for agents or requests |
| Agent names | unprefixed, `agents.prefix` to avoid collisions | always `superagent:<name>`; `agents.prefix` still applies inside the namespace |
| Orchestrator | a selectable primary agent | the main conversation's role; `setDefaultAgent: false`, or your own `agent` setting, turns it off |
| Board `latest` strategy | strips old snapshots per request | each prompt carries the current snapshot; old ones stay in history |
| Background dispatch | `background: true` | dispatches run in the background (`run_in_background` where the tool offers it) |
| Following up a subagent | `subagent` with its `sessionID` | `SendMessage` to its agent id |
| Bootstrap in subagents | injected into every session; subagents are told to skip it | the main conversation only; specialists carry their own contract |
| A skill added while running | picked up by the watcher | picked up by `/reload-plugins` or a new session |
| A command switched off by `/preset` | unregistered | hidden from the command list, and says it is off if typed |

## What degrades, and how

Everything in [the OpenCode table](superagent.md#what-degrades-and-how)
applies, plus:

| If | Behaviour |
|---|---|
| Mods cannot run (Claude Code older than 2.1.287, `--safe-mode`, `--bare`, `disableAllHooks`, or an organization's `allowManagedModsOnly`) | Skills still load; the roster, bootstrap, orchestrator role, board, guards, commands and panel do not. Superagent then behaves like the `solo` preset without its bootstrap. |
| `claude -p`, the Agent SDK, or a cloud session | Everything but the panel: hooks run there, panes are not drawn. |
| A slot or councillor names a non-Claude model | That model is dropped with a warning; the agent inherits. |
| A command name is taken | Yours is kept; Superagent's is not registered, and the bootstrap says so once. |
| The pane does not fit | It waits for room; `/superagent` opens it at any width. |

## Troubleshooting

**Nothing happens.** Run `/plugin`: the Installed tab should list
`superagent`, and the line under the tabs should say a mod is active. In your
shell, `claude plugin validate <path-to-superagent>` lists every event the
hooks module handles and every call it makes.

**A warning line in the transcript** names what Superagent dropped and why — a
model that is not a Claude model, a prompt file it could not read, a command
it could not register.

**More detail.** `SUPERAGENT_DEBUG=1` writes debug lines to Claude Code's
debug log (`claude --debug`).

## How it is built

- `.claude-plugin/plugin.json` is the manifest; it points `hooks` at
  `claude-code/hooks.json`, whose `modules` entry is `claude-code/superagent.js`.
  `.claude-plugin/marketplace.json` lists the plugin at the repository root, so
  the repository is its own marketplace.
- `skills/` is shared, unchanged, with OpenCode, and so are the prompts.
- `core/` holds everything both hosts share: the roster, config, presets,
  permissions, board, ownership, routing table, council, bootstrap, tool maps,
  prompt extraction and the panel layout. It touches no host API and no Node
  module, because a hooks module runs in an environment of its own, with no
  Node and no `process`.
- `claude-code/lib/` translates the shared model into Claude Code's terms —
  agent specs, model ids, tool permissions, paths, command texts, panel
  elements — as pure functions.
- `claude-code/superagent.js` holds every mods API call (a hooks module may
  call the API only from its own file) and wires the hooks. Every hook that can
  refuse or rewrite an event has a `.catch` that passes the event through
  unchanged, so Superagent failing never blocks a session.

### Verified against Claude Code 2.1.317

- `claude plugin validate` passes and lists the expected hooks, calls and
  environment reads.
- `claude plugin test` (tests/claude-code/superagent.test.ts) drives the
  hooks module through Claude Code's own engine: registration, model routing,
  the solo preset, the bootstrap, the orchestrator's system-prompt section and
  write guard, ownership conflicts, the board, reviewer guards, every command,
  and the pane on the terminal and Desktop surfaces.
- Live, with `claude -p --plugin-dir`: the model sees the routing table, the
  orchestrator role and the bootstrap, and lists all nine `superagent:*`
  agent types; the orchestrator's `Write` outside `.superagent/` is refused
  with Superagent's reason; a `superagent:oracle` dispatch runs and answers.
- Live, in the interactive TUI (tmux): the pane opens beside the transcript; a
  background `superagent:oracle` dispatch appears with a turning spinner, a
  ticking timer and its live `Bash` call, then settles to `✓` with its
  answer while the main thread shows `thinking`.
