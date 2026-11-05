/** Real Codex host acceptance; all model responses are scripted on loopback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { toml } from '../../codex/lib/adapter.js';
import { installRoles } from '../../codex/install.mjs';
import { prepareLaunch } from '../../codex/lib/launch.js';
import { readState, statePath } from '../../codex/lib/state.js';

const source = path.resolve(import.meta.dirname, '../..');
function cli(args, home, cwd) {
  const result = spawnSync('codex', args, {
    cwd,
    env: { ...process.env, CODEX_HOME: home, RUST_LOG: 'error' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function rpc(home, cwd, options = [], environment = {}) {
  const child = spawn('codex', [...options, 'app-server', '--stdio'], {
    cwd,
    env: { ...process.env, ...environment, CODEX_HOME: home, RUST_LOG: 'error' },
  });
  let buffer = '';
  let next = 0;
  const pending = new Map();
  const notices = [];
  let diagnostics = '';
  child.stderr.on('data', (part) => {
    diagnostics = (diagnostics + part).slice(-8000);
  });
  child.stdout.on('data', (part) => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else if (message.method) notices.push(message);
    }
  });
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', () => rejectPending(new Error(`Codex exited: ${diagnostics}`)));
  return {
    notices,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}; ${diagnostics}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      }),
    initialized: () => child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'),
    close: async () => {
      rejectPending(new Error('RPC closed'));
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          child.stdin.end();
        });
      }
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}
async function initialize(client) {
  await client.call('initialize', {
    clientInfo: { name: 'superagent-acceptance', version: '1' },
    capabilities: { experimentalApi: true },
  });
  client.initialized();
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  'native install, skill/command discovery, hooks, model routing and sealed roles',
  { timeout: 60000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-native-'));
    const home = path.join(directory, 'home');
    const fixture = path.join(directory, 'plugin');
    const requests = [];
    const releaseChildren = [];
    let client;
    let server;
    try {
      await fs.mkdir(home);
      await fs.mkdir(fixture);
      // The shipped tree has no node_modules; avoid fingerprinting dev dependencies.
      for (const name of [
        'core',
        'codex',
        'skills',
        'claude-code',
        '.opencode',
        '.agents',
        '.codex-plugin',
        'package.json',
      ])
        await fs.cp(path.join(source, name), path.join(fixture, name), { recursive: true });
      const version = cli(['--version'], home, home).trim();
      assert.match(version, /^codex-cli /);
      cli(['plugin', 'marketplace', 'add', fixture], home, home);
      const installed = JSON.parse(
        cli(['plugin', 'add', 'superagent@superagent', '--json'], home, home),
      );
      assert.equal(installed.pluginId, 'superagent@superagent');
      await fs.writeFile(
        path.join(home, 'superagent.json'),
        JSON.stringify({
          preset: 'council',
          agents: {
            models: { reviewer: 'mock/superagent-reviewer#high' },
            permissionOverrides: { superagent: { shell: { 'touch *': 'deny' } } },
          },
          council: {
            members: [
              { name: 'alpha', model: 'mock/council-alpha' },
              { name: 'beta', model: 'mock/council-beta' },
            ],
          },
          updateCheck: { enabled: false },
        }),
      );
      const roles = installRoles({ configDir: home, projectDir: home });
      assert.equal(roles.actions.filter((a) => a.action === 'write').length, 11);
      client = rpc(home, home);
      await initialize(client);
      const skills = await client.call('skills/list', { cwds: [home], forceReload: true });
      const discovered = skills.data
        .flatMap((d) => d.skills)
        .filter((s) => s.pluginId === 'superagent@superagent');
      const commandSkills = await fs.readdir(path.join(source, 'codex/skills'));
      assert.equal(
        discovered.length,
        15 + commandSkills.length,
        'Shared skills plus native command skills',
      );
      assert.ok(discovered.some((s) => s.name === 'superagent:board'));
      assert.ok(skills.data.every((d) => d.errors.length === 0));
      const declarations = await client.call('hooks/list', { cwds: [home] });
      const hooks = declarations.data
        .flatMap((d) => d.hooks)
        .filter((h) => h.pluginId === 'superagent@superagent');
      assert.equal(hooks.length, 12);
      await client.close();
      client = null;
      // Approve exactly this temporary test bundle, never the user's installation.
      const approvals = hooks
        .map((h) => {
          const [declaration, contents] = h.currentHash.split('/');
          return `[hooks.state.${toml(h.key)}]\nenabled = true\ntrusted_hash = ${toml(declaration)}\ntrusted_content_hash = ${toml(contents)}\n`;
        })
        .join('\n');
      await fs.appendFile(path.join(home, 'config.toml'), '\n' + approvals);
      server = http.createServer(async (req, res) => {
        let text = '';
        for await (const part of req) text += part;
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        requests.push(body);
        const items =
          requests.length === 1
            ? [
                'superagent-task-reviewer',
                'superagent-councillor-alpha',
                'superagent-councillor-beta',
              ].map((agent_type, index) => ({
                id: `spawn-${index}`,
                type: 'function_call',
                call_id: `spawn-${index}`,
                namespace: 'multi_agent_v1',
                name: 'spawn_agent',
                arguments: JSON.stringify({
                  agent_type,
                  message:
                    'Synthetic independent task; return one sentence, no edits or delegation.',
                  fork_context: false,
                }),
              }))
            : body.model === 'superagent-test' &&
                requests.filter((r) => r.model === 'superagent-test').length === 2
              ? [
                  {
                    id: 'guard-call',
                    type: 'function_call',
                    call_id: 'guard-call',
                    name: 'exec_command',
                    arguments: JSON.stringify({
                      cmd: `touch ${path.join(home, 'forbidden-marker')}`,
                    }),
                  },
                ]
              : [
                  {
                    id: `message-${requests.length}`,
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Synthetic acceptance complete.' }],
                  },
                ];
        const respond = () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const emit = (type, fields) =>
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
          items.forEach((item, output_index) => {
            emit('response.output_item.added', { output_index, item });
            emit('response.output_item.done', { output_index, item });
          });
          emit('response.completed', {
            response: {
              id: `response-${requests.length}`,
              status: 'completed',
              output: items,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          });
          res.end();
        };
        if (body.model === 'superagent-reviewer' || body.model.startsWith('council-'))
          releaseChildren.push(respond);
        else respond();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      installRoles({ configDir: home, projectDir: home, remove: true });
      const launch = prepareLaunch({ configDir: home, projectDir: home });
      client = rpc(
        home,
        home,
        [
          ...launch.args,
          '-c',
          'model_provider="mock"',
          '-c',
          'model="superagent-test"',
          '-c',
          `model_providers.mock=${toml({ name: 'Mock', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', supports_websockets: false })}`,
        ],
        launch.env,
      );
      await initialize(client);
      const started = await client.call('thread/start', { cwd: home });
      const threadID = started.thread.id;
      await client.call('turn/start', {
        threadId: threadID,
        input: [
          {
            type: 'text',
            text: 'ROOT_CONTEXT_MARKER: synthetic test; explicitly delegate to the reviewer and both council members independently.',
          },
        ],
      });
      await until(() => releaseChildren.length === 3, 'Three child requests never overlapped');
      const running = await readState(statePath(home, threadID));
      assert.equal(running.boards[threadID].filter((r) => r.state === 'running').length, 3);
      releaseChildren.splice(0).forEach((respond) => respond());
      await until(
        () =>
          client.notices.filter(
            (n) => n.method === 'hook/completed' && n.params.run.eventName === 'subagentStop',
          ).length === 3,
        'Missing native child completion hooks',
      );
      assert.match(JSON.stringify(requests[0]), /SUPERAGENT_ROUTING/);
      assert.ok(requests[0].tools.some((t) => t.name === 'exec_command'));
      await until(
        () =>
          requests.some((r) =>
            JSON.stringify(r.input).includes('Superagent role policy: deny shell'),
          ),
        'Native deny reason did not reach the model',
      );
      await assert.rejects(fs.access(path.join(home, 'forbidden-marker')));
      const reviewer = requests.find((r) => r.model === 'superagent-reviewer');
      assert.match(JSON.stringify(reviewer), /SUPERAGENT_CONTRACT/);
      assert.equal(reviewer.reasoning?.effort, 'high');
      assert.equal(JSON.stringify(reviewer.input).includes('ROOT_CONTEXT_MARKER'), false);
      for (const name of ['council-alpha', 'council-beta']) {
        const member = requests.find((r) => r.model === name);
        assert.ok(member, `Missing councillor ${name}`);
        assert.equal(
          member.tools.some((t) =>
            ['exec_command', 'write_stdin', 'shell_command'].includes(t.name),
          ),
          false,
          'Council shell tools must be withheld',
        );
        assert.equal(
          member.tools.some((t) => t.type === 'namespace' && /^multi_agent/.test(t.name)),
          false,
        );
      }
      assert.equal(
        reviewer.tools.some((t) => t.type === 'namespace' && /^multi_agent/.test(t.name)),
        false,
        'Workers and reviewers must not have delegation tools',
      );
      const completed = client.notices.filter((n) => n.method === 'hook/completed');
      assert.ok(completed.length >= 5);
      assert.ok(
        completed.some(
          (n) => n.params.run.id.endsWith(':guard-call') && n.params.run.status === 'blocked',
        ),
      );
      assert.ok(
        completed.every(
          (n) =>
            n.params.run.status === 'completed' ||
            (n.params.run.id.endsWith(':guard-call') && n.params.run.status === 'blocked'),
        ),
        JSON.stringify(
          completed.map((n) => ({ event: n.params.run.eventName, status: n.params.run.status })),
        ),
      );
      const state = await readState(statePath(home, threadID));
      assert.equal(state.boards[threadID].length, 3);
      assert.ok(state.boards[threadID].every((r) => r.state === 'completed'));
      assert.ok(state.boards[threadID].every((r) => r.childSessionID));
    } finally {
      await client?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
