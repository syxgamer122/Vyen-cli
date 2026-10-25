# Documentation Drift Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile 7 documentation drift issues across `docs/SPEC.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, and `docs/ROADMAP.md` with verifiable automated contract tests.

**Architecture:** Extend `tests/docs-contract.test.mjs` with automated contract checks verifying versioning, URL normalization, session lifecycle semantics, language exceptions, workspace trust scope, release notes, and module counts. Update the 5 documentation files to satisfy these contracts while maintaining the strict 23,000 character limit in `AGENTS.md` + `AGENT_LEARNINGS.md`.

**Tech Stack:** Markdown, Node.js (`node:test`), TypeScript 5.9.

**Spec:** [docs/superpowers/specs/2026-10-25-doc-synchronization-design.md](file:///c:/Users/Admin/Downloads/Vyen-cli-main/docs/superpowers/specs/2026-10-25-doc-synchronization-design.md)

## Global Constraints

- Strict character budget: combined length of `AGENTS.md` and `AGENT_LEARNINGS.md` must not exceed 23,000 characters (`tests/repo-hygiene.test.mjs`).
- No BOM in any source or documentation files (`tests/repo-hygiene.test.mjs`).
- Zero changes to functional code in `src/*.ts`.
- English for code, comments, specs, tests, and commit messages; Vietnamese explicitly allowed and maintained for `README.md` and `CHANGELOG.md`.
- Every numbered item in `## Review Focus` must have an exact 1:1 matching row in `## Scenarios & Tests` referencing an assertion in `tests/docs-contract.test.mjs`.

## Review Focus

1. SPEC documents version-agnostic title, Base URL /v1 normalization, and subagent session lifecycle distinction
2. AGENTS.md documents Vietnamese language exception, additional docs, and maintains character budget under 23000
3. README.md documents that --trust-workspace activates both permissions.allow and hooks
4. CHANGELOG.md records 0.4.0 release notes for settings, permissions, hooks, and workspace trust
5. ROADMAP.md reflects completed Phase 1, 28 modules, and 5 Windows platform skips with zero test failures

## Scenarios & Tests

**What the user sees:** Users and developers reading `docs/SPEC.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, and `docs/ROADMAP.md` encounter fully aligned documentation matching actual 0.4.0 code capabilities, with zero contradictions regarding test results, module counts, workspace trust, or session lifecycle.

| # | Criterion | Test |
|---|---|---|
| 1 | SPEC documents version-agnostic title, Base URL /v1 normalization, and subagent session lifecycle distinction | tests/docs-contract.test.mjs › SPEC documents version-agnostic title, Base URL /v1 normalization, and subagent session lifecycle distinction |
| 2 | AGENTS.md documents Vietnamese language exception, additional docs, and maintains character budget under 23000 | tests/docs-contract.test.mjs › AGENTS.md documents Vietnamese language exception, additional docs, and maintains character budget under 23000 |
| 3 | README.md documents that --trust-workspace activates both permissions.allow and hooks | tests/docs-contract.test.mjs › README.md documents that --trust-workspace activates both permissions.allow and hooks |
| 4 | CHANGELOG.md records 0.4.0 release notes for settings, permissions, hooks, and workspace trust | tests/docs-contract.test.mjs › CHANGELOG.md records 0.4.0 release notes for settings, permissions, hooks, and workspace trust |
| 5 | ROADMAP.md reflects completed Phase 1, 28 modules, and 5 Windows platform skips with zero test failures | tests/docs-contract.test.mjs › ROADMAP.md reflects completed Phase 1, 28 modules, and 5 Windows platform skips with zero test failures |

---

### Task 1: Add Failing Documentation Contract Tests

**Files:**
- Modify: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: Node test runner `node:test`, `node:assert/strict`, `readFile` from `node:fs/promises`
- Produces: 5 new tests asserting the synchronized document contracts across the 5 files

- [ ] **Step 1: Write the failing tests in `tests/docs-contract.test.mjs`**

Add 5 tests:
1. `SPEC documents version-agnostic title, Base URL /v1 normalization, and subagent session lifecycle distinction`
2. `AGENTS.md documents Vietnamese language exception, additional docs, and maintains character budget under 23000`
3. `README.md documents that --trust-workspace activates both permissions.allow and hooks`
4. `CHANGELOG.md records 0.4.0 release notes for settings, permissions, hooks, and workspace trust`
5. `ROADMAP.md reflects completed Phase 1, 28 modules, and 5 Windows platform skips with zero test failures`

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run: `node --test tests/docs-contract.test.mjs`
Expected: FAIL on the 5 new tests asserting document contents that have not been updated yet.

- [ ] **Step 3: Verify plan traceability test passes**

Run: `node --test tests/plan-traceability.test.mjs`
Expected: PASS (confirms plan titles match test titles in `tests/docs-contract.test.mjs`).

- [ ] **Step 4: Commit test suite changes**

```bash
git add tests/docs-contract.test.mjs docs/superpowers/plans/2026-10-25-doc-synchronization.md
git commit -m "test(docs): add failing contracts for doc drift synchronization"
```

---

### Task 2: Synchronize `docs/SPEC.md` and `AGENTS.md` (with Character Budget Compaction)

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `AGENTS.md`
- Test: `tests/docs-contract.test.mjs`
- Test: `tests/repo-hygiene.test.mjs`

**Interfaces:**
- Consumes: Specifications from `docs/superpowers/specs/2026-10-25-doc-synchronization-design.md`
- Produces: Updated `docs/SPEC.md` and compacted `AGENTS.md` passing tests 1 and 2

- [ ] **Step 1: Update `docs/SPEC.md`**
- Change title to `# Vyen CLI`.
- In Base URL section: document that gateways (`api.yuristore.xyz`, `localhost:8000`, `127.0.0.1:8000`) automatically append `/v1` when the path is omitted.
- In Session Lifecycle & Boundaries: clarify that subagents own dedicated child `SessionStore` instances and invoke `endSession()` on cleanup, whereas ephemeral runners (Agent Network rounds, workflow prompt steps with `sessionLifecycle = false`) inherit tool hooks without triggering global `SessionStart`/`SessionEnd` events.
- Update reference: change `See REFERENCE_REVIEW.md` to `See [REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md)`.

- [ ] **Step 2: Update and compact `AGENTS.md`**
- In `## 4. Docs`: add `docs/MCP.md`, `docs/AUDIT.md`, and `docs/ROADMAP.md`.
- In `## 5. Language`: add explicit note that `README.md` and `CHANGELOG.md` are maintained in Vietnamese.
- In `§3.4`: clarify subagent child session stores vs ephemeral runners with `sessionLifecycle: false`.
- Compact verbose prose in introductory paragraphs and §1.1 to free at least 180 characters, ensuring `AGENTS.md` + `AGENT_LEARNINGS.md` remains comfortably $\le 22,850$ characters.

- [ ] **Step 3: Run contract and hygiene tests**

Run: `node --test tests/docs-contract.test.mjs tests/repo-hygiene.test.mjs`
Expected: Tests 1 and 2 PASS, repo hygiene PASS (character count $\le 23,000$).

- [ ] **Step 4: Commit SPEC and AGENTS changes**

```bash
git add docs/SPEC.md AGENTS.md
git commit -m "docs(spec,agents): synchronize lifecycle, language exceptions, and spec header"
```

---

### Task 3: Synchronize `README.md` and `CHANGELOG.md`

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: Vietnamese documentation standards
- Produces: Updated `README.md` and `CHANGELOG.md` passing tests 3 and 4

- [ ] **Step 1: Update `README.md`**
- In the Workspace Trust section, explicitly document that `--trust-workspace` is required for both `hooks` and `permissions.allow` in `.vyen/settings.json`, and that the SHA-256 hash covers both the settings file and scripts referenced in `permissions.allow`.

- [ ] **Step 2: Update `CHANGELOG.md`**
- Under `## 0.4.0`, add complete release bullet points for:
  - Layered Settings (`.vyen/settings.json`) with `permissions.allow`, `permissions.ask`, `permissions.deny`.
  - Lifecycle Hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, etc.) with JSON stdin/stdout, fail-closed handling (exit code 2), and clean environment.
  - Workspace Trust verification (`--trust-workspace`) for hooks and allow scripts.
  - CLI override flags `--allowed-tools` and `--disallowed-tools`.
  - One-time default gateway warning for `DEFAULT_GATEWAY_URL`.

