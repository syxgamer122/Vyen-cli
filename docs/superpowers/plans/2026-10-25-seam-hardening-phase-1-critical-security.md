# Seam Hardening Phase 1: Critical Security Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the two Critical security audit vulnerabilities in `vyen` by implementing segment-aware `deny` rules for compound shell commands and comprehensive workspace trust hashing covering executables in `permissions.allow`.

**Architecture:** 
1. In `src/policy.ts`, enhance `matchToolPattern` so that `bash` deny evaluations tokenize compound command separators (`;&|`, newlines, `$()`, backticks) and strip command wrappers (`sudo`, `sh -c`), denying any command if any segment matches a deny rule.
2. In `src/hooks.ts` and `src/cli.ts`, expand `calculateWorkspaceTrustHash` to discover and hash all script/executable targets referenced in `permissions.allow` alongside hook commands, using a `file:<path>:missing` sentinel for non-existent targets so subsequent file creation revokes trust.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node.js `node:crypto`, `node:fs/promises`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-seam-hardening-and-security-closure-design.md`

## Global Constraints

- TypeScript 5.9 strict (NodeNext), 0 `@ts-ignore`, 0 `@ts-expect-error` without reason, 0 `as any`.
- `AGENTS.md` character budget must remain strictly under 23,000 / 24,000 characters.
- Zero BOM in any source or test file.
- All 4 execution runners (`cli.ts`, `subagents.ts`, `network.ts`, `workflow.ts`) must respect security rules.
- Security controls must fail closed, never open (§3.3).

## Review Focus

1. `deny: ['bash(rm *)']` must block compound commands prepended with benign commands (`echo hi; rm -rf /` or `cd . && rm -rf /`).
2. `deny: ['bash(rm *)']` must block commands wrapped with privilege escalators (`sudo rm -rf /`) or shell wrappers (`sh -c 'rm -rf /'`).
3. Modifying an allow-referenced script (e.g. `./scripts/deploy.sh`) must change the trust hash and revoke workspace trust.
4. An allow rule referencing a non-existent script must record a `missing` sentinel so creating the script later changes the hash.
5. Benign unchained commands in allow rules (e.g. `git status`) must remain allowed without regression.

## Scenarios & Tests

**What the user sees:** Users and automated environments are protected from command injection and malicious repository scripts: chained commands containing denied segments are blocked immediately, and modifying an auto-allowed script automatically revokes workspace trust and forces interactive user re-approval.

| # | Criterion | Test |
|---|---|---|
| 1 | Deny rules block chained and compound commands | tests/policy.test.mjs › deny rules with bash patterns block compound, chained, and wrapped commands |
| 2 | Deny rules block wrapped commands (sudo, sh -c) | tests/policy.test.mjs › deny rules with bash patterns block compound, chained, and wrapped commands |
| 3 | Modifying an allow-referenced script invalidates workspace trust | tests/hooks.test.mjs › calculateWorkspaceTrustHash covers executables in project allow rules and changes on script modification or creation |
| 4 | Non-existent script target records missing sentinel and invalidates on creation | tests/hooks.test.mjs › calculateWorkspaceTrustHash covers executables in project allow rules and changes on script modification or creation |
| 5 | Benign commands continue to be allowed without regression | tests/policy.test.mjs › bare bash allow rules reject chained or compound commands |

---

### Task 1: Segment-Aware Deny Rules for Bash Commands

**Files:**
- Modify: `src/policy.ts:65-105`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: `extractToolArgumentString`, `matchSimplePattern`
- Produces: `matchToolPattern(pattern: string, request: ToolRequest, options: { isAllow?: boolean; cwd?: string })`

- [ ] **Step 1: Write the failing test in `tests/policy.test.mjs`**

Add test proving prepended and wrapped commands bypass deny rules:
```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: FAIL with `AssertionError: 'default' !== 'deny'` for chained commands.

- [ ] **Step 3: Implement segment-aware deny matching in `src/policy.ts`**

In `matchToolPattern`, when `canonicalRequestTool === 'bash'` and `!options.isAllow`:
1. Split `argStr` on compound command operators: `/[;\r\n|&]+|\$\(|\`/`.
2. For each segment, strip whitespace and command wrappers (`/^(?:sudo|env|sh\s+-c|bash\s+-c)\s+/i`, surrounding quotes).
3. If `matchSimplePattern(rawArgPattern, segment)` returns `true` for any segment, return `true`.

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/policy.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts tests/policy.test.mjs
git commit -m "fix(security): make bash deny rules segment-aware against chained and wrapped commands"
```

---

### Task 2: Allow Script Trust Hashing & Missing File Sentinel

**Files:**
- Modify: `src/hooks.ts:60-105`
- Modify: `src/cli.ts:812-825`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `calculateWorkspaceTrustHash(cwd: string, commands: string[]): Promise<string>`
- Produces: Updated `calculateWorkspaceTrustHash` that hashes scripts from allow rules with `missing` sentinel for absent files.

- [ ] **Step 1: Write the failing test in `tests/hooks.test.mjs`**

Add test proving allow script modification or creation invalidates trust:
```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: FAIL because `calculateWorkspaceTrustHash` currently skips non-existent files without a sentinel and doesn't unpack `bash(...)` wrappers.

- [ ] **Step 3: Implement allow script extraction and missing file sentinel in `src/hooks.ts` and `src/cli.ts`**

1. In `src/cli.ts`:
   Extract commands and allow patterns:
   ```typescript
   const hookCommands = (layered.hooks ?? []).map(h => h.command);
   const allowCommands = (layered.projectPermissions?.allow ?? []);
   const allTrustTargets = [...hookCommands, ...allowCommands];
   const hash = await calculateWorkspaceTrustHash(runtime.cwd, allTrustTargets);
   ```
2. In `src/hooks.ts:calculateWorkspaceTrustHash`:
   - Strip tool wrappers (e.g., `bash(...)` -> content inside parentheses).
   - Tokenize tokens as paths.
   - For each potential local path:
     - If it exists and is a file: `hasher.update('file:' + cleanToken + ':'); hasher.update(content);`
     - If it does not exist: `hasher.update('file:' + cleanToken + ':missing');`

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `node node_modules/typescript/bin/tsc; node --test tests/hooks.test.mjs`
Expected: All tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts src/cli.ts tests/hooks.test.mjs
git commit -m "fix(security): include project allow scripts and missing file sentinels in workspace trust hash"
```

---

### Task 3: Full Gate & Plan Traceability Verification

- [ ] **Step 1: Run plan-traceability guard**

Run: `node --test tests/plan-traceability.test.mjs`
Expected: Pass 4/4 tests with 0 errors.

- [ ] **Step 2: Run repo hygiene guard**

Run: `node --test tests/repo-hygiene.test.mjs`
Expected: Pass 5/5 tests (0 BOM, budget cap intact).

- [ ] **Step 3: Run full typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors, 0 warnings.
