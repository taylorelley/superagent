# Superagent on Codex

Tested on Linux with **codex-cli 0.166.0-alpha.1**, Node 24, and the native
plugin/app-server APIs and the native V1 multi-agent backend. The launcher
selects that backend for this invocation; hosted/Work V2 tool surfaces are not
validated. Node 22 or later is required by the adapter. Other
Codex versions and operating systems have not been validated.

## Completion scope

The implementation is complete for the agreed **plugin-only scope**. Command
skills, the text/watch panel, and role refresh/new-session behavior are the
supported adaptations for this host. They are documented platform differences,
not requests to change Codex.

Packaging follows the supported compatibility layout and repository marketplace
format in [OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins).
`.codex-plugin/plugin.json` declares the shared and Codex-specific skill paths;
`.agents/plugins/marketplace.json` supplies the native catalog, install policy,
category and display metadata. The existing Claude marketplace remains separate.
The compatibility format preserves host-specific command skills without adding
them to the skill directory shared with OpenCode and Claude Code.

This is a local/manual hook-based plugin. The guide excludes hook-containing
plugins from the public directory; local installation does not imply public
publication or support on every ChatGPT/Codex surface.

## Install from a checkout

```sh
codex plugin marketplace add /absolute/path/to/superagent
codex plugin add superagent@superagent
cd /absolute/path/to/superagent
node codex/install.mjs --dry-run
node codex/install.mjs
```

The native plugin loads the existing `skills/` directly, plus four Codex command
skills. The role installer generates the nine shared specialist roles and any
configured councillors under `${CODEX_HOME:-~/.codex}/agents/superagent/`.
It changes neither `config.toml` nor `AGENTS.md`. A receipt records owned files;
modified or colliding files are preserved and reported. Run the installer from
the target project directory using the absolute path to the script to include
that project's configuration. Generated roles are user-level: refresh them
when switching projects with different role/model settings.

Start a **new** Codex session. Use Codex's `/hooks` trust interface to review and
approve the installed hooks. Managed environments may prohibit user hooks;
installing Superagent never bypasses that policy. A plugin content change may
require renewed trust. An untrusted or unavailable guard means the team has not
been validated for use; skill discovery alone does not establish enforcement.

For configured primary-model routing and automatic role refresh, launch from
the project using:

```sh
node /absolute/path/to/superagent/codex/run.mjs
```

This creates an isolated role cache for each project/configuration launch, registers
those files through per-invocation overrides, and forwards Codex arguments.
Concurrent projects can therefore use different model slots without overwriting
one another's role files. It also applies the configured orchestrator model,
provider and reasoning effort. An ordinary `codex` launch keeps its own primary
model selection; specialist roles still carry their configured models.
`agents.setDefaultAgent: false` preserves the user's primary role/model.

## Configuration

The same JSON/JSONC schema and preset resolver are shared with both existing
hosts. Files are read in this order:

1. Defaults and the chosen preset.
2. `${CODEX_HOME:-~/.codex}/superagent.json` (or `.jsonc`).
3. `<project>/.codex/superagent.json` (or `.jsonc`).
4. The saved user `superagent.state.json`.
5. Environment overrides.

`SUPERAGENT_PRESET`, `SUPERAGENT_DISABLE=1` and `SUPERAGENT_DEBUG=1` retain their
shared meanings. A command can select a session preset. Model values accept
`inherit`, a model id, `provider/model`, or an object with `id` and `variant`.
A `#high` suffix selects reasoning effort; it does not set temperature.
Providers must already be configured in Codex. Syntactically invalid model
values warn and inherit; unavailable providers/models are reported by Codex; councillors without usable distinct model identities are skipped.

Example:

```json
{
  "agents": {
    "models": {
      "implementer": "openai/gpt-6.1-sol",
      "reviewer": "openai/gpt-6.1-sol#high"
    }
  }
}
```

