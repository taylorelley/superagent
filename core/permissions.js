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

/**
 * A rule's resource pattern as a regex. Following OpenCode's wildcard, `*`
 * matches any run of characters, separators included, and `?` matches one.
 */
const patternCache = new Map();
const patternToRegExp = (pattern) => {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    const body = String(pattern)
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    compiled = new RegExp(`^${body}$`, 's');
    patternCache.set(pattern, compiled);
  }
  return compiled;
};

/**
 * The effect the rules give `action` on `resource`, or undefined when no rule
 * matches (the host's own default then applies). Last match wins, as in
 * OpenCode V2. `resource` may be several candidates — a path both relative and
 * absolute, say — and a rule matches when any of them does.
 */
export const evaluate = (rules, action, resource) => {
  const candidates = (Array.isArray(resource) ? resource : [resource]).filter(
    (r) => typeof r === 'string',
  );
  let effect;
  for (const rule of rules ?? []) {
    const ruleAction = normalizeAction(rule.action);
    if (ruleAction !== '*' && ruleAction !== action) continue;
    const re = patternToRegExp(rule.resource ?? '*');
    if (rule.resource === '*' || candidates.some((c) => re.test(c))) effect = rule.effect;
  }
  return effect;
};

/**
 * Actions the rules remove outright: the last rule matching the action (its
 * own, or a `*` rule) denies resource `*`. OpenCode hides such a tool from the
 * agent rather than prompting for it, and a host that can withhold a tool
 * should do the same. `actions` names candidates the rules may only reach
 * through `*`; the actions the rules name themselves are always considered.
 */
export const hiddenActions = (rules, actions = []) => {
  const named = (rules ?? []).map((rule) => normalizeAction(rule.action)).filter((a) => a !== '*');
  return [...new Set([...actions, ...named])].filter((action) => {
    const last = (rules ?? []).findLast((rule) => {
      const ruleAction = normalizeAction(rule.action);
      return ruleAction === '*' || ruleAction === action;
    });
    return last?.resource === '*' && last.effect === 'deny';
  });
};
