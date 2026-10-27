# AGENTS.md — working agreements for this repository

TypeScript 5.9 (strict, NodeNext) + Node ≥ 22.16 + AI SDK 6, packaged as the
`vyen` terminal coding agent. Primary target is Termux/Android on Linux; Windows
is supported.

**The contract is `docs/SPEC.md`** — read it for what code promises. This file adds
working agreements. Keep it short: loaded in prompts via `loadProjectInstructions`
(`src/context.ts`), truncated at 24 000 characters; unenforced rules are harmful.

**Budget: stay under 24 000 characters combined, with at least 1 000 to spare.**
`loadProjectInstructions` truncates combined instructions (`AGENTS.md` + `AGENT_LEARNINGS.md`)
at 24 000 and drops the middle. Keep $\ge 1,000$ spare. Fold lessons into rules or move
background to `AGENT_LEARNINGS.md`.

**Read only what this turn needs.** Plans in `docs/superpowers/plans/` are history,
not input. Read this file, current plan, and touched spec sections.

## 1. The gate before reporting "done"

```bash
npm run lint         # oxlint src tests bin scripts
npm run typecheck    # tsc --noEmit
npm test             # tsc build -> node --test tests/*.test.mjs
```

`npm test` builds first, proving the build is clean.
`npm run release:pack` is for release work only — do not run it for an ordinary change.

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

- **Do not lower the gate.** `@ts-ignore` banned; `@ts-expect-error` requires reason
  on same line; no `as any` to silence `tsc`; no disabling lint rules; no `--no-verify`.
  Fix code, not rules (`as any` and lint rules apply to new code; §6 forbids out-of-scope refactors).
- **Do not edit gatekeepers.** `tests/plan-traceability.test.mjs` and
  `tests/repo-hygiene.test.mjs` guard this file; editing them to pass failures is forbidden.
  *Exception:* deliberate rule changes must update the guard with commit explanation.
- **Do not bend evidence.** Never report "verified" or "done" without running the command.
  Report exact command output (e.g. `npm test` -> 248/249 green).
- **Destructive commands.** No `git reset --hard`, `git checkout -- .`, `git restore .`,
  `git clean -fd`, `git push --force` without asking first; never touch uncommitted changes outside scope.
- **Secrets & Config.** Never print keys into transcripts or commit `.env`/key files; keys
  come from `VYEN_API_KEY` or `~/.config/vyen/credentials.json`. Redaction in `src/errors.ts`.
  Missing `~/.config/vyen/` or credentials/memories bootstrap on demand; never crash when absent.

> **Guarded vs self-declared.** BOM, `@ts-ignore`, and reason-less `@ts-expect-error`
> are guarded by `tests/repo-hygiene.test.mjs`; traceability tables by
> `tests/plan-traceability.test.mjs`. The rest (`as any`, `--no-verify`, destructive
> commands, bent evidence) are self-declared and non-negotiable.

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

**Three Review & Completion Rules:**
1. Before saying it's done, run the tests and the build, and paste the output.
2. After making changes, have a subagent that hasn't seen this conversation review the diff against `REVIEW.md`. From round two on, it looks only at what's new.
3. Three review rounds max. If it still doesn't pass after three, stop and come back to rethink the approach with me.

**Review findings become rules, not TODOs:** Every confirmed finding (red test,
review verdict, user correction) lands as a rule in the section that owns it
before the turn ends. Never defer review findings as TODOs while leaving the rule
untouched.

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

### 3.4 Session lifecycle touches the store, not transient harnesses

Session lifecycle synchronization (`SessionStart`/`SessionEnd`):
- Key lifecycle state to the `SessionStore` (module-level `WeakSet`), never to
  transient `Harness` instances.
- Trigger `activeHarness.endSession()` before store swaps (`/new`, `/resume`,
  `/delete`) and in subagent cleanup (subagents maintain their own child `SessionStore`).
- Nested runners (Agent Network, workflow steps with `sessionLifecycle: false`) inherit tool hooks but do not emit global session lifecycle hooks.

## 4. Docs

**Docs have no effect. Tests do.** Plans included — see §2.5.

- `REVIEW.md` — review checklist and bug patterns from git history.
- `docs/SPEC.md` — the contract. If code and SPEC disagree, one is a bug; say which.
- `docs/VALIDATION.md` — what the suite covers, and what claims are *not* established.
- `docs/REFERENCE_REVIEW.md` — stream and subagent design references and rationale.
- `docs/MCP.md` — Model Context Protocol architecture, tools and resources.
- `docs/AUDIT.md` — audit checklist, threat model, and security review history.
- `docs/ROADMAP.md` — evolutionary milestones, phase tracking, and completed architecture.
- `README.md` — the user-facing surface. A behaviour change the user can notice belongs here.
- Plans in `docs/superpowers/plans/` are **history**. A completed plan is not rewritten;
  keep existing pointers resolvable.

## 5. Language

| Where | Language |
|---|---|
| Code, comments, docs, test names | **English** *(Exception: `README.md` and `CHANGELOG.md` are in Vietnamese)* |
| Commit messages | **English**, `type(scope): description` (`feat:`, `fix:`, `refactor:`, `chore:`) |

Measured 2026-10-22: commit subjects are ASCII-only to prevent tooling/release breaks.

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

**Before deleting: not finding it is NOT proof.** Four requirements:
1. Search something that definitely exists to confirm the search tool works.
2. Never trust empty output when the command printed errors (`Select-String` regex errors exit 0).
3. Use a real recursive tool (`rg`, `grep`, `Get-ChildItem -Recurse`; `**` in PowerShell is unreliable).
4. Scan the full tree (`tests/`, fixtures, configs, strings), not just `src/`.

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
| MCP clients, tools, presets, and memory | `src/mcp.ts`, `src/mcp-presets.ts`, `src/memory.ts` |
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

## 11. Empirical learnings & failure patterns

Detailed failure patterns, anti-patterns, active tripwires, and security mistake
analyses are maintained exclusively in `AGENT_LEARNINGS.md` (loaded automatically
alongside this file by `src/context.ts`). When a mistake is confirmed (red test,
review verdict, user correction), append the evidence there — never a second copy
of a rule that already lives in `AGENTS.md`.
