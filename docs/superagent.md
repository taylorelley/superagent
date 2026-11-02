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

Every specialist has `subagent` denied, which removes the tool from it entirely —
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

This is the reason the roster exists. OpenCode 2's `subagent` tool does take a
`model`, but its own description tells the model never to set one unless the
user asks, and a guessed model ID fails the dispatch. So the reliable way to
run a reviewer on a different model from an implementer is for them to be
different *agents*, each with its model pinned in its definition.

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
lists them — in `provider/model` form, optionally with a `#variant`
(`anthropic/claude-opus-4-5#high`). No preset ships with model IDs in it,
because the right ones depend entirely on which providers you use.

OpenCode 2 agents have no temperature field, so the per-slot `temperature`
settings are applied by the plugin's `context` hook to each request that agent
makes — and only when nothing earlier in the request has already set one.

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
    "permissionOverrides": {} // per agent, applied after the roster's own rules
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

`/preset <name> --persist` saves a preset and applies it: the plugin re-reads
its configuration and reloads its agent and command registrations, so new
dispatches and new sessions get the new roster. **A running session keeps the
agent and model it already selected**, and the command says so rather than
reporting a change that has not happened. OpenCode 2 runs one plugin instance
per project location, so other projects you have open pick the preset up the
next time their instance loads (or after `opencode service restart`). Without
`--persist`, `/preset <name>` changes nothing and says so.

`permissionOverrides` take a permission map per agent — `{ "oracle": {
"webfetch": "deny", "edit": { "*": "deny", "notes/**": "allow" } } }` — or a
list of OpenCode 2 rules (`[{ "action", "resource", "effect" }]`). OpenCode 1
action names are translated: `task` → `subagent`, `bash` → `shell`, and
`write`/`patch` → `edit`.

## The job board

Every `subagent` dispatch is recorded, and a compact snapshot is injected into
the session's model requests so the orchestrator can see what it launched.
`/board` prints it.

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

So Superagent also renders a panel into OpenCode's TUI sidebar. It answers,
top to bottom, what the plan is, what the main agent is doing, and what each
subagent is doing:

```text
 Plan                            2/4
 2026-11-02-demo.md
 ▸ Task 2: Count files

 Main · brainstorming
 ● subagent general             0:06

 Subagents                       1/2
 ● general · Count files        0:06
   shell sleep 6 && ls
   owns src/api/**
   ⚠ overlaps implementer
 ✓ explore · Find callers       1:05
   → Found 3 call sites in tui-…

 Superagent v0.1.0   team · 10 agents
```

(Captured from OpenCode 2.2.5's real TUI, with the conflict and second row
added for illustration.)

- **Plan** — the `docs/superagent/plans/*.md` file the session is working
  from, found in the tool calls of the session or of one of its subagents
  (under `team` the orchestrator may not edit files, so a subagent usually
  writes it). `2/4` counts ticked `- [x]` steps; `▸` is the task holding the
  first unticked one. A plan without checkboxes reports its task count. No
  plan, no section.
- **Main** — the skill the main agent last loaded (the "→ Skill" line in the
  main pane scrolls away; this one stays), what it is doing right now and for
  how long, or `idle`. Between tool calls it says `thinking`.
- **Subagents** — one row per dispatch: agent and objective, then a timer
  while it runs or its duration once it is done. A running row adds the tool
  call its child session is making right now (the main pane only shows
  "General Subagent — Count files"; what happens inside the child is otherwise
  invisible), the files it declared it owns, and — in the warning colour — any
  running dispatch it overlapped when it started. A finished row adds what
  came back (`→ …`), or why it failed. States carry glyphs so an outcome reads
  at a glance: `●` running, `✓` completed, `✗` error, `○` cancelled.
- **Footer** — the version (did my update land) and the preset with its roster
  size. A subsystem switched off gets its own line (`board off`); the defaults
  being on is not news.

The panel deliberately leaves out what OpenCode's own sidebar already shows —
todos, context use, MCP servers, changed files.

