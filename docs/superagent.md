# Superagent — the OpenCode agent team

Superagent is this fork's OpenCode-only agent-team layer, built on top of the
skills methodology it inherited from [Superpowers](https://github.com/obra/superpowers)
(brainstorm → spec → plan → TDD → review → verify). This layer supplies the
execution substrate — a roster of specialist agents, each routable to its own
model, coordinated by an orchestrator that schedules work rather than doing it.

> **Fork-specific.** This layer lives only in `taylorelley/superagent`. It is
> not part of upstream `obra/superpowers` and is not proposed for it.
>
> Agent-roster, job-board, and council concepts are adapted from
> [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)
> (MIT). Reimplemented from scratch; no code copied.

---

## The roster

Ten agents, registered automatically. Six reuse prompts the skills library
already ships; four are new to this layer.

| Agent | Dispatch it for | Model slot |
|---|---|---|
| `superagent` | The primary agent. Plans and delegates; does not implement. | `orchestrator` |
| `implementer` | One scoped task from a plan | `implementer` |
| `implementer-deep` | A task an earlier implementer failed to fix | `implementerDeep` |
| `task-reviewer` | One task's diff, for spec compliance and quality | `reviewer` |
| `re-reviewer` | Whether a fix round addressed its findings | `reviewer` |
| `code-reviewer` | The whole-branch review before merge | `deepReviewer` |
| `spec-reviewer` | A spec document, before planning starts | `docReviewer` |
| `plan-reviewer` | A plan document, before implementation starts | `docReviewer` |
| `oracle` | An architecture call, or a bug that resisted a fix | `oracle` |
| `librarian` | External documentation and API research | `librarian` |

OpenCode's built-in `explore` (read-only reconnaissance) and `general` are used
as-is rather than duplicated.

Every specialist has `task` denied, which removes the tool from it entirely —
so "you do not dispatch subagents" is structural rather than a request the
prompt has to keep making. Reviewers and advisors also have `edit` denied. The
orchestrator can only write under `.superagent/`.

### Names

The names are unprefixed because they are meant to be typed. If one collides
with an agent you already have, **yours wins** — Superagent logs a warning and
skips that entry. To register the full roster alongside your own, set a prefix:

```json
{ "agents": { "prefix": "sp-" } }
```

## Model routing

This is the reason the roster exists. OpenCode's `task` tool has no `model`
parameter, so the only way to run a reviewer on a different model from an
implementer is for them to be different *agents*.

Out of the box every slot is unrouted, meaning each agent inherits your session
model. You get role separation and context isolation, but not cost control.
Routing is per slot:

```json
{
  "agents": {
    "models": {
      "implementer": "anthropic/claude-haiku-4-5",
      "reviewer":    "anthropic/claude-haiku-4-5",
      "deepReviewer":"anthropic/claude-opus-4-5",
      "oracle":      "anthropic/claude-opus-4-5"
    }
  }
}
```

Use whatever model IDs your authenticated providers expose — `opencode models`
lists them. No preset ships with model IDs in it, because the right ones depend
entirely on which providers you use.

An unrouted slot omits the model and inherits. If a slot names a model that is
not available, the **model assignment** is dropped with a warning — the agent
still registers and inherits the session model, and is never silently pointed at
some different model.

## Configuration

Merged in order, later winning:

1. built-in defaults
2. the active preset
3. `~/.config/opencode/superagent.json` (honours `OPENCODE_CONFIG_DIR`)
4. `<project>/.opencode/superagent.json`
5. `~/.config/opencode/superagent.state.json` (written by `/preset --persist`)
6. `SUPERAGENT_PRESET`, `SUPERAGENT_DISABLE`, `SUPERAGENT_DEBUG`

Comments and trailing commas are allowed. A malformed file is ignored with a
warning rather than taking the layer down.

```jsonc
{
  "preset": "team",
  "agents": {
    "enabled": true,
    "prefix": "",
    "disable": [],            // roster keys to skip
    "setDefaultAgent": true,  // make `superagent` OpenCode's default agent
    "models": { /* per slot, see above */ },
    "temperature": { "reviewer": 0.1, "oracle": 0.1 },
    "permissionOverrides": {} // per agent, merged over the roster's own
  },
  "council": { "enabled": false, "members": [], "minParticipants": 2 },
  "board": {
    "enabled": true,
    "strategy": "latest",     // or "checkpoint"
    "enforceOwnership": "warn" // or "off"
  },
  "bootstrap": { "enabled": true },
  "tui": { "enabled": true },    // the sidebar panel
  "updateCheck": { "enabled": true, "intervalHours": 24 }
}
```

### Presets

| Preset | What it does |
|---|---|
| `team` | Default. Full roster, job board on. |
| `council` | `team` plus the council. |
| `solo` | All Superagent features off. The bootstrap and skill registration stay — exactly the behaviour before this layer existed. |

**Turning it off:** `{"preset": "solo"}`, or `SUPERAGENT_DISABLE=1`.

`/preset <name>` selects one and `--persist` saves it, but **switching a preset
does not take effect until OpenCode restarts.** Agent definitions are resolved
into cached state at startup. The command says so rather than reporting a
change that has not happened.

## The job board

Every `task` dispatch is recorded, and a compact snapshot is injected into the
session so the orchestrator can see what it launched. `/board` prints it.

Its real job is preventing concurrent writes to the same file, which is the
failure that makes parallel dispatch worse than serial — both dispatches
succeed and one silently loses. The orchestrator declares each dispatch's
claim in the task prompt:

```text
<!-- superagent-ownership: write=src/api/**; read=src/** -->
```

A later dispatch whose write claim overlaps a running one gets a notice
prepended to its prompt naming the conflict. Overlap detection deliberately
over-reports: a spurious warning costs a sentence, a missed collision costs
work. Running dispatches that declared nothing are flagged, since those are the
ones where a collision cannot be detected at all.

There is no poller and no wake scheduler — see the API notes below for why.

## The sidebar panel

Everything above is addressed to the model. The routing table lives in the
system prompt, the board snapshot is injected into the conversation and — under
the default `latest` strategy — stripped and rewritten every turn, and `/board`
spends a model turn printing state the plugin already holds. None of that is
much use to the human at the keyboard.

So Superagent also renders a panel into OpenCode's TUI sidebar:

```text
 Superagent                  v0.1.0
 team · agents on · board on

 Agents                          10
 oracle               claude-opus-4-1
 +9 collapsed

 Dispatches                     2/6
 ● code-reviewer              running
   Review task 3 against the plan
 ● implementer           running (bg)
   Add the failing test for snaps…
   owns .opencode/lib/**
 ✓ librarian                completed
 +1 more
```

Live, free, and always the current state: the version and preset answer "did my
update land" and "why is it behaving like that", and the dispatch list answers
"what is running and what is it holding" — the ownership line especially, since
that is what says two agents are about to collide.

Both lists are capped, because a panel that outgrows the sidebar is silently
clipped from the bottom, which is where the live section is. Turn the panel off
with `{"tui": {"enabled": false}}`, or with `SUPERAGENT_DISABLE=1`, which turns
off everything.

The roster is **collapsed by default**: the Agents header carries the count and
only the routed (non-inherit) slots are listed, since a pinned model is the
part a reader cannot guess. The `+N collapsed` line says how many are hidden.
Click the header, or the `+N collapsed` line, to expand it at runtime — no
config edit or restart needed; `{"tui": {"agents": {"expanded": true}}}` in
`superagent.json` only sets the *starting* state now. Dispatches are always
expanded — they are the live section — and both lists' `+N more` lines are
clickable too, revealing one more page (the same row cap again) per click.

### Staying live: why a poll alone was not enough

The panel polls its snapshot file once a second and used to call OpenCode's
`renderer.requestRender()` when it changed, on the assumption that this would
make the host re-run `sidebar_content` and pick up the new data. In practice
it did not: `requestRender()` repaints whatever node tree the host already
has, but nothing confirmed the host ever calls `sidebar_content` again after
the first mount, and observed behaviour said it does not — the panel only
refreshed after something else forced a remount, such as switching to a
subagent's view and back.

So the panel no longer waits for a re-invocation that may never come. It
keeps one root node alive for the life of the registration
(`createRootRepainter` in `.opencode/tui/superagent-tui.js`) and, on every
poll tick and every click, patches that root's child in place — unmounting
the old render and mounting the new one — before calling `requestRender()`
to actually paint it. This depends on the OpenTUI module exposing some
removal primitive alongside the `insert()` it has always used to build a
tree; `elementFactory` tries a short list of plausible names
(`remove`/`removeChild`/`removeNode`/`unmount`) and, if none exist, degrades
to the single initial render the panel has always done rather than stacking
un-removed content. See "Still unverified" below — this has not yet been
confirmed against a live host.

Dispatch states carry glyphs so an outcome reads at a glance: `●` running,
`✓` completed, `✗` error, `○` cancelled.

The Dispatches section can tell you why it is empty:

| State | Meaning |
|---|---|
| `no snapshot yet — nothing dispatched` | No dispatch has been recorded yet in this project. |
| `snapshot from a different plugin version` | The snapshot file is from an older Superagent copy (snapshot format mismatch). |
| `server vX ≠ panel vY` | The server plugin and the TUI plugin are different versions — the sidebar cannot trust the server's data. Point `opencode.json` and `tui.json` at the same source. |
| `none this session` | The bridge works; this session simply has no dispatches. |

### Registering it

The panel is a **second plugin entry point**, and OpenCode configures the two
separately. `opencode.json` is read by the server, `tui.json` by the TUI, so
Superagent has to be listed in both:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git"] }

// ~/.config/opencode/tui.json
{ "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git"] }
```

Listing it in only `opencode.json` is the supported, complete setup for
everything else in this document — you simply get no panel.

### How it is built

Three constraints shape it, all verified below:

- **It is a separate module.** A plugin module default-exports either `server()`
  or `tui()`, never both, and the TUI entry is resolved from
  `exports["./tui"]` in `package.json` — `.opencode/tui/superagent-tui.js`.
- **It renders through the host's OpenTUI, not its own.** Superagent has no
  dependencies, and a second copy of the renderer would be wrong even if it had.
  The panel imports the host's instance through the virtual specifier
  `opentui:runtime-module:%40opentui%2Fsolid`. If that import fails the panel is
  not registered, and nothing else is affected.
- **The board reaches it through a file.** The two entries are separate module
  graphs in separate processes, so `board.js`'s in-memory ledger is not visible
  from the panel. Each change is projected to
  `~/.config/opencode/superagent/tui-<hash-of-project-dir>.json`, which the
  panel polls once a second. Only the board crosses: the version, preset and
  roster are recomputed on the TUI side from the same modules the plugin uses,
  so there is nothing to keep in sync.
- **It patches itself rather than trusting a re-render.** See "Staying live"
  above — the panel mounts one root node once and repaints by swapping that
  node's child, using `mount`/`unmount` primitives `elementFactory` derives
  from the same OpenTUI module.
- **Clicks use OpenTUI's own event props, not an OpenCode API.** OpenCode's
  plugin API has no click/keybind surface (a `TuiWidget`/`onActivate`/`keybind`
  proposal exists only as an open, unimplemented feature request —
  `anomalyco/opencode#28902`). But OpenTUI's element primitives natively
  support `onMouseDown` and friends, and `elementFactory`'s `element()`
  forwards every prop verbatim via `setProp` — so the Agents header and both
  `+N more` lines simply carry an `onMouseDown` prop, same as any other. Not
  yet confirmed the live host actually delivers the event — see below.

