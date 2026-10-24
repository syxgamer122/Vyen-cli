# AGENTS.md — working agreements for this repository

TypeScript 5.9 (strict, NodeNext) + Node ≥ 22.16 + AI SDK 6, packaged as the
`vyen` terminal coding agent. Primary target is Termux/Android on Linux; Windows
is supported.

**The contract is `docs/SPEC.md`** — read it when you need to know what the code
promises. This file only adds the working agreements SPEC cannot express. Keep it
short: it is loaded into the prompt of every model call (`loadProjectInstructions`
in `src/context.ts`, truncated at 24 000 characters), so a rule that nobody follows
is worse than no rule.

**Budget: stay under 24 000 characters, with at least 1 000 to spare.**
`loadProjectInstructions` truncates at 24 000 and drops the **middle** of the
file, not the end — a file that grows past the cap silently loses its middle
section. When it needs more room, fold a lesson into a rule and delete the dated
line (§ Lessons), or move the rule into `docs/SPEC.md` and keep only the pointer
here.

**Read only what this turn needs.** This repository holds long plans and ledgers
under `docs/superpowers/plans/`; they are **history**, not input. A turn needs:
this file + the plan of the current turn + the spec sections it touches. Reading
more is self-inflicted context loss.

## 1. The gate before reporting "done"

```bash
npm run lint         # oxlint src tests bin scripts
npm run typecheck    # tsc --noEmit
npm test             # tsc build -> node --test tests/*.test.mjs
```

`npm test` builds first, so a green `npm test` already proves the build is clean.
`npm run release:pack` (pack + install into an isolated prefix) is for release
work only — do not run it for an ordinary change.

Lint must report zero errors. Warnings are baseline; do not "fix" them and do not
report them as findings.

**Known failures that are not regressions.** Five Windows cases remain: four in
`tests/files.test.mjs` (POSIX mode bits and symlinks) and one in
`tests/audit.test.mjs` (an outside-workspace symlink Windows refuses without
administrator rights). Names and counts live in `docs/VALIDATION.md`; read them
there. Use the **test name**, not the file name, and do not weaken an assertion.

Measured 2026-10-24 on Windows, Node 24.18.0: the publish test is now green after
the cross-platform release-packer fix; the three POSIX PTY tests are skipped on
Windows.

Distinguish a real regression by **reading the failing test name**, not the file
name: one file can hold both a real regression and a known platform failure.

**Checklist to report "done"** — every line is a condition that must hold, not a
suggestion:

- [ ] `npm run typecheck` exit 0 · `npm run lint` no new errors · `npm test` not
      red (except the known failures above)
- [ ] New tests were proven **RED** before the fix (§2), and the mutation was
      confirmed to actually change behaviour (§2.2)
- [ ] Every promise made in a new comment has a test that goes red when the
      guard is removed (§2.1)
- [ ] Expectations come from the requirement, not from the code (§2.5 — Law 2,
      self-declared)
- [ ] At least one end-to-end scenario test at an observable boundary exists for
      the feature (§2.5 — Law 3, self-declared)
- [ ] The `requesting-code-review` skill ran before pushing (§2.5 — Law 4,
      self-declared)
- [ ] The plan has a `## Scenarios & Tests` section and every item in
      `## Review Focus` has a row in it (§2.5 — Law 1, guarded by
      `tests/plan-traceability.test.mjs`)
- [ ] New files are `git add`ed; source files have no BOM (§8)

### 1.1 No lowering the gate, no destructive commands

The gate above only counts if the agent does not lower it.

- **Do not lower the gate.** `@ts-ignore` is banned outright; `@ts-expect-error`
  only with a reason on the same line; no `as any` to silence `tsc`; no disabling
  a lint rule; no `--no-verify` when committing. Fix the code, not the rule.
  The two rules about `as any` and lint disabling apply to **new** code — they
  are not a licence to clean up the old tree (§6 forbids out-of-scope refactors).
- **Do not edit the gatekeepers.** `tests/plan-traceability.test.mjs` and
  `tests/repo-hygiene.test.mjs` guard this file; editing them to make a failing
  assertion pass is self-declaring "the criterion was wrong". *Exception:* when a
  rule here changes, change the guard with it, deliberately, and say so in the
  commit message.
- **Do not bend the evidence.** Never write "verified" or "done" for something
  that was not run. Name the command and the real result (e.g. `npm test` →
  248/249 files green, 1 file flaky).
