# Seam Hardening Phase 2: Configuration Resilience and Safe Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate vulnerabilities related to corrupted configuration, permissive defaults, and unhandled hook failures by enforcing fail-closed configuration parsing, untrusted hook defaults, fail-closed hook timeouts, and environment isolation.

**Architecture:**
1. In `src/settings.ts`, update `loadProjectSettings` to strip UTF-8 BOM, return `{}` only on `ENOENT`, and throw an actionable error on malformed JSON or invalid schema so security rules are never silently discarded.
2. In `src/hooks.ts`, default `HookBus.isTrusted` to `false` when omitted so untrusted environments run zero hooks.
3. In `src/hooks.ts` and `src/harness.ts`, record `timedOut` in `HookExecutionResult` and treat hook timeouts or errors during `PreToolUse` as tool execution denials (`denied: true`).
4. In `src/hooks.ts`, preserve `SSH_AUTH_SOCK` and Git identity environment variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) while stripping credentials.
5. In `tests/hooks.test.mjs`, isolate `process.env.XDG_CONFIG_HOME` to temporary fixture directories to prevent test pollution of user directories.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node.js `node:fs/promises`, `node:child_process`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-seam-hardening-and-security-closure-design.md`

## Global Constraints

- TypeScript 5.9 strict (NodeNext), 0 `@ts-ignore`, 0 `@ts-expect-error` without reason, 0 `as any`.
- `AGENTS.md` + `AGENT_LEARNINGS.md` combined character budget must remain strictly under 23,000 / 24,000 characters.
- Zero BOM in any source or test file.
- All security controls must fail closed, never open (§3.3).
- Clean Windows platform support (path normalizations, non-hanging process trees).

## Review Focus

1. Corrupted `.vyen/settings.json` (syntax error or schema invalidity) must throw an error and abort CLI startup instead of silently discarding deny rules.
2. BOM in `.vyen/settings.json` must be cleanly stripped and parsed without throwing syntax errors.
3. `HookBus` must default `isTrusted` to `false` when omitted, preventing hook execution in untrusted workspaces.
4. `PreToolUse` hook timeouts or spawn crashes must fail closed, denying tool execution.
5. `sanitizeEnvironment` must preserve `SSH_AUTH_SOCK` and `GIT_*` author/committer variables while stripping credential keys.

## Scenarios & Tests

**What the user sees:** Corrupted or invalid configuration files trigger an immediate, informative error rather than silently removing security protections; hooks are disabled by default until explicitly trusted; hanging or crashed security hooks block tool execution rather than allowing uninspected commands; and Git/SSH operations in hooks retain necessary authentication without leaking secrets.

| # | Criterion | Test |
|---|---|---|
| 1 | Malformed settings file throws and fails closed | tests/policy.test.mjs › loadProjectSettings strips BOM, handles ENOENT, and throws on malformed JSON or invalid schema |
| 2 | UTF-8 BOM is stripped and settings parsed cleanly | tests/policy.test.mjs › loadProjectSettings strips BOM, handles ENOENT, and throws on malformed JSON or invalid schema |
| 3 | HookBus defaults isTrusted to false when omitted | tests/hooks.test.mjs › HookBus defaults isTrusted to false when omitted and skips execution |
| 4 | PreToolUse timeout or crash blocks tool execution | tests/hooks.test.mjs › Harness blocks tool execution when PreToolUse hook times out or fails |
| 5 | Environment sanitization preserves SSH and Git identity | tests/hooks.test.mjs › sanitizeEnvironment preserves SSH_AUTH_SOCK and Git identity while stripping secret keys |

---

### Task 1: Fail-Closed Settings Loading & BOM Handling

**Files:**
- Modify: `src/settings.ts:58-69`
- Modify: `tests/policy.test.mjs:9-30`

**Interfaces:**
- Consumes: `projectSettingsSchema`, `projectSettingsPath`
- Produces: `loadProjectSettings(cwd: string): Promise<ProjectSettings>` (throws on corrupted JSON or schema errors, strips BOM, handles `ENOENT`).

- [ ] **Step 1: Write the failing test in `tests/policy.test.mjs`**

Replace the old `missing or malformed project settings file degrades safely` with:
```javascript
test('loadProjectSettings strips BOM, handles ENOENT, and throws on malformed JSON or invalid schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-settings-test-'));
  try {
    // Missing file returns {}
    const missing = await loadProjectSettings(dir);
    assert.deepEqual(missing, {});

    const vyenDir = join(dir, '.vyen');
    await mkdir(vyenDir, { recursive: true });

    // UTF-8 BOM with valid JSON parses correctly
    const validWithBom = '\uFEFF' + JSON.stringify({
      permissions: { deny: ['bash(rm -rf *)'] },
    });
    await writeFile(join(vyenDir, 'settings.json'), validWithBom, 'utf8');
    const parsedBom = await loadProjectSettings(dir);
    assert.deepEqual(parsedBom.permissions?.deny, ['bash(rm -rf *)']);

    // Broken JSON throws error (fail-closed)
    await writeFile(join(vyenDir, 'settings.json'), '{ broken json ', 'utf8');
    await assert.rejects(
      async () => await loadProjectSettings(dir),
      /Failed to parse project settings/
    );

    // Invalid schema throws error (fail-closed)
    await writeFile(join(vyenDir, 'settings.json'), JSON.stringify({
      permissions: { allow: 123 },
    }), 'utf8');
    await assert.rejects(
      async () => await loadProjectSettings(dir),
      /Invalid project settings/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: FAIL because `loadProjectSettings` currently swallows errors into `{}` and does not strip BOM.

- [ ] **Step 3: Implement BOM stripping and fail-closed error handling in `src/settings.ts`**

In `src/settings.ts`:
```typescript
export async function loadProjectSettings(cwd: string): Promise<ProjectSettings> {
  const filePath = projectSettingsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  // Strip leading UTF-8 BOM if present
  const cleaned = raw.replace(/^\uFEFF/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Failed to parse project settings at ${filePath}: ${(error as Error).message}`);
  }

  const result = projectSettingsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid project settings schema at ${filePath}: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts tests/policy.test.mjs
