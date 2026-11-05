/**
 * The single source of truth for each host's tool mapping.
 *
 * Superagent skills are harness-neutral: they speak in actions ("create a
 * todo", "dispatch a subagent") rather than tool names. Each host supplies
 * the translation, and this module holds both. Generated regions in
 * `.opencode/INSTALL.md` and `docs/claude-code.md` are rendered from here and
 * checked by `tests/opencode/test-tool-map-single-source.sh`.
 *
 * OpenCode: verified against the V2 tool inventory (opencode 2.2.5).
 * Claude Code: verified against the built-in tool inventory of Claude Code
 * 2.1.317 (`.claude-plugin/types/claude-code-tools`).
 */

export const HOSTS = ['opencode', 'claude', 'codex'];

/**
 * `action` is the vocabulary a skill uses; `tool` is what the host calls it.
 * Order is meaningful — it is the order readers see in every rendering.
 */
export const TOOL_MAPS = {
  codex: {
    title: 'Codex',
    mappings: [
      { action: 'Create or update todos', tool: '`update_plan`' },
      {
        action: '`Subagent (general-purpose):`',
        tool: '`spawn_agent` with `agent_type` and `fork_context: false`',
      },
      { action: 'Invoke a skill', tool: 'Read its `SKILL.md` from the installed plugin' },
      { action: 'Read files', tool: '`exec_command` with a read-only command' },
      { action: 'Create, edit, or delete files', tool: '`apply_patch`' },
      { action: 'Run shell commands', tool: '`exec_command`' },
      { action: 'Search files', tool: '`exec_command` with `rg`' },
      { action: 'Fetch a URL', tool: 'the available web tool or an approved fetch command' },
    ],
    notes: [
      'Tools may be namespaced; use the inventory supplied by the host.',
      'Use `send_input` to continue a child and `wait_agent` to await its result.',
      'Spawning is asynchronous; dispatch independent children before waiting.',
    ],
  },
  opencode: {
    title: 'OpenCode',
    mappings: [
      { action: 'Create or update todos', tool: '`todowrite`' },
      { action: '`Subagent (general-purpose):`', tool: '`subagent` with `agent: "general"`' },
      { action: 'Invoke a skill', tool: "OpenCode's native `skill` tool" },
      { action: 'Read files', tool: '`read`' },
      {
        action: 'Create, edit, or delete files',
        tool: '`edit`, `write` (or `patch` where offered)',
      },
      { action: 'Run shell commands', tool: '`shell`' },
      { action: 'Search files', tool: '`grep`, `glob`' },
      { action: 'Fetch a URL', tool: '`webfetch`' },
    ],
    notes: [
      'For read-only codebase exploration, prefer `agent: "explore"`.',
      'To continue a subagent, call `subagent` again with the `sessionID` it returned.',
      "Use OpenCode's native `skill` tool to list and load skills.",
    ],
  },
  claude: {
    title: 'Claude Code',
    mappings: [
      { action: 'Create or update todos', tool: '`TaskCreate`, `TaskUpdate` (or `TodoWrite`)' },
      {
        action: '`Subagent (general-purpose):`',
        tool: '`Agent` with `subagent_type: "general-purpose"`',
      },
      { action: 'Invoke a skill', tool: "Claude Code's `Skill` tool" },
      { action: 'Read files', tool: '`Read`' },
      { action: 'Create, edit, or delete files', tool: '`Edit`, `Write`' },
      { action: 'Run shell commands', tool: '`Bash`' },
      { action: 'Search files', tool: '`Grep`, `Glob`' },
      { action: 'Fetch a URL', tool: '`WebFetch`' },
    ],
    notes: [
      'For read-only codebase exploration, prefer `subagent_type: "Explore"`.',
      'To continue a subagent, send it a `SendMessage` addressed to the agent id it returned.',
      'Superagent skills are named `superagent:<skill>`; load them with the `Skill` tool.',
    ],
  },
};

const mapFor = (host) => TOOL_MAPS[host] ?? TOOL_MAPS.opencode;

/** Every `{ action, tool }` row for a host. */
export const toolMappings = (host = 'opencode') => mapFor(host).mappings;

/** The bullet list, shared by the bootstrap and the generated doc regions. */
export const renderToolMapBullets = (host = 'opencode') =>
  mapFor(host)
    .mappings.map(({ action, tool }) => `- ${action} → ${tool}`)
    .join('\n');

/** The block appended to the session bootstrap. */
export const renderBootstrapToolMap = (host = 'opencode') =>
  [
    `**Tool Mapping for ${mapFor(host).title}:**`,
    `When skills request actions, substitute ${mapFor(host).title} equivalents:`,
    renderToolMapBullets(host),
    '',
    ...mapFor(host).notes,
  ].join('\n');

/** The block written between the generated markers in the documentation. */
export const renderDocToolMap = (host = 'opencode') =>
  [renderToolMapBullets(host), '', ...mapFor(host).notes].join('\n');

/** OpenCode's rows, under the names this module has always exported. */
export const TOOL_MAPPINGS = TOOL_MAPS.opencode.mappings;
export const TOOL_MAP_NOTES = TOOL_MAPS.opencode.notes;

export const DOC_MARKER_BEGIN =
  '<!-- BEGIN GENERATED TOOL MAP — source: .opencode/lib/tool-map.js -->';
export const DOC_MARKER_END = '<!-- END GENERATED TOOL MAP -->';

/** The markers for a host's generated region; OpenCode's are the historical ones. */
export const docMarkers = (host = 'opencode') =>
  host === 'opencode'
    ? { begin: DOC_MARKER_BEGIN, end: DOC_MARKER_END }
    : {
        begin: `<!-- BEGIN GENERATED ${host.toUpperCase()} TOOL MAP — source: core/tool-map.js -->`,
        end: `<!-- END GENERATED ${host.toUpperCase()} TOOL MAP -->`,
      };
