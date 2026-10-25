# Seam Hardening Phase 4: Polish, Documentation Truth, and Contract Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final 7 audit findings (Items 7, 8, 10, 11, 12, 15b, 17, 18, 19) by normalizing matcher casing, adding cancellable hook dispatch via `AbortSignal`, enforcing POSIX path case-sensitivity, removing unused context fields, writing real settings integration tests, and aligning SPEC/README with implemented hook contracts.

**Architecture:**
1. In `src/hooks.ts`, normalize matcher tool comparison to case-insensitive (`Bash` matches `bash`), and add `signal?: AbortSignal` support to `HookBus.dispatch` to abort running hook processes.
2. In `src/policy.ts`, make file path matching case-sensitive on POSIX (`process.platform !== 'win32'`) while keeping tool names canonical, remove unused `mode` field from `PolicyEvaluationContext`, and clarify precedence comments.
3. In `tests/policy.test.mjs`, create real `.vyen/settings.json` integration fixtures testing CLI flag precedence (`--allowed-tools`).
4. In `docs/SPEC.md`, `README.md`, `docs/ROADMAP.md`, and `src/help.ts`, document the 8-event hook table, disclose Claude Code inspiration and parameter mappings, document project-only hook location, and clarify that `--trust-workspace` re-records trust on every invocation.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node.js `node:child_process`, `node:test`, Markdown.

**Spec:** `docs/superpowers/specs/2026-10-25-seam-hardening-and-security-closure-design.md` (Increment 4)

## Global Constraints

- TypeScript 5.9 strict (NodeNext), 0 `@ts-ignore`, 0 `@ts-expect-error` without reason, 0 `as any`.
- Combined instructions budget (`AGENTS.md` + `AGENT_LEARNINGS.md` + 2) must remain <= 23,000 characters.
- Zero BOM in any source or test file.
- All new tests proven RED before GREEN.
- Respect POSIX vs Windows platform semantics without breaking existing platform skips.

## Review Focus

1. `matchesHook` matches tool names case-insensitively (`Bash` matches `bash` and `WRITE_FILE` matches `write_file`).
2. `HookBus.dispatch` respects `AbortSignal` and terminates running child processes on abort.
3. File path matching is case-sensitive on POSIX (`process.platform !== 'win32'`) while tool names remain canonical lowercase.
4. Settings fixtures with CLI `--allowed-tools` flags enforce precedence over project allow rules.
5. SPEC and README document the 8 hook events table and disclose Claude Code inspiration.

## Scenarios & Tests

**What the user sees:** Hook definitions can use standard capitalization (`matcher: "Bash"`) without failing; hanging hook commands cancel immediately when operations are aborted; path permissions on Linux/macOS strictly enforce case-sensitivity; and documentation clearly discloses all 8 hook events, exit code semantics, and workspace trust requirements.

| # | Criterion | Test |
|---|---|---|
| 1 | matchesHook matches tool names case-insensitively | tests/hooks.test.mjs › matchesHook matches tool names case-insensitively |
| 2 | HookBus dispatch terminates child process on AbortSignal | tests/hooks.test.mjs › HookBus dispatch aborts child process when AbortSignal triggers |
| 3 | File path matching is case-sensitive on POSIX | tests/policy.test.mjs › file path matching is case-sensitive on POSIX systems |
| 4 | Settings fixture and CLI allowed tools enforce precedence | tests/policy.test.mjs › settings fixture and CLI allowed tools flags enforce precedence |
| 5 | SPEC documents 8 hook events table and Claude Code inspiration | tests/docs-contract.test.mjs › SPEC documents the 8 hook events table and Claude Code inspiration |

---

### Task 1: Hook Matcher Casing & AbortSignal Dispatch

**Files:**
- Modify: `src/hooks.ts:230-280,313-390`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `HookBus.dispatch(event: HookEvent, payload: Record<string, unknown>, signal?: AbortSignal)`
- Produces: Case-insensitive matcher matching and cancellable hook execution.

- [ ] **Step 1: Write the failing tests in `tests/hooks.test.mjs`**

Add tests proving case-insensitive matchers and AbortSignal cancellation:
```javascript
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

  assert.ok(elapsed < 2000, `aborted hook must return quickly, took ${elapsed}ms`);
  assert.equal(results.length, 1);
  assert.ok(results[0].error?.includes('abort') || results[0].exitCode !== 0);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: FAIL because `matchesHook` does not lowercase `matcher` before matching, and `HookBus.dispatch` does not accept `signal`.

- [ ] **Step 3: Implement case-insensitive matcher and AbortSignal in `src/hooks.ts`**

1. In `matchesHook`:
   ```typescript
   if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
     const rawTool = typeof payload.tool === 'string' ? payload.tool : '';
     const toolName = rawTool.toLowerCase();
     const m = matcher.toLowerCase();
     if (m === toolName || normalizeToolName(m) === toolName) return true;
     if (m.endsWith('*') && toolName.startsWith(m.slice(0, -1))) return true;
     return false;
   }
   ```
2. In `HookBus.dispatch`:
   Add `signal?: AbortSignal` to signature and check `if (signal?.aborted) return [];`.
3. In `executeCommand`:
   Pass `signal?: AbortSignal` and attach `signal?.addEventListener('abort', ...)` to kill child process immediately.

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts tests/hooks.test.mjs
git commit -m "feat(hooks): case-insensitive tool matcher and AbortSignal hook cancellation"
```

---

### Task 2: POSIX Case-Sensitivity & Policy Cleanup