git commit -m "fix(settings): strip UTF-8 BOM and fail closed on malformed settings JSON or invalid schema"
```

---

### Task 2: Untrusted HookBus Default

**Files:**
- Modify: `src/hooks.ts:240-246`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `HookBusOptions`
- Produces: `HookBus` with `isTrusted` defaulting to `false` when omitted.

- [ ] **Step 1: Write the failing test in `tests/hooks.test.mjs`**

Add test proving omitting `isTrusted` defaults to untrusted and skips execution:
```javascript
test('HookBus defaults isTrusted to false when omitted and skips execution', async () => {
  let executed = false;
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
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: FAIL because `this.isTrusted` currently defaults to `true`.

- [ ] **Step 3: Update `HookBus` constructor in `src/hooks.ts`**

Change:
```typescript
this.isTrusted = options.isTrusted ?? false;
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts tests/hooks.test.mjs
git commit -m "fix(hooks): default HookBus isTrusted to false for safe-by-default execution"
```

---

### Task 3: Fail-Closed PreToolUse Hook Timeouts and Errors

**Files:**
- Modify: `src/hooks.ts:30-38,360-384`
- Modify: `src/harness.ts:740-756`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `HookExecutionResult`, `Harness.executeBatch`
- Produces: `HookExecutionResult.timedOut`, fail-closed `PreToolUse` evaluation in Harness.

- [ ] **Step 1: Write the failing test in `tests/hooks.test.mjs`**

Add test proving PreToolUse timeout or crash blocks tool execution:
```javascript
test('Harness blocks tool execution when PreToolUse hook times out or fails', async t => {
  const f = await fixture(t);
  const bus = new HookBus({
    cwd: f.cwd,
    isTrusted: true,
    timeoutMs: 100,
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'node -e "setTimeout(() => {}, 2000)"',
      },
    ],
  });

  const harness = new Harness({
    cwd: f.cwd,
    session: f.session,
    tools: f.tools,
    model: f.model,
    hookBus: bus,
  });

  const [call] = [{ toolCallId: 'call_1', toolName: 'bash', input: { command: 'echo done' } }];
  const [result] = await harness.executeBatch([call], new AbortController().signal);
  assert.equal(result.output.type, 'error-text');
  assert.match(result.output.value, /Tool execution blocked.*timed out/i);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: FAIL because timeouts currently return `denied: false` and `Harness` only checks `h.denied`.

- [ ] **Step 3: Implement `timedOut` tracking and fail-closed check in `src/hooks.ts` and `src/harness.ts`**

1. In `src/hooks.ts`:
   Add `timedOut?: boolean;` to `HookExecutionResult`.
   In `child.on('close')`:
   ```typescript
   resolvePromise({
     executed: true,
     exitCode,
     stdout,
     stderr,
     denied,
     timedOut: Boolean(timedOut),
     injectedContext,
     error,
   });
   ```
2. In `src/harness.ts:745`:
   ```typescript
   const failedPreHook = preHooks.find(h => h.denied || h.timedOut || Boolean(h.error));
   if (failedPreHook) {
     denied = true;
     meta.durationMs = Date.now() - startedMs;
     const reason = failedPreHook.denied
       ? (failedPreHook.stderr?.trim() || 'Tool execution denied by PreToolUse hook.')
       : (failedPreHook.error || (failedPreHook.timedOut ? 'PreToolUse hook timed out.' : 'PreToolUse hook failed.'));
     output = {
       type: 'error-text',
       value: `Tool execution blocked: ${reason}`,
     };
     this.emit({ type: 'tool', name: call.toolName, id: call.toolCallId, state: 'error', meta });
     return { type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: call.toolName, output };
   }
   ```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts src/harness.ts tests/hooks.test.mjs
git commit -m "fix(security): fail closed on PreToolUse hook timeouts and execution errors"
```

---

### Task 4: Environment Sanitization & Test Isolation

**Files:**
- Modify: `src/hooks.ts:197-209`
- Modify: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `sanitizeEnvironment`
- Produces: `sanitizeEnvironment` that preserves `SSH_AUTH_SOCK` and `GIT_*` identity while stripping secrets.

- [ ] **Step 1: Write the failing test in `tests/hooks.test.mjs`**

Add tests proving `SSH_AUTH_SOCK` and Git identity are preserved, and isolate `XDG_CONFIG_HOME`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: FAIL because `SSH_AUTH_SOCK` is currently stripped by the `/AUTH/` regex match.

- [ ] **Step 3: Implement preserved environment variables list in `src/hooks.ts`**

In `src/hooks.ts:197-209`:
```typescript
const PRESERVED_ENV_KEYS = new Set([
  'SSH_AUTH_SOCK',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

export function sanitizeEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const protectedBase = childEnv(baseEnv);
  const clean: NodeJS.ProcessEnv = {};
  const sensitivePattern = /KEY|TOKEN|SECRET|AUTH|PASS|CREDENTIAL|PRIVATE/i;

  for (const [key, value] of Object.entries(protectedBase)) {
    if (!key) continue;
    if (PRESERVED_ENV_KEYS.has(key)) {
      clean[key] = value;
      continue;
    }
    if (sensitivePattern.test(key) || key === 'VYEN_API_KEY') {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}
```

In `tests/hooks.test.mjs`:
Isolate `process.env.XDG_CONFIG_HOME` in `test('project hooks require workspace trust and hash changes invalidate trust')` so it uses a temp dir:
```javascript
const oldXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(dir, '.config');
try {
  ...
} finally {
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
}
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts tests/hooks.test.mjs
git commit -m "fix(hooks): preserve SSH_AUTH_SOCK and git identity in sanitized environment and isolate test configs"
```

---

### Task 5: Full Verification & Gatekeeper Checks

- [ ] **Step 1: Run plan-traceability guard**

Run: `node --test tests/plan-traceability.test.mjs`
Expected: Pass all tests.

- [ ] **Step 2: Run repo hygiene guard**

Run: `node --test tests/repo-hygiene.test.mjs`
Expected: Pass all tests (0 BOM, budget cap intact).

- [ ] **Step 3: Run full typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors, 0 warnings.