Refresh role files and start a new session after changing role/model settings.
The hook adapter only advertises roles whose installed files match the current
configuration. A disabled, missing or stale Superagent role cannot be dispatched
through the guarded native tool.

## Commands

The command functions reuse the shared command availability rules, presets,
board, council instructions and update helpers. Codex discovers these as native
skills: select them through `/skills`, or explicitly invoke
`$superagent:board`, `$superagent:council`, `$superagent:preset`, or
`$superagent:update`. They are **not** registered bare `/board` or `/preset`
callbacks. A real model still mediates invocation of a command skill.

For deterministic execution from a shell:

```sh
node <plugin-root>/codex/command.mjs board --session <thread-id>
node <plugin-root>/codex/command.mjs council "Question" --session <thread-id>
node <plugin-root>/codex/command.mjs preset solo --persist --session <thread-id>
node <plugin-root>/codex/command.mjs update check --session <thread-id>
node <plugin-root>/codex/command.mjs update install --session <thread-id>
```

`CODEX_THREAD_ID` is used when `--session` is omitted. Missing ids are errors;
the command does not guess a session or read a different session's board.
`update` reports the cached version; an asynchronous startup hook refreshes
that cache at the configured interval. `update check` explicitly checks it.
`update install` upgrades the marketplace, reinstalls the native plugin and
refreshes generated roles, then reports that a new session is required. Checks
respect `updateCheck.enabled`; an explicit install remains an explicit action.

A preset switch updates hook policy for that session; `--persist` also saves the
user default. Codex's already-loaded role registry is not rewritten in place.
Refresh generated roles and start a new session before using new role/model
settings. Built-in Codex commands and personal skills are left alone; the new
command skills live inside the plugin namespace.

## Board, permissions and recovery

The adapter reuses `core/board.js`, `core/ownership.js` and
`core/permissions.js`. Ordered permission rules keep the shared precedence.
Native role files disable delegation for specialists, apply a read-only sandbox
to read-only roles, and remove shell tools from councillors. Per-tool hooks
add edit-path and command-pattern deny/ask rules. Allowed calls remain subject
to Codex's own approvals; Superagent never returns an automatic approval for an
allowed call. Opaque code executors that bypass a restricted role's tool guard
are refused when recognized.

The controller can edit only `.superagent/**` through the edit tool. As with
the existing adapters, an edit-tool policy is distinct from shell access;
Superagent does not claim to parse and sandbox every possible shell command.
Workers receive the same scoped task contracts and review prompts as the other
hosts. Per-task worktrees, reviews, fix rounds, escalation, rulings and stacked
PR preparation continue to come from the shared skills.

Each hook process restores and checkpoints the shared board. Transactions use a
per-controller lock and atomic file replacement; child hooks link back to the
same controller scope, including children working in separate worktrees.
Records retain call ids, child ids, ownership, conflicts, timing and results.
Follow-ups revive records; missing child ids and missing final answers produce
errors rather than fabricated success. Bootstrap is injected at startup and
restored after compaction; subsequent prompt/tool hooks carry current board
context. Historical context cannot be removed through observation-only model
hooks.

State lives under `<CODEX_HOME>/superagent/`; controller ids are hashed into
filenames. Corrupt checkpoints fail closed and are never silently replaced.
If a killed hook leaves a `.lock` directory, verify that no hook for that state
is running before removing that lock. Pending work after a hard process crash
may require reconciliation from the plan ledger and git history; the adapter
does not invent a completed outcome.

## Panel

The adapter renders `core/panel.js` through a text surface. It shows the shared
roster, dispatch states, ownership/conflicts, results, active tools/skills,
elapsed time and observed plan progress. Child activity uses the same durable
controller state. Plans referenced under `docs/superagent/plans/` are parsed by
the shared progress helper; native `update_plan` calls also update progress.

```sh
node <plugin-root>/codex/panel.mjs --session <thread-id>
node <plugin-root>/codex/panel.mjs --session <thread-id> --watch --expanded
```

