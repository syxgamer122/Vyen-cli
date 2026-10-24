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
