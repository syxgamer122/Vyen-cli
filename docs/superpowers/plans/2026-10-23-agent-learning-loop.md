# Agent Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository's "lessons" mechanism verifiable: a lesson counts only when a test can go red for it.

**Architecture:** Strengthen the two guards that already run in the suite instead of adding a third mechanism. `plan-traceability` learns to resolve a row to the *test title* inside the file, not just the file; `repo-hygiene` gains a size budget read from the real prompt cap; the end-to-end test lost in the upstream merge is restored; and the Lessons section declares which entries a guard enforces and which are self-declared.

**Tech Stack:** Node >= 22, `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** `AGENTS.md` §2.5 (Laws 1-4) and `docs/VALIDATION.md`.

## Global Constraints

- Gate: `npm run typecheck` exit 0, `npm run lint` no errors, `npm test` green apart from the five known Windows platform failures recorded in `AGENTS.md` §1.
- Plans dated before 2026-10-22 are history: never rewritten and never retrofitted.
- A new rule is not "guarded" unless a test goes red when the rule is broken.
- Code, comments, test names and commits are English; no new dependency.
- `AGENTS.md` must stay under the prompt cap with 1 000 characters to spare.

## Review Focus

1. A row whose test title has been deleted must turn the suite red.
2. A row naming a title that lives in a different test file must turn the suite red.
3. `AGENTS.md` growing past the margin must turn the suite red.
4. Deleting either guard file must turn the other one red.
5. A plan dated 2026-10-22 with file-only rows must stay green (history is not retrofitted).

## Scenarios & Tests

**What the user sees:** the same `npm test` as before, except that a plan pointing at a test that no longer exists — or an `AGENTS.md` that has outgrown the prompt budget — now fails by name instead of passing silently.

| # | Criterion | Test |
|---|---|---|
| 1 | A row whose test title was deleted | tests/plan-traceability.test.mjs › from 2026-10-23 every Scenarios & Tests row names a test the file contains |
| 2 | A row naming a title that lives elsewhere | tests/plan-traceability.test.mjs › from 2026-10-23 every Scenarios & Tests row names a test the file contains |
| 3 | AGENTS.md growing past the margin | tests/repo-hygiene.test.mjs › AGENTS.md fits under the prompt cap with room to spare |
| 4 | Deleting either guard file | tests/plan-traceability.test.mjs › the two guards protect each other |
| 5 | Plans dated 2026-10-22 | tests/plan-traceability.test.mjs › from 2026-10-23 every Scenarios & Tests row names a test the file contains |

---

### Task 1: Restore the lost end-to-end test

**Files:**
- Modify: `tests/context.test.mjs` (append at end; add `writeFile` to the `node:fs/promises` import)

**Interfaces:**
- Consumes: `systemPrompt(config, readOnly, planMode, goal, cache)` from `../dist/context.js`; `fixture(t)` from `./helpers.mjs`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Restore the test exactly as committed in `abad1ad`**

```js
test('the workspace AGENTS.md reaches the system prompt, lessons section included', async t => {
  const { systemPrompt } = await import('../dist/context.js');
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'AGENTS.md'), '# Working agreements\n\n## Lessons - append here\n\n- [pitfall] (2026-10-22) build the workspace before running a single test file\n');
  const config = { cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://localhost/v1', apiKey: 'fake', contextWindow: 128000, maxOutputTokens: 4096, timeoutMs: 15000 };
  const prompt = await systemPrompt(config, false, false, undefined);
  assert.match(prompt, /Workspace guidance \(AGENTS\.md\)/);
  assert.match(prompt, /build the workspace before running a single test file/);
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/context.test.mjs`
Expected: PASS. This is a restored regression test, not new behaviour.

- [ ] **Step 3: Prove it is not vacuous**

Rename the fixture file inside the test to `NOTAGENTS.md`, rebuild, run again.
Expected: FAIL on the first `assert.match`. Restore the name.

- [ ] **Step 4: Commit**

```bash
git add tests/context.test.mjs
git commit -m "test: restore the end-to-end proof that AGENTS.md reaches the prompt"
```

### Task 2: Resolve a plan row to a test title

**Files:**
- Modify: `tests/plan-traceability.test.mjs` (append one test; add a helper)
- Modify: `AGENTS.md` (§2.5 Law 1, the paragraph that documents the accepted format)

**Interfaces:**
- Produces: `rowTitle(row)` returns `{ file, title } | null`; `testTitles(source)` returns `string[]`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Add the date constant and the helpers**

```js
// From this date a row must name the test, not only the file: a file whose test
// was deleted must turn this guard red (the upstream merge of 2026-10-22 did
// exactly that and the file-only check stayed green).
const TEST_TITLE_ADOPTED = '2026-10-23';

function rowTitle(cell) {
  const parts = cell.split('›');
  if (parts.length !== 2) return null;
  const file = /tests\/[A-Za-z0-9._-]+\.test\.mjs/.exec(parts[0]);
  if (!file) return null;
  return { file: file[0], title: parts[1].trim() };
}

function testTitles(source) {
  return [...source.matchAll(/test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(match => match[2]);
}
```

- [ ] **Step 2: Write the failing test**

```js
test('from 2026-10-23 every Scenarios & Tests row names a test the file contains', async () => {
  for (const plan of await planFiles()) {
    if (plan.date < TEST_TITLE_ADOPTED) continue;
    const text = await readFile(join(PLANS_DIR, plan.name), 'utf8');
    const scenarios = section(text, 'Scenarios & Tests');
    if (!scenarios) continue;
    for (const row of rowsOf(scenarios)) {
      const target = rowTitle(row.text);
      assert.ok(target, `${plan.name}: row ${row.number} must name a test as "tests/<file>.test.mjs › <title>"`);
      const source = await readFile(join(ROOT, target.file), 'utf8');
      assert.ok(
        testTitles(source).includes(target.title),
        `${plan.name}: row ${row.number} names "${target.title}", which ${target.file} does not contain`,
      );
    }
  }
});
```

- [ ] **Step 3: Run it to verify RED**

Create a probe plan `docs/superpowers/plans/2026-10-23-zz-probe.md` with one criterion and one row naming a title that does not exist.
Run: `node --test tests/plan-traceability.test.mjs`
Expected: FAIL with `names "..." which tests/context.test.mjs does not contain`. Delete the probe.

- [ ] **Step 4: Verify the other direction (title in a different file)**

Point the probe row at `tests/context.test.mjs` but give it a title that exists only in `tests/plan-traceability.test.mjs`.
Expected: FAIL. Delete the probe.

- [ ] **Step 5: Run green**

Run: `node --test tests/plan-traceability.test.mjs`
Expected: PASS (no plan dated 2026-10-23 exists yet; this plan itself becomes the first once its rows are updated in Task 2 Step 6).

- [ ] **Step 6: Update this plan's own rows, and the Law 1 documentation**

Add `› <title>` to the six rows above, and change the AGENTS.md sentence to:

> a row that names `tests/<name>.test.mjs` **and**, for plans dated 2026-10-23 or later, the test title after `›`.

- [ ] **Step 7: Commit**

```bash
git add tests/plan-traceability.test.mjs AGENTS.md docs/superpowers/plans/2026-10-23-agent-learning-loop.md
git commit -m "test: make a plan row resolve to a test title, not just a file"
```

### Task 3: Budget `AGENTS.md` against the real prompt cap

**Files:**
- Modify: `tests/repo-hygiene.test.mjs` (append one test)
- Modify: `AGENTS.md` (trim so the new test passes)

**Interfaces:**
- Produces: nothing later tasks import.
- Consumes: `src/context.ts` line `limitText(parts.join('\n\n'), 24_000)`.

- [ ] **Step 1: Write the failing test**

```js
test('AGENTS.md fits under the prompt cap with room to spare', async () => {
  const context = await readFile(join(ROOT, 'src', 'context.ts'), 'utf8');
  const cap = /limitText\(parts\.join\([^)]*\),\s*([\d_]+)\)/.exec(context);
  assert.ok(cap, 'the prompt cap in src/context.ts was not found — update this guard');
  const limit = Number(cap[1].replaceAll('_', ''));
  const text = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(
    text.length <= limit - 1000,
    `AGENTS.md is ${text.length} characters; the loader truncates at ${limit} and drops the middle, so it must stay at or below ${limit - 1000}`,
  );
});
```

- [ ] **Step 2: Run it to verify RED**

Run: `node --test tests/repo-hygiene.test.mjs`
Expected: FAIL — `AGENTS.md is 23019 characters ... must stay at or below 23000`.

- [ ] **Step 3: Trim `AGENTS.md` until green**

Fold the redundant lessons into shorter one-liners (the `dist/` lesson and the guard-self-report lesson are the two longest). Do not cut a rule that is not duplicated. Re-run after each edit.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/repo-hygiene.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/repo-hygiene.test.mjs AGENTS.md
git commit -m "test: hold AGENTS.md under the prompt cap instead of trusting prose"
```

### Task 4: Declare what is enforced and what is not

**Files:**
- Modify: `AGENTS.md` (`## Lessons` header and two entries)

- [ ] **Step 1: Add the declaration line to the Lessons header**

> **Enforced vs self-declared.** An entry ending in `— guard: tests/<file>.test.mjs` is enforced by that test; every other entry is self-declared and relies on the agent choosing to follow it.

- [ ] **Step 2: Mark the two entries a test actually enforces**

- the PowerShell/BOM lesson → `— guard: tests/repo-hygiene.test.mjs` (a BOM reddens that guard);
- the guard-self-report lesson → `— guard: tests/repo-hygiene.test.mjs` (the guard scans itself).

Leave the other seven unmarked. That is the finding, not an omission.

- [ ] **Step 3: Re-run the budget guard after every edit** (Task 3 remains green)

Run: `node --test tests/repo-hygiene.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: say which lessons a guard enforces and which are self-declared"
```

## Self-Review

- **Spec coverage:** Law 1 (criterion -> test) is strengthened in Task 2; the "prose has no effect, tests do" principle is applied in Task 3; the merge regression is closed by Task 1.
- **Step scan:** each step names the exact assertion or the exact command and its expected output.
- **Type consistency:** `rowTitle`/`testTitles` are used only in Task 2.
- **Review Focus:** items 1-3 have a test in the owning task; item 4 is the existing tripwire test; item 5 is the date filter in the new test.
- **Proportion:** four tasks, one new test each, no new module.
