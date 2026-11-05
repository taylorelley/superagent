import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLaunch } from '../../codex/lib/launch.js';

test('concurrent project configurations use independent role caches without rewriting user config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-launch-'));
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const results = ['a', 'b'].map((model) => {
      const project = path.join(dir, model);
      fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
      fs.writeFileSync(
        path.join(project, '.codex/superagent.json'),
        JSON.stringify({ agents: { models: { implementer: `mock/${model}` } } }),
      );
      return prepareLaunch({ configDir: home, projectDir: project, env: {} });
    });
    assert.notEqual(results[0].roleDir, results[1].roleDir);
    const repeated = prepareLaunch({ configDir: home, projectDir: path.join(dir, 'a'), env: {} });
    assert.notEqual(repeated.roleDir, results[0].roleDir);
    for (let i = 0; i < results.length; i++) {
      const launch = results[i];
      assert.match(
        fs.readFileSync(path.join(launch.roleDir, 'superagent-implementer.toml'), 'utf8'),
        new RegExp(`model = "${['a', 'b'][i]}"`),
      );
      assert.equal(launch.env.SUPERAGENT_ROLE_DIR, launch.roleDir);
      assert.ok(launch.args.some((a) => a.startsWith('agents."superagent-implementer"=')));
    }
    assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(home, 'agents')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit Codex directory flags select configuration without parsing a literal prompt', async () => {
  const { launchDirectory } = await import('../../codex/lib/launch.js');
  assert.equal(launchDirectory(['-C', 'project'], '/base'), '/base/project');
  assert.equal(launchDirectory(['--cd=/other'], '/base'), '/other');
  assert.equal(launchDirectory(['--', '-C', 'literal prompt'], '/base'), '/base');
  assert.throws(() => launchDirectory(['--cd'], '/base'));
});
