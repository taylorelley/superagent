/**
 * The Superagent roster, as Claude Code agent types.
 *
 * `core/roster.js` is the one description of the team, shared with OpenCode.
 * This module translates it into what `$.agent.register` takes — the same
 * fields an agent file carries — and into the permission rules the hooks
 * module enforces at `tool.check`. It is pure: the hooks module reads the
 * prompt files and passes their text in, because only the hooks module may
 * call the mods API.
 *
 * How OpenCode's agent fields land in Claude Code:
 *
 * - **Prompt.** Identical text. Dispatch templates go through the same
 *   extraction (`core/prompt-compose.js`), so the two hosts cannot drift.
 * - **Permissions.** The roster's permission map is lowered to the same
 *   ordered rule list OpenCode uses (`core/permissions.js`). An action whose
 *   last rule denies `*` is withheld outright — `disallowedTools` — which is
 *   what OpenCode does with such a tool. Anything finer (a path-scoped edit, a
 *   command pattern, an `ask`) is enforced per call by the hooks module.
 * - **Model.** Claude Code runs Claude models: an alias (`opus`, `sonnet`,
 *   `haiku`, `fable`), a full id, or `inherit`. `provider/model` values written
 *   for OpenCode keep working when the model is a Claude one; anything else is
 *   dropped with a warning and the agent inherits, exactly as OpenCode drops an
 *   unavailable model. A `#variant` that names an effort level becomes the
 *   agent's `effort`.
 * - **Temperature.** Claude Code has no per-agent or per-request temperature,
 *   so the per-slot `temperature` settings do not apply here (see
 *   docs/claude-code.md).
 * - **Names.** A plugin's agent types are always `<plugin>:<name>`, so they
 *   cannot collide with the user's own agents; `agents.prefix` still applies,
 *   inside the plugin's namespace.
 */

import { ROSTER } from '../../core/roster.js';
import { mergeRules, hiddenActions } from '../../core/permissions.js';
import { extractDispatchTemplate, composeAgentPrompt } from '../../core/prompt-compose.js';
import { COUNCILLOR_PERMISSION, councillorPrompt } from '../../core/council.js';

