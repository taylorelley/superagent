/**
 * Superagent configuration: defaults, layering, and validation.
 *
 * Layers, later winning:
 *   1. DEFAULTS below
 *   2. the active preset
 *   3. user   ${OPENCODE_CONFIG_DIR:-~/.config/opencode}/superagent.json[c]
 *   4. project <directory>/.opencode/superagent.json[c]
 *   5. environment overrides
 *
 * Resolution is two-pass, because the preset name is itself configurable: the
 * files are merged once to find out which preset is wanted, then merged again
 * on top of that preset so an explicit user setting still beats it.
 *
 * Nothing here throws. OpenCode swallows a throw from the config hook, so a
 * malformed config file must degrade to defaults with a warning rather than
 * leave the plugin silently inert.
 */

import fs from 'fs';
import path from 'path';
import { stripJsonc, deepMerge } from './fs-utils.js';
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
     * Render the Superagent panel into OpenCode's TUI sidebar.
     *
     * The panel is a second entry point (`exports["./tui"]`) that OpenCode
     * loads from `tui.json` rather than `opencode.json`, so this setting only
     * does anything for a user who registered it there. See docs/superagent.md.
     */
    enabled: true,
  },
};

const VALID = {
  'board.strategy': ['latest', 'checkpoint'],
  'board.enforceOwnership': ['warn', 'off'],
};

/**
 * Read a JSON/JSONC file, returning null when absent and warning when broken.
 *
 * A root that parses but is not an object — `null`, an array, a bare number —
 * is rejected here rather than merged, since merging it would replace the whole
 * configuration with something that has no sections at all.
 */
export const readConfigFile = (filePath) => {
  for (const candidate of [filePath, `${filePath}c`]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(stripJsonc(fs.readFileSync(candidate, 'utf8')));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warn(`ignoring ${candidate}: expected a JSON object at the top level`);
        return null;
      }
      return parsed;
    } catch (err) {
      warn(`ignoring ${candidate}: ${err.message}`);
      return null;
    }
  }
  return null;
};

/** Environment overrides, applied last so they win over every file. */
export const envOverrides = (env = process.env) => {
  const out = {};
  if (env.SUPERAGENT_PRESET) out.preset = env.SUPERAGENT_PRESET;
  if (env.SUPERAGENT_DISABLE === '1' || env.SUPERAGENT_DISABLE === 'true') {
    out.agents = { enabled: false };
    out.board = { enabled: false };
    out.tui = { enabled: false };
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
  for (const section of ['agents', 'council', 'board', 'bootstrap', 'tui']) {
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
  if (!isObject(config.agents.temperature)) config.agents.temperature = { ...DEFAULTS.agents.temperature };
  return config;
};

/**
 * Resolve the effective configuration.
 *
 * `configDir` is OpenCode's user config directory; `projectDir` is the
 * directory OpenCode was opened in.
 */
export const stateFilePath = (configDir) => path.join(configDir, `${CONFIG_BASENAME}.state.json`);

export const loadConfig = ({ configDir, projectDir, env = process.env } = {}) => {
  const userFile = configDir ? readConfigFile(path.join(configDir, `${CONFIG_BASENAME}.json`)) : null;
  const projectFile = projectDir
    ? readConfigFile(path.join(projectDir, '.opencode', `${CONFIG_BASENAME}.json`))
    : null;
  // Written by `/preset <name> --persist`. Kept separate from the user's own
  // file so persisting a choice never rewrites their hand-edited config.
  const stateFile = configDir ? readConfigFile(stateFilePath(configDir)) : null;
  const envConfig = envOverrides(env);

  const withoutPreset = [userFile, projectFile, stateFile, envConfig]
    .filter(Boolean)
    .reduce((acc, layer) => deepMerge(acc, layer), DEFAULTS);

  const userPresets = deepMerge(userFile?.presets ?? {}, projectFile?.presets ?? {});
  const preset = resolvePreset(withoutPreset.preset, userPresets);
  if (!preset.known) {
    warn(
      `unknown preset "${preset.name}"; using "${DEFAULT_PRESET}". ` +
        `Known presets: ${Object.keys({ ...userPresets }).concat(['solo', 'team', 'council']).sort().join(', ')}`
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
  debug('resolved config', JSON.stringify({ preset: settings.preset, agents: settings.agents.enabled }));
  return settings;
};
