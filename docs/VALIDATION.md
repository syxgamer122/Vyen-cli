# Validation — 0.2.2 (upstream record)

> The section below is upstream's dated record, taken from `binxgtl/goon-cli` at
> v0.2.25. The current run for this fork is at the end of the file.

Executed on Linux x64, Node.js 24.19.0, 2026-10-16.

The earlier 29/29 result for 0.1.0 was obtained with the default umask only.
It missed a real bug: open(mode) and writeFile({mode}) both apply umask. Under
007 the original file-mode test failed (28/29 overall), and an edit could change
0755 to 0750. That earlier result did not establish restrictive-umask behavior.

## Current checks

| Command / environment | Result |
|---|---|
| `npm test` | 76 passed, 0 failed, 0 skipped |
| `(umask 027; node --test tests/*.test.mjs)` | 76 passed, 0 failed, 0 skipped |
| `(umask 007; node --test tests/*.test.mjs)` | 76 passed, 0 failed, 0 skipped |
| `npm run typecheck` | Passed, strict TypeScript |
| `npm run lint` | Passed, no warnings |
| `npm run release:pack` | Built, packed, installed in isolated prefix, executable/help/version passed |
| CLI integration tests, including terminal-answer regressions, from installed archive | 55 passed, 0 failed, 0 skipped |

File tests now establish 0755 with an explicit chmod after fixture creation.
A regression test launches separate Node processes with umasks 027, 007 and 077,
edits existing files at modes 0755, 0640 and 0444, and checks exact permissions.
It separately checks that new files obey the process umask. Runtime writes
chmod the temporary file for existing files before fsync/rename.

## Stream/subagent dogfood regressions

The user's 0.2.0 dogfood report found child event spam and inline think text
being shown as an answer. A before/after comparison of the released executable
and the fix (two children, 256 one-character text deltas each, 150-word contexts)
measured **518 → 6** parent subagent events, **689109 → 3037** NDJSON bytes and
**518 → 2** copies of task. This is a controlled mock-provider fixture.

A separate tool-bearing regression asserts exactly twelve child events for two
children, regardless of narration length, with final-report-only delivery and
complete original child messages retained. Cleanup fault injection verifies
error terminals, lock-release ordering and slot reuse. The reasoning suite tests
every marker split position, nested/multiple/unclosed blocks, code literals,
explicit extraction-off and opt-in rendering, unchanged tool/resume history,
Anthropic signature replay, reasoning-only failure, truncation and cancellation.
Compaction tests accept only the visible summary before replacing history.

See [REFERENCE_REVIEW.md](REFERENCE_REVIEW.md) for pinned upstream sources,
adopted contracts, NDJSON migration and remaining implementation boundaries.

## 0.2.2 missing terminal answer

The 0.2.1 guard required an observed reasoning flag before rejecting an empty
answer. Baseline runs reproduced successful `done` with empty text for an empty
response, opaque gateway reasoning, a parent after child completion, and native
Anthropic redacted thinking. The user's exact gateway payload was not supplied;
these fixtures establish the guard defect rather than claim a provider-specific
production diagnosis.

Nine new tests cover empty/whitespace/native/opaque/redacted terminal responses,
prior tool narration followed by an empty final, successful children followed by
an empty parent final, empty child failure, and explicit permission denial.
The mutation test verifies completed writes/history survive the error and resume
does not replay them. Usage and locks are also checked. Validation now requires a
non-whitespace answer in each terminal model step regardless of reasoning flags.

## Integration coverage

Tests use local mock model HTTP endpoints and real AI SDK adapters, filesystem,
subprocesses and session stores. No paid model request was made.

- OpenAI-compatible streamed tool arguments and reasoning roundtrip; Anthropic
  Messages and OpenAI Responses; write/read/edit across resume; offline
  init/doctor; invalid config; key redaction; noninteractive approval denial;
  read-only tool surfaces; incomplete stream rejection and HTTP cancellation.
- Scheduler order, two concurrent reads and serial mutation barriers;
  cancellation result pairing; compaction/archive; oversized input; stale file
  revisions; exact edits; symlink/path escapes; fallback search; output bounds;
  process groups/timeouts; session locks, dead-owner recovery and workspace resume.
