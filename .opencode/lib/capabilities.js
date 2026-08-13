/**
 * What this OpenCode session can actually do.
 *
 * Feature detection rather than assumption: the same plugin runs against
 * OpenCode builds with different flags, and telling an orchestrator to use a
 * capability that is not there wastes a turn on a rejected tool call.
 */

/**
 * Whether `task(background: true)` is available.
 *
 * Gated behind an experimental flag on OpenCode's side. A plugin cannot turn it
 * on — the `shell.env` hook only affects shells the session spawns, not the
 * process's own flags — so the user must launch with
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode`.
 *
 * Note that when it is off, OpenCode strips `background` from the task tool's
 * JSON schema entirely, so the model cannot pass it by accident. Nothing needs
 * to defend against that; this flag only decides which advice the routing table
 * gives.
 */
export const backgroundSubagentsAvailable = (env = process.env) => {
  const raw = env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
  return raw === '1' || raw === 'true';
};
