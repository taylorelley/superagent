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
