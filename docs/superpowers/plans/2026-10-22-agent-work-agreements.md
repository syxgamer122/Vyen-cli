# Agent Work Agreements — Porting the Predecessor Repository's Rules

**Goal:** Give this repository the working agreements that proved their worth on
the predecessor project (Next.js + Vitest), adapted to this repository's real
gates (tsc + oxlint + `node:test`), with the two rules that were only prose
turned into guards that go red.

**Architecture:** One file, `AGENTS.md` at the repository root, holds the rules
and the accumulating lessons. It is the file `loadProjectInstructions()`
(`src/context.ts`) already injects into every model prompt, so the lessons are
read without any new mechanism. Two new test files guard the rules that must
not rot: `tests/repo-hygiene.test.mjs` (BOM, `@ts-ignore`, guard tripwire) and
`tests/plan-traceability.test.mjs` (criterion → test traceability).

**Tech Stack:** Node ≥ 22.16, `node:test`, no new dependency.

## Global Constraints

- No new runtime mechanism. The lessons live in `AGENTS.md`, which is already
  loaded; `~/.config/vyen/memories.json` stays the only other persistent-note
  store (user-scoped, different scope and format).
- The repository already has `memories.json`; a second parallel store for
  "persistent notes" is a patch, not an extension.
- A rule that claims a guard must have a test that goes red when the rule is
  broken. Every guard is proved red before it is trusted.
- The predecessor's rules are **adapted, not copied**: the gates here are
  `npm run typecheck`, `npm run lint`, `npm test`; there is no Vitest, no
  ESLint, no `docs:check`, no Next.js.
- The language of this repository is English (code, comments, docs, commits).
- Plans written before 2026-10-22 are history and are not retrofitted.

## Review Focus

1. **A workspace whose `AGENTS.md` carries the accumulated lessons** — the file
   must reach the model's system prompt, not sit unread on disk. Pinned in
   Task 2.
2. **A source file saved with a byte-order mark** — the suite must go red.
   Pinned in Task 3.
3. **A source file using `@ts-ignore` to silence the type checker** — the suite
   must go red. Pinned in Task 3.
4. **A plan whose `## Review Focus` item has no row in its Scenarios & Tests
   table** — the suite must go red. Pinned in Task 4.
5. **A Scenarios & Tests row naming a test file that does not exist** — the
   suite must go red. Pinned in Task 4.
6. **An agent deleting one of the two guard files** — the other guard must
   notice. Pinned in Task 3.

## Scenarios & Tests

**What the user sees:** the repository carries a single `AGENTS.md` with the
working agreements and the lessons accumulated so far; a turn that breaks one
of the guarded rules turns `npm test` red instead of passing quietly.

| # | Criterion | Test |
|---|---|---|
| 1 | AGENTS.md reaches the system prompt | `tests/context.test.mjs` |
| 2 | a byte-order mark turns the suite red | `tests/repo-hygiene.test.mjs` |
| 3 | @ts-ignore turns the suite red | `tests/repo-hygiene.test.mjs` |
| 4 | a criterion without a table row turns the suite red | `tests/plan-traceability.test.mjs` |
| 5 | a row naming a missing test file turns the suite red | `tests/plan-traceability.test.mjs` |
| 6 | deleting a guard file turns the suite red | `tests/repo-hygiene.test.mjs` |

---

### Task 1: Write `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (already present at `HEAD` — added by commit `a1ead27`;
  this task refines and completes it, it does not create it)

**Steps:**
- [ ] Port the gates, the "do not lower the gate" rules, the red-before-green
      rules, the three-layer plan/test/review model with its four laws, the
      dead-code and identifier rules, the byte-level rules and the quick map.
- [ ] Replace every predecessor-specific fact with this repository's own:
      `tsc` / `oxlint` / `node --test`, no Vitest, no ESLint, no `docs:check`.
- [ ] Record the measured baseline and the exact names of the platform
      failures, measured on this machine.

### Task 2: Prove the file is read, not just stored

**Files:**
- Modify: `tests/context.test.mjs`

**Steps:**
- [ ] Add a test that writes an `AGENTS.md` into a workspace and asserts the
      text reaches `systemPrompt()` — the observable boundary is the prompt
      the model receives.
- [ ] Prove it red first: assert on a file that is not loaded, watch it fail,
      then point the assertion at `AGENTS.md`.

### Task 3: Guard the byte-level and type-level rules

**Files:**
- Create: `tests/repo-hygiene.test.mjs`

**Steps:**
- [ ] Guard: no BOM in `src/`, `tests/`, `scripts/`, `bin/`.
- [ ] Guard: no `@ts-ignore`; `@ts-expect-error` needs a reason on its line.
- [ ] Guard: the two guard files reference each other, so neither can be
      deleted alone.
- [ ] Prove each guard red before trusting it (inject a BOM, inject a
      `@ts-ignore`, delete a marker) and restore afterwards.

### Task 4: Guard the plan traceability

**Files:**
- Create: `tests/plan-traceability.test.mjs`

**Steps:**
- [ ] Guard: every plan states numbered `## Review Focus` criteria.
- [ ] Guard: every plan written from 2026-10-22 on has a `## Scenarios & Tests`
      table with one row per criterion.
- [ ] Guard: every row names a test file that exists.
- [ ] Guard: the guard is not vacuous — at least one plan must exist.
- [ ] Prove it red with a probe plan, then remove the probe.

### Task 5: Final verification

**Steps:**
- [ ] `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] `npm test` must be green apart from the five known platform failures.
- [ ] Delete the superseded `AGENT_LEARNINGS.md`: the lessons live in
      `AGENTS.md`, and two files for one job is a patch.
