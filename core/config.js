/**
 * Superagent configuration: defaults, layering, and validation. Shared by both
 * hosts; each host finds and reads its own files and hands the parsed layers
 * to `resolveSettings`.
 *
 * Layers, later winning:
 *   1. DEFAULTS below
 *   2. the active preset
 *   3. the user file     (OpenCode: ${OPENCODE_CONFIG_DIR:-~/.config/opencode}/superagent.json;
 *                         Claude Code: ${CLAUDE_CONFIG_DIR:-~/.claude}/superagent.json)
 *   4. the project file  (OpenCode: <project>/.opencode/superagent.json;
 *                         Claude Code: <project>/.claude/superagent.json)
 *   5. the state file written by `/preset --persist`
 *   6. environment overrides
 *
 * Resolution is two-pass, because the preset name is itself configurable: the
 * layers are merged once to find out which preset is wanted, then merged again
 * on top of that preset so an explicit user setting still beats it.
 *
 * Nothing here throws. A malformed config file must degrade to defaults with
 * a warning rather than leave the plugin silently inert.
 */

import { stripJsonc, deepMerge } from './parse.js';
import { resolvePreset, DEFAULT_PRESET } from './presets.js';
import { warn, debug } from './log.js';

export const CONFIG_BASENAME = 'superagent';

export const DEFAULTS = {
  version: 1,

  /** Which preset to start from. */
  preset: DEFAULT_PRESET,

  agents: {
    /** Register the specialist roster at all. */
    enabled: true,
    /**
     * Prefix for every registered agent name. Empty by default — the names are
     * meant to be typed. Set this if one collides with an agent you already
     * have; see the collision note in `agents.js`.
     */
    prefix: '',
    /** Roster keys to skip entirely. */
    disable: [],
    /** Make the orchestrator OpenCode's default agent. */
    setDefaultAgent: true,
    /**
     * Model per slot. `null` means "inherit the session model", which is what
     * OpenCode does when an agent has no model pinned. Slot names come from
     * `roster.js`.
     */
    models: {
      orchestrator: null,
      implementer: null,
      implementerDeep: null,
      reviewer: null,
      deepReviewer: null,
      docReviewer: null,
      oracle: null,
      librarian: null,
    },
    /**
     * Temperature per slot. Only judgment roles are pinned: a reviewer that
     * samples creatively is a reviewer that invents findings. Implementers are
     * left unset so they follow the model's own default.
     */
    temperature: {
      reviewer: 0.1,
      deepReviewer: 0.1,
      docReviewer: 0.1,
      oracle: 0.1,
    },
    /** Per-agent permission overrides, merged over the roster's own. */
    permissionOverrides: {},
  },

  council: {
    enabled: false,
    /**
     * Empty by default. A council is only useful when its members run
     * different models, and Superagent cannot guess which models a user has
     * authenticated. See `docs/superagent.md` for the shape.
     */
    members: [],
    minParticipants: 2,
  },

  board: {
    enabled: true,
    /**
     * `latest` replaces the previous snapshot each turn; `checkpoint` appends
     * only when the board changed. `latest` keeps context small but rewrites
     * history, which defeats prompt caching.
     */
    strategy: 'latest',
    maxRetainedSnapshots: 3,
    persist: true,
    /** `warn` annotates a conflicting dispatch; `off` records without acting. */
    enforceOwnership: 'warn',
  },

  bootstrap: { enabled: true },

  tui: {
    /**
     * Render the Superagent panel: OpenCode's TUI sidebar, or a pane beside
     * Claude Code's transcript. See docs/superagent.md and docs/claude-code.md.
     */
    enabled: true,
    /** Render the full roster instead of the collapsed summary. */
    agents: { expanded: false },
  },

  updateCheck: {
    /**
     * Ask GitHub once per session start whether a newer Superagent exists.
     * Only ever asks "is there a newer version" — nothing about the user or
     * their project is sent. See docs/superagent.md.
     */
    enabled: true,
    /** Hours between checks; a cached result inside this window is reused. */
    intervalHours: 24,
  },
};

const VALID = {
  'board.strategy': ['latest', 'checkpoint'],
  'board.enforceOwnership': ['warn', 'off'],
};

/**
 * Parse the text of a JSON/JSONC config file, returning null and warning when
 * it is broken. `label` names the file in the warning.
 *
 * A root that parses but is not an object — `null`, an array, a bare number —
 * is rejected here rather than merged, since merging it would replace the whole
 * configuration with something that has no sections at all.
 */