Everything is capped, because a panel that outgrows the sidebar is silently
clipped from the bottom. The subagent list shows five rows, with detail lines
for the first three running ones, and its `+N more` line reveals one more page
per click. Every row is fitted to the sidebar's 35-column text area (measured
in 2.2.5), left half truncated first, so two halves never run together. Turn
the panel off with `{"tui": {"enabled": false}}`, or with
`SUPERAGENT_DISABLE=1`, which turns off everything.

The roster is hidden by default — it is configuration, not activity. Clicking
the footer toggles it (routed slots first, then the rest, as `inherit`), and
its `+N more` line pages through a long one. `{"tui": {"agents": {"expanded":
true}}}` in `superagent.json` only sets the *starting* state.

### Where the data comes from

Two sources, split by what each side can know:

- **The host's session store** (`context.data.session`: `get`, `family`,
  `status`, `message.list`) — the plan path, the main agent's skill and
  current tool call, and each child session's current tool call. Every tool
  call is already there as a `{ type: 'tool', name, state: { status, input } }`
  part on an assistant message, so reading it costs nothing and can never
  disagree with the main pane. A skill loaded through the `skill` tool does not
  emit `session.skill.activated` in 2.2.5, which is why the skill is read from
  tool parts. See `.opencode/lib/tui-activity.js`.
- **The board snapshot** — what only the server knows: each dispatch's
  ownership claims and conflicts, its outcome and result, and the update
  notice. The server links each dispatch to its child session — from the tool
  result for a background dispatch, from `session.created` (whose payload
  carries `parentID`, the agent and, as its title, the dispatch description)
  for a foreground one — so the panel can join the two. A record that was never
  linked falls back to the running child with the same agent and title, and a
  running child no record accounts for still gets a row.

### Staying live

