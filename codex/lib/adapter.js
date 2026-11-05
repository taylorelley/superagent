import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_PATTERN, planProgress } from '../../core/activity.js';
import { ROSTER } from '../../core/roster.js';
import { promptPath } from '../../claude-code/lib/roster.js';
import { buildRoster } from './roster.js';
import { renderBootstrap } from '../../core/bootstrap.js';
import { hiddenActions } from '../../core/permissions.js';
import { renderRoutingTable } from '../../core/routing.js';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const version = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'),
).version;
export function createAdapter(settings, { configDir, roleDir, requireInstalled = false } = {}) {
  const prompts = {};
  for (const { prompt } of ROSTER) {
    const relative = promptPath(prompt);
    try {
      prompts[relative] = fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
    } catch {
      /* buildRoster reports missing prompts */
    }
  }
  const roster = buildRoster(settings, prompts);
  if (requireInstalled) {
    roster.registered = roster.registered.filter((role) => {
      if (role.orchestrator) return true;
      try {
        const file = path.join(
          roleDir ?? path.join(configDir, 'agents', 'superagent'),
          `${role.name}.toml`,
        );
        if (fs.readFileSync(file, 'utf8') === roleToml(role)) return true;
      } catch {
        /* missing or inaccessible roles are not advertised */
      }
      roster.warnings.push(
        `Role ${role.name} needs installation or refresh: run node "${path.join(pluginRoot, 'codex/install.mjs')}" and start a new session.`,
      );
      return false;
    });
    roster.specialists = roster.registered.filter((role) => !role.orchestrator);
  }
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills/using-superagent/SKILL.md'), 'utf8');
  const routing = renderRoutingTable(roster.registered, { host: 'codex' });
  return {
    ...roster,
    bootstrap: settings.bootstrap.enabled
      ? renderBootstrap(skill, { host: 'codex', extra: roster.registered.length ? routing : '' })
      : '',
  };
}
export const toml = (value) => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  return `{ ${Object.entries(value)
    .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
    .join(', ')} }`;
};
export const roleToml = (role) => {
  const denied = hiddenActions(role.rules, ['edit', 'subagent', 'shell']);
  return (
    Object.entries({
      name: role.name,
      description: role.description,
      developer_instructions: role.prompt,
      ...role.config,
      ...(denied.includes('edit') ? { sandbox_mode: 'read-only' } : {}),
      ...(denied.includes('subagent') ? { agents: { enabled: false } } : {}),
      ...(denied.includes('shell') || denied.includes('subagent')
        ? {
            features: {
              ...(denied.includes('subagent') ? { multi_agent_v2: false } : {}),
              ...(denied.includes('shell') ? { shell_tool: false } : {}),
            },
          }
        : {}),
    })
      .map(([key, value]) => `${key} = ${toml(value)}`)
      .join('\n') + '\n'
  );
};

/** Observe only a referenced plan inside the current local workspace. */
export function observePlan(input) {
  const candidate = JSON.stringify(input.tool_input ?? {}).match(PLAN_PATTERN)?.[1];
  if (!candidate) return null;
  try {
    const cwd = fs.realpathSync(input.cwd);
    const file = fs.realpathSync(path.resolve(cwd, candidate));
    if (!file.startsWith(cwd + path.sep)) return null;
    const progress = planProgress(fs.readFileSync(file, 'utf8'));
    return progress ? { ...progress, name: path.basename(file) } : null;
  } catch {
    return null;
  }
}