- **Destructive commands.** No `git reset --hard`, `git checkout -- .`,
  `git restore .`, `git clean -fd`, `git push --force` without asking first; never
  touch uncommitted changes outside the task's scope.
- **Secrets.** Never print a key into the transcript, never commit key files or
  `.env`; keys come from the environment (`VYEN_API_KEY`) or
  `~/.config/vyen/credentials.json`, never hardcoded. `src/errors.ts` is where
  credentials are **redacted**, not where they are read from.

> **What is guarded and what is not.** BOM (§8), any `@ts-ignore`, and a
> reason-less `@ts-expect-error` are **RED** when violated
> (`tests/repo-hygiene.test.mjs`); deleting either guard file is **RED** too —
> each guard asserts that the other one exists. A missing `## Scenarios & Tests`
> table or a `Review Focus` item without a row is **RED**
> (`tests/plan-traceability.test.mjs`). The rest — `as any`, lint disabling,
> `--no-verify`, destructive commands, bent evidence — have **no** measurement, so
> they are self-declared like Laws 2/3/4. Do not demand a test for them, and do
> not treat them as optional.
>
> Measured 2026-10-24: 25 files in `src/`, none of them contains `as any`.
> Two `oxlint-disable` comments in `src/tui.ts` are control-regex exceptions;
> any new disable needs a reason on the same line.

### 1.2 Speculative hardening

Before writing code for a race, a security edge case or another unlikely
failure, say in words a 10-year-old could understand what breaks, how likely it
is, and how much complexity it adds. Ask and wait for approval; in a subagent
or a background run, do not ask — leave it out and note it in the report. Never
widen the task to cover it. Existing security, path and permission invariants
are not speculative: never weaken or delete one without asking, tested or not.

## 2. New tests must be proven RED before the fix

```
normal → green · break the code → RED · restore → green
```

Three failure modes already seen here — do not repeat them:

1. **A regex that matches more than intended.** `assert.match(text, /VyenMark|VyenLogo/)`
   also matches the `import` line, so deleting the real call site leaves the test
   green. Anchor the pattern and assert that the cut point exists
   (`assert.ok(idx > -1)`).
2. **A search that returns `-1`.** `slice(text.indexOf(x))` on `-1` is
   `slice(-1)` — everything after it, so every later assertion is meaningless.
3. **An edit that silently fails.** PowerShell's `Get-Content`/`Set-Content`
   mangle UTF-8, so `.Replace()` with a non-ASCII string **does not match and
   does not error**. Use `[System.IO.File]::ReadAllText/WriteAllText` with
   `Encoding::UTF8`, then **read the file back** to confirm the change landed.
   This is about the shell **you** are typing in; the agent's own `bash` tool is
   POSIX bash (§8) and does not mangle UTF-8.

### 2.1 No promises before the test exists

**A comment that promises behaviour needs a test that goes red when the guard
is removed. If you cannot write that test, do not write the promise** — or scope
the promise to what is actually measured. A common mistake: *"the broken line is
dropped"* (dropped in memory, the file is not truncated) · *"TOCTOU is enabled
by itself"* (the patch compares the old value against the value it is about to
write) · *"a trace of every write/delete"* (the write helper does not write to
any log).

### 2.2 A green mutation is not a good test — tell the cases apart

After writing a test, break what it locks down. If the test is **still green**,
you have two cases, and they need different answers:

1. **The mutation did not apply** (string mismatch, special characters in
   PowerShell) — **always confirm the patch landed in the file** before drawing
   any conclusion.
2. **The test is empty** — it asserts something else: `assert.ok(true)`; an
   assertion on a string that only appears in the error branch; a counter
   incremented **inside the test**.

### 2.3 A test must be able to tell two implementations apart

Two implementations that produce **identical** results cannot be distinguished by
a test that only checks the result. Do not rely on it; rely on something
**measurable** (for example, assert on the string as it is loaded).

### 2.4 Zero and empty results are suspicious results

Zero looks plausible, so it is easy to believe. Before concluding "there is
nothing here", re-check the **measurement**: run it against something that
certainly exists and see whether it returns something other than zero.

## 2.5 Plan, test and review — three layers must not drift

Measured 2026-10-20 on the predecessor Next.js application (the same `vyen`
product before this CLI): the feature "simulated turn for the CLI" shipped with
**1 Critical** — the model's answer was never written to the transcript. This
was not carelessness: the three layers had drifted.

