# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

Loaded by `loadProjectInstructions` in `src/context.ts`. When a mistake is confirmed
(red test, review verdict, user correction), append evidence here—never duplicate
rules from `AGENTS.md`.

## 1. System Seams: The Four Execution Runners Rule
- **Anti-Pattern (CLI-Only):** wiring policy/hooks only in `src/cli.ts`/`src/subagents.ts`, leaving `src/network.ts` and `src/workflow.ts` unmediated — a silent bypass.
- **"Attach" means live:** pass the live policy evaluator, not a snapshot; test updates after construction.

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes
- **Detail:** split on compound operators (`;`, `&&`, `||`, `|`, newline, `$()`, `<()`, `>()`, backticks); strip subshells `(...)`, `{...}`, quotes, wrappers (`sudo`, `env`, `sh -c`, `bash -c`, `eval`, `exec`); deny if ANY segment matches.
- **Seen (2026-10-25):** stripping only outer quotes allowed `"rm" -rf /`, `r\m -rf /`, `/bin/rm -rf /` to bypass `deny: ["bash(rm *)"]`.
- **Rule:** tokenize with shell quoting; strip wrappers and redirections (including `VAR="..."` and `sudo -u "user"` with quoted spaces); match basename (`.exe` on Windows); fail closed on `$`, backticks, command substitution.
- **Guard:** `tests/policy.test.mjs` › "bash deny and ask rules cannot be bypassed by quoting or escaping the command word".

## 3. Trust Coverage: Executables in Auto-Allow Rules
- **Anti-Pattern:** hashing only `layered.hooks`, omitting `permissions.allow` script targets (`allow: ["bash(./deploy.sh)"]`). Missing scripts hash `file:<path>:missing`.

## 4. Fail-Closed vs. Fail-Open Architecture
- **Anti-Pattern:** `isTrusted` defaulting to `true`, hook timeouts defaulting to `denied: false`, or `loadProjectSettings` catching errors into `{}`.
- **Deny Precedence:** persistent project/user `deny` rules evaluate before `cliAllowed`.
- **HookBus Spawn (2026-10-30):** wrap `spawn()` in `try...catch` so synchronous spawn errors resolve fail-closed (`denied: true`).

## 5. Lifecycle Synchronization: Process vs. Session Lifetime
- **Anti-Pattern:** dispatching `SessionEnd` only on CLI exit, `SessionStart` only on `messages.length === 0`, or storing flags on transient `Harness`.
- **Guard:** `tests/hooks.test.mjs` › "Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once".

## 6. Testing Rigor: Negative Baselines & Adversarial Tests
- **Rule:** test negative baselines (unconfigured tools run without prompts) and adversarial vectors (chaining, missing files, subshells, quotes); at least one test spawns the real hook process.

## 7. Review Findings Become Rules, Not TODOs
- **Rule:** every confirmed finding lands as a rule in its owning section before the turn ends.

## 8. Build, Loader & Guard Pitfalls
- **Tests import from `dist/`:** compile before running a single test file (`npm.cmd` cannot spawn without a shell on Windows).
- **Loader verification:** a file nothing loads is dead — grep the loader (`loadProjectInstructions`) first.
- **Self-reporting guards:** spell self-referential guard patterns in pieces.

## 9. Readers Must Not Turn Corruption Into an Empty Document
- **Rule (2026-10-25):** `{}` is only for `ENOENT`. Parse/schema errors throw; strip BOM before `JSON.parse`. Corrupt reads must not overwrite on save (`tests/config.test.mjs`).

## 10. Command Surfaces Must Reuse the Guarded Primitive
- **Rule (2026-10-25):** slash commands that write/delete use guarded primitives (`WorkspaceFiles.writeExport`, throwing store methods); never report success from `undefined` (`tests/files.test.mjs`, `tests/session.test.mjs`).

## 11. Multi-Branch Regex Tokenizers Must Keep Parallel Capture Groups
- **Seen (2026-10-28):** `highlightCode` used a non-capturing group `(?://...)` in fallback regex, shifting destructuring offsets left by 1.
- **Rule:** regex alternation branches `(A)|(B)|(C)|(D)` must have identical capturing group counts and index order.
- **Guard:** `tests/tui.test.mjs` › "syntax highlighting: Markdown fenced code blocks highlight keywords, strings, comments, numbers, and JSON keys in TUI".

## 12. Wire Schemas Must Validate Against Real Emitted Events
- **Rule:** wire schemas must reuse canonical types and validate against real emitted streams; every event family requires a stream-level test.
- **Guard:** `tests/headless.test.mjs` › "every emitted event validates against the v1 schema during tool use".

## 13. Audit Logger Singletons & Lifecycle Flushing
- **Anti-Pattern:** Recreating logger singletons on calls with options drops the serial write queue. Mutate options (addSecretKey) instead.
- **Rule:** Flush audit queue in session lifecycle `endSession()` and server `stop()` to prevent dropped records on exit.
- **Guard:** `tests/audit-log.test.mjs` › "pair session lifecycle and remote approvals write audit records with origin".
