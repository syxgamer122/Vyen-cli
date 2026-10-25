# AGENTS.md Hardening & Gap Closure — Design Specification

**Date:** 2026-10-25  
**Topic:** Hardening working agreements, eliminating loopholes, and resolving Windows test failures in `AGENTS.md` and related test suites.  
**Target:** In-place refactoring and hardening (Approach 1).

---

## 1. Context & Motivation

`AGENTS.md` defines the strict working agreements for the `vyen` CLI repository. An empirical audit revealed 8 significant loopholes and technical vulnerabilities:
1. **Character Budget Trap:** The file length is 22,858 characters against a test limit of 23,000 characters (`tests/repo-hygiene.test.mjs`), leaving only 142 characters before breaking the build, and risking silent middle-truncation at 24,000 characters.
2. **Self-Declared Rules (Laws 2, 3, 4):** Lack observable verification boundaries in completion reports.
3. **Normalized Test Failures on Windows:** 5 known platform failures (4 in `tests/files.test.mjs`, 1 in `tests/audit.test.mjs`) leave `npm test` exiting with code 1, normalizing red terminal output.
4. **Build Command Paradox:** Line 443 prescribes `npm run build` while Line 445 warns `npm.cmd` causes `EINVAL` without a shell on Windows.
5. **Law 1 Semantic Void:** `tests/plan-traceability.test.mjs` checks markdown table syntax but cannot detect vacuous or mismatched test mappings.
6. **Phantom Configuration Dependencies:** `AGENTS.md` assumes `~/.config/vyen/memories.json` and `credentials.json` already exist without bootstrap/fallback semantics.
7. **Dead Code vs. Scope Conflict:** Ambiguity between "dead code gets deleted" and "do not refactor code unrelated to the task".
8. **BOM & UTF-8 PowerShell Traps:** Risk of PowerShell cmdlets adding UTF-8 BOM, tripping `tests/repo-hygiene.test.mjs`.

---

## 2. Goals & Non-Goals

### Goals
- **Budget Safety:** Reduce `AGENTS.md` character length from ~22,858 to ~19,500–20,000 characters, creating a 3,000+ character safety buffer below the 23,000 cap.
- **Clean Green Test Suite on Windows:** Add clean platform skips (`t.skip(...)` on `process.platform === 'win32'`) for the 5 POSIX/symlink tests, making `npm test` exit with code 0 (all passing or cleanly skipped).
- **Clear Dead-Code Contract:** Define dual-mode dead-code rules: surgical cleanup during features/fixes; repository-wide cleanup only in dedicated cleanup tasks.
- **Unified Build Guidance:** Remove the conflicting Line 443 build advice; standardize on `node node_modules/typescript/bin/tsc` and `npm test`.
- **Config Bootstrap Semantics:** Explicitly document fallback/creation when `~/.config/vyen/` files are absent.
- **Reinforce Law 2/3/4 Observable Proof:** Mandate explicit proof output in completion reports (E2E command evidence, reviewer subagent output).

### Non-Goals
- Modifying core application runtime logic in `src/`.
- Removing the 24k prompt limit or modifying `src/context.ts`.
- Weakening any security, path containment, or redaction rules.

---

## 3. Detailed Design

### 3.1 Prose Compaction in `AGENTS.md` (Resolving Loopholes 1 & 4)
- Streamline lengthy historical narratives (e.g. detailed stories from October 2026 incidents in Section 2.5 and Section Lessons).
- Condense verbose tables into compact, bulleted working agreements.
- Delete the outdated Line 443 lesson (`run npm run build before node --test...`), preserving only the actionable rule: run `node node_modules/typescript/bin/tsc` directly on Windows when compiling individual test targets.
- Target character reduction: ~3,000 characters freed.

### 3.2 Dual-Mode Dead Code Policy (Resolving Loophole 7)
Section 6 will be refined to explicitly separate two execution modes:
1. **Feature / Bugfix Turn (Surgical):** Delete dead code created by your own changes or within the immediate touched function/module. If you notice unrelated dead code in another file, mention it in the report—do not touch or delete it.
2. **Dedicated Cleanup Task:** When the user explicitly requests dead-code removal or cleanup, full-repo scanning is authorized following the 4 mandatory verification checks (whole tree, tests, fixtures, string literals) in a single standalone commit.

### 3.3 Platform Test Skips on Windows (Resolving Loophole 3)
In the 5 specific platform-bound test cases:
- 4 cases in `tests/files.test.mjs` (POSIX file permissions `0o755`, `0o640`, umask mode restoration, unprivileged symlinks).
- 1 case in `tests/audit.test.mjs` (symlink image escape outside workspace).
Add standard `node:test` platform guards:
```javascript
if (process.platform === 'win32') {
  t.skip('Windows lacks unprivileged symlinks and POSIX file modes');
  return;
}
```
**Outcome:** `npm test` will report 0 failures and exit 0 on Windows, eliminating normalized deviance.

### 3.4 Configuration Fallback & Bootstrap (Resolving Loophole 6)
Update Section 1.1 and Section 6:
- Note that `~/.config/vyen/` may not exist on fresh or Windows environments.
- Specify that missing `credentials.json` or `memories.json` must be treated as empty and bootstrapped/created on demand, rather than assumed pre-populated.

### 3.5 Traceability & Self-Declared Rules Reinforcement (Resolving Loopholes 2, 5, 8)
- Update §2.5 to state explicitly that a Scenarios & Tests table entry must link to a real assertion verifying the criterion behavior (no empty `assert.ok(true)` mocks).
- Reiterate that completion reports must quote fresh command output (Law 3) and subagent reviewer verdict (Law 4) as proof.
- Re-emphasize UTF-8 without BOM tooling requirements for Windows contributors.

---

## 4. Verification Plan

1. **Hygiene & Character Count:**
   - Run `node node_modules/typescript/bin/tsc` (build).
   - Run `node --test tests/repo-hygiene.test.mjs`.
   - Verify character count of `AGENTS.md` is `<= 20,500` (well below `23,000`).
2. **Test Suite Green on Windows:**
   - Run `npm test`.
   - Verify 0 failures, 0 errors, exit code 0.
3. **Plan Traceability Intact:**
   - Run `node --test tests/plan-traceability.test.mjs`.
   - Verify all existing plans still pass traceability.
