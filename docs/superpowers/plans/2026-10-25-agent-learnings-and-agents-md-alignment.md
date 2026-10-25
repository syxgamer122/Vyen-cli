# AGENTS.md & AGENT_LEARNINGS.md Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `AGENTS.md` and `AGENT_LEARNINGS.md`, establish single source of truth for learnings, codify session lifecycle and review invariants in `AGENTS.md`, and ensure combined character budget stays safely below the prompt cap.

**Architecture:** Update `AGENTS.md` budget prose to document the combined limit; add §3.4 Session Lifecycle and integrate review findings rule into Law 4; migrate tactical pitfalls to `AGENT_LEARNINGS.md §6`; verify against repo-hygiene and plan-traceability guards.

**Tech Stack:** TypeScript, Node.js (`node:test`), Markdown.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-learnings-and-agents-md-alignment-design.md`

## Global Constraints

- Combined instructions length (`AGENTS.md` + `AGENT_LEARNINGS.md` + 2) must stay <= 23,000 characters per `tests/repo-hygiene.test.mjs`.
- No BOM on any edited or created files.
- No lowering test gates, no `@ts-ignore`.
- Preserve all existing path containment and security invariants.

## Review Focus

1. AGENTS.md and combined instruction set fits under the prompt cap with room to spare.
2. All source and instruction files carry no byte-order mark (BOM).
3. Every Review Focus criterion maps directly to an existing test in the test suite.
4. Harness session lifecycle hooks emit SessionStart and SessionEnd appropriately without duplicates.

## Scenarios & Tests

**What the user sees:** After running this plan, `AGENTS.md` and `AGENT_LEARNINGS.md` have distinct, non-overlapping roles, with session lifecycle codified in §3.4, tactical lessons centralized in `AGENT_LEARNINGS.md`, and combined length verified under the 23,000 character prompt budget.

| # | Criterion | Test |
|---|---|---|
| 1 | AGENTS.md and combined instruction set fits under the prompt cap with room to spare | tests/repo-hygiene.test.mjs › AGENTS.md fits under the prompt cap with room to spare |
| 2 | All source and instruction files carry no byte-order mark | tests/repo-hygiene.test.mjs › source files carry no byte-order mark |
| 3 | Every Review Focus criterion maps directly to an existing test | tests/plan-traceability.test.mjs › every Review Focus criterion has a row in the Scenarios & Tests table |
| 4 | Harness session lifecycle hooks emit SessionStart and SessionEnd appropriately without duplicates | tests/hooks.test.mjs › Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once |

---

### Task 1: Update AGENTS.md with Combined Budget and Seam Architecture
**Files:**
- Modify: `AGENTS.md`
- Test: `tests/repo-hygiene.test.mjs`

- [x] Step 1: Update budget section in `AGENTS.md` to specify combined limit (`AGENTS.md` + `AGENT_LEARNINGS.md`).
- [x] Step 2: Add review findings rule ("Review findings become rules, not TODOs") to §2.5 Law 4.
- [x] Step 3: Add §3.4 Session Lifecycle synchronization specifying `SessionStore` `WeakSet` and `endSession()` triggers.
- [x] Step 4: Replace `## Lessons — append here` with §11 pointing exclusively to `AGENT_LEARNINGS.md`.

### Task 2: Update AGENT_LEARNINGS.md as Single Store for Learnings
**Files:**
- Modify: `AGENT_LEARNINGS.md`
- Test: `tests/repo-hygiene.test.mjs`

- [x] Step 1: Update §1, §3, and §5 in `AGENT_LEARNINGS.md` to reference `AGENTS.md` §3.2, §3.4, and §2.5 Law 4.
- [x] Step 2: Add `## 6. Build, Loader & Guard Pitfalls` containing the tactical lessons migrated from `AGENTS.md`.
- [x] Step 3: Verify combined character count is <= 22,000 (buffer > 1,000 chars below 23,000 limit).

### Task 3: Full Suite Verification & Audit
**Files:**
- Test: `tests/repo-hygiene.test.mjs`
- Test: `tests/plan-traceability.test.mjs`
- Test: `tests/hooks.test.mjs`

- [x] Step 1: Run `node --test tests/plan-traceability.test.mjs` to confirm plan validity.
- [x] Step 2: Run `node --test tests/repo-hygiene.test.mjs` to confirm budget and BOM invariants.
- [x] Step 3: Run `node --test tests/hooks.test.mjs` to confirm lifecycle hook tests pass.
- [x] Step 4: Run full `npm test` and `npm run lint`.