## Background dispatch

Off unless you start OpenCode with it:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

With it on, the orchestrator dispatches independent work in parallel and is
notified as each finishes. Without it, the routing table tells it to issue
several `task` calls in one message instead, and the one-writer-per-file rule
still applies. A plugin cannot enable this itself.

## Parallel dispatch

When a plan declares independent tasks (its Task Order & Dependencies table —
see `skills/writing-plans`) and background subagents are enabled, SDD executes
each wave concurrently: every task gets its own git worktree at
`.worktrees/<plan-basename>/t<N>` on its own branch, is dispatched with
`background: true`, and the controller merges each branch back into the
feature branch after its review passes. A merge conflict means the plan's
disjoint-files claim was wrong — surfaced loudly as a plan defect rather than
a silent overwrite. Without the flag, a wave of one, or no table, SDD runs
serially as before.

If worktree creation fails (sandbox/permission), SDD falls back to serial
execution in place, with a ledger note.

Merging back into one shared feature branch happens *within* a wave, across
its independent tasks. *Between* waves that depend on each other, the
merged result becomes a new stack layer instead — see Stacked PRs below.

## Stacked PRs

`skills/using-stacked-prs` extends the worktree-by-default workflow: for
sequential/dependent work (dependent plan waves, or a single branch your
human partner asks to split), the default at finish time is a chain of
small PRs — one per layer, each based on the one below — instead of one
large PR.

