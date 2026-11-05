import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configDirectory, loadConfig } from './lib/config.js';
import { createAdapter, roleToml } from './lib/adapter.js';

const digest = (text) => createHash('sha256').update(text).digest('hex');
export function installRoles({
  configDir = configDirectory(),
  projectDir = process.cwd(),
  remove = false,
  dryRun = false,
  roleDir,
  settings,
} = {}) {
  const directory = roleDir ?? path.join(configDir, 'agents', 'superagent');
  const receiptFile = path.join(directory, 'receipt.json');
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const adapter = createAdapter(settings ?? loadConfig({ configDir, projectDir }));
  const desired = remove
    ? {}
    : Object.fromEntries(adapter.specialists.map((role) => [`${role.name}.toml`, roleToml(role)]));
  const actions = [];
  const receipt = { ...previous };
  for (const name of new Set([...Object.keys(previous), ...Object.keys(desired)])) {
    if (path.basename(name) !== name || !name.endsWith('.toml'))
      throw new Error('Invalid installation receipt');
    const file = path.join(directory, name);
    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== null && digest(current) !== previous[name]) {
      actions.push({ file, action: 'conflict' });
      continue;
    }
    if (!(name in desired)) {
      actions.push({ file, action: 'remove' });
      if (!dryRun) fs.rmSync(file, { force: true });
      delete receipt[name];
    } else {
      actions.push({ file, action: current === desired[name] ? 'unchanged' : 'write' });
      if (!dryRun) {
        fs.mkdirSync(directory, { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, desired[name], { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      }
      receipt[name] = digest(desired[name]);
    }
  }
  if (!dryRun) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  }
  return { actions, warnings: adapter.warnings, restartRequired: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--remove', '--dry-run'].includes(arg)))
      throw new Error('Usage: node codex/install.mjs [--dry-run] [--remove]');
    const result = installRoles({
      remove: args.includes('--remove'),
      dryRun: args.includes('--dry-run'),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.actions.some((a) => a.action === 'conflict')) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