| Layer | Where | How it drifts |
|---|---|---|
| Criteria (prose) | `## Review Focus` | *"the simulated turn's transcript must be recorded"* — **no criterion had a test** |
| The work (code) | Task in the plan | The task only says *"return `messages.slice(soDauVao)`"* ⇒ **the code satisfies it** while the criterion is still wrong |
| Verification | test + review | The test is green because the expectation came from the code; **no review** before the push |

⇒ Extend §4 to **PLANS**: prose has no effect, including prose inside a plan.

### Law 1 — Every criterion = one row in the "criterion → test" table

A plan written from **2026-10-22** on (the date this rule was adopted) must
contain a `## Scenarios & Tests` section:

```md
## Scenarios & Tests

**What the user sees:** <1-3 sentences: after running it, what does the user see?>

| # | Criterion | Test |
|---|---|---|
| 1 | <first 5 words of the criterion in Review Focus> | `tests/<file>.test.mjs` |
```

Every numbered item in `## Review Focus` needs a matching row, and — once the
plan is done — the test file named in the row must **exist**.
`tests/plan-traceability.test.mjs` checks exactly those two things ⇒ a criterion
without a row is **RED**. Plans written before 2026-10-22 are history and are
not retrofitted (§4).

The guard accepts a criterion written as `1.` or `1)`, a plan file named
`YYYY-MM-DD-<slug>.md`, and a row that names `tests/<name>.test.mjs`. From
2026-10-23 a row must also name the test after `›` — a file whose test was
deleted must go red. Anything else is **RED**, so write the plan in that shape
from the start.

The test **cannot** check that the row really covers the criterion: constraining
it by comparing lead words once **falsely rejected a valid plan**. ⇒ The prose in
the table still has to be **read** (by the agent and by the reviewer). Do not
promise more than the test guards.

The `**What the user sees:**` line is written **before** the code: it is the one
boundary the plan's author did not think of.

### Law 2 — Expectations come from the requirement, not from the code

Numbers and values in an expectation must be derived from the requirement —
**not** from "this is what I just wrote". Measured 2026-10-20:
`expect(r.messages.length).toBe(2)` — the 2 was counted off the code ⇒ the test
was green because the code was as written, not because the behaviour was right.
The tell: change the implementation (add or remove one message) and the
expectation must **change with it**.

### Law 3 — Every feature has at least one end-to-end scenario test

At an **observable** boundary: a file on disk, real output, an exit code.
A function-level test cannot catch a system-level bug — that was exactly the
Critical of turn 6.

### Law 4 — Independent review is MANDATORY before pushing

Skill `requesting-code-review`. Measured 2026-10-20: the turn that implemented
the simulated turn **pushed 4 commits** without calling review — and the
reviewer afterwards caught exactly that Critical. Re-reading your own diff
**cannot** replace it: self-review is broken by construction (it re-reads the
*intent*, not the *behaviour*). The reviewer must be asked to **run an
end-to-end probe**, not just read the diff.

### The usual reasons for skipping (measured)

| Excuse | Reality |
|---|---|
| "I already have a `Review Focus`" | Focus is prose; only the **Task** is checked ⇒ Focus can be wrong and nobody reports it |
| "The tests are green" | Green because the expectation came from the code (Law 2) |
| "The mutation caught it" | A mutation catches what the test **already asserted**; it cannot catch **missing** behaviour |
| "The reviewer will catch it" | Without a reviewer nobody catches it — turn 5 pushed without review |

**Laws 2/3/4 are rules for the agent and have NO test guarding them** (only Law 1
is guarded). Do not demand a test for them — and do not treat them as optional.

## 3. A new tool touches four places

A tool that runs is not yet a finished tool. Adding one means all of:

- `src/tools.ts` — the registration and its schema, the alias normalisation in
  `normalizeToolInput`, and the state-transition classification in `isReadOnly`
- `src/context.ts` — the ACTIVE MODE tool list inside the system prompt
- `src/harness.ts` — `buildToolMeta`, which produces the TUI summary line
- `src/tui.ts` — the slash-command list, when the tool has a slash command

Missing one of them is a silent defect: the tool works but the agent never sees
it, or the agent sees it but the TUI shows a bare name.

### 3.1 A slash command, config key or event has its own seams