- [ ] **Step 3: Run contract tests**

Run: `node --test tests/docs-contract.test.mjs`
Expected: Tests 3 and 4 PASS.

- [ ] **Step 4: Commit README and CHANGELOG changes**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(readme,changelog): document workspace trust scope and 0.4.0 settings and hooks"
```

---

### Task 4: Synchronize `docs/ROADMAP.md`

**Files:**
- Modify: `docs/ROADMAP.md`
- Test: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: Roadmap status updates
- Produces: Updated `docs/ROADMAP.md` passing test 5

- [ ] **Step 1: Update `docs/ROADMAP.md`**
- In Section 1.1:
  - Update `Source size` module count from 25 to 28 modules.
  - Update `Test suite` and add clarification that 5 platform-specific test cases (POSIX mode bits and symlinks) are cleanly skipped on Windows (`process.platform === 'win32'`), achieving exit code 0 with 0 failures.
  - Update `Vyen extension seams` and `Vyen permission rules` to acknowledge completion of HookBus, Layered Settings, and Policy Engine.
- In Section 2.2 / Phase 1: mark R1.1 (Layered settings) and R1.2 (Hook bus) as Completed (2026-10-25).
- In Section 8.1: update release gate description to state 0 failures with 5 platform skips on Windows.
- In Appendix A: note that the 5 Windows platform limitations are cleanly skipped on Windows as of 2026-10-25.

- [ ] **Step 2: Run contract test**

Run: `node --test tests/docs-contract.test.mjs`
Expected: Test 5 PASS (all 8 tests in `docs-contract.test.mjs` green).

- [ ] **Step 3: Commit ROADMAP changes**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): mark phase 1 completed, update module count to 28, and record windows test skips"
```

---

### Task 5: Full Verification and Review

**Files:**
- Verification only

- [ ] **Step 1: Run full gate checks**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: 0 errors in lint/typecheck, `npm test` exits 0 with 0 failures.

- [ ] **Step 2: Run repo hygiene and traceability checks**

Run:
```bash
node --test tests/repo-hygiene.test.mjs
node --test tests/plan-traceability.test.mjs
```
Expected: PASS.

- [ ] **Step 3: Invoke independent code review**

Use subagent code reviewer to inspect the synchronized changes across all 5 files.
