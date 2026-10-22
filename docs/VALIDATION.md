# Validation — 0.2.2

Executed on Linux x64, Node.js 24.19.0, 2026-10-16.

The earlier 29/29 result for 0.1.0 was obtained with the default umask only.
It missed a real bug: open(mode) and writeFile({mode}) both apply umask. Under
007 the original file-mode test failed (28/29 overall), and an edit could change
0755 to 0750. That earlier result did not establish restrictive-umask behavior.

## Current checks (2026-10-16 Linux run — not repeated since)

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

## 2026-10-22 — agent work agreements

`AGENTS.md` now carries the working agreements and the accumulated lessons for
this repository, and two new guard files turn the rules that must not rot into
something the suite enforces.

Measured on Windows, Node 26.12.0: `npm test` → 153 tests, 146 pass, 5 fail,
2 skipped. The five failures are exactly the known platform failures listed
above — four in `tests/files.test.mjs` (no POSIX mode bits, no unprivileged
symlinks) and one in `tests/publish.test.mjs`. The publish test writes its own
extensionless `gh` stub onto `PATH`; Windows cannot execute an extensionless
shebang file, so the spawn fails with `spawn gh ENOENT` — the real GitHub CLI is
neither needed nor involved. `npm run typecheck` and `npm run lint` pass. The
rows in "Current checks" are from the 2026-10-16 Linux run and were not
repeated here.

New coverage:

- `tests/repo-hygiene.test.mjs` — no byte-order mark in `src/`, `tests/`,
  `scripts/`, `bin/`; no `@ts-ignore`; a reason on the same line for every
  `@ts-expect-error`; the two guard files reference each other, so neither can
  be deleted alone.
- `tests/plan-traceability.test.mjs` — every plan states numbered
  `## Review Focus` criteria; every plan written from 2026-10-22 on carries a
  `## Scenarios & Tests` table with one row per criterion; every row names a
  test file that exists; the guard refuses to pass vacuously.
- `tests/context.test.mjs` — a workspace `AGENTS.md` reaches the system
  prompt, `## Lessons` section included. This is the observable boundary for
  "the rules the agent is given are the rules in the file".

Each guard was proven **red** with a throwaway probe — a file carrying a BOM, a
`@ts-ignore` line, a plan missing its table, a row naming a test file that does
not exist — before it was trusted. The probes were removed and the guards went
green. One probe exposed a defect in the guard itself: a test that contains the
literal it searches for reports itself, so the directives are spelled in pieces.

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
- Repository hygiene tests cover the byte-order mark, the type-checker escape
  hatches and the plan-to-test traceability; the workspace `AGENTS.md` is
  checked at the system-prompt boundary.

The GitHub workflow now runs the full suite at default, 027 and 007 umasks on
Node 22.16 and 24. Consult the repository's Actions runs for remote results.

## Scope

No Android/Termux device, ARM64, macOS or Windows was available for execution.
Termux is an implementation target, not a device-tested claim. POSIX PTY coverage
is skipped on Windows. Emoji grapheme rendering can vary between terminals;
--no-tui retains plain readline. MCP integration covers tools over stdio and
Streamable HTTP; resource listing and reads are implemented, and reading a
resource requires approval. Prompts, OAuth and legacy SSE are not implemented.
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
