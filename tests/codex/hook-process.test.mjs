import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('hook responds to a complete JSON event without waiting for stdin EOF', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-hook-'));
  const child = spawn('node', ['codex/hooks/run.mjs'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, CODEX_HOME: dir },
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (p) => {
    output += p;
  });
  child.stderr.on('data', (p) => {
    errors += p;
  });
  try {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hook did not exit: ${errors}`)), 2000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', reject);
    });
    child.stdin.write(
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'root', cwd: dir }),
    );
    assert.equal(await result, 0, errors);
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /Tool Mapping for Codex/);
  } finally {
    child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