OpenCode 2 renders a plugin's slot claim inside Solid's ownership tree, and
OpenTUI finds its renderer through Solid context. So the panel's root is filled
with a *reactive* `insert(root, () => …)`: the snapshot poll (once a second,
re-parsed only when the file's mtime moves) and every click bump one Solid
signal, and Solid re-runs that insert inside the slot's own owner, where
creating elements is legal. The panel repaints in place, immediately. While
anything is running the poll also repaints once a second, so the timers tick;
with nothing running, an unchanged panel is left alone. The plan file is
re-read only when its mtime moves.

That replaces the OpenCode 1 situation, where the panel could only refresh when
the host happened to re-invoke `sidebar_content` (creating elements from a poll
tick threw `No renderer found`, and `@opentui/solid` has no imperative removal
export to patch a tree with). Confirmed against OpenCode 2.2.5 in a real
terminal, driven through a pty with a scripted model: the plan, the main
agent's skill, a subagent's live `shell` call with a ticking timer, then
`thinking`, then `✓` with its duration and result all appeared with no view
switch.

The Subagents section can tell you why it is empty:

| State | Meaning |
|---|---|
| `no snapshot yet — nothing dispatched` | No dispatch has been recorded yet in this project. |
| `snapshot from a different plugin version` | The snapshot file is from an older Superagent copy (snapshot format mismatch). |
| `server vX ≠ panel vY` | The snapshot was written by a different Superagent version than the panel's — usually a server that has not restarted since an update. Run `opencode service restart`. |
| `none this session` | The bridge works; this session simply has no dispatches. |

### Registering it

Nothing to do. The panel is the package's `./tui` export, and OpenCode 2 loads
the TUI parts of the plugins its server loads — the one `plugins` entry in
`opencode.json` covers both. (OpenCode 1 needed a second entry in `tui.json`;
remove it.)

### How it is built

- **It is the package's TUI part.** `exports["./tui"]` in `package.json` points
  at `.opencode/tui/superagent-tui.js`, a V2 TUI plugin — a default-exported
  `{ id: "superagent.tui", setup(context) }` that claims the
  `sidebar.content` slot through `context.ui.slot`. The slot's input carries
  the `sessionID` being shown, so the panel always describes the session on
  screen.
- **It renders through the host's OpenTUI and Solid, not its own.** Superagent
  has no dependencies, and a second copy of the renderer would be wrong even if
  it had. The panel imports the host's instances through the virtual
  specifiers `opentui:runtime-module:%40opentui%2Fsolid` and
  `opentui:runtime-module:solid-js` (the host registers both, plus
  `@opentui/core` and `@opencode/plugin/tui`, for every plugin, including one
  installed under `node_modules`). If either import fails the panel is not
  registered, and nothing else is affected.
- **The roster comes from the host.** The expanded roster lists the entries
  present in `context.data.location.agent.list()`, so a name that was
  skipped for a collision is not claimed as ours.
- **The board reaches it through a file.** The server and TUI parts are
  separate module graphs — and with a remote server, separate machines — so
  `board.js`'s in-memory ledger is not visible from the panel. Each change is
  projected to `~/.config/opencode/superagent/tui-<hash-of-project-dir>.json`,
  which the panel polls. Only the board crosses: the version, preset and
  roster are recomputed on the TUI side from the same modules the plugin uses,
  and live activity is read from the host's own session store.
- **Clicks use OpenTUI's own event props.** OpenTUI's element primitives
  support `onMouseDown`, and `elementFactory` forwards every prop verbatim via
  `setProp`, so the footer and both `+N more` lines carry an `onMouseDown`
  prop.
- **The update toast.** When the snapshot reports a newer version, the panel
  shows one `context.ui.toast` per TUI process.

## Background dispatch

Built in. OpenCode 2's `subagent` tool takes `background: true`, returns as
soon as the child session starts, and notifies the parent when it finishes, so
the orchestrator dispatches independent work in parallel. (OpenCode 1 gated
this behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`; that variable no
longer does anything.) The one-writer-per-file rule still applies. To send a
running or finished subagent follow-up instructions, the orchestrator calls
`subagent` again with the `sessionID` it returned.

## Parallel dispatch

When a plan declares independent tasks (its Task Order & Dependencies table —
see `skills/writing-plans`), SDD executes
each wave concurrently: every task gets its own git worktree at
`.worktrees/<plan-basename>/t<N>` on its own branch, is dispatched with
`background: true`, and the controller merges each branch back into the
feature branch after its review passes. A merge conflict means the plan's
disjoint-files claim was wrong — surfaced loudly as a plan defect rather than
a silent overwrite. With a wave of one, or no table, SDD runs serially as
before. The `subagent` tool has no working-directory parameter, so each wave
implementer is told its worktree path in its prompt.

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

Once per plugin instance, on the first session it sees — not once per
session, so a dispatch's child sessions don't repeat it, and never during
startup, so a slow network cannot delay OpenCode — the plugin asks GitHub
whether a newer Superagent exists: a release first (`GET /repos/taylorelley/superagent/releases/latest`),
falling back to `package.json` on the default branch if this repo has not cut
one yet. The result is cached to
`<configDir>/superagent/update-check.json` and reused for `updateCheck.intervalHours`
(default 24) before asking again, so a normal day of restarts costs at most
one request. Nothing about the user or the project is sent — the request asks
"what's the latest version," full stop.

When a newer version is found:

- The sidebar panel (`## The sidebar panel` above) gains a line —
  `⬆ vX.Y.Z available — run /update install` — directly above its footer.
- The TUI shows one toast (`context.ui.toast.show`) per TUI process. The V2
  server plugin context has no toast API, so the toast comes from the panel,
  which reads the same snapshot.

`/update` reports the installed version, the latest known version, and when it
was last checked, reading only the cache — it never blocks on a fetch of its
own. `/update install` shells out, in order of preference, to:

1. `git pull --ff-only`, when the installed package is a git checkout;
2. `opencode plugin update <target>`, when Superagent is a package target in
   your `plugins` (`github:taylorelley/superagent`, a version spec, …) — the
   target is read from your OpenCode config;
3. `npm install superagent@git+https://github.com/taylorelley/superagent.git --prefix <configDir>`,
   the fallback documented in `.opencode/INSTALL.md`.

A missing tool degrades to reporting the exact manual command rather than
failing silently. It says plainly that **the update does not take effect until
the service restarts** (`opencode service restart`) — plugin code is imported
once, when the plugin loads.

Turn the check off with `{"updateCheck": {"enabled": false}}`, or with
`SUPERAGENT_DISABLE=1`, which turns off everything.

## What degrades, and how

| Feature | If unavailable | Behaviour |
|---|---|---|
| Background dispatch | a child session reports no id | The board records the dispatch as completed rather than leaving it running forever |
| Model routing | not `provider/model`, or not in any provider | Model dropped with a warning; agent inherits the session model |
| A skill ID | already taken by a personal or project skill | Yours is kept; ours is skipped |
| The sidebar panel | the host's OpenTUI or Solid cannot be imported | Panel not registered; everything else unaffected |
| An agent name | already taken by the user | Yours is kept; ours is skipped with a warning |
| Council | fewer than 2 members | `/council` explains how to configure it instead of dispatching |
| Council | a member fails to answer | Synthesis proceeds and names the failure; under 2 answers is reported inconclusive |
| A reused prompt template | upstream changed its shape | Agent is skipped with a warning, and a test fails in CI |
| Config file | malformed | Ignored with a warning; defaults apply |
| Everything | `preset: "solo"` | Bootstrap and skills only |

## Troubleshooting

**The agents don't appear.** Check the plugin loaded at all:
`opencode plugin list`, then
`opencode run --standalone --print-logs "hello" < /dev/null 2>&1 | grep -iE 'superagent|plugin'`
(a `failed to load plugin` line names the cause). `opencode debug agents`
prints every agent the server registered, with its permission rules. Make sure
the entry is under `plugins` — OpenCode 2 ignores a V1 `plugin` array's
implementation.

**Warnings about a name collision.** You already have an agent with that name.
Set `agents.prefix`.

**More detail.** `SUPERAGENT_DEBUG=1`.

**The Subagents section stays empty.** If it names a version mismatch
(`server v… ≠ panel v…`), the snapshot was written by a server still running an
older copy — `opencode service restart`, and re-dispatch. If it
says `no snapshot yet`, dispatch something; if it says `none this session`,
the bridge works and this session has simply not dispatched. Run with
`SUPERAGENT_DEBUG=1` for the panel's per-render log line (file, mtime, session,
record count, state).

---

## How the OpenCode 2 plugin API is used

Superagent targets the [OpenCode 2 plugin format](https://opencode.ai/v2/docs/plugins/).
Each part is a plain default-exported `{ id, setup }` object — what
`Plugin.define` from `@opencode/plugin` returns, since `define` is the identity
function — so the package keeps its zero-dependency rule.

| Concern | OpenCode 1 | OpenCode 2 (this plugin) |
|---|---|---|
| Entry | `export const SuperagentPlugin = async ({ client, directory }) => hooks` | `export default { id: "superagent", setup(ctx) }` |
| Skills | push `skills/` onto `config.skills.paths` | `ctx.skill.transform` adds each `SKILL.md`; the directory is watched and `ctx.skill.reload()` re-reads it |
| Agents | assign `config.agent[name]` | `ctx.agent.transform` → `editor.update(name, …)` on an unused ID; `editor.default(…)` |
| Agent prompt / permissions | `prompt`, `permission: { tool: effect }` | `system`, `permissions: [{ action, resource, effect }]` (lowered by `lib/permissions.js`) |
| Agent temperature | `temperature` | no field; set per request in the `context` hook |
| Commands | `config.command[name] = { template }` + `command.execute.before` | `ctx.command.transform` → `editor.add({ name, execute })`; `execute` submits the expansion with `ctx.session.prompt` |
| Bootstrap and board | `experimental.chat.messages.transform` | `ctx.session.hook("context", …)` editing `event.messages` |
| Dispatch tracking | `tool.execute.before/after` on `task` | `ctx.tool.hook("execute.before" / "execute.after")` on `subagent` |
| Background completion | `event` hook, `session.idle` / `session.error` | `ctx.event.subscribe` on `session.execution.succeeded/failed/interrupted`, `session.deleted` |
| Sidebar panel | `tui()` + `api.slots.register({ sidebar_content })`, listed in `tui.json` | `{ id, setup(context) }` + `context.ui.slot({ append: "sidebar.content" })`, loaded from the same `plugins` entry |
| Update toast | `client.tui.showToast` (unverified) | `context.ui.toast.show` from the TUI part |

Three properties of V2 shaped the port:

- **Transforms are replayed.** A registry read rebuilds the registry by
  re-running every transform on a fresh value. So every transform here is
  synchronous and I/O-free (prompts and skills are read once at setup), and
  reports what it did through its return value — conflicts are logged once per
  process, not once per replay.
- **The command editor can only add, and a later add shadows.** So
  `ctx.command.list()` is read before registering, and a name the user already
  has is skipped and reported, the same as an agent collision.
- **The agent editor can set the default agent but not read it.** So the
  plugin reads `default_agent` from the user's OpenCode config files
  (`lib/opencode-config.js`) and only selects `superagent` when none is set.

### Verified against OpenCode 2.2.5

Run on Linux against `opencode` 2.2.5 (installed with
`curl -fsSL https://opencode.ai/v2/install | bash`), in an isolated home,
with an OpenAI-compatible mock provider that scripts tool calls and records
every request body — so what the model receives is checked byte for byte.

- **The plugin loads from a local package directory, from a symlink in
  `~/.config/opencode/plugins/`, and as a `github:` package target**
  installed by `opencode plugin add`.
- **The roster registers.** `opencode debug agents` lists all ten agents with
  the intended modes and system prompts; `superagent` is the default agent.
  Permission rules read back as intended: workers end with
  `subagent * deny`, reviewers and advisors with `edit * deny`, `librarian`
  with `webfetch * allow`, and `superagent` with `edit * deny` followed by the
  two `.superagent/**` allows.
- **Skills register and load.** The system prompt advertises every Superagent
  skill; the real `skill` tool loads `brainstorming` from the plugin-registered
  entry, with its base directory set to `skills/brainstorming`. A personal or
  project skill with the same ID wins. A skill added while the service is
  running is picked up without a restart (`tests/opencode/test-priority.sh`).
- **The bootstrap is injected** as the first part of the first user message of
  every agent-loop request, routing table and tool map included, and into
  subagent sessions too.
- **Per-slot temperature applies**: a dispatch to `oracle` sent
  `temperature: 0.1`; the orchestrator's requests sent none.
- **Dispatch tracking works** for foreground and background `subagent` calls,
  including a failed call (recorded as `error`). A background dispatch stayed
  `running` until its child's `session.execution.succeeded` event settled it.
  The job board appears in the parent session's follow-up requests.
- **Commands work.** `/preset`, `/board` and `/update` are listed by
  `command.list` (`/council` only with the council preset), and
  `session.command` runs them: the expansion arrives as the next user prompt.
  `/preset solo --persist` removed the roster and `/board` from that location
  without a restart.
- **The sidebar panel renders and stays live** in the real TUI (driven in
  `tmux`): it showed the version, preset, roster summary and dispatches, and
  updated in place as a second, background dispatch ran and settled.
- **The activity panel** (driven through a pty, scripted mock model): the plan
  a subagent wrote (`2/4`, current task), `Main · brainstorming` with a ticking
  timer, a foreground subagent's live `shell` call, then `thinking`, then `✓`
  with its duration and `→ Found 1 file: README.md`. The same run confirmed
  the payloads the panel relies on: `session.created` carries `parentID`; a
  skill loaded through the `skill` tool emits no `session.skill.activated`;
  `session.tool.called` has no tool name (it is on
  `session.tool.input.started` and the `execute.before` hook); and a
  `subagent` result is wrapped in `<subagent sessionID=… state=…>`.

### Still unverified

- **Behaviour with a real model.** No model provider with available quota was
  reachable from the environment the port was tested in, so the acceptance
  check — `brainstorming` auto-triggering on "Let's make a react todo list" in
  a clean session — has not been re-run on OpenCode 2. Everything above was
  exercised with a scripted mock model.
- Model routing with real per-slot models (the mock exposes one provider).
- Whether a mouse click is delivered to the panel's `onMouseDown` props by the
  live host (the footer's roster toggle, the `+N more` lines). The click path is the same signal bump as the poll, which is
  verified; the event delivery is not.
- Behaviour on Windows, and with the TUI attached to a remote server (the
  panel reads its snapshot from the local config directory).
- Whether multiple `subagent` calls in a single assistant message run
  concurrently in the foreground.