- **Slash command:** `src/cli.ts` parsing, `src/tui.ts` help/autocomplete,
  `src/help.ts`, `README.md`, and a test that runs the command.
- **Config key or CLI flag:** `src/config.ts` schema/default, `src/cli.ts` flag,
  `src/help.ts`, `docs/SPEC.md`, `README.md`, and a test that proves the default.
- **`HarnessEvent`:** the union and emit site in `src/harness.ts`, the TUI and
  NDJSON renderers, `docs/SPEC.md`, and a consumer test at the stream boundary.

Skipping a seam is SPEC drift even when the code compiles.

## 4. Docs

**Docs have no effect. Tests do.** Plans included — see §2.5.

- `docs/SPEC.md` — the contract. If the code and SPEC disagree, one of them is a
  bug; say which.
- `docs/VALIDATION.md` — what the suite actually covers, and which claims are
  *not* established.
- `docs/REFERENCE_REVIEW.md` — design references and the reasoning behind the
  stream and subagent contracts.
- `README.md` — the user-facing surface. A behaviour change the user can notice
  belongs here.
- Plans in `docs/superpowers/plans/` are **history**. A completed plan is not
  rewritten; if code still points at a section of a plan, keep the pointer
  resolvable.

## 5. Language

| Where | Language |
|---|---|
| Code, comments, docs, test names | **English** |
| Commit messages | **English**, `type(scope): description` (`feat:`, `fix:`, `refactor:`, `chore:`) |

Measured 2026-10-22: the last 20 commits are ASCII-only. Keep it that way —
accents in commit subjects break some tooling and the release automation.

## 6. Dead code gets deleted

*"If it is not needed, delete it — do not keep it."* Do not keep it because it
"might be needed later", and do not refactor code unrelated to the task.
Delete it **cleanly in the code** — the reason belongs in the commit message, not
in a "tombstone" comment left in the source. Keep a comment only where the next
person is very likely to write it again (an architectural trap).

**Before writing something new: reuse what exists.** Writing a second mechanism
for a job that already has one is **a patch**. Before creating a file,
constant or function, answer by grep: has anyone already done this? If yes —
**extend it**, do not write a parallel one. The repository already has
`~/.config/vyen/memories.json` (user-scoped preferences, injected into the
prompt) and the `## Lessons` section of this file (project-scoped, dated, in the
repository). A second store for either job is a patch.

**Before deleting: not finding it is NOT proof.** Four things are required:

1. Run the search against something that **certainly still exists** and confirm it
   is found.
2. Do not trust an empty result when the command just printed errors (a wrong
   regex makes `Select-String` throw *per file* and still exit 0 with no
   matches).
3. Use a real recursive tool: `rg`, the `grep` tool, `Get-ChildItem -Recurse`.
   `**` in PowerShell is not always recursive.
4. Scan the whole tree, not only the source directory — a live symbol can live
   in `tests/`, a fixture, a config file, or only appear as a **string**.

## 7. Units and identifiers must match

### 7.1 Units between a schema and the backend must match

Renaming a parameter does **not** change its unit. A different unit must be
**converted**, and the conversion must follow **each tool**, not the parameter
name. Before believing that a parameter name "matches", open the schema **and**
the backend's schema side by side and read the **min/max and the unit** of both.

### 7.2 Never key on a user-supplied (or model-supplied) string

```
read "a.txt" → write "./a.txt"  ⇒ NOT blocked ✘   (same file!)
read "a.txt" → write "A.TXT"    ⇒ NOT blocked ✘   (Windows does not distinguish case)
```

The rule: key on the **normalised** form (`path.resolve` plus lower-casing on a
case-insensitive filesystem), never on the raw string the user typed. The same
rule applies to everything used as a key: session ids, file names, config keys.

### 7.3 Change a contract → grep every caller

Changing the **signature**, the return type or the behaviour of a function can
break code *calling* it outside the diff. Before changing, **grep every caller**
over the whole tree. Fix it in the **shared place, once** — do not patch each
caller in turn to "make it work".

## 8. Check the bytes when editing files — BOM and meaningless changes

- Source files **must not** have a BOM (`tests/repo-hygiene.test.mjs` guards it).
- After a bulk edit, read `git diff --stat` and look for a file that changed
  entirely without its content changing.
- Special characters in an edit command are a silent source of errors: a
  backtick instead of a quote is a **parse error**, while `'` inside a
  PowerShell `.Replace()` with a non-ASCII string **does not match and does not
  error**.
