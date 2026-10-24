import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, provider, sse } from './helpers.mjs';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { Harness } from '../dist/harness.js';
import {
  calculateWorkspaceTrustHash,
  isWorkspaceTrusted,
  recordWorkspaceTrust,
  HookBus,
} from '../dist/hooks.js';

test('project hooks require workspace trust and hash changes invalidate trust', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-test-'));
  const vyenDir = join(dir, '.vyen');
  await mkdir(vyenDir, { recursive: true });

  const settingsFile = join(vyenDir, 'settings.json');
  const scriptFile = join(dir, 'script.sh');

  await writeFile(settingsFile, JSON.stringify({
    hooks: [
      { event: 'PreToolUse', matcher: 'bash', command: 'bash ./script.sh' },
    ],
  }), 'utf8');
  await writeFile(scriptFile, 'echo "ok"', 'utf8');

  // Compute initial hash
  const hash1 = await calculateWorkspaceTrustHash(dir, ['bash ./script.sh']);
  assert.ok(typeof hash1 === 'string' && hash1.length === 64, 'hash must be 64-char sha256 hex');

  // Initially untrusted
  const untrusted = await isWorkspaceTrusted(dir, hash1);
  assert.equal(untrusted, false, 'initially untrusted');

  // Record trust
  await recordWorkspaceTrust(dir, hash1);
  const trusted = await isWorkspaceTrusted(dir, hash1);
  assert.equal(trusted, true, 'trusted after recording');

  // Modify the script file
  await writeFile(scriptFile, 'echo "malicious modification"', 'utf8');
  const hash2 = await calculateWorkspaceTrustHash(dir, ['bash ./script.sh']);
  assert.notEqual(hash1, hash2, 'modifying script must change trust hash');

  // Now checking trust with new hash2 should be false
  const trustedAfterTamper = await isWorkspaceTrusted(dir, hash2);
  assert.equal(trustedAfterTamper, false, 'tampered script must invalidate trust');

  await rm(dir, { recursive: true, force: true });
});

test('hook bus executes PreToolUse command and exit 2 denies execution', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'node -e "process.exit(2)"',
      },
      {
        event: 'PreToolUse',
        matcher: 'write_file',
        command: 'node -e "process.exit(0)"',
      },
    ],
  });

  // Matching 'bash' triggers exit 2 -> denied
  const resBash = await bus.dispatch('PreToolUse', {
    tool: 'bash',
    input: { command: 'rm -rf /' },
  });
  assert.equal(resBash.length, 1);
  assert.equal(resBash[0].exitCode, 2);
  assert.equal(resBash[0].denied, true);

  // Matching 'write_file' triggers exit 0 -> not denied
  const resWrite = await bus.dispatch('PreToolUse', {
    tool: 'write_file',
    input: { path: 'a.txt' },
  });
  assert.equal(resWrite.length, 1);
  assert.equal(resWrite[0].exitCode, 0);
  assert.equal(resWrite[0].denied, false);

  // Non-matching 'read_file' executes no hooks
  const resRead = await bus.dispatch('PreToolUse', {
    tool: 'read_file',
    input: { path: 'a.txt' },
  });
  assert.equal(resRead.length, 0);
});

test('hook command exit 0 stdout injects context', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [
      {
        event: 'UserPromptSubmit',
        command: 'node -e "process.stdout.write(\\"Injected system notice\\")"',
      },
    ],
  });

  const res = await bus.dispatch('UserPromptSubmit', { prompt: 'hello' });
  assert.equal(res.length, 1);
  assert.equal(res[0].exitCode, 0);
  assert.equal(res[0].injectedContext, 'Injected system notice');
});

test('broken or timed out hook does not crash the run', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    timeoutMs: 300,
    hooks: [
      {
        event: 'SessionStart',
        command: 'node -e "throw new Error(\\"Crash test\\")"',
      },
      {
        event: 'SessionStart',
        command: 'node -e "setTimeout(() => {}, 2000)"',
        timeoutMs: 100,
      },
    ],
  });

  // Dispatch should resolve safely without throwing uncaught exceptions
  const res = await bus.dispatch('SessionStart', { sessionId: 'test-session-1' });
  assert.equal(res.length, 2);
  assert.ok(res[0].error, 'broken hook records error');
  assert.ok(res[1].error, 'timed out hook records error');
});

