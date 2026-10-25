# AGENTS.md & AGENT_LEARNINGS.md Alignment & Decoupling — Design Specification

**Date:** 2026-10-25  
**Topic:** Aligning `AGENTS.md` and `AGENT_LEARNINGS.md`, clarifying prompt budget constraints, resolving duplicate sections, and properly categorizing architecture rules vs empirical learnings.  
**Target:** Clean Separation & Unified Budget (Approach 1).

---

## 1. Intent & The Why

`AGENTS.md` and `AGENT_LEARNINGS.md` are the two instruction files loaded automatically into the model prompt via `loadProjectInstructions` in `src/context.ts`.

A systematic audit revealed three major structural inconsistencies:
1. **Misleading Budget Prose vs Shared Cap Reality:** `AGENTS.md` states that it must stay under 24,000 characters. In reality, `src/context.ts` concatenates `AGENTS.md` and `AGENT_LEARNINGS.md` together and truncates the *combined* string at 24,000 characters (`limitText(parts.join('\n\n'), 24_000)`). `tests/repo-hygiene.test.mjs` enforces `combined <= limit - 1000` (<= 23,000 characters). With `AGENTS.md` at 18,066 chars and `AGENT_LEARNINGS.md` at 2,993 chars (total 21,059), only ~1,941 characters remain before truncation cuts out the middle of `AGENTS.md` (specifically §9 Quick Map and §10 Checklist).
2. **Ambiguous Append Locations:** `AGENTS.md` has a `## Lessons — append here` section with 4 dated items, while `AGENT_LEARNINGS.md` states "When a mistake is confirmed... append the evidence here — never a second copy of a rule that already lives in AGENTS.md". This causes ambiguity about where new lessons should be recorded.
3. **Misplaced Core Invariants & Working Agreements:** Critical architectural rules (Session lifecycle synchronization via `SessionStore` `WeakSet` in `AGENT_LEARNINGS.md §3`) and agent working agreements ("Review findings become rules, not TODOs" in `AGENT_LEARNINGS.md §5`) reside in `AGENT_LEARNINGS.md` instead of being codified in `AGENTS.md`.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Unified Budget Documentation:** Update `AGENTS.md` to state clearly that 24,000 is the *combined* character limit for all loaded instructions (`AGENTS.md` + `AGENT_LEARNINGS.md`), with a mandatory buffer of at least 1,000 characters (enforced by `tests/repo-hygiene.test.mjs`).
- **Single Source of Truth for Learnings:** Move active tactical lessons (`[pitfall]` and `[mistake]` items regarding `dist/` compilation on Windows, loader verification, and repo-hygiene regex self-reporting) from `AGENTS.md` to `AGENT_LEARNINGS.md`. Remove the redundant `git add -A` item (already codified in §6 and §10 checklist).
- **Single Append Point:** Remove `## Lessons — append here` from `AGENTS.md` and replace with a direct reference pointing to `AGENT_LEARNINGS.md`.
- **Codify Session Lifecycle Seams in `AGENTS.md`:** Add §3.4 in `AGENTS.md` specifying the session lifecycle invariants (tying `SessionStart`/`SessionEnd` to `SessionStore` `WeakSet`, calling `endSession()` before session changes), leaving historical incident details in `AGENT_LEARNINGS.md §3`.
- **Codify Review Finding Rule in `AGENTS.md`:** Incorporate the rule that review findings become rules (not deferred TODOs) directly into `AGENTS.md §2.5 Law 4`, keeping `AGENT_LEARNINGS.md` focused on empirical failure modes and vectors.
- **Maintain Character Budget:** Ensure the combined character count remains under 23,000 characters (leaving >1,500 characters safety buffer).

### Non-Goals
- Modifying `src/context.ts` or altering how `loadProjectInstructions` loads files.
- Changing runtime TypeScript code in `src/`.
- Relaxing any existing security invariant, gate rule, or test requirement.

