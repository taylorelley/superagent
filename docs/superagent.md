# Superagent — the OpenCode agent team

Superagent is this fork's OpenCode-only layer on top of Superpowers. Superpowers
supplies the methodology (brainstorm → spec → plan → TDD → review → verify);
Superagent supplies the execution substrate — a roster of specialist agents,
each routable to its own model, coordinated by an orchestrator that schedules
work rather than doing it.

> **Fork-specific.** This layer lives only in `taylorelley/superpowers`. It is
> not part of upstream `obra/superpowers` and is not proposed for it.
>
> Agent-roster, job-board, and council concepts are adapted from
> [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)
> (MIT). Reimplemented from scratch; no code copied.

---

## The roster

Ten agents, registered automatically. Six reuse prompts Superpowers already
ships; four are new to this layer.

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
orchestrator can only write under `.superpowers/`.

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

An unrouted slot omits the model and inherits. A slot routed to a model that is
not available is **dropped with a warning**, never silently swapped for a
different model.

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
  "bootstrap": { "enabled": true }
}
```

### Presets

| Preset | What it does |
|---|---|
| `team` | Default. Full roster, job board on. |
| `council` | `team` plus the council. |
| `solo` | Everything off — exactly the behaviour before this layer existed. |

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

```
<!-- superagent-ownership: write=src/api/**; read=src/** -->
```

A later dispatch whose write claim overlaps a running one gets a notice
prepended to its prompt naming the conflict. Overlap detection deliberately
over-reports: a spurious warning costs a sentence, a missed collision costs
work. Running dispatches that declared nothing are flagged, since those are the
ones where a collision cannot be detected at all.

There is no poller and no wake scheduler — see the API notes below for why.

## Background dispatch

Off unless you start OpenCode with it:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

With it on, the orchestrator dispatches independent work in parallel and is
notified as each finishes. Without it, the routing table tells it to issue
several `task` calls in one message instead, and the one-writer-per-file rule
still applies. A plugin cannot enable this itself.

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
`opencode run --print-logs "hello" 2>&1 | grep -i superpowers`. Note that
plugin-registered agents surfacing in `opencode agent list` is subject to a
[known caching-order bug](https://github.com/code-yeongyu/oh-my-openagent/issues/1320)
in OpenCode; they can work in-session while missing from that listing.

**Warnings about a name collision.** You already have an agent with that name.
Set `agents.prefix`.

**More detail.** `SUPERAGENT_DEBUG=1`.

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
`edit: { "*": "deny", "**/.superpowers/**": "allow" }` keeps the `edit` tool
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

### Still unverified

These need a real OpenCode binary and are not settled by source reading:

- Whether a multi-file plugin installed through the documented `git+https` spec
  resolves its relative imports in every supported Bun version. Node and Bun
  both resolve a symlinked module to its realpath, and the test harness installs
  the tree the same way, but that is not the same as a real install.
- Whether plugin-registered agents appear in `opencode agent list`, which has a
  [known caching-order bug](https://github.com/code-yeongyu/oh-my-openagent/issues/1320)
  and a [Windows failure](https://github.com/code-yeongyu/oh-my-openagent/issues/3219)
  in another plugin that registers agents the same way.
- Whether multiple `task` calls in a single assistant message run concurrently.
- Whether `@opencode-ai/plugin` (and so zod) is importable from an installed
  plugin, which gates the optional council tool.
