import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, fixture, provider, sse } from './helpers.mjs';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { Harness } from '../dist/harness.js';
import {
  calculateWorkspaceTrustHash,
  isWorkspaceTrusted,
  recordWorkspaceTrust,
  HookBus,
  sanitizeEnvironment,
} from '../dist/hooks.js';

test('project hooks require workspace trust and hash changes invalidate trust', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-test-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  try {
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
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(dir, { recursive: true, force: true });
  }
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
    const sanitized = sanitizeEnvironment({
      SAFE_VAR: 'hello',
      AWS_ACCESS_KEY_ID: 'aws-secret',
      DB_PASSWORD: 'password123',
    });
    assert.equal(sanitized.SAFE_VAR, 'hello');
    assert.equal(sanitized.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(sanitized.DB_PASSWORD, undefined);
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

test('Harness endSession dispatches SessionEnd hook', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res) => {
    sse(res, { text: 'Done.' });
  });

  const config = {
    model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  let sessionEnded = false;
  const hookBus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    hooks: [
      {
        event: 'SessionEnd',
        command: 'node -e "process.exit(0)"',
      },
    ],
  });
  hookBus.dispatch = async (event) => {
    if (event === 'SessionEnd') sessionEnded = true;
    return [];
  };

  const harness = new Harness(config, store, tools, () => {}, undefined, hookBus);
  await harness.run('hello', AbortSignal.timeout(10_000));
  await harness.endSession();
  assert.equal(sessionEnded, true, 'SessionEnd must be dispatched on endSession');
});

test('SessionStart hook stdout injects context into new session', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res) => {
    sse(res, { text: 'Hello.' });
  });

  const config = {
    model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  const hookBus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    hooks: [
      {
        event: 'SessionStart',
        command: 'node -e "process.stdout.write(\\"Injected system info\\")"',
      },
    ],
  });

  const harness = new Harness(config, store, tools, () => {}, undefined, hookBus);
  await harness.run('first message', new AbortController().signal);

  const injected = store.session.messages.find(m => typeof m.content === 'string' && m.content.includes('Injected system info'));
  assert.ok(injected, 'SessionStart stdout must be injected into session messages');
});

test('PreCompact only dispatches when compaction threshold is reached or on manual compact', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res) => {
    sse(res, { text: 'Short turn.' });
  });

  const config = {
    model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  let preCompactFired = false;
  const hookBus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    hooks: [
      {
        event: 'PreCompact',
        command: 'node -e "process.exit(0)"',
      },
    ],
  });
  const origDispatch = hookBus.dispatch.bind(hookBus);
  hookBus.dispatch = async (event, payload) => {
    if (event === 'PreCompact') preCompactFired = true;
    return origDispatch(event, payload);
  };

  const harness = new Harness(config, store, tools, () => {}, undefined, hookBus);
  await harness.run('Small query', new AbortController().signal);

  assert.equal(preCompactFired, false, 'PreCompact must not fire when context is far below threshold');
});

test('hook process environment strips custom keyEnv protected secrets', async () => {
  const { protectSecretEnv } = await import('../dist/process.js');
  protectSecretEnv('CUSTOM_UNMATCHED_KEY');
  process.env.CUSTOM_UNMATCHED_KEY = 'super-secret-key-12345';
  try {
    const bus = new HookBus({
      cwd: process.cwd(),
      isTrusted: true,
      hooks: [
        {
          event: 'SessionStart',
          command: 'node -e "process.stdout.write(process.env.CUSTOM_UNMATCHED_KEY || \\\"CLEAN\\\")"',
        },
      ],
    });
    const res = await bus.dispatch('SessionStart', { sessionId: 'test-custom-key' });
    assert.equal(res.length, 1);
    assert.equal(res[0].injectedContext?.trim(), 'CLEAN', 'CUSTOM_UNMATCHED_KEY must not reach child process');
  } finally {
    delete process.env.CUSTOM_UNMATCHED_KEY;
  }
});

test('calculateWorkspaceTrustHash correctly extracts quoted script paths with spaces', async t => {
  const f = await fixture(t);
  const scriptDir = join(f.cwd, 'my scripts');
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, 'guard test.js');
  await writeFile(scriptPath, 'console.log("guard");');

  const cmdWithQuotes = `node "${scriptPath}"`;
  const hash1 = await calculateWorkspaceTrustHash(f.cwd, [cmdWithQuotes]);

  // Modifying the script with spaces in path should change the trust hash
  await writeFile(scriptPath, 'console.log("modified guard");');
  const hash2 = await calculateWorkspaceTrustHash(f.cwd, [cmdWithQuotes]);

  assert.notEqual(hash1, hash2, 'hash must change when quoted script file is modified');
});

