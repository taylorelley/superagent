import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assessCapabilities, REQUIRED_CAPABILITIES } from './lib/capabilities.js';

// No inherited Codex home, login, project config, or live-provider requests.
const directory = mkdtempSync(join(tmpdir(), 'superagent-codex-probe-'));
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--integration'))
    throw new Error('Usage: node codex/probe.mjs [--integration]');
  const run = (args) => {
    const result = spawnSync('codex', args, {
      cwd: directory,
      env: { ...process.env, CODEX_HOME: directory },
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return {
      args,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error?.message ?? null,
    };
  };
  const version = run(['--version']);
  const testedVersion = version.status === 0 ? version.stdout.trim() : null;
  const evidence = {};
  let nativeIntegration;
  if (args.includes('--integration')) {
    const result = spawnSync(
      'bash',
      [resolve(import.meta.dirname, '../tests/codex/run-tests.sh'), '--integration'],
      {
        cwd: directory,
        env: { ...process.env, CODEX_HOME: directory },
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      },
    );
    nativeIntegration = {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error?.message ?? null,
    };
    if (result.status === 0)
      for (const name of REQUIRED_CAPABILITIES) {
        evidence[name] = {
          status: 'verified',
          version: testedVersion,
          command: 'bash tests/codex/run-tests.sh --integration',
          observation:
            'Adapter contracts and native fixture passed installation, skills, model/effort routing, concurrent sealed children, hook denial and durable-board assertions.',
        };
      }
  }
  const adaptations = {
    roles:
      'Installed role files or launch-specific overrides; registry changes require refresh and a new session.',
    context:
      'Startup/compaction and prompt/tool context hooks; historical snapshots cannot be removed.',
    commands:
      'Namespaced native command skills and a deterministic CLI rather than bare callback aliases.',
    panel: 'The shared renderer provides a text/watch view rather than an embedded native pane.',
  };
  for (const [name, adaptation] of Object.entries(adaptations)) {
    if (evidence[name]) evidence[name] = { ...evidence[name], status: 'adapted', adaptation };
  }
  const report = assessCapabilities(evidence, testedVersion);
  if (nativeIntegration) report.nativeIntegration = nativeIntegration;
  report.discovery = [version, run(['plugin', '--help']), run(['app-server', '--help'])];
  report.note =
    'Completion is scoped to the documented plugin architecture. Host-specific adaptations are explicit; strict cross-host parity is reported separately. Real-model behavior and untested platforms are not certified by this fixture.';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pluginComplete ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
