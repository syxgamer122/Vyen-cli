import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, fixture, provider, sse } from './helpers.mjs';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { Harness } from '../dist/harness.js';
import { mcpConfigSchema } from '../dist/mcp.js';
import {
  calculateWorkspaceTrustHash,
  evaluateWorkspaceTrust,
  isWorkspaceTrusted,
  recordWorkspaceTrust,
  HookBus,
  sanitizeEnvironment,
  matchesHook,
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

test('isWorkspaceTrusted strips BOM from trusted_workspaces.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-bom-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  try {
    const hash = 'a'.repeat(64);
    await recordWorkspaceTrust(dir, hash);
    const storePath = join(process.env.XDG_CONFIG_HOME, 'vyen', 'trusted_workspaces.json');
    const content = await readFile(storePath, 'utf8');
    // Prepend UTF-8 BOM
    await writeFile(storePath, '\uFEFF' + content, 'utf8');
    const trusted = await isWorkspaceTrusted(dir, hash);
    assert.equal(trusted, true, 'workspace should be trusted even if trusted_workspaces.json has a BOM');
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

test('matchesHook matches tool names case-insensitively', () => {
  assert.equal(matchesHook('Bash', 'PreToolUse', { tool: 'bash' }), true);
  assert.equal(matchesHook('BASH', 'PreToolUse', { tool: 'bash' }), true);
  assert.equal(matchesHook('write_FILE', 'PreToolUse', { tool: 'write_file' }), true);
  assert.equal(matchesHook('Bash*', 'PreToolUse', { tool: 'bash' }), true);
});

test('HookBus dispatch aborts child process when AbortSignal triggers', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    timeoutMs: 10000,
    hooks: [
      { event: 'PreToolUse', matcher: 'bash', command: 'node -e "setTimeout(() => {}, 5000)"' },
    ],
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: {} }, controller.signal);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2500, `aborted hook must return quickly, took ${elapsed}ms`);
  assert.equal(results.length, 1);
  assert.ok(results[0].error?.includes('abort') || results[0].exitCode !== 0);
});

test('delete current command triggers activeHarness endSession before store swap', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const deleteMarker = "if (input === '/delete' || input.startsWith('/delete '))";
  const start = source.indexOf(deleteMarker);
  assert.ok(start > -1, 'missing /delete branch in src/cli.ts');
  const block = source.slice(start, source.indexOf('rebuildHarness', start));
  const endCall = block.indexOf('activeHarness?.endSession()');
  const swap = block.indexOf('store = await SessionStore.open');
  assert.ok(endCall > -1, '/delete must call activeHarness?.endSession()');
  assert.ok(swap > -1, '/delete must swap store');
  assert.ok(endCall < swap, '/delete must end session before opening replacement store');
});

test('calculateWorkspaceTrustHash handles question mark wildcard for allow scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-test-trust-qmark-'));
  try {
    const scriptsDir = join(dir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'run-1.sh'), '#!/bin/sh\necho 1\n');
    await writeFile(join(scriptsDir, 'run-2.sh'), '#!/bin/sh\necho 2\n');
    await writeFile(join(scriptsDir, 'run-ab.sh'), '#!/bin/sh\necho ab\n');

    const allowRules = ['bash(./scripts/run-?.sh)'];

    const hash1 = await calculateWorkspaceTrustHash(dir, allowRules);
    assert.ok(hash1, 'hash should be computed');

    // Modifying a matching single-char script changes hash
    await writeFile(join(scriptsDir, 'run-1.sh'), '#!/bin/sh\necho 1-modified\n');
    const hash2 = await calculateWorkspaceTrustHash(dir, allowRules);
    assert.notEqual(hash1, hash2, 'hash must change when matched single-char script changes');

    // Modifying non-matching script (run-ab.sh) does NOT change hash
    await writeFile(join(scriptsDir, 'run-ab.sh'), '#!/bin/sh\necho ab-modified\n');
    const hash3 = await calculateWorkspaceTrustHash(dir, allowRules);
    assert.equal(hash2, hash3, 'hash must not change when unmatched script changes');

    // Also verify root-relative wildcard path e.g. ./root-?.sh
    await writeFile(join(dir, 'root-1.sh'), '#!/bin/sh\necho r1\n');
    const rootAllowRules = ['bash(./root-?.sh)'];
    const rootHash1 = await calculateWorkspaceTrustHash(dir, rootAllowRules);
    await writeFile(join(dir, 'root-1.sh'), '#!/bin/sh\necho r1-modified\n');
    const rootHash2 = await calculateWorkspaceTrustHash(dir, rootAllowRules);
    assert.notEqual(rootHash1, rootHash2, 'root-relative wildcard must change hash when file modified');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PreToolUse hook spawn error marks execution result as denied', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'non_existent_command_12345' }],
  });
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].denied, true, 'PreToolUse spawn error must fail-closed with denied: true');
});

test('PreToolUse hook timeout marks execution result as denied', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    timeoutMs: 100,
    hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'node -e "setTimeout(() => {}, 5000)"' }],
  });
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].denied, true, 'PreToolUse timeout must fail-closed with denied: true');
});

