import { renderPanel } from '../../core/panel.js';
import { boardSnapshots, restoreBoardState } from '../../core/board.js';
import { version } from './adapter.js';

/** Text surface for the shared panel. Native Codex has no plugin pane API. */
export function renderTextPanel({
  state,
  sessionID,
  settings,
  adapter,
  width = 60,
  now = Date.now(),
  expanded = false,
  update,
}) {
  restoreBoardState(state.boards);
  const rows = boardSnapshots()[sessionID]?.records ?? [];
  const activity = state.activity[sessionID];
  const h = {
    text: (_props, children) => ({ lines: [children.map(String).join('')] }),
    box: (props, children) => {
      if (props.flexDirection === 'row') {
        const parts = children.map((c) => c.lines ?? [String(c)]);
        const height = Math.max(0, ...parts.map((p) => p.length));
        return {
          lines: Array.from({ length: height }, (_, i) => {
            const cells = parts.map((p) => p[i] ?? '');
            if (props.justifyContent === 'space-between' && cells.length === 2)
              return (
                cells[0] +
                ' '.repeat(Math.max(1, width - cells[0].length - cells[1].length)) +
                cells[1]
              );
            return cells.join('');
          }),
        };
      }
      return { lines: children.flatMap((c) => c.lines ?? [String(c)]) };
    },
  };
  const tree = renderPanel(
    {
      version,
      preset: settings.preset,
      width,
      now,
      agents: adapter.registered,
      agentsExpanded: expanded,
      subsystems: {
        agents: settings.agents.enabled,
        board: settings.board.enabled,
        council: settings.council.enabled,
      },
      records: rows,
      children: rows
        .filter((r) => r.childSessionID)
        .map((r) => ({
          id: r.childSessionID,
          agent: r.agent,
          title: r.objective,
          state: r.state,
          current: state.activity[r.childSessionID]?.tool,
        })),
      main: activity
        ? {
            state: 'running',
            current: activity.tool,
            since: activity.startedAt,
            skill: state.sessions[sessionID]?.skill,
          }
        : null,
      plan: state.sessions[sessionID]?.plan,
      updateAvailable: update?.updateAvailable,
      latestVersion: update?.latestVersion,
      hostNotice: 'Text view; native Codex pane unavailable',
    },
    h,
  );
  return (tree.lines ?? []).join('\n');
}