/** OpenCode permission actions → the Claude Code tools they govern. */
export const ACTION_TOOLS = {
  edit: ['Edit', 'Write', 'NotebookEdit'],
  subagent: ['Agent'],
  shell: ['Bash', 'PowerShell'],
  read: ['Read', 'Glob', 'Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  skill: ['Skill'],
  todowrite: ['TodoWrite', 'TaskCreate', 'TaskUpdate'],
};

/** Claude Code tool → OpenCode permission action. */
export const TOOL_ACTIONS = Object.fromEntries(
  Object.entries(ACTION_TOOLS).flatMap(([action, tools]) => tools.map((tool) => [tool, action])),
);

const ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Is this a model id Claude Code can run (directly, or through a cloud provider)? */
const isClaudeModel = (id) =>
  ALIASES.has(id) || /^claude-/i.test(id) || /(^|\.)anthropic\.claude-/i.test(id);

/**
 * Translate a configured model into Claude Code's terms.
 *
 * Returns `{}` for an unrouted slot (the agent inherits), `{ model, effort? }`
 * for a usable one, or `{ warning }` when the value cannot run on Claude Code.
 */
export const toClaudeModel = (value) => {
  if (value === null || value === undefined || value === '') return {};
  let raw = value;
  let variant;
  if (typeof value === 'object') {
    raw = value.id ?? value.model;
    variant = value.variant;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { warning: `model ${JSON.stringify(value)} is not a model id` };
  }
  const [ref, hashVariant] = raw.trim().split('#');
  variant = variant ?? hashVariant;
  const id = ref.slice(ref.lastIndexOf('/') + 1);
  if (!isClaudeModel(id)) {
    return {
      warning:
        `model "${raw}" is not a Claude model, and Claude Code runs only Claude models; ` +
        'the agent will inherit the session model instead',
    };
  }
  const out = { model: id };
  if (variant && EFFORTS.has(variant)) out.effort = variant;
  return out;
};

/** The files the roster's prompts come from, relative to the plugin root. */
export const promptPath = (spec) =>
  spec.kind === 'template' ? spec.path : `.opencode/${spec.path}`;

export const promptPaths = (roster = ROSTER) => [
  ...new Set(roster.map((entry) => promptPath(entry.prompt))),
];

/**
 * Turn a prompt file's text into the agent's system prompt.
 *
 * Throws when a dispatch template has changed shape — the caller skips that
 * agent with a warning, as OpenCode does, rather than registering a prompt
 * *about* dispatching.
 */
export const composePrompt = (spec, text) =>
  spec.kind === 'template'
    ? composeAgentPrompt(extractDispatchTemplate(text, spec.path), spec.extra)
    : String(text).trim();

/** The tools an agent's rules withhold outright. */
export const withheldTools = (rules) =>
  hiddenActions(rules).flatMap((action) => ACTION_TOOLS[action] ?? []);

/** Agent type names may hold letters, digits, `_` and `-`, up to 64 characters. */
export const safeName = (name) =>
  String(name)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

/**
 * Build the roster for this session.
 *
 * `prompts` maps each `promptPath` to the file's text (or null when missing).
 * Returns:
 *
 * - `specs`: what to pass to `$.agent.register`, one per specialist;
 * - `registered`: roster entries with their full `<plugin>:<name>` names and
 *   resolved models, for the routing table and the panel;
 * - `orchestrator`: the orchestrator's prompt and rules when it is enabled —
 *   it is not an agent type here but the main thread's role, which the hooks
 *   module adds to the system prompt;
 * - `rules`: full agent name → permission rules, for per-call enforcement;
 * - `warnings`: what was dropped and why.
 */
export const buildRoster = (settings, prompts, { pluginName = 'superagent' } = {}) => {
  const result = { specs: [], registered: [], orchestrator: null, rules: {}, warnings: [] };
  if (settings?.agents?.enabled === false) return result;

  const { prefix = '', disable = [], models = {}, permissionOverrides = {} } = settings.agents;

  for (const entry of ROSTER) {
    if (disable.includes(entry.key)) continue;

    const text = prompts?.[promptPath(entry.prompt)];
    if (typeof text !== 'string') {
      result.warnings.push(`prompt file missing, skipping agent: ${promptPath(entry.prompt)}`);
      continue;
    }
    let prompt;
    try {
      prompt = composePrompt(entry.prompt, text);
    } catch (err) {
      result.warnings.push(`could not extract a prompt from ${entry.prompt.path}: ${err.message}`);
      continue;
    }

    const rules = mergeRules(entry.permission, permissionOverrides?.[entry.key]);
    const routed = toClaudeModel(models?.[entry.slot]);
    if (routed.warning) result.warnings.push(`slot "${entry.slot}": ${routed.warning}`);

    if (entry.orchestrator) {
      result.orchestrator = { entry, prompt, rules, model: routed.model, effort: routed.effort };
      continue;
    }

    const shortName = safeName(`${prefix}${entry.key}`);
    const name = `${pluginName}:${shortName}`;
    const disallowedTools = withheldTools(rules);

    result.specs.push({
      name: shortName,
      description: entry.description,
      prompt,
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(routed.model ? { model: routed.model } : {}),
      ...(routed.effort ? { effort: routed.effort } : {}),
    });
    result.rules[name] = rules;
    result.registered.push({ ...entry, name, model: routed.model ?? null });
  }

  return result;
};

/**
 * Build one agent type per councillor.
 *
 * `members` are the usable ones (`usableMembers` in `core/council.js`, which
 * also warns about members sharing a model). Councillors are sealed exactly
 * as on OpenCode: no edits, no dispatching, no shell.
 */
export const buildCouncil = (settings, members, { pluginName = 'superagent' } = {}) => {
  const result = { specs: [], registered: [], rules: {}, warnings: [] };
  const prefix = settings?.agents?.prefix ?? '';
  const rules = mergeRules(COUNCILLOR_PERMISSION);
  const disallowedTools = withheldTools(rules);

  for (const member of members ?? []) {
    const shortName = safeName(`${prefix}councillor-${member.name}`);
    const name = `${pluginName}:${shortName}`;
    const routed = toClaudeModel(member.model);
    if (routed.warning) result.warnings.push(`councillor "${member.name}": ${routed.warning}`);
    result.specs.push({
      name: shortName,
      description: `Council member ${member.name}. Answers one question independently.`,
      prompt: councillorPrompt(member),
      disallowedTools,
      ...(routed.model ? { model: routed.model } : {}),
      ...(routed.effort ? { effort: routed.effort } : {}),
    });
    result.rules[name] = rules;
    result.registered.push({ name, member, model: routed.model ?? null });
  }
  return result;
};