Two mechanisms, selected automatically, never a reason to skip stacking:

- **Tooled mode** — GitHub's native Stacked PRs feature via the `gh-stack`
  CLI extension (`gh stack init/add/submit/sync/rebase/merge`), used when a
  GitHub remote, `gh`, `gh-stack`, and the feature itself are all present.
- **Manual mode** — the same layering with plain git and the forge's own
  CLI: sequential branch naming, PRs based on the layer below, a "Stack
  Overview" section in each PR body linking its siblings, cascading
  `git rebase` + `git push --force-with-lease` when a lower layer changes,
  and sequential merge-and-retarget when landing. This is the true default
  and needs no third-party tool — `gh-stack` is only an opportunistic
  accelerator, never a hard dependency.

`finishing-a-development-branch`'s "push and create a PR" option delegates
to this skill whenever the branch is part of a stack; a plain,
non-decomposable branch still gets one PR as before.

## The council

`/council <question>` asks several models the same question in parallel and
synthesizes the answers, reporting agreement as `unanimous`, `majority` or
`split`, plus every dissenting risk no other member addressed.

It needs at least two members with **distinct** models — councillors on one
model produce agreement by construction, which is worse than not asking:

```json
{
  "council": {
    "enabled": true,
    "members": [
      { "name": "alpha", "model": "provider/model-a", "steering": "correctness and edge cases" },
      { "name": "beta",  "model": "provider/model-b", "steering": "simplicity and maintainability" }
    ]
  }
}
```

