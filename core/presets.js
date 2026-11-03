/**
 * Shipped presets.
 *
 * A preset is a named partial config, merged between the built-in defaults and
 * the user's own file. Users add their own under `presets` in
 * `superagent.json`.
 *
 * There is deliberately no "frugal" or "quality" preset here. A preset that
 * routes slots to cheaper or stronger models has to name real model IDs, and
 * the right IDs depend on which providers the user has authenticated. Shipping
 * `anthropic/...` would break every OpenAI user and vice versa. So the shipped
 * presets differ only in which parts of the layer are switched on, and model
 * routing is documented as something you write for your own providers — see
 * `docs/superagent.md`.
 */

export const SHIPPED_PRESETS = {
  /**
   * The layer off. Bootstrap and skill registration only — byte-for-byte the
   * behaviour of the plugin before Superagent existed. This is the escape
   * hatch referenced by the opt-out documentation.
   */
  solo: {
    agents: { enabled: false },
    board: { enabled: false },
  },

  /**
   * The default. Full roster, job board on, every model slot inheriting the
   * session model until the user routes them.
   */
  team: {
    agents: { enabled: true },
    board: { enabled: true },
  },

  /**
   * Team plus a council. Councillors still need distinct models configured to
   * be worth anything — three councillors on one model is three copies of the
   * same opinion — so this preset only turns the machinery on.
   */
  council: {
    agents: { enabled: true },
    board: { enabled: true },
    council: { enabled: true },
  },
};

export const DEFAULT_PRESET = 'team';

export const listPresets = (config) =>
  Object.keys({ ...SHIPPED_PRESETS, ...(config?.presets ?? {}) }).sort();

/** Look up a preset by name across shipped and user-defined ones. */
export const resolvePreset = (name, userPresets = {}) => {
  if (!name) return { name: DEFAULT_PRESET, body: SHIPPED_PRESETS[DEFAULT_PRESET], known: true };
  const body = userPresets[name] ?? SHIPPED_PRESETS[name];
  if (!body) return { name, body: {}, known: false };
  return { name, body, known: true };
};