**Files:**
- Modify: `src/policy.ts:12-20,42-60,71-83`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: `matchSimplePattern`, `PolicyEvaluationContext`
- Produces: Case-sensitive path matching on POSIX, clean `PolicyEvaluationContext` without unused `mode`.

- [ ] **Step 1: Write the failing test in `tests/policy.test.mjs`**

Add test proving POSIX case-sensitivity for file arguments:
```javascript
test('file path matching is case-sensitive on POSIX systems', () => {
  const isWin = process.platform === 'win32';
  const ctx = {
    projectRules: {
      deny: ['read_file(Secret.txt)'],
    },
  };

  const decisionExact = evaluateToolPolicy({ tool: 'read_file', input: { path: 'Secret.txt' } }, ctx);
  assert.equal(decisionExact, 'deny');

  const decisionLower = evaluateToolPolicy({ tool: 'read_file', input: { path: 'secret.txt' } }, ctx);
  if (isWin) {
    assert.equal(decisionLower, 'deny', 'Windows is case-insensitive');
  } else {
    assert.equal(decisionLower, 'default', 'POSIX must be case-sensitive');
  }
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: On POSIX (or simulated), `matchSimplePattern` previously used `toLowerCase()` unconditionally.

- [ ] **Step 3: Implement POSIX case-sensitivity and remove unused `mode` in `src/policy.ts`**

1. Remove `mode?: PermissionMode;` from `PolicyEvaluationContext`.
2. In `matchSimplePattern(pattern, text, isPath = false)`:
   If `isPath && process.platform !== 'win32'`, compare strings case-sensitively.
3. In `matchToolPattern`: pass `isPath = true` for non-bash tool argument patterns.

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts tests/policy.test.mjs
git commit -m "fix(policy): enforce POSIX path case-sensitivity and remove dead mode field"
```

---

### Task 3: Settings Fixture & CLI Precedence Test

**Files:**
- Modify: `tests/policy.test.mjs`

- [ ] **Step 1: Write the test in `tests/policy.test.mjs`**

Add real fixture test verifying CLI flag override precedence over layered settings:
```javascript
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

  // CLI disallowed overrides project allow
  const ctxDisallow = {
    cliDisallowed: ['read_file'],
    projectRules: settings.permissions,
  };
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'safe.txt' } }, ctxDisallow),
    'deny',
  );

  // CLI allowed overrides ask/default but NOT persistent user/project deny
  const ctxAllow = {
    cliAllowed: ['read_file'],
    projectRules: settings.permissions,
  };
  // Explicit deny rule stays denied
  assert.equal(
    evaluateToolPolicy({ tool: 'read_file', input: { path: 'private.txt' } }, ctxAllow),
    'deny',
  );

  await rm(dir, { recursive: true, force: true }).catch(() => {});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: Passes cleanly.

- [ ] **Step 3: Commit**

```bash
git add tests/policy.test.mjs
git commit -m "test(policy): add real settings fixture and CLI flag precedence test"
```

---

### Task 4: Documentation Contract Truth & Spec Sync

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`
- Modify: `src/help.ts`
- Modify: `tests/docs-contract.test.mjs`

- [ ] **Step 1: Write the failing test in `tests/docs-contract.test.mjs`**

Add contract assertions:
```javascript
test('SPEC documents the 8 hook events table and Claude Code inspiration', async () => {
  const [spec, readme, roadmap, help] = await Promise.all([
    readFile('docs/SPEC.md', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('docs/ROADMAP.md', 'utf8'),
    readFile('src/help.ts', 'utf8'),
  ]);

  // Hook event matrix in SPEC
  for (const event of [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PreCompact', 'Stop',
  ]) {
    assert.match(spec, new RegExp(`\\|\\s*${event}\\s*\\|`));
  }

  // Claude Code disclosure
  assert.match(spec, /Claude Code/i);
  assert.match(roadmap, /Claude Code/i);

  // --trust-workspace documented
  assert.match(help, /--trust-workspace/);
  assert.match(readme, /--trust-workspace/);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/docs-contract.test.mjs`
Expected: FAIL because SPEC table and Claude Code disclosure are not yet formatted.

- [ ] **Step 3: Update `docs/SPEC.md`, `README.md`, `docs/ROADMAP.md`, `src/help.ts`**

1. In `docs/SPEC.md`: add the full 8-event table with Payload, Exit 2 denial, Exit 0 context injection, and Claude Code design disclosure.
2. In `README.md`: document project hooks in `.vyen/settings.json`, `--trust-workspace` re-hashing, and exit code semantics.
3. In `docs/ROADMAP.md`: record resolution of R1.1/R1.2 audit items 7, 8, 17, 18, 19.
4. In `src/help.ts`: ensure `--trust-workspace` entry is documented.

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/docs-contract.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md README.md docs/ROADMAP.md src/help.ts tests/docs-contract.test.mjs
git commit -m "docs: document 8 hook events table, Claude Code disclosure, and trust workspace facts"
```

---

### Task 5: Full Verification & Code Review Gate

- [ ] **Step 1: Run plan-traceability guard**
  Run: `node --test tests/plan-traceability.test.mjs`
- [ ] **Step 2: Run repo hygiene guard**
  Run: `node --test tests/repo-hygiene.test.mjs`
- [ ] **Step 3: Run full typecheck and lint**
  Run: `npm run typecheck && npm run lint`
- [ ] **Step 4: Run complete test suite**
  Run: `npm test`
- [ ] **Step 5: Code Review**
  Invoke `requesting-code-review` subagent for independent sign-off.
