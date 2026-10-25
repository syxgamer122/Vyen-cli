# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

Loaded by `loadProjectInstructions` in `src/context.ts`. When a mistake is confirmed
(red test, review verdict, user correction), append the evidence here — never a second
copy of a rule that already lives in `AGENTS.md`. Two copies of one rule drift apart.

## 1. System Seams: The Four Execution Runners Rule
- **Canonical rule:** `AGENTS.md` §3.2 & §3.4.
- **Anti-Pattern (CLI-Only):** wiring policy/hooks only in `src/cli.ts`/`src/subagents.ts`, leaving `src/network.ts` and `src/workflow.ts` unmediated — a silent bypass, not a partial win.
- **"Attach" means live:** pass the policy evaluator, not a snapshot; test changes after construction.

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes
- **Canonical rule:** `AGENTS.md` §3.3.
- **Detail:** split on `;`, `&&`, `||`, `|`, newline, `$()`, `<()`, `>()`, backticks; strip subshells `(...)`, `{...}`, quotes, wrappers (`sudo`, `env`, `sh -c`, `bash -c`, `eval`, `exec`, flags); deny if ANY segment matches.
- **Seen (2026-10-25):** stripping only outer quotes left the command word unnormalized: `"rm" -rf /`, `r\m -rf /`, `r""m -rf /`, `rm${IFS}-rf /`, `/bin/rm -rf /`, `command rm -rf /` all bypassed `deny: ["bash(rm *)"]`.
- **Rule:** tokenize with shell quoting rules; strip wrappers (`sudo`/`env`/`nohup`/`time`/`nice`/`timeout`/`xargs`), reserved words and redirections; match basename (`.exe` on Windows); fail closed on `$`, backticks, command substitution and brace expansion. Indirect execution (`python -c`, scripts) is not followed.
- **Guard:** `tests/policy.test.mjs` › "bash deny and ask rules cannot be bypassed by quoting or escaping the command word".

## 3. Trust Coverage: Executables in Auto-Allow Rules
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern (Hooks-Only Hash):** hashing only `layered.hooks`, omitting `permissions.allow` script targets (`allow: ["bash(./deploy.sh)"]`). Non-existent scripts hash `file:<path>:missing`.

## 4. Fail-Closed vs. Fail-Open Architecture
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern:** `isTrusted` defaulting to `true`, hook timeouts defaulting to `denied: false`, or `loadProjectSettings` catching errors into `{}`.
- **Deny Precedence:** persistent project/user `deny` rules evaluate before `cliAllowed`.

## 5. Lifecycle Synchronization: Process vs. Session Lifetime
- **Canonical rule:** `AGENTS.md` §3.4.
- **Anti-Pattern:** dispatching `SessionEnd` only on CLI exit, `SessionStart` only on `messages.length === 0`, or storing flags on the transient `Harness`.
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
- **Seen (2026-10-25):** `loadCredentials` returned `{}` on a BOM/parse error; `saveCredential` then rewrote the file with only the new key, deleting every other provider key.
- **Rule:** `{}` is only correct for `ENOENT`. Parse/schema errors throw and name the file; strip BOM before `JSON.parse`. A reader that feeds a writer must never convert corruption into an empty document.
- **Guard:** `tests/config.test.mjs` › "saveCredential refuses to overwrite a corrupt credentials file".

## 10. Command Surfaces Must Reuse the Guarded Primitive
- **Seen (2026-10-25):** `/export` called `writeFile` after `files.path`, overwriting an unread source file with no backup; `/delete <unknown>` printed `Deleted saved session: undefined`.
- **Rule:** a slash command that writes or deletes goes through the tool's guard (`WorkspaceFiles.writeExport`, a throwing store method); catch the guard's error at the command boundary; never print success from a value that can be `undefined`.
- **Guard:** `tests/files.test.mjs` › "session export refuses to overwrite a non-export file"; `tests/session.test.mjs` › "deleteSession reports an unknown session instead of returning undefined".
