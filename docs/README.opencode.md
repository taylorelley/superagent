# Superagent for OpenCode

Complete guide for using Superagent with [OpenCode.ai](https://opencode.ai).

Superagent targets **OpenCode 2** and its plugin format
([docs](https://opencode.ai/v2/docs/plugins/)). It does not load in OpenCode 1:
V1 plugin implementations do not run in V2 and vice versa. If you are still on
OpenCode 1, pin an earlier Superagent commit or upgrade OpenCode
(`curl -fsSL https://opencode.ai/v2/install | bash`).

## Installation

```bash
opencode plugin add github:taylorelley/superagent
```

That installs the package into OpenCode's plugin cache and adds it to the
`plugins` array of your global `opencode.json(c)`. To configure it by hand
instead (global or project-level):

```json
{
  "plugins": ["github:taylorelley/superagent"]
}
```

One entry loads both parts of the package — the server plugin (skills, agents,
commands, bootstrap) and the TUI sidebar panel. There is no separate `tui.json`
entry in V2.

Changes to watched config reload automatically; otherwise run
`opencode service restart`. Verify by asking: "What can Superagent do?", or
check that `superagent` appears in `opencode plugin list`.

### Migrating from OpenCode 1

- Rename `plugin` to `plugins` in `opencode.json`, and replace the
  `superagent@git+https://…` spec with `github:taylorelley/superagent` (or run
  `opencode plugin add` as above).
- Delete the `superagent` entry from `tui.json`; V2 loads the TUI part from the
  same `plugins` entry.
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is no longer needed: background
  subagents are built into V2's `subagent` tool.
- `superagent.json` is unchanged. `agents.permissionOverrides` written with V1
  tool names (`task`, `bash`) are translated to V2's (`subagent`, `shell`).

### Migrating from the old symlink-based install

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

### Finding Skills

Use OpenCode's native `skill` tool to list all available skills:

```
use skill tool to list skills
```

### Loading a Skill

```
use skill tool to load brainstorming
```

### Personal Skills

Create your own skills in `~/.config/opencode/skills/`:

```bash
mkdir -p ~/.config/opencode/skills/my-skill
```

Create `~/.config/opencode/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Use when [condition] - [what it does]
---

# My Skill

[Your skill content here]
```

### Project Skills

Create project-specific skills in `.opencode/skills/` within your project.

**Skill Priority:** Project skills > Personal skills > Superagent skills. A
personal or project skill with the same ID as a Superagent skill replaces it.

## Updating

```bash
opencode plugin update github:taylorelley/superagent
```

(use the target exactly as it appears in your `plugins` array), or `/update
install` from inside a session, then `opencode service restart`. OpenCode
checks unpinned git plugins for updates when the server starts, without
changing the installed copy.

To follow a branch or tag, append it:

```bash
opencode plugin add 'github:taylorelley/superagent#main'
```

A branch moves, so that selects a line of development rather than pinning one.
For a reproducible install, append a full commit SHA instead.

## How It Works

The server part (`.opencode/plugins/superagent.js`) is a V2 plugin — a
default-exported `{ id, setup }`. In `setup` it:

1. **Registers the skills** through `ctx.skill.transform`, so OpenCode's
   native `skill` tool discovers every Superagent skill without symlinks or
   config edits. The skills directory is watched, so an edited skill is picked
   up by the running server.
2. **Injects bootstrap context** through the `ctx.session.hook("context")`
   model-request hook, prepending Superagent awareness to the first user
   message of every agent-loop request. Like V1's messages transform, this only
   changes the outgoing request, never stored history.
3. **Registers the agent-team layer** — agents through `ctx.agent.transform`,
   slash commands through `ctx.command.transform`, and the job board through
   `ctx.tool.hook("execute.before" | "execute.after")` plus the event stream.

### Tool Mapping

Skills speak in actions rather than naming any one runtime's tools. On OpenCode these resolve to:

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

## The agent-team layer

> **Not in upstream Superpowers.** This layer is specific to
> `taylorelley/superagent`; installing `obra/superpowers` gets you the skills
> without it.

Superagent adds a specialist agent roster on top of the skills above: an
orchestrator that plans and delegates, implementers, reviewers, an oracle and a
librarian, each routable to its own model, plus a job board that stops two
concurrent dispatches writing the same file.

It is on by default and documented in [superagent.md](superagent.md). Set
`{"preset": "solo"}` in `superagent.json` to turn it off.

## Troubleshooting

### Plugin not loading

1. `opencode plugin list` — is `superagent` there, and active?
2. Check OpenCode logs: `opencode run --standalone --print-logs "hello" 2>&1 | grep -iE 'superagent|plugin'`.
   A `failed to load plugin` line names the cause.
3. Verify the entry is under `plugins` (V2), not `plugin` (V1).
4. Make sure you're running OpenCode 2 (`opencode --version`).

### Install issues

If OpenCode cannot install the git-backed package, install it with system npm
and point OpenCode at the local package directory (V2 local plugin entries
must name a directory):

```bash
npm install superagent@git+https://github.com/taylorelley/superagent.git --prefix ~/.config/opencode
```

```json
{
  "plugins": ["/home/you/.config/opencode/node_modules/superagent"]
}
```

### Skills not found

1. Use OpenCode's `skill` tool to list available skills
2. Check that the plugin is loading (see above)
3. Each skill needs a `SKILL.md` file with valid YAML frontmatter

### Bootstrap not appearing

1. Check the plugin is active (see above); the bootstrap is injected by its
   `context` hook.
2. Check `{"bootstrap": {"enabled": false}}` is not set in `superagent.json`.
3. Run `opencode service restart` after config changes.

## Getting Help

- Report issues: https://github.com/taylorelley/superagent/issues
- Main documentation: https://github.com/taylorelley/superagent
- OpenCode docs: https://opencode.ai/v2/docs/
