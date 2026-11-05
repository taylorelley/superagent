import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCapabilities, REQUIRED_CAPABILITIES } from '../../codex/lib/capabilities.js';

test('missing runtime evidence never advertises parity', () => {
  const report = assessCapabilities();
  assert.equal(report.fullParity, false);
  assert.deepEqual(report.missing, REQUIRED_CAPABILITIES);
});

test('evidence must match the tested version and include a command and observation', () => {
  const evidence = Object.fromEntries(
    REQUIRED_CAPABILITIES.map((name) => [
      name,
      {
        version: 'test-1',
        status: 'verified',
        command: `acceptance ${name}`,
        observation: 'passed',
      },
    ]),
  );
  assert.equal(assessCapabilities(evidence, 'test-1').fullParity, true);
  assert.equal(assessCapabilities(evidence, 'test-2').fullParity, false);
  delete evidence.permissions.observation;
  assert.deepEqual(assessCapabilities(evidence, 'test-1').missing, ['permissions']);
});

test('documented plugin adaptations complete the accepted scope without claiming strict parity', () => {
  const evidence = Object.fromEntries(
    REQUIRED_CAPABILITIES.map((name) => [
      name,
      {
        version: 'test-1',
        status: 'verified',
        command: 'acceptance',
        observation: 'passed',
      },
    ]),
  );
  evidence.panel = {
    ...evidence.panel,
    status: 'adapted',
    adaptation: 'Shared renderer in a text/watch view; no embedded pane.',
  };
  const report = assessCapabilities(evidence, 'test-1');
  assert.equal(report.pluginComplete, true);
  assert.equal(report.fullParity, false);
  assert.deepEqual(report.pluginMissing, []);
  assert.deepEqual(report.missing, ['panel']);
  delete evidence.panel.adaptation;
  assert.equal(assessCapabilities(evidence, 'test-1').pluginComplete, false);
});
