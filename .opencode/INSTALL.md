# Superagent for OpenCode

The guide to installing, using, and troubleshooting Superagent on
[OpenCode](https://opencode.ai).

## Prerequisites

- [OpenCode](https://opencode.ai) **2** installed
  (`curl -fsSL https://opencode.ai/v2/install | bash`). Superagent is an
  OpenCode 2 plugin ([plugin format](https://opencode.ai/v2/docs/plugins/));
  it does not load in OpenCode 1.

## Installation

### Before you install: check for name conflicts

Superagent registers a roster of agents and a few slash commands
(`/council`, `/preset`, `/board`, `/update`) through OpenCode's plugin API. It
never edits your `opencode.json`, and at runtime it never
overwrites a name you already have — a collision is skipped with a warning
and your definition wins (see
[docs/superagent.md](https://github.com/taylorelley/superagent/blob/main/docs/superagent.md#names)) —
so skipping this check is never unsafe. It only means you find out about a
collision from a log line after restarting OpenCode instead of before.

If you are an agent performing this install on a human's behalf, do this
check first and report the result before editing `opencode.json`:

1. Read the human's existing OpenCode config — global
   `~/.config/opencode/opencode.json(c)` and any project-level
   `.opencode/opencode.json(c)` or `opencode.json(c)` — and note the keys
   already present under `agents` and `commands` (`agent` and `command` in a
   config still written for OpenCode 1), plus any files under
   `.opencode/agents/` and `.opencode/commands/`. Or, with OpenCode running,
   `opencode debug agents` lists every agent by ID.
2. Read the roster and command names Superagent will try to register,
   straight from source so this never drifts out of date with what actually
   ships: agent `key`s in
   [`.opencode/lib/roster.js`](../.opencode/lib/roster.js), and command
   names in the `COMMANDS` object in
   [`.opencode/lib/commands.js`](../.opencode/lib/commands.js).
3. Cross-reference the two lists. If nothing collides, proceed with the
   install as normal.
4. If something collides, tell the human before finishing the install and
   ask how they want to handle it:
   - **Do nothing** — Superagent skips the colliding name and keeps their
     existing agent/command (the default, always safe).
   - **Register alongside it** — add `{"agents": {"prefix": "sp-"}}` to
     `superagent.json` so the full roster registers under prefixed names
     instead of being skipped.
   - **Rename or remove their own entry** first, if they'd rather have the
     roster take the unprefixed name.

### Add the plugin

```bash
opencode plugin add github:taylorelley/superagent
```

That installs the package into OpenCode's plugin cache and adds it to the
`plugins` array of your global `opencode.json(c)`. Or add it by hand, globally
or per project:

```json
{
  "plugins": ["github:taylorelley/superagent"]
}
```

Config changes reload automatically; if they do not, run
`opencode service restart`. Verify with `opencode plugin list`, or by asking:
"What can Superagent do?"

### The sidebar panel

The same entry also loads Superagent's TUI part: a panel in the session
sidebar with its version, the active preset, the registered roster, and the
live job board. OpenCode 2 loads the TUI parts of the plugins its server loads,
so there is nothing else to configure (and no `tui.json` entry — delete one
left over from OpenCode 1). Turn it off with `{"tui": {"enabled": false}}` in
`superagent.json`.

## Migrating from OpenCode 1

1. Upgrade OpenCode: `curl -fsSL https://opencode.ai/v2/install | bash`.
2. In `opencode.json`, rename `plugin` to `plugins` and replace
   `superagent@git+https://github.com/taylorelley/superagent.git` with
   `github:taylorelley/superagent` — or remove the old entry and run
   `opencode plugin add github:taylorelley/superagent`.
3. Remove the `superagent` entry from `tui.json`.
4. Drop `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` from how you start
   OpenCode; V2's `subagent` tool supports background dispatch natively.

`superagent.json` needs no changes. Permission overrides written with V1 tool
names (`task`, `bash`) are translated to V2's (`subagent`, `shell`).

## Migrating from the old symlink-based install

If you previously installed superagent using `git clone` and symlinks, remove the old setup:

```bash
# Remove old symlinks
rm -f ~/.config/opencode/plugins/superagent.js
rm -rf ~/.config/opencode/skills/superagent

# Optionally remove the cloned repo
rm -rf ~/.config/opencode/superagent

# Remove skills.paths from opencode.json if you added one for superagent
```

Then follow the installation steps above.

## Usage

Use OpenCode's native `skill` tool:

```
use skill tool to list skills
use skill tool to load brainstorming
```

### Personal and project skills

Put your own skills in `~/.config/opencode/skills/` (personal) or
`.opencode/skills/` inside a project. Each skill is a directory with a
`SKILL.md`:

```markdown
---
name: my-skill
description: Use when [condition] - [what it does]
---

# My Skill

[Your skill content here]
```

Priority is project skills > personal skills > Superagent skills, so a
personal or project skill with the same name as a Superagent skill replaces it.

## Updating

```bash
opencode plugin update github:taylorelley/superagent
opencode service restart
```

Use the target exactly as it appears in your `plugins` array. OpenCode checks
unpinned git plugins for updates when its server starts, but never changes the
installed copy on its own.

Superagent also checks GitHub for a newer version once per server start and
notes it in the sidebar panel (and a TUI toast) when one exists. `/update`
reports the current and latest known versions; `/update install` runs the
update in place — `opencode plugin update <target>` for a configured package,
`git pull --ff-only` for a git checkout, or the `npm install ... --prefix`
fallback documented below otherwise. Either way, **the service must restart**
(`opencode service restart`): plugin code is imported once, when the plugin
loads. See [docs/superagent.md#updates](../docs/superagent.md#updates). Turn
the check off with `{"updateCheck": {"enabled": false}}` in `superagent.json`.

To follow a branch or tag, append it:

```bash
opencode plugin add 'github:taylorelley/superagent#main'
```

A branch moves, so that selects a line of development rather than pinning one.
For a reproducible install, append a full commit SHA instead.

## How it works

The server part (`.opencode/plugins/superagent.js`) is an OpenCode 2 plugin — a
default-exported `{ id, setup }`. In `setup` it:

1. **Registers the skills** through `ctx.skill.transform`, so OpenCode's
   native `skill` tool discovers every Superagent skill without symlinks or
   config edits. The skills directory is watched, so an edited skill is picked
   up by the running server.
2. **Injects bootstrap context** through the `ctx.session.hook("context")`
   model-request hook, prepending Superagent awareness to the first user
   message of every agent-loop request. It only changes the outgoing request,
   never stored history.
3. **Registers the agent-team layer** — agents through `ctx.agent.transform`,
   slash commands through `ctx.command.transform`, and the job board through
   `ctx.tool.hook("execute.before" | "execute.after")` plus the event stream.

### Tool mapping

Skills speak in actions ("create a todo", "dispatch a subagent", "read a file"). On OpenCode these resolve to:

<!-- BEGIN GENERATED TOOL MAP — source: .opencode/lib/tool-map.js -->

- Create or update todos → `todowrite`
- `Subagent (general-purpose):` → `subagent` with `agent: "general"`
- Invoke a skill → OpenCode's native `skill` tool
- Read files → `read`
- Create, edit, or delete files → `edit`, `write` (or `patch` where offered)
- Run shell commands → `shell`
- Search files → `grep`, `glob`
- Fetch a URL → `webfetch`

For read-only codebase exploration, prefer `agent: "explore"`.
To continue a subagent, call `subagent` again with the `sessionID` it returned.
Use OpenCode's native `skill` tool to list and load skills.

<!-- END GENERATED TOOL MAP -->

(Verified against the OpenCode 2.2.5 tool inventory.)

## Troubleshooting

### Plugin not loading

1. `opencode plugin list` — is `superagent` listed and active?
2. Check logs: `opencode run --standalone --print-logs "hello" < /dev/null 2>&1 | grep -iE 'superagent|plugin'`.
   A `failed to load plugin` line names the cause.
3. Verify the entry is under `plugins` (OpenCode 2), not `plugin` (OpenCode 1).
4. Make sure you're running OpenCode 2: `opencode --version`.

### Git-backed plugin specs fail to resolve

If `opencode plugin add` cannot fetch or install the package, install it with
npm and point OpenCode at the local package directory (OpenCode 2 local
plugin entries must name a directory; use an absolute path):

```bash
npm install superagent@git+https://github.com/taylorelley/superagent.git --prefix ~/.config/opencode
```

```json
{
  "plugins": ["/home/you/.config/opencode/node_modules/superagent"]
}
```

The server and TUI parts load from that one entry, so they always run the same
version. A panel that still shows `server v… ≠ panel v…` in its Subagents
section is reading a snapshot written by a server that has not restarted since
an update — run `opencode service restart`.

### Skills not found

1. Use the `skill` tool to list what's discovered
2. Check that the plugin is loading (see above)
3. Each skill needs a `SKILL.md` file with valid YAML frontmatter

### Bootstrap not appearing

1. Check the plugin is active (see above); the bootstrap is injected by its
   `context` hook.
2. Check `{"bootstrap": {"enabled": false}}` is not set in `superagent.json`.
3. Run `opencode service restart` after config changes.

## The agent-team layer

Superagent registers a roster of specialist agents on OpenCode — an orchestrator
that delegates, implementers, reviewers, an oracle, a librarian — each routable
to its own model. It is on by default.

> **Not in upstream Superpowers.** This layer is specific to
> `taylorelley/superagent`; installing `obra/superpowers` gets you the skills
> without it.

Parallel dispatch uses the `subagent` tool's built-in `background: true`;
there is no flag to set.

Configure in `~/.config/opencode/superagent.json` or
`<project>/.opencode/superagent.json`. To turn the whole layer off and get the
plain skills behaviour back:

```json
{ "preset": "solo" }
```

If your agents do not appear, or a name collides with one of your own, see
["Before you install: check for name conflicts"](#before-you-install-check-for-name-conflicts)
above and [docs/superagent.md](https://github.com/taylorelley/superagent/blob/main/docs/superagent.md).

## Getting Help

- Report issues: https://github.com/taylorelley/superagent/issues
- Agent-team layer and configuration: [docs/superagent.md](../docs/superagent.md)
- Main documentation: https://github.com/taylorelley/superagent
- OpenCode docs: https://opencode.ai/v2/docs/