- MCP uses real SDK servers over both stdio and Streamable HTTP, including
  paginated discovery, local argument validation, bearer/env mapping, refusal
  to inherit the provider key, explicit read-only allowlists, ignoring remote
  readOnlyHint for permissions, isError propagation, cancellation, timeout,
  credential redaction, unregister/close and CLI startup-failure lock cleanup and
  SIGTERM during MCP initialization
  preserving exit code 143 while killing the server and releasing the session.
- Subagents run through the real provider/harness loop: isolated context,
  read-only child tool surfaces, maximum two concurrent research workers,
  sequential editing workers, no recursive delegation, inherited approvals,
  denial stopping the parent, shared budget accounting, persistent child
  sessions, SIGINT draining children and releasing every session lock.
- TUI tests keyboard editing/history, Unicode/wide-character wrapping,
  cancellation, narrow resize and escape-sequence removal. A real POSIX
  pseudo-terminal drives the CLI through /status, resize, a task, a write
  approval and /exit; it verifies alternate-screen exit, canonical-mode
  restoration, written file contents and absence of session locks. The PTY
  test uses Python 3 during development/CI; the installed CLI does not.
- Release tests cover stable-version selection, patch increments, lockfile
  synchronization, installed version reporting, and a local bare-Git/mocked
  GitHub publishing simulation including retry without another version bump.

The GitHub workflow now runs the full suite at default, 027 and 007 umasks on
Node 22.16 and 24. Consult the repository's Actions runs for remote results.

## Scope

For the 0.2.2 upstream record: no Android/Termux device, ARM64, macOS or Windows
was available for execution. Termux is an implementation target, not a
device-tested claim. POSIX PTY coverage is skipped on Windows. Emoji grapheme
rendering can vary between terminals; --no-tui retains plain readline. MCP
integration covered tools over stdio and Streamable HTTP at that time; resources,
prompts, OAuth and legacy SSE were not implemented in that tree. Resources are
implemented in the current tree; see the 2026-10-24 section below.
Children have separate transcripts and tool policies, not OS isolation. They do
not load MCP or spawn further agents. Shared budgets are checked between model
requests, so concurrent in-flight requests may exceed the threshold.

Shell/MCP processes run as the current user, without an OS sandbox. File path
checks prevent ordinary traversal/symlink mistakes and are not a boundary
against a hostile process sharing that account. Transcript data is not globally
secret-scrubbed. Reported key-redaction tests cover error output, not all possible
model or tool content.

The installable archive includes compiled dist/ and installs with development
dependencies omitted and lifecycle scripts disabled. The inspected installed
runtime tree contains zero `.node` native addons. Platform-specific lint binaries
are development dependencies only. Runtime dependencies still download from npm.

## 2026-10-22 — vyen fork on the upstream 0.3.0 tree

This fork takes `binxgtl/goon-cli` at v0.3.0 plus its two unreleased commits
(`feat(resume): tabbed session picker for this folder and all projects` and
`fix(approval): narrow prefix approvals found by independent review`) as its
source, renames the product to `vyen`, and keeps three fixes upstream still
lacks. Upstream's own audit is in `docs/AUDIT.md`; the fork's deviations are
recorded in `docs/superpowers/plans/2026-10-22-upstream-merge.md`.

Measured on Windows, Node 26.12.0: `npm test` → 158 tests, 146 pass, 6 fail,
2 skipped. The six failures at that time are the platform failures then listed in `AGENTS.md` §1 —
four in `tests/files.test.mjs` (no POSIX mode bits, no unprivileged
symlinks), one in `tests/audit.test.mjs` (a symlink to an image outside the
workspace) and one in `tests/publish.test.mjs` (an extensionless `gh` stub
cannot be executed on Windows). `npm run typecheck` and `npm run lint` pass.

The fork's own suite adds: `tests/brand.test.mjs` (no live `goon` identifier
survives the rename), `tests/migrate.test.mjs` (the goon → vyen data
migration), `tests/plan-traceability.test.mjs` and
`tests/repo-hygiene.test.mjs` (the two guards that protect each other).

What the fork adds on top of upstream:

- The `vyen` identity: the npm package is `@nguyenhuumanh/vyen` (npm's name
  policy rejects every unscoped `vyen*` name) and the installed command is
  still `vyen`.
- `src/migrate.ts`: a goon installation's config, credentials, memories,
  presets, skills and sessions are copied into the vyen directories on first
  launch. The copy is resumable, never overwrites an existing file, never
  moves or deletes the legacy data, and never throws.
