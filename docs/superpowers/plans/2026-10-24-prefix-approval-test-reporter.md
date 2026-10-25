# Prefix approval: test-runner module loading - 2026-10-24

Spec: `docs/ROADMAP.md` R0.7 and R0.9; `docs/CRITIQUE_VERIFICATION.md`;
`docs/VALIDATION.md`.

## Goal

Close the verified `npm test -- --test-reporter=...` prefix-approval bypass,
add a red test, and correct the documents that currently claim the whole
prefix-approval class is closed. Keep the existing safe approvals intact.

## Architecture

`src/approval.ts` turns a command line into a prefix and rejects tokens that can
load a module, write a file or read configuration. `RISKY_OPTION_RE` already
covers pytest's `-p`, node's `-r`, git's `--output` and similar options. Add
Node's `--test-reporter` and `--test-reporter-destination` to the same deny
list. No new state, tool, command or dependency.

## Tech Stack

TypeScript 5.9 strict (NodeNext), node:test, oxlint, tsc.

## Global Constraints

- No new dependencies or tools; this is a one-line classification fix.
- Do not weaken the pytest, node, git or package-install guards.
- Do not change the safe `npm test -- --watch=false` approval.
- Do not implement the `pytest.ini`/`pyproject.toml` trust-boundary change in
  this plan; that is a product decision recorded in R0.7 and left explicit.
- New assertions must be red before `src/approval.ts` changes and green after.

## Review Focus

1. An approved `npm test` does not cover `--test-reporter=<module>` or
   `--test-reporter-destination`.
2. Safe `npm test -- --watch=false` and the existing pytest, `ls` and `git`
   approvals still behave as before.
3. `docs/CRITIQUE_VERIFICATION.md` and `docs/VALIDATION.md` say
   "flag-level" and name the remaining project-config trust boundary instead of
   claiming the whole class is closed.
4. `docs/ROADMAP.md` R0.7 names the reporter bypass, and Section 10 no longer
   tells the reader to fix six document drifts that are already fixed.
5. The new reporter assertions are red against the unpatched
   `src/approval.ts` and green after the one-line regex change.

## Scenarios & Tests

**What the user sees:** after approving `npm test`, a
`--test-reporter=./evil.js` run asks for approval instead of loading the
reporter module; a safe `npm test -- --watch=false` still runs without a
prompt. The docs name the remaining `pytest.ini` trust boundary instead of
claiming it is closed.

| # | Criterion | Test |
|---|---|---|
| 1 | An approved npm test | `tests/audit.test.mjs` › bash prefix approvals only cover simple commands |
| 2 | Safe npm test | `tests/audit.test.mjs` › bash prefix approvals only cover simple commands |
| 3 | docs say flag-level | `tests/docs-contract.test.mjs` › SPEC matches the implemented retry, budget and MCP-resource contract, and README states the real release and gateway facts |
| 4 | Roadmap R0.7 names | `tests/docs-contract.test.mjs` › SPEC matches the implemented retry, budget and MCP-resource contract, and README states the real release and gateway facts |
| 5 | new reporter assertions | `tests/audit.test.mjs` › bash prefix approvals only cover simple commands |

## Tasks

### Task 1: Add the failing reporter and document assertions

Files: `tests/audit.test.mjs`, `tests/docs-contract.test.mjs`.

In `tests/audit.test.mjs`, inside the existing
`bash prefix approvals only cover simple commands` test, after the safe
`npm test -- --watch=false` assertion, add:

```js
  // Node's --test-reporter loads a module from the argument; it must not ride
  // on an approved "npm test" either.
  for (const command of [
    'npm test -- --test-reporter=./evil.js',
    'npm test -- --test-reporter ./evil.js',
    'npm test -- --test-reporter-destination=./out.txt',
  ]) assert(!isApprovedBashPrefix({ command }, approved), command);
  assert(isApprovedBashPrefix({ command: 'npm test -- --watch=false' }, approved));
```

In `tests/docs-contract.test.mjs`, before the final `assert.match(readme,
/Lưu ý bảo mật/)` line, add:

```js
  assert.match(critique, /Explicit flag-level prefix bypasses closed/);
  assert.doesNotMatch(critique, /Explicit prefix bypass closed/);
  assert.match(critique, /--test-reporter/);
  assert.match(roadmap, /--test-reporter/);
  assert.match(validationText, /--test-reporter/);
  assert.doesNotMatch(roadmap, /Fix the six document drifts/);
  assert.match(roadmap, /six document drifts and module tests landed on 2026-10-24/);
```

### Task 2: Watch the new assertions fail

Run:

```bash
npm run build
node --test --test-name-pattern="bash prefix approvals only cover simple commands|SPEC matches the implemented" tests/audit.test.mjs tests/docs-contract.test.mjs
```

Expected: the audit assertion for `--test-reporter=./evil.js` fails because the
current regex approves it; the docs-contract test fails because the old
documents still say "Explicit prefix bypass closed" and still contain the stale
Section 10 line. Record the failure lines in the task ledger.

### Task 3: Add the deny-list tokens

File: `src/approval.ts`.

Extend the comment above `RISKY_OPTION_RE` and add the two tokens to the
alternation; put the longer token first:

```ts
// Node's --test-reporter loads a module from the argument, and
// --test-reporter-destination writes a file; like pytest's -p, they must not
// ride on an approved "npm test".
const RISKY_OPTION_RE = /^--?(?:o|output|out|outfile|out-file|outdir|out-dir|output-dir|exec|ext-diff|upload-pack|receive-pack|config-file|override-ini|config|c|eval|e|command|shell|pager|editor|global|prefix|target-dir|init-file|rcfile|require|r|import|loader|test-reporter-destination|test-reporter|p|plugins?)(?:=|$)/i;
```

### Task 4: Prove the audit assertions pass

Run:

```bash
npm run build
node --test --test-name-pattern="bash prefix approvals only cover simple commands" tests/audit.test.mjs
```

Expected: 1 test, 1 pass, 0 fail. Also confirm `npm test -- --watch=false`,
`python -m pytest -q tests`, `ls -laR` and `git diff --stat` remain approved.

### Task 5: Correct the documents

- `docs/ROADMAP.md` R0.7: change the title to "Close the explicit flag-level
  pytest and test-reporter prefix-approval bypasses"; add
  `--test-reporter`/`--test-reporter-destination` to the acceptance; keep the
  sentence that automatic `pytest.ini`/`pyproject.toml` discovery remains a
  trust boundary.
- `docs/ROADMAP.md` Section 10: replace the stale first item with:
  `1. Keep the Phase 0 contract tests green; the six document drifts and module tests landed on 2026-10-24.`
- `docs/CRITIQUE_VERIFICATION.md` item 2: replace "Explicit prefix bypass
  closed." with "Explicit flag-level prefix bypasses closed; project config
  remains a trust boundary." Add one sentence naming the reporter assertions
  and the `--config-file`/`pytest.ini` boundary.
- `docs/VALIDATION.md` prefix-approval paragraph: add one sentence that the
  same test rejects `--test-reporter` and `--test-reporter-destination` while
  keeping the safe `npm test -- --watch=false` form, and that the reporter
  assertions were red before the regex change.

### Task 6: Run the focused docs test and the full gate

Run:

```bash
npm run build
node --test --test-name-pattern="SPEC matches the implemented" tests/docs-contract.test.mjs
npm run typecheck
npm run lint
npm test
```

Expected: docs-contract 1/1 pass; typecheck and lint exit 0; `npm test` remains
202 tests, 194 pass, 5 known Windows failures, 3 skipped. The count stays 202
because the reporter assertions extend an existing test.

### Task 7: Record evidence and stop before unrelated work

Append a short entry to `docs/VALIDATION.md` naming the red/green mutation and
the final suite count. Do not change `DEFAULT_GATEWAY_URL`, `src/pair.ts`,
`src/files.ts`, `src/process.ts` or any R3 item in this plan.

## Out of scope

- `pytest.ini`/`pyproject.toml` automatic discovery: this is a product trust
  decision already recorded in R0.7; it is not silently changed here.
- `/pair` rate limit, token TTL and Origin checks (R2.6), worktree allowed roots
  (R3.3), the bash sandbox (R3.1), web DNS/TLS tests (R2.3) and background-task
  lifecycle (R3.4).