Councillors are sealed: they read and reason, but cannot edit, dispatch, or run
commands.

## Updates

Once per OpenCode process — not once per session, so a dispatch's child
sessions don't repeat it — the plugin asks GitHub whether a newer Superagent
exists: a release first (`GET /repos/taylorelley/superagent/releases/latest`),
falling back to `package.json` on the default branch if this repo has not cut
one yet. The result is cached to
`<configDir>/superagent/update-check.json` and reused for `updateCheck.intervalHours`
(default 24) before asking again, so a normal day of restarts costs at most
one request. Nothing about the user or the project is sent — the request asks
"what's the latest version," full stop.

When a newer version is found:

- The sidebar panel (`## The sidebar panel` above) gains a line —
  `⬆ vX.Y.Z available — run /update install` — directly under the version
  header. This is the one channel independently confirmed working in this
  codebase.
- The plugin also makes a best-effort `client.tui.showToast(...)` call. This
  API is not yet confirmed against this project's own pinned OpenCode source
  (see "Still unverified" below) — treat the panel line as the reliable
  notice and the toast as a bonus that may or may not appear.

`/update` reports the installed version, the latest known version, and when it
was last checked, reading only the cache — it never blocks on a fetch of its
own. `/update install` shells out to `git pull --ff-only` (when the install is
a git checkout) or `npm install superagent@git+https://github.com/taylorelley/superagent.git --prefix <configDir>`
(OpenCode's own git-spec install path, see `.opencode/INSTALL.md`) — the same
two paths documented there, so a missing `git`/`npm` degrades to reporting the
exact manual command rather than failing silently. Like `/preset`, it says
plainly that **the update does not take effect until OpenCode restarts** —
plugin code is resolved once at startup.

Turn the check off with `{"updateCheck": {"enabled": false}}`, or with
`SUPERAGENT_DISABLE=1`, which turns off everything.

## What degrades, and how

| Feature | If unavailable | Behaviour |
|---|---|---|
| Background dispatch | flag not set | Routing table switches to parallel-in-one-message; nothing errors |
| Model routing | model not in any provider | Key dropped with a warning; agent inherits the session model |
| An agent name | already taken by the user | Yours is kept; ours is skipped with a warning |
| Council | fewer than 2 members | `/council` explains how to configure it instead of dispatching |
| Council | a member fails to answer | Synthesis proceeds and names the failure; under 2 answers is reported inconclusive |
| A reused prompt template | upstream changed its shape | Agent is skipped with a warning, and a test fails in CI |
| Config file | malformed | Ignored with a warning; defaults apply |
| Everything | `preset: "solo"` | Bootstrap and skills only |

## Troubleshooting

**The agents don't appear.** Check the plugin loaded at all:
`opencode run --print-logs "hello" 2>&1 | grep -i superagent`. Note that
plugin-registered agents surfacing in `opencode agent list` is subject to a
[known caching-order bug](https://github.com/code-yeongyu/oh-my-openagent/issues/1320)
in OpenCode; they can work in-session while missing from that listing.

**Warnings about a name collision.** You already have an agent with that name.
Set `agents.prefix`.

**More detail.** `SUPERAGENT_DEBUG=1`.

**The Dispatches section stays empty.** If it names a version mismatch
(`server v… ≠ panel v…`), the server and TUI plugin copies differ — list the
same source in `opencode.json` and `tui.json`, restart, and re-dispatch. If it
says `no snapshot yet`, dispatch something; if it says `none this session`,
the bridge works and this session has simply not dispatched. Run with
`SUPERAGENT_DEBUG=1` for the panel's per-render log line (file, mtime, session,
record count, state).

---

## Verified behaviour of the OpenCode plugin API

Everything below was read out of `sst/opencode` at commit `14b37df`, not
inferred from documentation. Several of these contradict the obvious design, so
they are recorded with their source locations for whoever revisits this.

### Plugin `config` mutations reach agent assembly

`Config.get()` returns `InstanceState.use(state, (s) => s.config)` — the *same
object reference* on every call within an instance
(`packages/opencode/src/config/config.ts:606`). The plugin service runs each
plugin's `config` hook against that object
(`packages/opencode/src/plugin/index.ts:243`), and `Agent.state` yields
`Plugin.Service` before it reads `config.get()`
(`packages/opencode/src/agent/agent.ts:93,100`).

So a plugin that writes `config.agent[name]` in its `config` hook is seen by
agent assembly. This is the same mechanism the skills-path registration has
always relied on.

### A `config` hook throw is swallowed

The hook is invoked under `Effect.ignore`
(`packages/opencode/src/plugin/index.ts:249`). It logs through
`Effect.logError` first, but execution continues and the plugin's registrations
are simply absent. A malformed user config must therefore never throw — it must
log and fall back to defaults. Every hook in this plugin is wrapped in
`guardHook` (`.opencode/lib/log.js`) for exactly this reason.

### Agent entries are assigned, not merged, by the plugin

Agent assembly merges config entries field-by-field onto built-ins
(`packages/opencode/src/agent/agent.ts:267-294`), but that happens *after* the
plugin hook. From the plugin's side `config.agent` is a plain object, so
`config.agent[name] = {...}` overwrites whatever a user put there.

Superagent therefore never writes a key that already exists — a user's own
`implementer` wins, and Superagent logs a warning and skips.

### Omitting `model` is how an agent inherits the session model

`if (value.model) item.model = Provider.parseModel(value.model)`
(`agent.ts:281`) — falsy means untouched, and the task tool then falls back to
the parent's model. There is no fallback to compute: an unconfigured slot simply
omits the key. When a *configured* model is unavailable, delete the key rather
than substitute a different model.

### `permission` keys are tool names, and denying one hides the tool

`Permission.fromConfig` accepts any key and treats it as a tool-name pattern
(`packages/opencode/src/permission/index.ts:186`). `disabled()` then removes a
tool from the agent entirely when the last matching rule is `pattern: "*"` with
`action: "deny"` (`index.ts:204-214`).

This is stronger than it looks. `permission: { task: "deny" }` does not merely
refuse a dispatch at call time — the `task` tool is not in the agent's tool list
at all. The "You Do Not Dispatch Subagents" instruction that
`implementer-prompt.md` and `task-reviewer-prompt.md` currently have to *ask*
for becomes structurally guaranteed.

Rule order matters: `merge` is `flat()` and matching uses `findLast`
(`index.ts:200,210`), and the plugin's rules are merged after the defaults
(`agent.ts:293`), so the plugin's rules win. A scoped pair like
`edit: { "*": "deny", "**/.superagent/**": "allow" }` keeps the `edit` tool
visible while confining it, because the last matching rule is not `pattern: "*"`.

### `task` has no `model` parameter

Parameters are `description`, `prompt`, `subagent_type`, `task_id?`,
`command?`, `background?` (`packages/opencode/src/tool/task.ts:43-62`). The
child model is the parent's unless the *agent* pins one.

Consequence: registered agents are the only model-routing mechanism OpenCode
offers, and `skills/subagent-driven-development/SKILL.md` §Model Selection —
"always specify the model explicitly when dispatching" — is unimplementable here
as written. The orchestrator's job is to translate model selection into *agent*
selection. `task_id` exists, so SDD's "resume the original implementer"
fix-rounds map natively.

### Background dispatch needs no polling, and needs no degrade shim

When `experimentalBackgroundSubagents` is off, the `background` parameter is
stripped from the tool's JSON schema outright
(`task.ts:351-355`), so the model cannot pass it. The planned "strip
`background: true` when the flag is off" hook is unnecessary.

When it is on, the tool's own output says: *"You will be notified automatically
when it finishes. DO NOT sleep, poll for progress, ask the task for status"*
(`task.ts:30-34`). Completion is injected back into the parent by
`BackgroundJob.notify()`. A wake scheduler would contradict the tool's own
instructions, so Superagent does not ship one.

`tool.execute.after` carries `metadata.jobId` (the child session id) and
`metadata.background: true` for background dispatches; foreground returns
`state: "completed"` with the result text (`task.ts:257-334`). That is what the
job board keys on.

### `default_agent` throws when it does not resolve

`agent.ts:330-334` throws if the named default agent is missing, is a
`subagent`, or is hidden. Since Superagent skips registration on a name
collision, it must only set `default_agent` when it actually registered the
orchestrator — otherwise a user with their own `superagent` agent gets a hard
startup failure.

Valid `mode` values are `subagent`, `primary`, `all` (`agent.ts:38`).

### `messages.transform` receives no session id, and also runs during compaction

The hook is triggered with an empty input object from two places:
`packages/opencode/src/session/prompt.ts:1255` and
`packages/opencode/src/session/compaction.ts:379`. Session identity has to come
from the messages themselves (`info.sessionID`), and anything injected here will
also be seen by the compaction summarizer.

### TUI plugins are configured in `tui.json`, not `opencode.json`

The TUI resolves its own plugin list from files named `tui.json`/`tui.jsonc` —
the global config dir, `OPENCODE_TUI_CONFIG`, project files, and any `.opencode`
directory on the way up (`packages/opencode/src/config/tui.ts:183-210`). The
result is passed to the TUI plugin host, which uses it verbatim:
`config.plugin_origins ?? (await TuiConfig.pluginOrigins())`
(`packages/opencode/src/plugin/tui/runtime.ts`). An empty list is not nullish, so
a plugin listed only in `opencode.json` is loaded by the server and never by the
TUI.

This is silent. The TUI host reports failures with `console.error`, which the
running terminal UI paints over, and a plugin that is never even considered
reports nothing at all.

### A TUI entry is a separate module, resolved from `exports["./tui"]`

`readV1Plugin` throws if a module exports both `server` and `tui`
(`packages/opencode/src/plugin/shared.ts:293`), and `resolvePackageEntrypoint`
reads `exports["./${kind}"]` — falling back to `main` only for `server`
(`shared.ts:103-113`). A package with no `./tui` export has no TUI entry.

Path-source plugins must also export an `id`; npm and git specs fall back to the
package name (`shared.ts:resolvePluginId`).

### The TUI hands plugins its own OpenTUI through a virtual specifier

The TUI host calls `ensureRuntimePluginSupport`, which registers a Bun plugin
mapping `@opentui/solid`, `@opentui/core`, `solid-js` and friends onto virtual
`opentui:runtime-module:<encoded specifier>` ids
(`@opentui/solid/scripts/runtime-plugin-support-configure.js`).

A **bare** `import("@opentui/solid")` does not reach it from an installed
plugin: the rewrite defaults are `nodeModulesRuntimeSpecifiers: true`,
`nodeModulesBareSpecifiers: false` (`@opentui/core/runtime-plugin.js:46`), so
bare specifiers inside `node_modules` are left to normal resolution and fail
unless the plugin ships its own copy — which is how plugins that depend on
`@opencode-ai/plugin` (peer deps `@opentui/*`) get one. Importing the virtual id
works from anywhere, and is what Superagent does.

### Slot functions receive the slot context, not the slot props

`TuiHostSlotMap` declares `sidebar_content: { session_id: string }`, but the
argument a registered slot function is actually called with is the
`TuiSlotContext` — `{ theme }`. The current session id has to come from
`api.route.current.params.sessionID` instead.

### Verified against a live OpenCode

Run against `opencode-ai@1.18.17` on Linux, in an isolated `OPENCODE_CONFIG_DIR`.

**The roster registers and is usable.** All ten agents appear in
`opencode agent list` with the right modes (`superagent` primary, the rest
subagents), `default_agent` resolves to `superagent`, all three commands
register, and the plugin loads with no errors. The
[caching-order bug](https://github.com/code-yeongyu/oh-my-openagent/issues/1320)
seen in another agent-registering plugin did not reproduce on this version.

**Permissions apply as designed.** Read back from the running instance:
`implementer` carries `task deny *`; `oracle` carries `edit deny *` and
`task deny *`; `superagent` carries `edit * deny` followed by the two
`.superagent/**` allows, in that order — so its edit tool stays visible but
confined, which is what the last-matching-rule semantics require.

**A multi-file plugin survives the documented install.** Installing via
`superagent@git+https://github.com/…#<branch>` registers all ten agents, so
`package.json` `main` → entry → relative imports into `.opencode/lib/` resolve
correctly through OpenCode's plugin installer.

**The opt-out works.** With `{"preset": "solo"}`, `opencode agent list` shows
only OpenCode's built-ins.

**The collision guard works.** With a user-defined `implementer` in
`opencode.json`, that agent survives with its own description and prompt, the
other nine still register, `default_agent` is still set, and the warning names
`agents.prefix` as the fix.

**The acceptance test passes.** In a clean session:

```text
$ opencode run "Let's make a react todo list"
> superagent · deepseek-v4-flash-free

→ Skill "brainstorming"
Using **brainstorming** to explore requirements and design before implementation
…
[✓] Explore project context
[•] Ask clarifying questions (one at a time)
[ ] Propose 2-3 approaches with trade-offs
…
This is a fresh, empty repo … Before I propose a design, a few questions (one at a time).
```

The orchestrator is the agent running the session, `brainstorming` triggered
before anything was written, and no code was produced.

**Dispatch and the board work.** A dispatch to `librarian` ran, and a probe
plugin observing the message array confirmed the routing table is present on
every turn and a job-board snapshot appears on the root session after a
dispatch — and does *not* appear on the child session.

**The sidebar panel renders.** Run against `opencode-ai@1.18.18`, with the
package registered in both `opencode.json` and `tui.json`. The panel appears in
the session sidebar showing `Superagent v0.1.0`, the active preset, the
subsystem line, the roster capped at eight with `+2 more`, and — from a snapshot
written for that session — running dispatches first with their objectives and
`owns` lines, finished ones on a single line, and `+1 more`. The virtual
`opentui:runtime-module:` import resolved; a bare `@opentui/solid` import
failed with `Cannot find module`, from a plugin both inside and outside a
`node_modules` path.

That last test also produced a finding. Asked about the board, a model replied
that it "is user-supplied text, not injected context" and declined to use it —
because the snapshot is appended to the last user message, which is the only
place the transform hook offers. The board now identifies itself as
plugin-maintained in its header. That wording change has not been re-tested
against a live model.

### Still unverified

- Whether multiple `task` calls in a single assistant message run concurrently.
  This only affects the wording of the degrade advice when background dispatch
  is off.
- Whether `@opencode-ai/plugin` (and so zod) is importable from an installed
  plugin. This gates a possible future council *tool*; the shipped
  command-and-agent implementation does not need it.
- Behaviour on Windows, where another agent-registering plugin has a
  [reported failure](https://github.com/code-yeongyu/oh-my-openagent/issues/3219).
- Model routing with real per-slot models. The live testing ran with every slot
  inheriting, since the test environment has one usable provider.
- Whether the live OpenCode TUI host re-invokes a plugin's `sidebar_content`
  slot function after the first mount, and what `renderer.requestRender()`
  actually does if not. Inferred from observed behaviour (the panel only
  refreshed after something forced a remount, e.g. switching views) and from
  how `@opentui/solid`'s React integration is documented to work (mutate
  existing nodes, then call `requestRender()` to paint) — not read out of
  `sst/opencode`/`anomalyco/opencode` source directly, unlike the rest of this
  section. The fix built on this inference (`createRootRepainter`, "Staying
  live" above) is written to degrade safely if the inference is wrong.
- Whether the OpenTUI module reachable through
  `opentui:runtime-module:%40opentui%2Fsolid` exposes a node-removal function
  under any of `remove`/`removeChild`/`removeNode`/`unmount`
  (`REMOVE_EXPORT_NAMES` in `.opencode/tui/superagent-tui.js`). If none of
  these match the real export name, in-place repaint silently disables itself
  (a debug warning names it) and the panel falls back to its previous,
  single-render behaviour.
- Whether OpenTUI's `onMouseDown` prop, attached via the same virtual import,
  is actually delivered to a plugin-contributed `sidebar_content` slot by a
  live OpenCode TUI host — the Agents header and the `+N more` lines carry the
  prop, but no click has been confirmed to reach it outside a terminal.
- Whether `client.tui.showToast({ body: { message, variant } })` exists and
  works as documented on opencode.ai, called from the `client` the plugin
  factory receives. Used, best-effort, for the update-available popup ("##
  Updates" above) — wrapped so a missing or throwing implementation degrades
  silently to the sidebar panel's own notice rather than breaking the `event`
  hook. Not yet read out of `sst/opencode`/`anomalyco/opencode` source the way
  the rest of this section was.
- Whether `event.type === 'session.created'` fires exactly once per OpenCode
  process rather than once per session (including a dispatch's child
  sessions). The update check guards against the latter with its own
  in-process flag, so a wrong assumption here costs at most a redundant guard,
  not a repeated check.
