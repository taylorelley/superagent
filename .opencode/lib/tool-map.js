/**
 * The single source of truth for the OpenCode tool mapping.
 *
 * Superagent skills are harness-neutral: they speak in actions ("create a
 * todo", "dispatch a subagent") rather than tool names. Each harness supplies
 * the translation. This mapping used to be restated in three places — the
 * plugin, `.opencode/INSTALL.md`, and `docs/README.opencode.md` — which meant
 * three chances to drift. Those documents now carry generated regions rendered
 * from this file, checked by `tests/opencode/test-tool-map-single-source.sh`.
 *
 * Verified against the installed OpenCode CLI's tool inventory.
 */

/**
 * `action` is the vocabulary a skill uses; `tool` is what OpenCode calls it.
 * Order is meaningful — it is the order readers see in every rendering.
 */
export const TOOL_MAPPINGS = [
  { action: 'Create or update todos', tool: '`todowrite`' },
  { action: '`Subagent (general-purpose):`', tool: '`task` with `subagent_type: "general"`' },
  { action: 'Invoke a skill', tool: "OpenCode's native `skill` tool" },
  { action: 'Read files', tool: '`read`' },
  { action: 'Create, edit, or delete files', tool: '`apply_patch`' },
  { action: 'Run shell commands', tool: '`bash`' },
  { action: 'Search files', tool: '`grep`, `glob`' },
  { action: 'Fetch a URL', tool: '`webfetch`' },
];

/** Qualifications that do not fit the two-column shape. */
export const TOOL_MAP_NOTES = [
  'For read-only codebase exploration, prefer `subagent_type: "explore"`.',
  "Use OpenCode's native `skill` tool to list and load skills.",
];

/** The bullet list, shared by the bootstrap and the generated doc regions. */
export const renderToolMapBullets = () =>
  TOOL_MAPPINGS.map(({ action, tool }) => `- ${action} → ${tool}`).join('\n');

/** The block appended to the session bootstrap. */
export const renderBootstrapToolMap = () =>
  [
    '**Tool Mapping for OpenCode:**',
    'When skills request actions, substitute OpenCode equivalents:',
    renderToolMapBullets(),
    '',
    ...TOOL_MAP_NOTES,
  ].join('\n');

/** The block written between the generated markers in the documentation. */
export const renderDocToolMap = () =>
  [renderToolMapBullets(), '', ...TOOL_MAP_NOTES.map((note) => `${note}`)].join('\n');

export const DOC_MARKER_BEGIN =
  '<!-- BEGIN GENERATED TOOL MAP — source: .opencode/lib/tool-map.js -->';
export const DOC_MARKER_END = '<!-- END GENERATED TOOL MAP -->';
