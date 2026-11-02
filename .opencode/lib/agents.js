/**
 * Register the roster through OpenCode V2's agent transform.
 *
 * Three behaviours here exist because of how OpenCode assembles agents:
 *
 * - **Never overwrite an existing agent.** By the time this transform runs,
 *   the editor already holds the built-ins and whatever the user wrote in
 *   `opencode.json` or `.opencode/agents/*.md`. `editor.update` on a taken ID
 *   would silently merge our definition into theirs. The roster names are
 *   unprefixed and generic on purpose — they are meant to be typed — so a
 *   collision is plausible, and the user's definition wins.
 *
 * - **Omit `model` rather than compute a fallback.** A subagent with no model
 *   inherits the parent session's. So an unrouted slot is expressed by leaving
 *   the key off, and an unavailable model is expressed by not setting it —
 *   never by substituting some other model the user did not ask for.
 *
 * - **Only select a default agent if the orchestrator was registered, and the
 *   user has not chosen one.** The editor exposes no getter for the current
 *   default, so the caller reads `default_agent` from the user's OpenCode
 *   config (see `opencode-config.js`) and passes it in.
 *
 * Everything here runs inside a transform, which OpenCode replays from
 * scratch whenever the agent registry is rebuilt. So it is synchronous, does
 * no I/O (prompts are read at setup and cached), and reports what it did
 * through its return value instead of through side effects.
 */

import fs from 'fs';
import path from 'path';
import { ROSTER } from './roster.js';
import { opencodeDir, packageRoot } from './paths.js';
import { extractDispatchTemplateFile, composeAgentPrompt } from './prompt-compose.js';
import { mergeRules } from './permissions.js';
import { warn, debug } from './log.js';

/** Prompts are read once at setup; the transform path must stay I/O free. */
const promptCache = new Map();

export const resetPromptCache = () => promptCache.clear();

export const loadPrompt = (spec) => {
  const cacheKey = `${spec.kind}:${spec.path}:${spec.extra ?? ''}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

  const base = spec.kind === 'template' ? packageRoot : opencodeDir;
  const filePath = path.join(base, spec.path);

  let prompt = null;
  if (!fs.existsSync(filePath)) {
    warn(`prompt file missing, skipping agent: ${spec.path}`);
  } else if (spec.kind === 'template') {
    try {
      prompt = composeAgentPrompt(extractDispatchTemplateFile(filePath), spec.extra);
    } catch (err) {
      // The upstream template changed shape. Registering the raw markdown would
      // give the agent a page *about* dispatching instead of a role, so skip.
      warn(`could not extract a prompt from ${spec.path}: ${err.message}`);
    }
  } else {
    prompt = fs.readFileSync(filePath, 'utf8').trim();
  }

  promptCache.set(cacheKey, prompt);
  return prompt;
};

/** Warm the prompt cache for every roster entry, so the transform never reads a file. */
export const preloadPrompts = (roster = ROSTER) => {
  for (const entry of roster) loadPrompt(entry.prompt);
};

/**
 * Parse `provider/model[#variant]` into a V2 model reference.
 *
 * Returns undefined for anything that is not that shape, so a typo in
 * `superagent.json` degrades to "inherit the session model" with a warning
 * instead of an agent OpenCode refuses to load.
 */
export const parseModelRef = (value) => {
  if (value && typeof value === 'object' && value.providerID && (value.id || value.model)) {
    return {
      providerID: value.providerID,
      id: value.id ?? value.model,
      ...(value.variant ? { variant: value.variant } : {}),
    };
  }
  if (typeof value !== 'string') return undefined;
  const [ref, variant] = value.split('#');
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
};

/**
 * Decide the model for a slot.
 *
 * Returns `undefined` when the key should be omitted entirely.
 */
const resolveModel = (slot, models, availableModels) => {
  const configured = models?.[slot];
  if (!configured) return undefined;
  const ref = parseModelRef(configured);
  if (!ref) {
    warn(
      `model "${configured}" for slot "${slot}" is not in provider/model form; ` +
        'the agent will inherit the session model instead',
    );
    return undefined;
  }
  const key = `${ref.providerID}/${ref.id}`;
  if (availableModels && availableModels.size && !availableModels.has(key)) {
    warn(
      `model "${configured}" for slot "${slot}" is not available from any configured provider; ` +
        'the agent will inherit the session model instead',
    );
    return undefined;
  }
  return ref;
};

/** Write one agent definition onto a fresh editor entry. */
export const defineAgent = (editor, name, { description, mode, system, permissions, model }) => {
  editor.update(name, (agent) => {
    agent.description = description;
    agent.mode = mode;
    agent.system = system;
    // Appended after OpenCode's defaults (allow everything, ask for `.env`),
    // so these narrow them under last-match.
    agent.permissions.push(...permissions);
    if (model) agent.model = model;
  });
};

/**
 * Register the roster onto an agent editor.
 *
 * Returns `{ registered, conflicts, temperatures }`: the agents actually
 * registered (what the routing table is rendered from), the names skipped
 * because they were taken, and the per-agent temperature the session hook
 * applies — V2 agents have no temperature field of their own.
 */
export const registerAgents = (
  editor,
  settings,
  { availableModels, defaultAgentConfigured = false } = {},
) => {
  const result = { registered: [], conflicts: [], temperatures: {} };
  if (!editor || settings?.agents?.enabled === false) return result;

  const { prefix = '', disable = [], models, temperature, permissionOverrides } = settings.agents;
  let orchestrator = null;

  for (const entry of ROSTER) {
    if (disable.includes(entry.key)) {
      debug(`skipping ${entry.key}: disabled by config`);
      continue;
    }

    const name = `${prefix}${entry.key}`;

    if (editor.get(name) !== undefined) {
      result.conflicts.push({ kind: 'agent', name });
      continue;
    }

    const prompt = loadPrompt(entry.prompt);
    if (!prompt) continue;

    defineAgent(editor, name, {
      description: entry.description,
      mode: entry.mode,
      system: prompt,
      permissions: mergeRules(entry.permission, permissionOverrides?.[entry.key]),
      model: resolveModel(entry.slot, models, availableModels),
    });

    const temp = temperature?.[entry.slot];
    if (typeof temp === 'number') result.temperatures[name] = temp;

    result.registered.push({ ...entry, name });
    if (entry.orchestrator) orchestrator = name;
  }

  // OpenCode falls back to `build` when the default names something that does
  // not exist, but selecting an agent we did not register would still be a
  // lie about what the session is running.
  if (orchestrator && settings.agents.setDefaultAgent && !defaultAgentConfigured) {
    editor.default(orchestrator);
    debug(`set default agent to ${orchestrator}`);
  }

  debug(`registered ${result.registered.length} agents`);
  return result;
};

/** Log each conflict once per process, not once per transform replay. */
const warned = new Set();
export const warnConflicts = (conflicts) => {
  for (const conflict of conflicts) {
    const key = `${conflict.kind}:${conflict.name}`;
    if (warned.has(key)) continue;
    warned.add(key);
    warn(
      conflict.kind === 'command'
        ? `a command named "/${conflict.name}" already exists; leaving it alone`
        : `an agent named "${conflict.name}" already exists; leaving it alone. ` +
            'Set agents.prefix in superagent.json to register the Superagent roster alongside it.',
    );
  }
};
