import { ROSTER } from '../../core/roster.js';
import { mergeRules } from '../../core/permissions.js';
import { composePrompt, promptPath, safeName } from '../../claude-code/lib/roster.js';
import { COUNCILLOR_PERMISSION, councillorPrompt, usableMembers } from '../../core/council.js';

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function toCodexModel(value) {
  if (value == null || value === '' || value === 'inherit') return {};
  const raw = typeof value === 'object' ? (value.id ?? value.model) : value;
  if (typeof raw !== 'string' || !raw.trim()) return { warning: 'Expected a model id' };
  const [ref, hash] = raw.trim().split('#');
  const variant = (typeof value === 'object' ? value.variant : null) ?? hash;
  if (variant && !EFFORTS.has(variant))
    return { warning: `Unsupported reasoning effort: ${variant}` };
  if (!ref || ref.startsWith('/') || ref.endsWith('/'))
    return { warning: 'Expected a non-empty provider/model reference' };
  if (ref === 'inherit') return variant ? { model_reasoning_effort: variant } : {};
  const slash = ref.indexOf('/');
  return {
    model: slash < 0 ? ref : ref.slice(slash + 1),
    ...(slash < 0 ? {} : { model_provider: ref.slice(0, slash) }),
    ...(variant ? { model_reasoning_effort: variant } : {}),
  };
}
export function buildRoster(settings, prompts, existing = new Set()) {
  const names = new Set(existing);
  const result = { registered: [], specialists: [], orchestrator: null, warnings: [] };
  if (!settings.agents.enabled) return result;
  const add = (entry, prompt, model) => {
    const name = safeName(`superagent-${settings.agents.prefix}${entry.key}`);
    if (names.has(name)) {
      result.warnings.push(`Agent ${name} already exists; keeping yours`);
      return;
    }
    const routed = toCodexModel(model);
    if (routed.warning) result.warnings.push(`${name}: ${routed.warning}; inheriting model`);
    const role = {
      ...entry,
      name,
      prompt,
      rules: mergeRules(entry.permission, settings.agents.permissionOverrides?.[entry.key]),
      config: routed.warning ? {} : routed,
    };
    names.add(name);
    result.registered.push(role);
    if (entry.orchestrator) result.orchestrator = role;
    else result.specialists.push(role);
  };
  for (const entry of ROSTER) {
    if (settings.agents.disable.includes(entry.key)) continue;
    try {
      const text = prompts[promptPath(entry.prompt)];
      if (typeof text !== 'string') throw new Error(`Missing ${promptPath(entry.prompt)}`);
      add(entry, composePrompt(entry.prompt, text), settings.agents.models[entry.slot]);
    } catch (error) {
      result.warnings.push(error.message);
    }
  }
  const distinct = new Map();
  for (const member of usableMembers(settings.council)) {
    const routed = toCodexModel(member.model);
    if (routed.warning || !routed.model) {
      result.warnings.push(`Council member ${member.name} has no usable model`);
      continue;
    }
    const provider = routed.model_provider ?? 'default';
    const id = `${provider}/${routed.model}`;
    const providers = distinct.get(routed.model) ?? new Set();
    if (
      providers.has(provider) ||
      providers.has('default') ||
      (provider === 'default' && providers.size)
    ) {
      result.warnings.push(`Council member ${member.name} duplicates ${id}`);
      continue;
    }
    providers.add(provider);
    distinct.set(routed.model, providers);
    add(
      {
        key: `councillor-${member.name}`,
        mode: 'subagent',
        description: `Council member ${member.name}`,
        permission: COUNCILLOR_PERMISSION,
      },
      councillorPrompt(member),
      member.model,
    );
  }
  return result;
}
