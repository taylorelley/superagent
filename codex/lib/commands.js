import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, commandsToRegister } from '../../core/commands.js';
import { SHIPPED_PRESETS } from '../../core/presets.js';
import { councilInstruction } from '../../core/council.js';
import { renderBoard } from '../../core/board.js';
import { readCache, cachePath, checkForUpdate } from '../../.opencode/lib/update-check.js';
import { version } from './adapter.js';
import { installUpdate } from './updates.js';

export async function expandCommand(
  name,
  args,
  { settings, adapter, state, sessionID, configDir, projectDir = process.cwd() },
) {
  if (!Object.hasOwn(COMMANDS, name)) return null;
  if (!commandsToRegister(settings).commands.some((c) => c.name === name))
    return `Superagent command ${name} is disabled.`;
  if (name === 'board')
    return renderBoard(sessionID) ?? 'Nothing has been dispatched in this session.';
  if (name === 'council')
    return councilInstruction(
      adapter.specialists.filter((r) => r.key.startsWith('councillor-')),
      (args ?? '').trim(),
      { host: 'codex' },
    );
  if (name === 'preset') {
    const [preset, ...flags] = (args ?? '').trim().split(/\s+/).filter(Boolean);
    const known = { ...SHIPPED_PRESETS, ...settings.presets };
    if (!preset || preset === 'show' || preset === 'list')
      return `Active preset: ${settings.preset}\nAvailable: ${Object.keys(known).sort().join(', ')}`;
    if (!Object.hasOwn(known, preset))
      return `Unknown preset ${preset}. Available: ${Object.keys(known).sort().join(', ')}`;
    if (flags.some((f) => f !== '--persist')) return 'Usage: preset [name] [--persist]';
    if (flags.includes('--persist')) {
      fs.mkdirSync(configDir, { recursive: true });
      const file = path.join(configDir, 'superagent.state.json');
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ preset }) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    }
    (state.sessions[sessionID] ??= {}).preset = preset;
    return `Preset ${preset} selected. Hook policy applies on the next event. Refresh generated roles and start a new Codex session to change loaded role definitions or models.`;
  }
  if (name === 'update') {
    if (args?.trim() === 'install') return installUpdate({ configDir, projectDir });
    if (args?.trim() === 'check' && settings.updateCheck.enabled)
      await checkForUpdate({
        currentVersion: version,
        cacheFile: cachePath(configDir),
        intervalHours: settings.updateCheck.intervalHours,
      });
    const cached = readCache(cachePath(configDir));
    return `Installed: ${version}\nLatest known: ${cached?.latestVersion ?? 'unknown'}\n${settings.updateCheck.enabled ? 'Use update check to refresh the cache.' : 'Update checks are disabled.'}`;
  }
  return null;
}
