import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRoles } from '../../codex/install.mjs';

test('installation is idempotent, dry-run makes no changes, modified roles survive uninstall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-install-'));
  try {
    assert.equal(installRoles({ configDir: dir, projectDir: dir, dryRun: true }).actions.length, 9);
    assert.equal(fs.existsSync(path.join(dir, 'agents')), false);
    const installed = installRoles({ configDir: dir, projectDir: dir });
    assert.equal(installed.actions.length, 9);
    assert.ok(
      installRoles({ configDir: dir, projectDir: dir }).actions.every(
        (a) => a.action === 'unchanged',
      ),
    );
    const file = installed.actions[0].file;
    fs.appendFileSync(file, '# personal change\n');
    const result = installRoles({ configDir: dir, projectDir: dir, remove: true });
    assert.equal(result.actions.filter((a) => a.action === 'conflict').length, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /personal change/);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((p) => p.endsWith('.toml')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