- `read_mcp_resource` requires approval and is absent in read-only mode.
  Upstream still registers it read-only, so an MCP server can return any
  content it holds without the user seeing a prompt.
- `wait_agent` reports `timed_out: true` while any target still runs.
  Upstream still derives the flag from whether *any* target finished, so a
  parent can read "not timed out" while a child is still working.
- A workspace change drops the turn checkpoints, so `/revert` in a second
  project cannot restore the first project's files.

Not established by this fork: Termux/Android device behaviour, macOS, ARM64,
and the provenance of the upstream fixes on hardware other than Linux CI.

## 2026-10-23 — the traceability guard resolves a test title

Measured on Windows, Node 26.12.0: `npm test` → 172 tests, 163 pass, 7 fail,
2 skipped. Six failures are exactly the platform failures listed in
`AGENTS.md` §1; the seventh is `tests/files.test.mjs` "a workspace change makes
the old backups unreachable instead of restoring them elsewhere", a test added
by a concurrent, uncommitted change outside this work. `npm run typecheck` and
`npm run lint` pass.

What changed:

- `tests/plan-traceability.test.mjs` now resolves a `Scenarios & Tests` row to
  the **test title** inside the file, not only to the file. The upstream merge
  of 2026-10-22 deleted the body of `tests/context.test.mjs` while the file
  stayed in place, and the file-only check stayed green. Plans dated
  2026-10-23 or later must write `tests/<file>.test.mjs › <test title>`;
  earlier plans are history and are not retrofitted.
- The end-to-end test that proves a workspace `AGENTS.md` reaches
  `systemPrompt()` was restored, `## Lessons` section included.
- `tests/repo-hygiene.test.mjs` reads the prompt truncation limit from
  `src/context.ts` and fails when `AGENTS.md` comes within 1 000 characters
  of it.
- The `## Lessons` section now declares which entries a test enforces
  (`(guard: tests/<file>.test.mjs)`) and that every other entry is
  self-declared.

Proved red before green: a plan row naming a missing title, a row naming a
title that lives in a different file, and an `AGENTS.md` over the margin each
failed with their own message. A plan dated 2026-10-22 without a title stayed
green. The working tree was clean after the probes.

Not established: the guard proves the test **exists by name**, not that the
test covers the criterion. That prose still has to be read, by the agent and by
the reviewer.

## 2026-10-24 — POSIX terminal tests require `python3`

The three pseudo-terminal tests spawn `python3` directly:

- `tests/tui.test.mjs` — "real TUI pseudo-terminal handles status, resize,
  approval and clean exit" and "real TUI pseudo-terminal: rebuilding the harness
  mid-run keeps the run cancellable", through `tests/fixtures/terminal.py`.
- `tests/audit.test.mjs` — "real TUI: approvals come back after switching from
  `--yes` (auto) to ask mode", through `tests/fixtures/terminal-mode-switch.py`.

Both fixtures import `pty`, `termios` and `fcntl`, so they are POSIX-only. The
tests skip **explicitly** on `win32` with `t.skip('POSIX pseudo-terminal test')`.
On a POSIX host without `python3`, `spawn` fails and the promise rejects through
`child.on('error', reject)`, so the test is **red**, not silently skipped. A
Linux CI image must therefore provide `python3`; do not add a "python missing"
skip, which would turn the dependency into a silent gap.

Not established: this record does not prove the tests ran on a host without
`python3` — it records the code path that makes such a host fail loudly.

## 2026-10-24 — stale release artifact removed

The 0.1.0-era archive in `release/` and its `SHA256SUMS.txt` were stale: the
archive contained the legacy `bin/` entry and 12 `src/` files, while
`package.json` is at 0.4.0 with 25 modules. No script reads or writes
`release/`; `scripts/pack-release.mjs` writes to `release-out/`, and
`package.json`'s `files` list excludes `release`. The directory and the
`!release/*.tgz` carve-out in `.gitignore` were deleted. `npm pack --dry-run
--ignore-scripts` lists 45 files and contains no `release/` entry.

Not established: the deletion is not guarded by a test. `tests/brand.test.mjs`
filters by extension (`ts|mjs|md|json|yml|py`), so it could never see a `.tgz`
even if `release/` were added to its scan list.

## 2026-10-24 — Phase 0 critique fixes (Windows)

