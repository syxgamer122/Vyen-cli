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

**Windows platform skips.** Five platform cases (POSIX mode bits and unprivileged
symlinks: four in `tests/files.test.mjs`, one in `tests/audit.test.mjs`) are cleanly
skipped on Windows (`process.platform === 'win32'`). With these skips, `npm test`
must exit 0 on all supported platforms with zero failures.

**Checklist to report "done"** — every line is a condition that must hold, not a
suggestion:

- [ ] `npm run typecheck` exit 0 · `npm run lint` no new errors · `npm test` exit 0
      (0 failures; platform skips allowed)
- [ ] New tests proven **RED** before the fix (§2); mutation confirmed to change behaviour (§2.2)
- [ ] Every promise in a new comment has a test that goes red when the guard is removed (§2.1)
- [ ] Expectations derived from requirement, not code (§2.5 — Law 2, verified in report)
- [ ] At least one end-to-end scenario test with observable output cited in report (§2.5 — Law 3)
- [ ] Independent code review verdict cited in report before pushing (§2.5 — Law 4)
- [ ] Plan has `## Scenarios & Tests` linking to real assertions (§2.5 — Law 1, guarded by
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
- **Secrets & Config.** Never print a key into the transcript, never commit key files or
  `.env`; keys come from the environment (`VYEN_API_KEY`) or
  `~/.config/vyen/credentials.json`, never hardcoded. `src/errors.ts` is where credentials
  are redacted. If `~/.config/vyen/` or credential/memory files are missing, treat them as
  empty and bootstrap on demand; never assume pre-existing files or crash when absent.

> **Guarded vs self-declared.** BOM, `@ts-ignore`, and reason-less `@ts-expect-error`
> are guarded by `tests/repo-hygiene.test.mjs`. Traceability tables are guarded by
> `tests/plan-traceability.test.mjs`. The rest (`as any`, `--no-verify`, destructive
> commands, bent evidence) are self-declared; treat them as non-negotiable.

### 1.2 Speculative hardening

Before writing code for an edge case or unlikely failure, explain what breaks,
its probability, and added complexity. Obtain approval before widening diff scope.
Never weaken existing security, path, or permission invariants.

## 2. New tests must be proven RED before the fix

```
normal → green · break the code → RED · restore → green
```

- **Avoid tautological tests:** Anchor regex patterns; check cut points (`idx > -1`);
  verify edits actually landed on disk before testing.
- **No unmeasured promises:** A comment promising behavior requires a test that goes red
  when the guard is removed (§2.1).
- **Mutations must change behavior:** If a broken code path remains green, the test is
  vacuous or the mutation did not apply (§2.2).
- **Distinguish implementations:** Assert on measurable internal state or loaded strings,
  not just identical end results (§2.3).
- **Zero is suspicious:** Re-check measurement against known positive cases before
  concluding a result is empty (§2.4).

## 2.5 Plan, test and review — three layers must not drift

Prose has no effect, including prose inside a plan (§4). Plans and verification
are bound by four operational laws:

### Law 1 — Every criterion = one row in the "criterion → test" table

A plan written from **2026-10-22** on must contain a `## Scenarios & Tests` section:

```md
## Scenarios & Tests

**What the user sees:** <1-3 sentences: after running it, what does the user see?>

| # | Criterion | Test |
|---|---|---|
| 1 | <criterion text> | tests/<file>.test.mjs › <test title> |
```

Every numbered item in `## Review Focus` needs a matching row naming an existing
test file and test title after `›` (`tests/plan-traceability.test.mjs` guards this).
Rows must target assertions that genuinely test criterion behavior (vacuous mocks
like `assert.ok(true)` violate this rule). The `**What the user sees:**` line must be
written **before** code.

### Law 2 — Expectations come from the requirement, not from the code

Numbers and values in assertions must be derived from specifications or requirements,
never counted off newly written code. The test: change the implementation and the
expectation must break.

### Law 3 — Every feature has at least one end-to-end scenario test

At an **observable** boundary: a file on disk, real terminal output, an exit code.
Cite actual command execution output in completion reports.

### Law 4 — Independent review is MANDATORY before pushing

Invoke `requesting-code-review`. Re-reading your own diff cannot replace review:
self-review re-reads intent, not behavior. The reviewer must be asked to run an
end-to-end probe. Cite reviewer subagent verdict in completion reports.

**Laws 2/3/4 have NO automated test guard** (only Law 1 is guarded by
`tests/plan-traceability.test.mjs`). Cite their observable proof in every report.

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

### 3.2 A permission rule, policy or hook touches four execution seams

Policy, hooks, and workspace trust are not finished until all 4 execution runners
are wired:

1. `src/cli.ts` — interactive TUI, headless `-p`, and session replace (`/new`, `/resume`)
2. `src/subagents.ts` — child harnesses must inherit policy and hook bus
3. `src/network.ts` — peer Agent Network harnesses must attach `policy` to `ToolRegistry` and pass `hookBus` to `Harness`
4. `src/workflow.ts` — workflow step harnesses must inherit policy and hook bus

Missing any one is a silent security bypass: prompts in that runner execute without
user deny rules or audit hooks.

### 3.3 Security controls fail closed, never open

- **Defaults:** `HookBus.isTrusted` defaults to `false`.
- **Timeouts & errors:** `PreToolUse` hook timeouts and spawn crashes default to
  `denied: true` (fail-closed).
- **Corrupt config:** `loadProjectSettings` must strip BOM, distinguish `ENOENT`
  from syntax/schema errors, and fail closed with a clear error; never silently
  discard `deny` rules into `{}`.
- **Chained commands:** Deny rules must be segment-aware (`;&|` etc.): a `deny`
  rule matches if ANY segment matches; an `allow` rule matches only if NO chained
  segment exists.
- **Trust coverage:** `calculateWorkspaceTrustHash` must cover all local scripts
  and executables referenced in `permissions.allow`, hashing non-existent targets
  as `file:<path>:missing`.

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

*"If it is not needed, delete it — do not keep it."* Clean deletion applies in two modes:

1. **Feature / bugfix turn (Surgical):** Delete dead code created by your own changes
   or within the immediate function/module you modified. If you notice unrelated
   dead code in another file, mention it in your report—do not delete it or expand
   diff scope.
2. **Dedicated cleanup task:** When specifically tasked with dead-code removal,
   full-tree deletion is authorized, provided all 4 verification checks below pass.

Delete dead code **cleanly in the code** with the reason in the commit message,
never in tombstone comments.

**Before writing something new: reuse what exists.** Writing a second mechanism
for a job that already has one is **a patch**. Before creating a file, constant or
function, check if one already exists: if yes, **extend it**. If user memory store
`~/.config/vyen/memories.json` does not exist on disk, bootstrap it on demand;
do not invent a parallel store.

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
  On Windows, ensure editors/tools write clean UTF-8 without BOM (never use default
  PowerShell `Out-File` or `Set-Content` which inject `0xEF 0xBB 0xBF`).
- After a bulk edit, read `git diff --stat` and look for a file that changed
  entirely without its content changing.
- Special characters in an edit command are a silent source of errors: a backtick
  instead of a quote is a parse error; use Node.js scripts or proper escaping.
- In this repository the agent's `bash` tool is **POSIX bash** (Git Bash/MSYS on
  Windows), never cmd.exe: use POSIX syntax and `/dev/null`.
