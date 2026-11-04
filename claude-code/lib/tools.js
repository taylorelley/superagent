/**
 * Tool calls, seen from the roster's permission rules.
 *
 * OpenCode decides an agent's tool calls against an ordered rule list
 * (`{ action, resource, effect }`, last match wins). Claude Code asks plugins
 * at `tool.check`. This module says which rule action and resource a Claude
 * Code tool call is, and what the roster's rules make of it, so the hooks
 * module can answer `tool.check` the way OpenCode would have decided.
 *
 * Only refusals are enforced: `deny` refuses the call and `ask` asks the
 * person. An `allow` never approves anything on the person's behalf — Claude
 * Code's own permission settings still decide those calls, so installing
 * Superagent never widens what runs without asking.
 */

import { evaluate } from '../../core/permissions.js';
import { TOOL_ACTIONS } from './roster.js';

const slash = (p) => String(p).replace(/\\/g, '/');

const isAbsolutePath = (p) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/**
 * Resolve `.` and `..` segments lexically. A leading `/` or `X:/` is kept and
 * never climbed above; a relative path keeps `..` it cannot resolve.
 */
export const collapse = (p) => {
  const drive = /^[A-Za-z]:\//.exec(p);
  const prefix = drive ? drive[0] : p.startsWith('/') ? '/' : '';
  const out = [];
  for (const seg of p.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') out.push(seg);
    else if (out.length && out[out.length - 1] !== '..') out.pop();
    else if (!prefix) out.push('..');
  }
  return prefix + out.join('/');
};

/**
 * A path as the rules may name it: relative to the project when it is inside
 * it, and absolute. A pattern like `.superagent/**`, or its any-depth form,
 * then matches whichever form the tool was given.
 */
export const pathCandidates = (file, cwd) => {
  if (typeof file !== 'string' || !file) return [];
  const input = slash(file);
  const root = cwd ? collapse(slash(cwd)).replace(/\/+$/, '') : '';
  if (!root && !isAbsolutePath(input)) return [collapse(input)];
  const abs = collapse(isAbsolutePath(input) ? input : `${root}/${input}`);
  if (root && abs.startsWith(`${root}/`)) return [abs.slice(root.length + 1), abs];
  return [abs];
};

/**
 * The rule action and resources a tool call is, or null for a tool the
 * roster's rules say nothing about (MCP tools, Claude Code's own bookkeeping).
 */
export const toolRequest = (tool, input, cwd) => {
  const action = TOOL_ACTIONS[tool];
  if (!action) return null;
  const args = input && typeof input === 'object' ? input : {};
  switch (action) {
    case 'edit':
      return { action, resources: pathCandidates(args.file_path ?? args.notebook_path, cwd) };
    case 'read':
      return {
        action,
        resources: args.file_path
          ? pathCandidates(args.file_path, cwd)
          : [args.path, args.pattern].filter((v) => typeof v === 'string'),
      };
    case 'shell':
      return { action, resources: [String(args.command ?? '')] };
    case 'subagent':
      return { action, resources: [String(args.subagent_type ?? '')] };
    case 'webfetch':
      return { action, resources: [String(args.url ?? '')] };
    case 'websearch':
      return { action, resources: [String(args.query ?? '')] };
    case 'skill':
      return { action, resources: [String(args.skill ?? args.name ?? '')] };
    default:
      return { action, resources: [] };
  }
};

/**
 * What the rules make of a call: `{ decision: 'deny' | 'ask', reason }`, or
 * null to leave the decision to Claude Code.
 */
export const checkCall = (rules, tool, input, { cwd, agent } = {}) => {
  const request = toolRequest(tool, input, cwd);
  if (!request || !rules?.length) return null;
  const effect = evaluate(rules, request.action, request.resources);
  if (effect !== 'deny' && effect !== 'ask') return null;
  const target = request.resources[0] ? ` ${request.resources[0]}` : '';
  const who = agent ? `the ${agent} agent` : 'this agent';
  return effect === 'deny'
    ? {
        decision: 'deny',
        reason:
          `Superagent: ${who} may not use ${tool}${target}. ` +
          'Its role does not include this; dispatch an agent whose role does.',
      }
    : { decision: 'ask', reason: `Superagent: ${who} needs approval to use ${tool}${target}.` };
};