test('calculateWorkspaceTrustHash covers executables in project allow rules and changes on script modification or creation', async t => {
  const f = await fixture(t);
  const scriptPath = join(f.cwd, 'scripts', 'deploy.sh');
  await mkdir(join(f.cwd, 'scripts'), { recursive: true });
  await writeFile(scriptPath, '#!/bin/sh\necho deploy\n');

  const allowCommands = ['bash(./scripts/deploy.sh)', 'bash(./scripts/missing.sh)'];
  const hash1 = await calculateWorkspaceTrustHash(f.cwd, allowCommands);

  // Modifying the existing script must change the hash
  await writeFile(scriptPath, '#!/bin/sh\necho malicious\n');
  const hash2 = await calculateWorkspaceTrustHash(f.cwd, allowCommands);
  assert.notEqual(hash1, hash2, 'hash must change when allow-referenced script is modified');

  // Creating the previously missing script must change the hash
  const missingPath = join(f.cwd, 'scripts', 'missing.sh');
  await writeFile(missingPath, '#!/bin/sh\necho created\n');
  const hash3 = await calculateWorkspaceTrustHash(f.cwd, allowCommands);
  assert.notEqual(hash2, hash3, 'hash must change when missing allow-referenced script is created');

  // Wildcard allow script rules must discover and hash matching scripts
  const wildcardCmd = ['bash(./scripts/*.sh)'];
  const hashWildcard1 = await calculateWorkspaceTrustHash(f.cwd, wildcardCmd);
  await writeFile(scriptPath, '#!/bin/sh\necho wildcard modified\n');
  const hashWildcard2 = await calculateWorkspaceTrustHash(f.cwd, wildcardCmd);
  assert.notEqual(hashWildcard1, hashWildcard2, 'hash must change when script matched by wildcard allow is modified');
});

test('HookBus defaults isTrusted to false when omitted and skips execution', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    hooks: [
      { event: 'PreToolUse', matcher: 'bash', command: 'node -e "console.log(1)"' },
    ],
  });

  assert.equal(bus.isTrusted, false, 'isTrusted must default to false when omitted');
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: { command: 'ls' } });
  assert.deepEqual(results, [], 'untrusted hook bus must dispatch zero hooks');
});

test('Harness blocks tool execution when PreToolUse hook times out or fails', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res, n) => {
    if (n === 1) {
      sse(res, {
        calls: [{ id: 'c1', name: 'write', input: { path: 'timed_out_blocked.txt', content: 'should not exist' } }],
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
    timeoutMs: 150,
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'write_file',
        command: 'node -e "setTimeout(() => {}, 5000)"',
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
  assert.match(part.output.value, /Tool execution blocked.*timed out/i);

  const exists = await stat(join(f.cwd, 'timed_out_blocked.txt')).then(() => true, () => false);
  assert.equal(exists, false, 'file must not be created when hook times out');
});

test('sanitizeEnvironment preserves SSH_AUTH_SOCK and Git identity while stripping secret keys', () => {
  const env = {
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GIT_AUTHOR_NAME: 'Alice',
    GIT_AUTHOR_EMAIL: 'alice@example.com',
    GIT_COMMITTER_NAME: 'Bob',
    GIT_COMMITTER_EMAIL: 'bob@example.com',
    OPENAI_API_KEY: 'sk-secret123',
    GITHUB_TOKEN: 'ghp_secret456',
    AUTH_SECRET: 'supersecret',
    CUSTOM_PASSWORD: 'password123',
    PATH: '/usr/bin:/bin',
  };

  const clean = sanitizeEnvironment(env);
  assert.equal(clean.SSH_AUTH_SOCK, '/tmp/ssh-agent.sock', 'SSH_AUTH_SOCK must be preserved');
  assert.equal(clean.GIT_AUTHOR_NAME, 'Alice', 'GIT_AUTHOR_NAME must be preserved');
  assert.equal(clean.GIT_COMMITTER_EMAIL, 'bob@example.com', 'GIT_COMMITTER_EMAIL must be preserved');
  assert.equal(clean.PATH, '/usr/bin:/bin');
  assert.equal(clean.OPENAI_API_KEY, undefined);
  assert.equal(clean.GITHUB_TOKEN, undefined);
  assert.equal(clean.AUTH_SECRET, undefined);
  assert.equal(clean.CUSTOM_PASSWORD, undefined);
});

test('Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once', async t => {
  const f = await fixture(t);
  const p = await provider(t, (req, res) => { sse(res, { text: 'Answer.' }); });
  const config = {
    model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const tools = new ToolRegistry(f.cwd, async () => true, false);

  const firstEvents = [];
  const firstBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  firstBus.dispatch = async event => { firstEvents.push(event); return []; };
  await new Harness(config, store, tools, () => {}, undefined, firstBus).run('first', AbortSignal.timeout(10_000));

  assert.equal(firstEvents.filter(e => e === 'SessionStart').length, 1);
  assert.equal(firstEvents.filter(e => e === 'SessionEnd').length, 0, 'a run must not end the session by itself');

  // Same store, new Harness: the CLI rebuilds harnesses on /model, /effort, /cd and
  // /mcp, and a rebuild must not reopen a session that is already open.
  const rebuiltEvents = [];
  const rebuiltBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  rebuiltBus.dispatch = async event => { rebuiltEvents.push(event); return []; };
  const rebuilt = new Harness(config, store, tools, () => {}, undefined, rebuiltBus);
  await rebuilt.run('second', AbortSignal.timeout(10_000));
  assert.equal(rebuiltEvents.filter(e => e === 'SessionStart').length, 0, 'a rebuild must not restart the session');

  await rebuilt.endSession();
  await rebuilt.endSession();
  assert.equal(rebuiltEvents.filter(e => e === 'SessionEnd').length, 1, 'SessionEnd must be idempotent');

  // A new process resumes from disk with a new SessionStore: the first turn must open it.
  await store.close();
  const resumedStore = await SessionStore.open(join(f.data, 'sessions'), config, store.session.id);
  t.after(() => resumedStore.close());
  const resumedEvents = [];
  const resumedBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  resumedBus.dispatch = async (event, payload) => { resumedEvents.push({ event, payload }); return []; };
  await new Harness(config, resumedStore, tools, () => {}, undefined, resumedBus)
    .run('third', AbortSignal.timeout(10_000));
  const starts = resumedEvents.filter(e => e.event === 'SessionStart');
  assert.equal(starts.length, 1, 'resumed session must start');
  assert.equal(starts[0].payload.sessionId, store.session.id);
});

test('a failing SessionEnd hook reports to stderr before the process exits', async t => {
  const f = await fixture(t);
  const p = await provider(t, (req, res) => { sse(res, { text: 'Done.' }); });
  await mkdir(join(f.cwd, '.vyen'), { recursive: true });
  await writeFile(
    join(f.cwd, '.vyen', 'settings.json'),
    JSON.stringify({ hooks: [{ event: 'SessionEnd', command: 'node -e "process.exit(1)"' }] }),
    'utf8',
  );

  const result = await cli(f, p.url, ['--trust-workspace', '--json', '-p', 'hello']).done;

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[Hook warning\]: \[Hook error \(SessionEnd\)\]/);
  assert.doesNotMatch(result.stdout, /Hook Warning/i, 'shutdown warnings must not go to the closed UI stream');
});

test('hook payloads carry the session id for prompt, tool, stop and compact events', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'c1', name: 'list_files', input: { path: '.' } }] });
    else sse(res, { text: 'Done.' });
  });
  const config = {
    model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  const seen = [];
  const bus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  bus.dispatch = async (event, payload) => { seen.push({ event, payload }); return []; };
  const harness = new Harness(config, store, tools, () => {}, undefined, bus);

  await harness.run('Inspect.', AbortSignal.timeout(10_000));
  // The mock provider only speaks SSE; compaction fails after PreCompact dispatches,
  // which is all this test observes.
  await harness.compact(AbortSignal.timeout(10_000)).catch(() => {});

  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact']) {
    const entry = seen.find(e => e.event === event);
    assert.ok(entry, `${event} must dispatch`);
    assert.equal(entry.payload.sessionId, store.session.id, `${event} payload must carry sessionId`);
  }
});

