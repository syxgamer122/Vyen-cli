# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

Loaded by `loadProjectInstructions` in `src/context.ts`. When a mistake is confirmed
(red test, review verdict, user correction), append evidence here — never a duplicate
of a rule in `AGENTS.md`. Two copies of one rule drift apart.

## 1. System Seams: The Four Execution Runners Rule
- **Canonical rule:** `AGENTS.md` §3.2 & §3.4.
- **Anti-Pattern (CLI-Only):** wiring policy/hooks only in `src/cli.ts`/`src/subagents.ts`, leaving `src/network.ts` and `src/workflow.ts` unmediated — a silent bypass.
- **"Attach" means live:** pass the live policy evaluator, not a snapshot; test updates after construction.

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes
- **Canonical rule:** `AGENTS.md` §3.3.
- **Detail:** split on compound operators (`;`, `&&`, `||`, `|`, newline, `$()`, `<()`, `>()`, backticks); strip subshells `(...)`, `{...}`, quotes, wrappers (`sudo`, `env`, `sh -c`, `bash -c`, `eval`, `exec`); deny if ANY segment matches.
- **Seen (2026-10-25):** stripping only outer quotes allowed `"rm" -rf /`, `r\m -rf /`, `/bin/rm -rf /`, `command rm -rf /` to bypass `deny: ["bash(rm *)"]`.
- **Rule:** tokenize with shell quoting; strip wrappers and redirections; match basename (`.exe` on Windows); fail closed on `$`, backticks, command substitution.
- **Guard:** `tests/policy.test.mjs` › "bash deny and ask rules cannot be bypassed by quoting or escaping the command word".

## 3. Trust Coverage: Executables in Auto-Allow Rules
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern:** hashing only `layered.hooks`, omitting `permissions.allow` script targets (`allow: ["bash(./deploy.sh)"]`). Missing scripts hash `file:<path>:missing`.

## 4. Fail-Closed vs. Fail-Open Architecture
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern:** `isTrusted` defaulting to `true`, hook timeouts defaulting to `denied: false`, or `loadProjectSettings` catching errors into `{}`.
- **Deny Precedence:** persistent project/user `deny` rules evaluate before `cliAllowed`.

## 5. Lifecycle Synchronization: Process vs. Session Lifetime
- **Canonical rule:** `AGENTS.md` §3.4.
- **Anti-Pattern:** dispatching `SessionEnd` only on CLI exit, `SessionStart` only on `messages.length === 0`, or storing flags on transient `Harness`.
- **Guard:** `tests/hooks.test.mjs` › "Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once".

## 6. Testing Rigor: Negative Baselines & Adversarial Tests
- **Canonical rule:** `AGENTS.md` §2.
- **Rule:** test negative baselines (unconfigured tools run without prompts) and adversarial vectors (chaining, missing files, subshells, quotes); at least one test spawns the real hook process.

## 7. Review Findings Become Rules, Not TODOs
- **Canonical rule:** `AGENTS.md` §2.5 Law 4.
- **Rule:** every confirmed finding lands as a rule in its owning section before the turn ends.

## 8. Build, Loader & Guard Pitfalls
- **Tests import from `dist/`:** compile before running a single test file (`npm.cmd` cannot spawn without a shell on Windows).
- **Loader verification:** a file nothing loads is dead — grep the loader (`loadProjectInstructions`) first.
- **Self-reporting guards:** spell self-referential guard patterns in pieces.

## 9. Readers Must Not Turn Corruption Into an Empty Document
- **Seen (2026-10-25):** `loadCredentials` returned `{}` on a parse error; `saveCredential` rewrote the file with only the new key, deleting other keys.
- **Rule:** `{}` is only for `ENOENT`. Parse/schema errors throw and name the file; strip BOM before `JSON.parse`.
- **Guard:** `tests/config.test.mjs` › "saveCredential refuses to overwrite a corrupt credentials file".

## 10. Command Surfaces Must Reuse the Guarded Primitive
- **Seen (2026-10-25):** `/export` called `writeFile` after `files.path`, overwriting unread source files; `/delete <unknown>` printed `Deleted saved session: undefined`.
- **Rule:** slash commands that write or delete go through guarded primitives (`WorkspaceFiles.writeExport`, throwing store methods); never print success from `undefined`.
- **Guard:** `tests/files.test.mjs` › "session export refuses to overwrite a non-export file"; `tests/session.test.mjs` › "deleteSession reports an unknown session instead of returning undefined".

## 11. Multi-Branch Regex Tokenizers Must Keep Parallel Capture Groups
- **Seen (2026-10-28):** `highlightCode` used a non-capturing group `(?://...)` in the fallback regex, shifting destructuring offsets left by 1 and scrambling token styles.
- **Rule:** regex alternation branches `(A)|(B)|(C)|(D)` must have identical capturing group counts and index order.
- **Guard:** `tests/tui.test.mjs` › "syntax highlighting: Markdown fenced code blocks highlight keywords, strings, comments, numbers, and JSON keys in TUI".

## 12. Wire Schemas Must Be Validated Against Real Emitted Events
- **Seen (2026-10-28):** the exported `v1` stream schema rejected the CLI's own events: tool `kind` values, todo `id/text` vs `content/priority`, goal statuses, subagent `phase/agentId` vs `id/state`, and missing `workflow_done`/`network_done`. The happy-path test passed because it never parsed emitted lines with the exported schema.
- **Rule:** a hand-written wire schema reuses the canonical type/schema or is validated against a real emitted stream; every event family has a stream-level test that goes red when the shape is reverted.
- **Guard:** `tests/headless.test.mjs` -> "every emitted event validates against the v1 schema during tool use"; "event schemas cover goal, workflow, network and reject the old drift".