- In this repository the agent's `bash` tool is **POSIX bash** (Git Bash/MSYS on
  Windows), never cmd.exe: use POSIX syntax and `/dev/null`. `>nul` creates a
  literal file named `nul` — the tool rewrites it to `/dev/null` and deletes the
  stray file, but do not rely on the cleanup.
- Termux: use `$PREFIX` paths, never assume `/tmp` or `/bin/sh`; no native
  addons; probe bubblewrap instead of assuming Android allows it.

## 9. Quick map

**Flow:** `bin/vyen.mjs` → `cli.ts` → `harness.ts` → `provider.ts` / `tools.ts` → `files.ts`, `process.ts`, `mcp.ts`.

| Job | Where |
|---|---|
| Tool registry, schemas, permission modes | `src/tools.ts` |
| Session prefix approval and bypass rules | `src/approval.ts` |
| Layered project settings, allow/ask/deny policy | `src/settings.ts`, `src/policy.ts` |
| System prompt, compaction, project instructions | `src/context.ts` |
| Harness loop, streaming, tool batching | `src/harness.ts` |
| Session store, checkpoints, locks | `src/session.ts` |
| Provider adapters (OpenAI / Responses / Anthropic) | `src/provider.ts` |
| Files: path safety, backups, diffs, apply_patch | `src/files.ts` |
| Shell execution and process groups | `src/process.ts` |
| MCP clients and tools | `src/mcp.ts` |
| Subagents | `src/subagents.ts` |
| Reasoning projection | `src/reasoning.ts` |
| Terminal UI | `src/tui.ts` |
| CLI entry, flags, slash commands | `src/cli.ts` |
| Config paths, atomic writes | `src/config.ts` |
| Error redaction | `src/errors.ts` |
| Legacy `goon` → `vyen` migration | `src/migrate.ts` |
| Remote pair server, Agent Network, workflows | `src/pair.ts`, `src/network.ts`, `src/workflow.ts` |
| Setup, prompt files, help, update, version, exports | `src/setup.ts`, `src/prompts.ts`, `src/help.ts`, `src/update.ts`, `src/version.ts`, `src/index.ts` |
| Tests (node:test + local mock provider) | `tests/*.test.mjs` |
| Release packing | `scripts/pack-release.mjs` |

## 10. Before reporting done

Run the §1 checklist. In addition:

- [ ] New files are `git add`ed
- [ ] Source files have no BOM (§8)
- [ ] `git status` shows only the files this task touched — every new file was
      read before it was staged (§6)

## Lessons — append here

The accumulating part: one dated, evidence-backed rule per mistake. Read this
section before planning; append to it after you get something wrong.

Format:

```
- [mistake|pitfall|approach] (YYYY-MM-DD) One reusable rule, naming the file,
  command or path it is about. Evidence goes in the sentence, not in a story.
```

`mistake` — something done wrong that must not be repeated. `pitfall` — a trap
in this codebase that surprises people. `approach` — a technique that worked,
reuse it.

**No secrets.** A lesson never records an API key, a token, a credential or
personal data. Name the *place* where the secret lives, never the secret.

**Enforced vs self-declared.** An entry ending in `(guard: tests/<file>.test.mjs)`
is enforced by that test; every other entry is self-declared and relies on the
agent choosing to follow it.

- [pitfall] (2026-10-22) Tests import from `dist/` — run `npm run build` before
  `node --test tests/<file>.test.mjs`, or a mutation check runs stale code.
- [pitfall] (2026-10-22) `execFile` and `spawn` cannot run `npm.cmd` on Windows
  without a shell (EINVAL) — run `node node_modules/typescript/bin/tsc` directly
  instead of `npm run build`.
- [mistake] (2026-10-22) A file nothing loads is dead — grep the loader first.
  Only `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` reach the prompt.
- [pitfall] (2026-10-22) A guard that contains the literal it searches for
  reports itself — spell the pattern in pieces and check its own file is clean
  (guard: tests/repo-hygiene.test.mjs).
- [mistake] (2026-10-22) `git add -A` swept in an untracked file without
  reading it — run `git status` and read every new file before committing it.

Keep this list short: when a lesson has been folded into a rule above, delete
the dated line. The section is loaded into every prompt — an unbounded list
pushes the rules out of the context.
