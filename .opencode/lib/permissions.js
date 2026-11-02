/**
 * Permissions, in OpenCode V2's shape.
 *
 * V2 agents carry an ordered list of `{ action, resource, effect }` rules, and
 * the last matching rule wins. The roster is easier to read — and to override
 * from `superagent.json` — as the V1 map it has always been written in
 * (`{ edit: 'deny', subagent: 'deny' }`, or a nested `{ pattern: effect }`
 * map), so the map stays the authoring format and this module lowers it.
 *
 * V1 action names are accepted and renamed, because users' existing
 * `permissionOverrides` were written against them: `task` became the
 * `subagent` tool, and `bash` became `shell`. `write` and `patch` are covered
 * by V2's `edit` action already, so they are folded into it.
 *
 * Rules are emitted broad-first: a nested map's `*` pattern always comes
 * before its narrower patterns, so the narrow ones win under last-match.
 */

/** V1 action name → V2 action name. */
const RENAMED_ACTIONS = {
  task: 'subagent',
  bash: 'shell',
  write: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  list: 'read',
};

const EFFECTS = new Set(['allow', 'ask', 'deny']);

export const normalizeAction = (action) => RENAMED_ACTIONS[action] ?? action;

/** Is this already a V2 rule list? */
const isRuleList = (value) =>
  Array.isArray(value) &&
  value.every((rule) => rule && typeof rule.action === 'string' && EFFECTS.has(rule.effect));

/**
 * Lower a permission map (or an already-V2 rule list) to V2 rules.
 *
 * Unknown effects are dropped rather than passed through: OpenCode would
 * reject the whole agent over one bad rule, and a typo in an override must not
 * be able to unregister the agent it was meant to tune.
 */
export const toRules = (permission) => {
  if (!permission) return [];
  if (isRuleList(permission)) {
    return permission.map((rule) => ({
      action: normalizeAction(rule.action),
      resource: typeof rule.resource === 'string' ? rule.resource : '*',
      effect: rule.effect,
    }));
  }
  if (typeof permission !== 'object' || Array.isArray(permission)) return [];

  const rules = [];
  for (const [rawAction, value] of Object.entries(permission)) {
    const action = normalizeAction(rawAction);
    if (typeof value === 'string') {
      if (EFFECTS.has(value)) rules.push({ action, resource: '*', effect: value });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const entries = Object.entries(value).filter(([, effect]) => EFFECTS.has(effect));
    // Broad first, so the specific patterns win under last-match.
    entries.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : 0));
    for (const [resource, effect] of entries) rules.push({ action, resource, effect });
  }
  return rules;
};

/** Roster permissions followed by the user's overrides, so the overrides win. */
export const mergeRules = (...permissions) => permissions.flatMap((p) => toRules(p));