The watch view can run in another terminal. It is **not an embedded Codex pane**
and does not provide the existing hosts' mouse interactions. `tui.enabled`
controls the optional text/watch view; the rest of the adapter works headlessly.

## Tool mapping

<!-- BEGIN GENERATED CODEX TOOL MAP — source: core/tool-map.js -->

- Create or update todos → `update_plan`
- `Subagent (general-purpose):` → `spawn_agent` with `agent_type` and `fork_context: false`
- Invoke a skill → Read its `SKILL.md` from the installed plugin
- Read files → `exec_command` with a read-only command
- Create, edit, or delete files → `apply_patch`
- Run shell commands → `exec_command`
- Search files → `exec_command` with `rg`
- Fetch a URL → the available web tool or an approved fetch command

Tools may be namespaced; use the inventory supplied by the host.
Use `send_input` to continue a child and `wait_agent` to await its result.
Spawning is asynchronous; dispatch independent children before waiting.

<!-- END GENERATED CODEX TOOL MAP -->

Mappings refer to the tested native multi-agent tool inventory. Other Codex
surfaces may expose different tool namespaces. An absent native `update_plan`
can be replaced by a plan checklist; no nonexistent tool should be invoked.

## Parity and evidence

| Feature | Status |
|---|---|
| All 15 shared workflow skills | Native discovery verified |
| Shared specialist roles and contracts | Native custom-role loading verified |
| Model/provider/effort routing | Native reviewer model and effort verified; primary slot uses launcher |
| Fresh context and parallel children | Three simultaneous mock-provider requests verified |
| Sealed workers and council | Native delegation withholding and council shell withholding verified |
| Scoped deny/ask guards | Native shell denial and blocked side effect verified; path/ask cases tested offline |
| Ownership board and lifecycle | Offline conflicts plus native parent/child completion verified |
| Bootstrap and compaction recovery | Native bootstrap delivery; compaction handling tested offline |
| Council synthesis instructions | Shared core; configured distinct-model role dispatch verified |
| Commands | Native command skills plus deterministic CLI; bare callback aliases unavailable |
| Presets | Session/persisted settings; role/model changes require refresh/new session |
| Updates | Shared cached checks and native install flow; live network update not exercised |
| Panel | Shared renderer in text/watch view; embedded pane and mouse parity unavailable |
| Real-model workflow behavior | Not verified by the scripted provider suite |
| Windows, macOS, remote executors | Not validated |

The table records the implemented behavior and its validation limits. Embedded
pane/mouse controls, bare command callbacks and in-place registry reload are
outside the accepted plugin scope. No Codex source modification is required or
planned. Real-model workflow behavior and other platforms remain separate
validation limits; the scripted tests do not claim to verify them.

Run the completion check with:

```sh
node codex/probe.mjs --integration
```

It runs the adapter contracts and native acceptance suite. Success reports
`pluginComplete: true` and exits zero. `fullParity` is a separate strict
comparison and remains false for documented adaptations. Discovery without
`--integration`, missing evidence or failed tests cannot report completion.

## Testing and uninstall

```sh
bash tests/codex/run-tests.sh --integration
bash tests/opencode/run-tests.sh
bash tests/claude-code/run-tests.sh
npm run lint
npm run format:check
bash scripts/lint-shell.sh --all
```

The native suite uses temporary plugin/config directories and a loopback mock
provider; no real model quota or user credentials are needed. It approves only
the temporary fixture's exact hook hashes. See [testing.md](testing.md).

To uninstall:

```sh
node <plugin-root>/codex/install.mjs --remove
codex plugin remove superagent@superagent
```

Modified role files are preserved and reported. User configuration, personal
skills, plans and ledger files are not removed. Per-launch role caches and
controller state are retained so saved threads can still reference their files. Start a new session to stop
using previously loaded roles.