test('PostToolUseFailure payloads carry the session id for denied and thrown tool calls', async t => {
  const f = await fixture(t);
  const deniedProvider = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'w1', name: 'write_file', input: { path: '../escape.txt', content: 'no' } }] });
    else sse(res, { text: 'Stopped.' });
  });
  const deniedConfig = {
    model: 'mock-model', provider: 'openai', baseUrl: deniedProvider.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: join(f.data, 'denied'), maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000,
  };
  const deniedStore = await SessionStore.open(join(f.data, 'denied', 'sessions'), deniedConfig);
  t.after(() => deniedStore.close());
  const deniedEvents = [];
  const deniedBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  deniedBus.dispatch = async (event, payload) => { deniedEvents.push({ event, payload }); return []; };
  await new Harness(deniedConfig, deniedStore, new ToolRegistry(f.cwd, async () => false, false), () => {}, undefined, deniedBus)
    .run('Try escape.', AbortSignal.timeout(10_000));
  const denied = deniedEvents.find(e => e.event === 'PostToolUseFailure');
  assert.ok(denied, 'denied tool must dispatch PostToolUseFailure');
  assert.equal(denied.payload.sessionId, deniedStore.session.id);

  // A read of a directory throws inside ToolRegistry.execute, hitting the catch path.
  const thrownProvider = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'r1', name: 'read_file', input: { path: '.' } }] });
    else sse(res, { text: 'Done.' });
  });
  const thrownConfig = { ...deniedConfig, baseUrl: thrownProvider.url, dataDir: join(f.data, 'thrown') };
  const thrownStore = await SessionStore.open(join(f.data, 'thrown', 'sessions'), thrownConfig);
  t.after(() => thrownStore.close());
  const thrownEvents = [];
  const thrownBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  thrownBus.dispatch = async (event, payload) => { thrownEvents.push({ event, payload }); return []; };
  await new Harness(thrownConfig, thrownStore, new ToolRegistry(f.cwd, async () => true, false), () => {}, undefined, thrownBus)
    .run('Read a directory.', AbortSignal.timeout(10_000));
  const thrown = thrownEvents.find(e => e.event === 'PostToolUseFailure');
  assert.ok(thrown, 'thrown tool must dispatch PostToolUseFailure');
  assert.equal(thrown.payload.sessionId, thrownStore.session.id);
});