test('hook process environment never receives sensitive API keys', async () => {
  const originalKey = process.env.VYEN_API_KEY;
  const originalToken = process.env.ANTHROPIC_API_KEY;
  process.env.VYEN_API_KEY = 'super-secret-vyen-key';
  process.env.ANTHROPIC_API_KEY = 'super-secret-anthropic-token';

  try {
    const bus = new HookBus({
      cwd: process.cwd(),
      isTrusted: true,
      hooks: [
        {
          event: 'Stop',
          command: 'node -e "process.stdout.write(JSON.stringify(process.env))"',
        },
      ],
    });

    const res = await bus.dispatch('Stop', { reason: 'done' });
    assert.equal(res.length, 1);
    const envCaptured = JSON.parse(res[0].stdout);

    assert.equal(envCaptured.VYEN_API_KEY, undefined, 'VYEN_API_KEY must be sanitized');
    assert.equal(envCaptured.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must be sanitized');
  } finally {
    if (originalKey !== undefined) process.env.VYEN_API_KEY = originalKey;
    else delete process.env.VYEN_API_KEY;
    if (originalToken !== undefined) process.env.ANTHROPIC_API_KEY = originalToken;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('Harness executeBatch intercepts tools with HookBus PreToolUse', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res, n) => {
    if (n === 1) {
      sse(res, {
        calls: [{ id: 'c1', name: 'write_file', input: { path: 'blocked.txt', content: 'should not exist' } }],
      });
    } else {
      sse(res, { text: 'Turn complete.' });
    }
  });

  const config = {
    model: 'mock-model',
    provider: 'openai',
    baseUrl: p.url,
    apiKey: 'mock-key',
    cwd: f.cwd,
    dataDir: f.data,
    maxOutputTokens: 2048,
    contextWindow: 8192,
    timeoutMs: 10000,
  };

  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  const hookBus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'write_file',
        command: 'node -e "process.exit(2)"',
      },
    ],
  });

  let stoppedReason = '';
  const harness = new Harness(config, store, tools, ev => {
    if (ev.type === 'stopped') stoppedReason = ev.reason;
  }, undefined, hookBus);

  await harness.run('Do write', new AbortController().signal);

  assert.equal(stoppedReason, 'Permission denied.');
  const exists = await stat(join(f.cwd, 'blocked.txt')).then(() => true, () => false);
  assert.equal(exists, false, 'file must not be created when hook exits 2');
});

test('hook bus calls onWarning when a hook fails or times out', async () => {
  const warnings = [];
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    onWarning: msg => warnings.push(msg),
    hooks: [
      {
        event: 'SessionStart',
        command: 'node -e "throw new Error(\\"Crash test\\")"',
      },
    ],
  });

  await bus.dispatch('SessionStart', { sessionId: 'test-session-warn' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Crash test/);
});

test('Harness executeBatch normalizes tool aliases before PreToolUse matching and surfaces denial reason', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res, n) => {
    if (n === 1) {
      sse(res, {
        calls: [{ id: 'c1', name: 'write', input: { path: 'blocked.txt', content: 'should not exist' } }],
      });
    } else {
      sse(res, { text: 'Turn complete.' });
    }
  });

  const config = {
    model: 'mock-model',
    provider: 'openai',
    baseUrl: p.url,
    apiKey: 'mock-key',
    cwd: f.cwd,
    dataDir: f.data,
    maxOutputTokens: 2048,
    contextWindow: 8192,
    timeoutMs: 10000,
  };

  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  const hookBus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'write_file',
        command: 'node -e "process.stderr.write(\\"policy violation: write forbidden\\"); process.exit(2);"',
      },
    ],
  });

  let stoppedReason = '';
  const harness = new Harness(config, store, tools, ev => {
    if (ev.type === 'stopped') stoppedReason = ev.reason;
  }, undefined, hookBus);

  await harness.run('Do write', new AbortController().signal);

  assert.equal(stoppedReason, 'Permission denied.');
  const toolMsg = store.session.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'tool message should be recorded');
  const part = toolMsg.content[0];
  assert.match(part.output.value, /policy violation: write forbidden/);

  const exists = await stat(join(f.cwd, 'blocked.txt')).then(() => true, () => false);
  assert.equal(exists, false, 'file must not be created when alias is intercepted');
});

test('hook execution does not crash on fast-exiting child with EPIPE', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [
      {
        event: 'PreToolUse',
        command: 'node -e "process.exit(2)"',
      },
    ],
  });

  const bigPayload = {
    tool: 'bash',
    input: { data: 'x'.repeat(64 * 1024) },
  };

  const res = await bus.dispatch('PreToolUse', bigPayload);
  assert.equal(res.length, 1);
  assert.equal(res[0].exitCode, 2);
  assert.equal(res[0].denied, true);
});