- Termux: use `$PREFIX` paths, never assume `/tmp` or `/bin/sh`; no native
  addons; probe bubblewrap instead of assuming Android allows it.

## 9. Quick map

**Flow:** `bin/vyen.mjs` → `cli.ts` → `harness.ts` → `provider.ts` / `tools.ts` → `files.ts`, `process.ts`, `mcp.ts`.

| Job | Where |
|---|---|
| Tool registry, schemas, permission modes | `src/tools.ts` |
| Session prefix approval and bypass rules | `src/approval.ts` |
| Layered project settings, policy and hook bus | `src/settings.ts`, `src/policy.ts`, `src/hooks.ts` |
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

Active tripwires and tactical lessons. Detailed failure patterns, anti-patterns,
and security mistake analyses are maintained in `AGENT_LEARNINGS.md` (loaded
automatically alongside this file by `src/context.ts`). When a lesson has been
folded into a rule above (§3.2, §3.3), delete the dated line to preserve prompt room.

- [pitfall] (2026-10-22) Tests import from `dist/` — compile with `node node_modules/typescript/bin/tsc`
  directly before running individual test files (`execFile`/`spawn` cannot run `npm.cmd` without a shell on Windows).
- [mistake] (2026-10-22) A file nothing loads is dead — grep the loader first.
  `loadProjectInstructions` loads `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, and `AGENT_LEARNINGS.md`.
- [pitfall] (2026-10-22) A guard that contains the literal it searches for
  reports itself — spell the pattern in pieces and check its own file is clean
  (guard: tests/repo-hygiene.test.mjs).
- [mistake] (2026-10-22) `git add -A` swept in an untracked file without
  reading it — run `git status` and read every new file before committing it.
