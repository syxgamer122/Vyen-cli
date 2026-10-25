# AGENTS.md Hardening & Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 8 loopholes and technical vulnerabilities in AGENTS.md, streamline character budget below 20,500 characters, and make npm test exit code 0 cleanly on Windows.

**Architecture:** Refactor AGENTS.md prose in-place to free >2,500 characters; resolve build paradox and dead-code ambiguities; add standard platform skips to 5 Windows-incompatible tests; enforce observable proof for Laws 1-4.

**Tech Stack:** TypeScript, Node.js (`node:test`), Markdown.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-md-hardening-design.md`

## Global Constraints

- Stay under 24,000 characters for `AGENTS.md` (and under `23,000` per `tests/repo-hygiene.test.mjs`).
- No `@ts-ignore` or un-annotated `@ts-expect-error`.
- No BOM on any source or markdown file.
- No weakening security, path containment, or credential redaction invariants.
- Do not edit gatekeeper tests to weaken assertions.

## Review Focus

1. AGENTS.md character count stays strictly below prompt cap buffer (<= 20,500 chars).
2. All source and instruction files carry no byte-order mark (BOM).
3. Every Review Focus criterion maps directly to an existing test in the test suite.
4. File edits preserve line ending normalization (CRLF/LF) and reject ambiguous replacements.
5. Backups and patch restoration cleanly revert modified, added, and deleted files.

## Scenarios & Tests

**What the user sees:** After this plan runs, `AGENTS.md` is ~3,000 characters lighter, all 8 loopholes are closed, and running `npm test` on Windows completes with 0 failures (Exit code 0).

| # | Criterion | Test |
|---|---|---|
| 1 | AGENTS.md character count stays strictly below prompt cap buffer | tests/repo-hygiene.test.mjs › AGENTS.md fits under the prompt cap with room to spare |
| 2 | All source and instruction files carry no byte-order mark | tests/repo-hygiene.test.mjs › source files carry no byte-order mark |
| 3 | Every Review Focus criterion maps directly to an existing test | tests/plan-traceability.test.mjs › every Review Focus criterion has a row in the Scenarios & Tests table |
| 4 | File edits preserve line ending normalization and reject ambiguous replacements | tests/files.test.mjs › exact edit rejects ambiguous replacements and supports explicit replaceAll |
| 5 | Backups and patch restoration cleanly revert modified, added, and deleted files | tests/files.test.mjs › applyPatch supports Add/Update/Delete and restoreBackups reverts modified, added, and deleted files |

---

### Task 1: Compact AGENTS.md Prose & Resolve Build Paradox
**Files:**
- Modify: `AGENTS.md:1-458`
- Test: `tests/repo-hygiene.test.mjs`

- [x] Step 1: Read `AGENTS.md` and identify verbose narrative sections (historical incident recounting in §2.5, intro, and §Lessons).
- [x] Step 2: Streamline prose, removing duplicate storytelling while preserving all operational rules.
- [x] Step 3: Remove conflicting Line 443 (`run npm run build before node --test...`), standardizing on `node node_modules/typescript/bin/tsc` and `npm test`.
- [x] Step 4: Verify character count is <= 20,500 using `tests/repo-hygiene.test.mjs`.

### Task 2: Refine Dead Code Policy & Config Fallback Semantics
**Files:**
- Modify: `AGENTS.md:312-340` (Section 6)
- Modify: `AGENTS.md:95-105` (Section 1.1)

- [x] Step 1: Update Section 6 to establish dual-mode dead-code rules: surgical cleanup during feature/bugfix turns; whole-repo sweeping only in dedicated cleanup tasks.
- [x] Step 2: Add explicit fallback/bootstrap instructions for `~/.config/vyen/` (`credentials.json` and `memories.json` bootstrap on demand when missing).
- [x] Step 3: Verify no BOM is introduced and character count remains safely within the cap.

### Task 3: Strengthen Law 1-4 Verification & BOM Prevention Guidance
**Files:**
- Modify: `AGENTS.md:190-265` (Section 2.5)
- Modify: `AGENTS.md:367-385` (Section 8)

- [x] Step 1: Update §2.5 to mandate that Scenarios & Tests rows must target assertions verifying actual criterion behavior, not vacuous mocks.
- [x] Step 2: Update checklist in §1 and §10 to require explicit terminal command evidence for Law 3 and reviewer subagent verification output for Law 4 in completion reports.
- [x] Step 3: Re-emphasize UTF-8 without BOM tooling instructions for Windows environments in §8.

### Task 4: Add Clean Windows Platform Skips to Known Failing Tests
**Files:**
- Modify: `tests/files.test.mjs:10-85`
- Modify: `tests/audit.test.mjs:105-125`
- Modify: `AGENTS.md:35-50` (Section 1)

- [x] Step 1: In `tests/files.test.mjs`, add `if (process.platform === 'win32') { t.skip('Windows lacks unprivileged symlinks / POSIX file modes'); return; }` to the 4 platform-failing tests.
- [x] Step 2: In `tests/audit.test.mjs`, add the same Windows platform skip to the unprivileged symlink escape test.
- [x] Step 3: Update `AGENTS.md` §1 to note that Windows platform tests are cleanly skipped, so `npm test` must report 0 failures (Exit 0).
- [x] Step 4: Run `node --test tests/files.test.mjs tests/audit.test.mjs` and confirm 0 failures, 5 skipped, Exit 0.

### Task 5: Full Suite Verification & Traceability Guard Check
**Files:**
- Test: `tests/plan-traceability.test.mjs`
- Test: `tests/repo-hygiene.test.mjs`

- [x] Step 1: Run `node --test tests/plan-traceability.test.mjs` to ensure the new plan meets all traceability criteria.
- [x] Step 2: Run `node --test tests/repo-hygiene.test.mjs` to verify character cap and no BOM across all source files.
- [x] Step 3: Run `npm run typecheck`, `npm run lint`, and `npm test` to confirm full repository clean pass.