Executed on Windows, Node 24.18.0, npm 12.0.2.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | 202 tests, 194 pass, 5 fail, 3 skipped, 184.9 s |
| `npm run release:pack` | exit 0; packs, installs in an isolated prefix, and runs `--version` / `--help` |

The five failures are the documented Windows-only cases, not regressions:

- `tests/audit.test.mjs` — "model-initiated image reads outside the workspace
  require approval; workspace images do not" (`EPERM` creating a symlink).
- `tests/files.test.mjs` — "existing files require a fresh read; edits preserve
  file mode" (POSIX mode bits reported as 438 instead of 493).
- `tests/files.test.mjs` — "edits preserve exact permissions under restrictive
  umasks; new files obey umask" (POSIX mode lost).
- `tests/files.test.mjs` — "workspace containment rejects ../ and symlink
  escapes including missing leaves" (`EPERM` creating a symlink).
- `tests/files.test.mjs` — "portable search is bounded and skips symlinks"
  (`EPERM` creating a symlink).

The publish test is green. It now covers several portability defects that the
previous record hid: `scripts/pack-release.mjs` runs `npm` through `cmd.exe` on
Windows, accepts npm 11's array and npm 12's object from `npm pack --json`, and
removes an inherited `npm_config_allow_scripts` before a project-scoped install.
The test sets that exported value to reproduce the failure; without the removal
it fails with `EALLOWSCRIPTS`, and with it the test passes. The packer leaves the
caller's registry, proxy and authentication settings intact, so a private mirror
still works. The publish test also runs a child process with a literal `%TEMP%`
argument to prove that `cmd.exe` does not expand percent signs in checkout paths.

The prefix-approval test now also rejects attached (`-pevil_plugin`) and
clustered (`-qp`, `-qpevil_plugin`, `-qo`) short options, `--override-ini`,
`--config-file` and `@file` argument expansion, and accepts the safe
`-q -k smoke -W error` and `-ra` forms for `python`, `python3`, `py` and direct
`pytest`. The same test rejects `--test-reporter` and `--test-reporter-destination`
while keeping the safe `npm test -- --watch=false` form, and the reporter
assertions were red before the regex change. It also keeps `ls -laR` approved
while rejecting `node -r`, so the `r` exception is command-aware. The docs-contract test imports `MAX_API_RETRIES`,
`configSchema` and `DEFAULT_GATEWAY_URL` so changing those values while the prose
stays fixed fails the test; it also checks the MCP registrations, all 25 `src`
modules in `AGENTS.md`, the five known Windows failures in this file, and the
release workflow.

New focused tests: `tests/errors.test.mjs` (redaction and 2,000-character cap),
`tests/prompts.test.mjs` (template expansion, workspace precedence, front
matter and the 64 KiB limit), `tests/help.test.mjs` (documented flags and
subcommands), `tests/setup.test.mjs` (`parseEffortInput` names, numbers and
rejects) and `tests/docs-contract.test.mjs` (SPEC retry/budget/MCP-resource
claims, README release workflow and default-gateway disclosure). Each new test
file had at least one test mutated once and observed red before restore; the
docs-contract test was red against the pre-fix documents.

R0.9 is covered by `tests/runtime.test.mjs` ("the default gateway warns once
before the first request and an explicit gateway stays silent" and "gateway
warning routes interactive runs to the display and noninteractive runs to
stderr") and `tests/setup.test.mjs` ("setup warns before probing the default
gateway and stays silent for another preset"). A test-only `--require` shim
answers `/models` and `/chat/completions` without network access and records each
request; the test asserts the warning appears once on stderr before the request
marker for both a prompt and `doctor`, and that an explicit `--base-url` stays
silent. The setup test uses the `SetupIO` seam and an isolated config/data
directory to assert the warning is written before `discover`, is absent for a
first setup choosing OpenRouter, and is absent for a later setup with an explicit
saved default. `DEFAULT_GATEWAY_URL` is unchanged. `doctor --json` keeps its
existing `baseUrl` field, adds `effectiveBaseUrl` and `defaultGateway`, and the
same runtime test asserts both the default and explicit destination cases.

Not established: no Termux/Android or ARM64 host was available, so the Termux
sandbox and startup budget remain unmeasured. This workspace is not a git
repository, so nothing was committed.

The `--test-reporter` and `--test-reporter-destination` deny-list additions in `src/approval.ts` were proven RED before the fix and GREEN after; the full suite completed at 202 tests, 194 pass, 5 fail, 3 skipped.
