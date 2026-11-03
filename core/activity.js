/**
 * What an agent is doing, as text for a narrow panel: tool calls as a few
 * words, the plan it is working from and how far through it is, and elapsed
 * time. Shared by OpenCode's sidebar and Claude Code's pane; pure, with no
 * host or Node access.
 */

/** Where `writing-plans` saves plans. */
export const PLAN_PATTERN =
  /(?:^|[\s"'`(/])((?:[^\s"'`()]*\/)?docs\/superagent\/plans\/[^\s"'`()/]+\.md)/;

const firstLine = (text) =>
  String(text ?? '')
    .split('\n')
    .find((line) => line.trim()) ?? '';

/** The last segment of a path, on either separator — `path.basename` without Node. */
const base = (value) =>
  typeof value === 'string' && value ? (value.split(/[\\/]/).filter(Boolean).pop() ?? '') : '';

/**
 * A tool call as a few words: the tool and the one argument that says what it
 * is touching. A column is narrow, so a path is reduced to its basename.
 */
export const describeTool = (name, input) => {
  const args = input && typeof input === 'object' ? input : {};
  const file = base(args.filePath ?? args.file_path ?? args.path);
  const detail =
    {
      edit: file,
      write: file,
      patch: file,
      read: file,
      shell: firstLine(args.command),
      bash: firstLine(args.command),
      glob: args.pattern,
      grep: args.pattern,
      webfetch: args.url,
      websearch: args.query,
      subagent: args.agent,
      task: args.subagent_type ?? args.agent,
      skill: args.id ?? args.name ?? args.skill,
      // Claude Code's names, lowercased for the lookup.
      notebookedit: base(args.notebook_path),
      agent: args.subagent_type,
    }[String(name ?? '').toLowerCase()] ??
    file ??
    '';
  const tool = name || 'tool';
  return detail ? `${tool} ${String(detail).trim()}` : tool;
};

const TASK_HEADING = /^#{2,4}\s+(Task\s+\d+[^\n]*)$/i;
const CHECKBOX = /^\s*[-*]\s+\[( |x|X)\]/;

/**
 * Progress through a `writing-plans` plan: checkboxes ticked out of the total,
 * and the task holding the first unticked one. A plan with no checkboxes still
 * reports its task count, with nothing marked done.
 */
export const planProgress = (text) => {
  const lines = String(text ?? '').split('\n');
  let done = 0;
  let total = 0;
  let heading = null;
  let current = null;
  const tasks = [];
  for (const line of lines) {
    const task = line.match(TASK_HEADING);
    if (task) {
      heading = task[1].trim();
      tasks.push(heading);
      continue;
    }
    const box = line.match(CHECKBOX);
    if (!box) continue;
    total += 1;
    if (box[1] === ' ') {
      if (!current) current = heading;
    } else {
      done += 1;
    }
  }
  if (total === 0) {
    if (!tasks.length) return null;
    return { done: 0, total: tasks.length, current: tasks[0], unit: 'tasks' };
  }
  return { done, total, current, unit: 'steps' };
};

/** `0:42`, `12:05`, `1:02:03`. */
export const formatElapsed = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