### Anti-Goals
- Splitting or copying rules across both files (two copies of one rule drift apart).
- Increasing the combined character count close to the 23,000 guard limit.

---

## 3. Constraints

- `tests/repo-hygiene.test.mjs` enforces:
  - `AGENTS.md` character length <= 23,000.
  - Combined character length (`AGENTS.md` + `AGENT_LEARNINGS.md` + 2) <= 23,000.
  - No BOM, no `@ts-ignore`, no reason-less `@ts-expect-error`.
- `npm run lint`, `npm run typecheck`, and `npm test` must all exit with 0.

---

## 4. Approaches Considered

### Approach 1: Clean Separation & Unified Budget (Selected)
- Document the combined budget in `AGENTS.md`.
- Migrate tactical lessons from `AGENTS.md` to `AGENT_LEARNINGS.md`.
- Codify §3.4 Session Lifecycle and Review Findings into `AGENTS.md`.
- Remove `## Lessons — append here` from `AGENTS.md`.
- **Trade-off:** Requires editing both files and carefully balancing prose length to keep combined characters under 23,000.
- **Why chosen:** Establishes clear separation of concerns (AGENTS.md = rules & seams; AGENT_LEARNINGS.md = empirical anti-patterns & attack vectors), matches reality of `tests/repo-hygiene.test.mjs`, and eliminates duplicate append points.

### Approach 2: Minimal Relocation
- Only update budget text in `AGENTS.md`.
- Move the 4 lesson items to `AGENT_LEARNINGS.md` without promoting lifecycle rules to `AGENTS.md`.
- **Trade-off:** Faster, but leaves critical architectural seams scattered in `AGENT_LEARNINGS.md`.

---

## 5. Detailed Design Decisions

### 5.1 `AGENTS.md` Modifications
1. **Budget Section (Lines 13-18):**
   - Clarify: "Budget: stay under 24 000 characters **combined across all loaded instructions** (`AGENTS.md` + `AGENT_LEARNINGS.md`), with at least 1 000 to spare."
2. **Review Finding Rule (§2.5 Law 4):**
   - Add: "Every confirmed finding (red test, review verdict, user correction) lands as a rule in the section that owns it before the turn ends. Never defer review findings as TODOs while leaving the rule untouched."
3. **Session Lifecycle Seam (§3.4):**
   - Add §3.4: "Session lifecycle synchronization (`SessionStart`/`SessionEnd`): Key lifecycle state to the `SessionStore` (module-level `WeakSet`), never to transient `Harness` instances. Trigger `activeHarness.endSession()` before store swaps (`/new`, `/resume`, `/delete`) and subagent cleanup."
4. **Remove `## Lessons — append here`:**
   - Replace lines 346–361 with a concise pointer to `AGENT_LEARNINGS.md` as the single store for empirical failure patterns and tactical tripwires.

### 5.2 `AGENT_LEARNINGS.md` Modifications
1. **Incorporate Tactical Lessons from `AGENTS.md`:**
   - Add a new section `## 6. Build & Tooling Pitfalls` containing:
     - `node node_modules/typescript/bin/tsc` compilation on Windows for individual test files.
     - Verifying loaders before declaring dead code.
     - Self-reporting test guards (splitting string literals).
2. **De-duplicate Canonical References:**
   - Ensure §1 and §2 reference `AGENTS.md` §3.2, §3.3, and §3.4 concisely without duplicating rule prose.
   - Retain concrete reproduction vectors (`sudo`, `sh -c`, `echo a; rm -rf /`) and anti-patterns.

---

## 6. What's Left to the Builder

- Implement exact edits to `AGENTS.md` and `AGENT_LEARNINGS.md`.
- Verify total character counts:
  - `AGENTS.md` <= 18,500 chars.
  - `AGENT_LEARNINGS.md` <= 3,800 chars.
  - Combined <= 22,000 chars (well below 23,000).
- Run `npm test` and `npm run lint` to confirm clean green state.