test('Non-PreToolUse hook timeout or error preserves denied false', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [{ event: 'SessionStart', command: 'non_existent_command_12345' }],
  });
  const results = await bus.dispatch('SessionStart', {});
  assert.equal(results.length, 1);
  assert.equal(results[0].denied, false, 'Non-PreToolUse spawn error must not mark denied: true');

  const timeoutBus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    timeoutMs: 100,
    hooks: [{ event: 'SessionStart', command: 'node -e "setTimeout(() => {}, 5000)"' }],
  });
  const timeoutResults = await timeoutBus.dispatch('SessionStart', {});
  assert.equal(timeoutResults.length, 1);
  assert.equal(timeoutResults[0].timedOut, true);
  assert.equal(timeoutResults[0].denied, false, 'Non-PreToolUse timeout must not mark denied: true');
});

test('workspace trust hash covers project MCP config and referenced scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-mcp-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  try {
    await mkdir(join(dir, '.vyen'), { recursive: true });
    const mcpFile = join(dir, '.vyen', 'mcp.json');

    const emptyHash = await calculateWorkspaceTrustHash(dir, []);
    const expected = createHash('sha256').update('settings:none').digest('hex');
    assert.equal(emptyHash, expected, 'absent mcp.json must not change the legacy hash');
    assert.equal(
      await calculateWorkspaceTrustHash(dir, [], { includeProjectMcp: false }),
      expected,
      'includeProjectMcp: false must leave the legacy hash unchanged',
    );

    await writeFile(mcpFile, JSON.stringify({ servers: { proj: { command: 'node', args: ['./server.mjs'] } } }));
    const withMcp = await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']);
    assert.notEqual(withMcp, emptyHash, 'adding .vyen/mcp.json must change the trust hash');

    await writeFile(mcpFile, JSON.stringify({ servers: { proj: { command: 'node', args: ['./other.mjs'] } } }));
    assert.notEqual(
      await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']),
      withMcp,
      'editing .vyen/mcp.json must change the trust hash',
    );

    await writeFile(mcpFile, JSON.stringify({ servers: { proj: { command: 'node', args: ['./server.mjs'] } } }));
    const missingScript = await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']);
    await writeFile(join(dir, 'server.mjs'), 'console.log(1)');
    const before = await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']);
    assert.notEqual(before, missingScript, 'creating a referenced script must change the trust hash');
    await writeFile(join(dir, 'server.mjs'), 'console.log(2)');
    assert.notEqual(
      await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']),
      before,
      'editing a referenced script must change the trust hash',
    );

    await writeFile(mcpFile, '{broken');
    await assert.doesNotReject(calculateWorkspaceTrustHash(dir, []), 'corrupt project MCP JSON must still hash');

    const kgFile = join(dir, '.vyen', 'knowledge-graph.jsonl');
    const hashWithoutKg = await calculateWorkspaceTrustHash(dir, []);
    await writeFile(kgFile, '{"type":"entity","name":"test","entityType":"mod","observations":[]}\n');
    const hashWithKg = await calculateWorkspaceTrustHash(dir, []);
    assert.notEqual(hashWithKg, hashWithoutKg, 'adding .vyen/knowledge-graph.jsonl must change the trust hash');

    await writeFile(kgFile, '{"type":"entity","name":"test2","entityType":"mod","observations":[]}\n');
    const hashWithModifiedKg = await calculateWorkspaceTrustHash(dir, []);
    assert.notEqual(hashWithModifiedKg, hashWithKg, 'modifying .vyen/knowledge-graph.jsonl must change the trust hash');
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateWorkspaceTrust requires trust for project MCP servers and records it on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-eval-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  try {
    await mkdir(join(dir, '.vyen'), { recursive: true });
    const mcpFile = join(dir, '.vyen', 'mcp.json');
    await writeFile(mcpFile, JSON.stringify({ servers: { proj: { command: process.execPath, args: ['./server.mjs'] } } }));
    await writeFile(join(dir, 'server.mjs'), 'console.log(1)');
    const projectMcpServers = mcpConfigSchema.parse(JSON.parse(await readFile(mcpFile, 'utf8'))).servers;

    const untrusted = await evaluateWorkspaceTrust(dir, { projectMcpServers });
    assert.equal(untrusted.isTrusted, false);
    assert.equal(untrusted.trustRequired, true);
    assert.match(untrusted.reasons.join(' '), /project MCP server/);
    assert.equal(untrusted.hash.length, 64);
    assert.ok(untrusted.layered, 'evaluateWorkspaceTrust returns the layered settings it loaded');

    const trusted = await evaluateWorkspaceTrust(dir, { projectMcpServers, trustWorkspace: true });
    assert.equal(trusted.isTrusted, true);
    const remembered = await evaluateWorkspaceTrust(dir, { projectMcpServers });
    assert.equal(remembered.isTrusted, true, 'trust is remembered for the same config');

    await writeFile(join(dir, 'server.mjs'), 'console.log(2)');
    const tampered = await evaluateWorkspaceTrust(dir, { projectMcpServers });
    assert.equal(tampered.isTrusted, false, 'editing a referenced script revokes trust');

    const errored = await evaluateWorkspaceTrust(dir, { projectMcpError: true });
    assert.equal(errored.trustRequired, true, 'a corrupt project MCP file still requires a trust decision');
    assert.equal(errored.isTrusted, false);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(dir, { recursive: true, force: true });
  }
});



