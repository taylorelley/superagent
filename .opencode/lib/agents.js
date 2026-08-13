/**
 * Build `config.agent` entries from the roster.
 *
 * Three behaviours here exist because of how OpenCode assembles agents, all
 * verified in docs/superagent.md:
 *
 * - **Never overwrite an existing key.** By the time the plugin's config hook
 *   runs, `config.agent` already holds whatever the user wrote. Assigning to a
 *   key would silently replace their agent with ours. The roster names are
 *   unprefixed and generic on purpose — they are meant to be typed — so a
 *   collision is plausible, and the user's definition wins.
 *
 * - **Omit `model` rather than compute a fallback.** Agent assembly does
 *   `if (value.model) ...`, and a subagent with no model pinned inherits the
 *   parent's. So an unrouted slot is expressed by leaving the key off, and an
 *   unavailable model is expressed by deleting it — never by substituting some
 *   other model the user did not ask for.
 *
 * - **Only set `default_agent` if the orchestrator was actually registered.**
 *   OpenCode throws at startup when `default_agent` names an agent that does
 *   not exist, so a skipped registration must not leave the setting behind.
 */

import fs from 'fs';
import path from 'path';
import { ROSTER } from './roster.js';
import { opencodeDir, packageRoot } from './paths.js';
import { extractDispatchTemplateFile, composeAgentPrompt } from './prompt-compose.js';
import { warn, debug } from './log.js';

/** Prompts are read once at config time; the transform path must stay I/O free. */
const promptCache = new Map();

export const resetPromptCache = () => promptCache.clear();

const loadPrompt = (spec) => {
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

/**
 * Decide the model for a slot.
 *
 * Returns `undefined` when the key should be omitted entirely.
 */
const resolveModel = (slot, models, availableModels) => {
  const configured = models?.[slot];
  if (!configured) return undefined;
  if (availableModels && availableModels.size && !availableModels.has(configured)) {
    warn(
      `model "${configured}" for slot "${slot}" is not available from any configured provider; ` +
        'the agent will inherit the session model instead'
    );
    return undefined;
  }
  return configured;
};

/**
 * Register the roster onto a live OpenCode config.
 *
 * Mutates `config` and returns the agents that were actually registered, which
 * is what the routing table is rendered from.
 */
export const registerAgents = (config, settings, { availableModels, conflicts } = {}) => {
  if (!config || settings?.agents?.enabled === false) return [];

  const { prefix = '', disable = [], models, temperature, permissionOverrides } = settings.agents;

  config.agent = config.agent || {};
  const registered = [];
  let orchestratorRegistered = false;

  for (const entry of ROSTER) {
    if (disable.includes(entry.key)) {
      debug(`skipping ${entry.key}: disabled by config`);
      continue;
    }

    const name = `${prefix}${entry.key}`;

    if (Object.prototype.hasOwnProperty.call(config.agent, name)) {
      warn(
        `an agent named "${name}" already exists; leaving it alone. ` +
          'Set agents.prefix in superagent.json to register the Superagent roster alongside it.'
      );
      conflicts?.push({ kind: 'agent', name });
      continue;
    }

    const prompt = loadPrompt(entry.prompt);
    if (!prompt) continue;

    const model = resolveModel(entry.slot, models, availableModels);
    const temp = temperature?.[entry.slot];

    config.agent[name] = {
      description: entry.description,
      mode: entry.mode,
      prompt,
      permission: { ...entry.permission, ...(permissionOverrides?.[entry.key] ?? {}) },
      ...(model ? { model } : {}),
      ...(typeof temp === 'number' ? { temperature: temp } : {}),
    };

    registered.push({ ...entry, name });
    if (entry.orchestrator) orchestratorRegistered = true;
  }

  // Only now is it safe: OpenCode throws at startup if default_agent names an
  // agent that does not exist, is a subagent, or is hidden.
  if (orchestratorRegistered && settings.agents.setDefaultAgent && !config.default_agent) {
    const orchestrator = registered.find((entry) => entry.orchestrator);
    config.default_agent = orchestrator.name;
    debug(`set default_agent to ${orchestrator.name}`);
  }

  debug(`registered ${registered.length} agents`);
  return registered;
};
