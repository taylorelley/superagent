/**
 * What the agents are doing right now, derived from the host's session data.
 *
 * ## Why this lives on the TUI side
 *
 * The TUI plugin context carries OpenCode's own reactive session store:
 * `context.data.session.get/family/status/message.list`. Every tool call a
 * session makes — the main agent's and each subagent's — is already in there,
 * as `{ type: 'tool', name, state: { status, input } }` parts on assistant
 * messages. Reading it here costs nothing and can never disagree with what the
 * host shows, where relaying the same facts through the board snapshot would
 * add a write per tool call and a second copy to keep honest.
 *
 * Confirmed against OpenCode 2.2.5 with a live TUI: a foreground subagent's
 * child session is in its parent's `family`, with `parentID`, `title` (the
 * dispatch description) and `agent`, and its tool calls are visible while the
 * main pane shows only "General Subagent — <description>".
 *
 * A skill loaded through the `skill` tool does not emit
 * `session.skill.activated`; it is only visible as a `skill` tool part, which
 * is why the active skill is read from tool parts.
 *
 * Everything here is a pure function of a small `data` adapter
 * (`{ get, family, status, messages }`), so it is testable in plain Node, and
 * nothing throws: a host that lacks an API gives an empty answer.
 */

import path from 'path';

/** Where `writing-plans` saves plans. */
export const PLAN_PATTERN =
  /(?:^|[\s"'`(/])((?:[^\s"'`()]*\/)?docs\/superagent\/plans\/[^\s"'`()/]+\.md)/;

const LIVE_TOOL_STATES = new Set(['running', 'streaming', 'pending']);

const safe = (fn, fallback) => {
  try {
    const value = fn();
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

/** The `data` adapter for an OpenCode V2 TUI context. */
export const sessionData = (context) => {
  const session = context?.data?.session;
  if (!session) return null;
  return {
    get: (id) => safe(() => session.get?.(id), null),
    family: (id) => safe(() => session.family?.(id), []),
    status: (id) => safe(() => session.status?.(id), null),
    messages: (id) => safe(() => session.message?.list?.(id), []),
  };
};

const toolParts = (message) =>
  Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'tool') : [];

const firstLine = (text) =>
  String(text ?? '')
    .split('\n')
    .find((line) => line.trim()) ?? '';

const base = (value) => (typeof value === 'string' && value ? path.basename(value) : '');

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
      skill: args.id ?? args.name,
    }[name] ??
    file ??
    '';
  const tool = name || 'tool';
  return detail ? `${tool} ${String(detail).trim()}` : tool;
};

/** The latest skill a session loaded, by tool call or by activation message. */
export const activeSkill = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.type === 'skill' && (message.name || message.skill)) {
      return message.name || message.skill;
    }
    const parts = toolParts(message);
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part.name !== 'skill' || part.state?.status === 'error') continue;
      const id = part.state?.input?.id ?? part.state?.input?.name;
      if (typeof id === 'string' && id) return id;
    }
  }
  return null;
};

/**
 * What a session is doing right now: the newest live tool call, or
 * `thinking` while an assistant message is still open with none.
 */
export const currentActivity = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.type !== 'assistant') continue;
    const parts = toolParts(message);
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!LIVE_TOOL_STATES.has(part.state?.status)) continue;
      const input = typeof part.state?.input === 'object' ? part.state.input : {};
      return {
        label: describeTool(part.name, input),
        since: part.time?.created ?? message.time?.created ?? null,
      };
    }
    if (!message.time?.completed) {
      return { label: 'thinking', since: message.time?.created ?? null };
    }
    return null;
  }
  return null;
};

/**
 * What a running session is doing. Between tool calls — the model is
 * generating, and the next assistant message may not exist yet — the answer
 * is `thinking`, timed from the newest message, never a blank line.
 */
const runningActivity = (messages) => {
  const current = currentActivity(messages);
  if (current) return current;
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  return { label: 'thinking', since: last?.time?.completed ?? last?.time?.created ?? null };
};

/** The main agent of `sessionID`: whether it is working, on what, in which skill. */
export const mainActivity = (data, sessionID) => {
  if (!data || !sessionID) return null;
  const messages = data.messages(sessionID);
  const status = data.status(sessionID);
  const running = status === 'running';
  const current = running ? runningActivity(messages) : null;
  return {
    state: running ? 'running' : 'idle',
    skill: activeSkill(messages),
    current: current?.label ?? null,
    since: current?.since ?? null,
  };
};

/** The direct children of `sessionID` — the subagents it dispatched. */
export const childActivities = (data, sessionID) => {
  if (!data || !sessionID) return [];
  const family = data.family(sessionID);
  if (!Array.isArray(family)) return [];
  return family
    .filter((id) => id !== sessionID)
    .map((id) => ({ id, info: data.get(id) }))
    .filter(({ info }) => info?.parentID === sessionID)
    .map(({ id, info }) => {
      const running = data.status(id) === 'running';
      const current = running ? runningActivity(data.messages(id)) : null;
      return {
        id,
        agent: info.agent ?? null,
        title: info.title ?? null,
        state: running ? 'running' : 'idle',
        current: current?.label ?? null,
        since: current?.since ?? null,
      };
    });
};

/**
 * The plan a session is working from: the newest `docs/superagent/plans/*.md`
 * path that appears in any of its tool inputs (written by `writing-plans`,
 * read back, or named in a subagent's prompt).
 */
export const findPlanPath = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const parts = toolParts(list[i]);
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const input = parts[j].state?.input;
      if (!input || typeof input !== 'object') continue;
      for (const value of Object.values(input)) {
        if (typeof value !== 'string') continue;
        const match = ` ${value}`.match(PLAN_PATTERN);
        if (match) return match[1];
      }
    }
  }
  return null;
};

/**
 * The plan behind `sessionID`'s work: named in its own tool calls, or written
 * or read by one of its subagents. Under the `team` preset the orchestrator
 * may not edit files at all (OpenCode denies it), so the plan is typically
 * written by a child — searching only the main session would miss it.
 */
export const sessionPlanPath = (data, sessionID) => {
  if (!data || !sessionID) return null;
  const own = findPlanPath(data.messages(sessionID));
  if (own) return own;
  const family = data.family(sessionID);
  if (!Array.isArray(family)) return null;
  for (let i = family.length - 1; i >= 0; i -= 1) {
    const id = family[i];
    if (id === sessionID || data.get(id)?.parentID !== sessionID) continue;
    const found = findPlanPath(data.messages(id));
    if (found) return found;
  }
  return null;
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