export const parseConfigText = (text, label = 'config') => {
  try {
    const parsed = JSON.parse(stripJsonc(String(text)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`ignoring ${label}: expected a JSON object at the top level`);
      return null;
    }
    return parsed;
  } catch (err) {
    warn(`ignoring ${label}: ${err.message}`);
    return null;
  }
};

/** Environment overrides, applied last so they win over every file. */
export const envOverrides = (env = {}) => {
  const vars = env ?? {};
  const out = {};
  if (vars.SUPERAGENT_PRESET) out.preset = vars.SUPERAGENT_PRESET;
  if (vars.SUPERAGENT_DISABLE === '1' || vars.SUPERAGENT_DISABLE === 'true') {
    out.agents = { enabled: false };
    out.board = { enabled: false };
    out.tui = { enabled: false };
    out.updateCheck = { enabled: false };
  }
  return out;
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Clamp values that would otherwise fail obscurely later.
 *
 * The section restoration is load-bearing, not defensive noise. `deepMerge`
 * faithfully carries a `"council": null` from a user's file, and this function
 * then used to dereference it — a `TypeError` thrown from `loadConfig`, which
 * runs at plugin construction *before* any hook is wrapped in `guardHook`, so
 * nothing catches it and the plugin never registers anything. A config file
 * that is valid JSON must never be able to do that.
 */
const validate = (config) => {
  for (const section of ['agents', 'council', 'board', 'bootstrap', 'tui', 'updateCheck']) {
    if (!isObject(config[section])) {
      if (config[section] !== undefined) {
        warn(`${section}: expected an object, ignoring and using defaults`);
      }
      config[section] = { ...DEFAULTS[section] };
    }
  }

  for (const [dotted, allowed] of Object.entries(VALID)) {
    const [group, key] = dotted.split('.');
    const value = config[group][key];
    if (value !== undefined && !allowed.includes(value)) {
      warn(`${dotted}: "${value}" is not one of ${allowed.join(', ')}; using "${allowed[0]}"`);
      config[group][key] = allowed[0];
    }
  }

  if (!Array.isArray(config.council.members)) config.council.members = [];
  if (!Array.isArray(config.agents.disable)) config.agents.disable = [];
  if (!isObject(config.agents.models)) config.agents.models = { ...DEFAULTS.agents.models };
  if (!isObject(config.agents.temperature))
    config.agents.temperature = { ...DEFAULTS.agents.temperature };
  if (!isObject(config.tui.agents)) config.tui.agents = { ...DEFAULTS.tui.agents };
  if (
    typeof config.updateCheck.intervalHours !== 'number' ||
    !(config.updateCheck.intervalHours >= 0)
  ) {
    config.updateCheck.intervalHours = DEFAULTS.updateCheck.intervalHours;
  }
  return config;
};

/**
 * Resolve the effective configuration from already-parsed layers.
 *
 * `userFile`, `projectFile` and `stateFile` are parsed objects or null; `env`
 * is the environment to read overrides from (a plain object of strings).
 */
export const resolveSettings = ({
  userFile = null,
  projectFile = null,
  stateFile = null,
  env = {},
} = {}) => {
  const envConfig = envOverrides(env);
  const withoutPreset = [userFile, projectFile, stateFile, envConfig]
    .filter(Boolean)
    .reduce((acc, layer) => deepMerge(acc, layer), DEFAULTS);

  const userPresets = deepMerge(userFile?.presets ?? {}, projectFile?.presets ?? {});
  const preset = resolvePreset(withoutPreset.preset, userPresets);
  if (!preset.known) {
    warn(
      `unknown preset "${preset.name}"; using "${DEFAULT_PRESET}". ` +
        `Known presets: ${Object.keys({ ...userPresets })
          .concat(['solo', 'team', 'council'])
          .sort()
          .join(', ')}`,
    );
  }

  const resolved = [
    preset.known ? preset.body : resolvePreset(DEFAULT_PRESET).body,
    userFile,
    projectFile,
    stateFile,
    envConfig,
  ]
    .filter(Boolean)
    .reduce((acc, layer) => deepMerge(acc, layer), DEFAULTS);

  // Validate before touching anything on `resolved`: a section restored here is
  // one that would otherwise be dereferenced while still null.
  const settings = validate(resolved);
  settings.preset = preset.known ? preset.name : DEFAULT_PRESET;
  debug(
    'resolved config',
    JSON.stringify({ preset: settings.preset, agents: settings.agents.enabled }),
  );
  return settings;
};
