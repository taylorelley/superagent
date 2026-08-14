# Installing Superagent for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed

## Installation

### Before you install: check for name conflicts

Superagent registers a roster of agents and a few slash commands
(`/council`, `/preset`, `/board`) into `opencode.json`. At runtime it never
overwrites a name you already have — a collision is skipped with a warning
and your definition wins (see
[docs/superagent.md](https://github.com/taylorelley/superagent/blob/main/docs/superagent.md#names)) —
so skipping this check is never unsafe. It only means you find out about a
collision from a log line after restarting OpenCode instead of before.

If you are an agent performing this install on a human's behalf, do this
check first and report the result before editing `opencode.json`:

1. Read the human's existing OpenCode config — global
   `~/.config/opencode/opencode.json` and any project-level
   `.opencode/opencode.json` or `opencode.json` — and note the keys already
   present under `agent` and `command`.
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

Add superagent to the `plugin` array in your `opencode.json` (global or project-level):

```json
{
  "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git"]
}
```

Restart OpenCode. The plugin installs through OpenCode's plugin manager and
registers all skills.

Verify by asking: "What can Superagent do?"

### Add the sidebar panel (optional)

Superagent can also render a panel into the TUI sidebar — its version, the
active preset, the registered roster, and the live job board. The TUI reads its
plugin list from a separate file, so add the same entry to `tui.json` alongside
your `opencode.json` (creating it if it does not exist):

```json
{
  "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git"]
}
```

Restart OpenCode and open a session; the panel appears under the sidebar's own
sections. Everything else works without this — you just get no panel.

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

## Updating

OpenCode installs Superagent through a git-backed package spec. Some OpenCode
and Bun versions pin that resolved git dependency in a lockfile or cache, so a
restart may not pick up the newest Superagent commit. If updates do not appear,
clear OpenCode's package cache or reinstall the plugin.

To follow a branch or tag, append it:

```json
{
  "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git#main"]
}
```

A branch moves, so that selects a line of development rather than pinning one.
For a reproducible install, append a full commit SHA instead.

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i superagent`
2. Verify the plugin line in your `opencode.json`
3. Make sure you're running a recent version of OpenCode

### Git-backed plugin specs fail to resolve

OpenCode installs git-backed specs (`superagent@git+https://…`) through its own
plugin manager, and some OpenCode/Bun versions pin or cache the resolved
dependency. Symptoms: the plugin fails to load in `opencode.json`, the TUI
panel never appears, or the two sides load different versions. The reliable
workaround is to install with npm and point OpenCode at the local package:

```bash
npm install superagent@git+https://github.com/taylorelley/superagent.git --prefix ~/.config/opencode
```

Then use the installed path in **both** files:

```json
{
  "plugin": ["~/.config/opencode/node_modules/superagent"]
}
```

```json
{
  "plugin": ["~/.config/opencode/node_modules/superagent"]
}
```

The server (`opencode.json`) and the TUI (`tui.json`) must resolve the **same
version** of the plugin. A mismatch is silent until a dispatch happens, and
then shows as `server v… ≠ panel v…` in the Dispatches section.

On Windows some OpenCode builds additionally fail to find `git.exe` for
`git+https` specs; the npm-install path above works there too.

### Skills not found

1. Use `skill` tool to list what's discovered
2. Check that the plugin is loading (see above)

### Tool mapping

Skills speak in actions ("create a todo", "dispatch a subagent", "read a file"). On OpenCode these resolve to:

<!-- BEGIN GENERATED TOOL MAP — source: .opencode/lib/tool-map.js -->

- Create or update todos → `todowrite`
- `Subagent (general-purpose):` → `task` with `subagent_type: "general"`
- Invoke a skill → OpenCode's native `skill` tool
- Read files → `read`
- Create, edit, or delete files → `apply_patch`
- Run shell commands → `bash`
- Search files → `grep`, `glob`
- Fetch a URL → `webfetch`

For read-only codebase exploration, prefer `subagent_type: "explore"`.
Use OpenCode's native `skill` tool to list and load skills.

<!-- END GENERATED TOOL MAP -->

## The agent-team layer

Superagent registers a roster of specialist agents on OpenCode — an orchestrator
that delegates, implementers, reviewers, an oracle, a librarian — each routable
to its own model. It is on by default.

> **Not in upstream Superpowers.** This layer is specific to
> `taylorelley/superagent`; installing `obra/superpowers` gets you the skills
> without it.

For parallel dispatch, start OpenCode with background subagents enabled:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

Without it everything still works; the orchestrator dispatches in one message
instead of in the background.

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
- Full documentation: https://github.com/taylorelley/superagent/blob/main/docs/README.opencode.md
