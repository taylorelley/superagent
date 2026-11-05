import path from 'node:path';
import fs from 'node:fs';
import { evaluate, hiddenActions } from '../../core/permissions.js';

const ACTIONS = {
  apply_patch: 'edit',
  patch: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  bash: 'shell',
  powershell: 'shell',
  read: 'read',
  grep: 'read',
  glob: 'read',
  agent: 'subagent',
  task: 'subagent',
  webfetch: 'webfetch',
  websearch: 'websearch',
  todowrite: 'todowrite',
  edit: 'edit',
  write: 'edit',
  spawn_agent: 'subagent',
  exec_command: 'shell',
  shell_command: 'shell',
  shell: 'shell',
  write_stdin: 'shell',
  read_file: 'read',
  list_dir: 'read',
  grep_files: 'read',
  web_search: 'websearch',
  update_plan: 'todowrite',
  send_input: 'subagent',
  send_message: 'subagent',
  followup_task: 'subagent',
  resume_agent: 'subagent',
  close_agent: 'subagent',
};
export const toolAction = (name) =>
  ACTIONS[String(name).split(/[.:/]/).pop().toLowerCase()] ?? null;
const resolvedTarget = (file) => {
  const suffix = [];
  let candidate = file;
  for (;;) {
    try {
      return path.join(fs.realpathSync(candidate), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
};
export function checkTool(rules, name, input, cwd) {
  const action = toolAction(name);
  if (!action) {
    // Code-mode executors can invoke arbitrary nested tools. They cannot bypass
    // a role guard that has no visibility into those nested calls.
    const restricted = rules.some((r) => r.effect !== 'allow');
    if (
      restricted &&
      /^(exec|python|javascript|run_code)$/.test(String(name).split(/[.:/]/).pop())
    ) {
      return { effect: 'deny', reason: 'Code-mode execution cannot enforce this role policy' };
    }
    return { effect: evaluate(rules, String(name), '*') };
  }
  let resources = ['*'];
  if (action === 'edit') {
    const patch = typeof input === 'string' ? input : (input?.patch ?? input?.input ?? '');
    if (typeof patch !== 'string') return { effect: 'deny', reason: 'Cannot parse edited paths' };
    resources = [
      ...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm),
    ].map((m) => m[1]);
    if (!resources.length && typeof input === 'object')
      resources = [
        input?.path ?? input?.file_path ?? input?.filePath ?? input?.notebook_path,
      ].filter((value) => typeof value === 'string');
    if (!resources.length) return { effect: 'deny', reason: 'Cannot determine every edited path' };
  } else if (action === 'shell') resources = [input?.cmd ?? input?.command ?? '*'];
  const effects = resources.flatMap((resource) => {
    if (action !== 'edit') return evaluate(rules, action, resource);
    try {
      const absolute = path.resolve(cwd, resource);
      const canonical = resolvedTarget(absolute);
      const root = resolvedTarget(path.resolve(cwd));
      return [
        evaluate(rules, action, [
          absolute.replaceAll('\\', '/'),
          path.relative(cwd, absolute).replaceAll('\\', '/'),
        ]),
        evaluate(rules, action, [
          canonical.replaceAll('\\', '/'),
          path.relative(root, canonical).replaceAll('\\', '/'),
        ]),
      ];
    } catch {
      return ['deny'];
    }
  });
  const effect = effects.includes('deny')
    ? 'deny'
    : effects.includes('ask')
      ? 'ask'
      : effects.includes('allow')
        ? 'allow'
        : undefined;
  return {
    effect,
    action,
    reason: effect ? `Superagent role policy: ${effect} ${action}` : undefined,
  };
}
export const withheldActions = (rules) =>
  hiddenActions(rules, [...new Set(Object.values(ACTIONS))]);
