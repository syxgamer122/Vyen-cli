# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

Loaded by `loadProjectInstructions` in `src/context.ts`. When a mistake is confirmed
(red test, review verdict, user correction), append the evidence here — never a second
copy of a rule that already lives in `AGENTS.md`. Two copies of one rule drift apart.

## 1. System Seams: The Four Execution Runners Rule
- **Canonical rule:** `AGENTS.md` §3.2 & §3.4.
- **Anti-Pattern (CLI-Only):** Wiring policy/hooks only in `src/cli.ts` (and `src/subagents.ts`), leaving `src/network.ts` (Agent Network) and `src/workflow.ts` (Workflows) unmediated.
- **Consequence:** Network/workflow prompts bypass deny rules and hooks. A seam in two runners is a silent bypass, not a partial win.
- **"Attach" means live:** snapshotting `registry.policy` ignores later changes. Pass the evaluator, not a snapshot, and test policy changes after construction.

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes
- **Canonical rule:** `AGENTS.md` §3.3.
- **Seen:** `echo a; rm -rf /` and `cd . && rm -rf /` bypassed start-anchored patterns.
- **Detail:** split on `;`, `&&`, `||`, `|`, newline, `$()`, `<()`, `>()`, backticks; strip subshells `(...)`, `{...}`, quotes, and wrappers (`sudo`, `env`, `sh -c`, `bash -c`, `eval`, `exec`, flags); deny if ANY segment matches.

## 3. Trust Coverage: Executables in Auto-Allow Rules
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern (Hooks-Only Hash):** Hashing only `layered.hooks`, omitting `permissions.allow` script targets (`allow: ["bash(./deploy.sh)"]`).
- **Consequence:** Modifying `./deploy.sh` leaves hash unchanged, auto-executing modified scripts. Non-existent scripts hash sentinel `file:<path>:missing` so later creation revokes trust.

## 4. Fail-Closed vs. Fail-Open Architecture
- **Canonical rule:** `AGENTS.md` §3.3.
- **Anti-Pattern:** `isTrusted` defaulting to `true`, hook timeouts defaulting to `denied: false`, or `loadProjectSettings` catching errors into `{}`.
- **Consequence:** Silently bypasses security controls. Defaults, errors, and timeouts must fail closed.
- **Deny Precedence:** Persistent project/user `deny` rules strictly evaluate before `cliAllowed`, preventing `--allowed-tools` flag escalations over restricted files.

## 5. Lifecycle Synchronization: Process vs. Session Lifetime
- **Canonical rule:** `AGENTS.md` §3.4.
- **Anti-Pattern:** Dispatching `SessionEnd` only on CLI exit, `SessionStart` only on `messages.length === 0`, or storing flags on the transient `Harness`.
- **Consequence:** `/new`, `/resume`, and `/delete` drop old `SessionEnd`; resumed sessions miss `SessionStart`; store rebuilds restart sessions or lose ends.
- **Guard:** `tests/hooks.test.mjs` › "Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once".

## 6. Testing Rigor: Negative Baselines & Adversarial Tests
- **Canonical rule:** `AGENTS.md` §2.
- **Anti-Pattern:** Testing only positive triggers without negative baselines (e.g. testing `ask: ['read_file']` without testing empty `{}` baseline).
- **Rule:** Always test negative baselines (unconfigured tools run without prompts) and adversarial vectors (chaining, missing files, subshells, quotes). At least one test must spawn the real hook process.

## 7. Review Findings Become Rules, Not TODOs
- **Canonical rule:** `AGENTS.md` §2.5 Law 4.
- **Anti-Pattern:** Filing review findings as deferred work while leaving the underlying rule untouched.
- **Rule:** Every confirmed finding (red test, review verdict, user correction) lands as a rule in its owning section before the turn ends.

## 8. Build, Loader & Guard Pitfalls
- **Tests import from `dist/`:** Compile with `node node_modules/typescript/bin/tsc` directly before running individual test files (`npm.cmd` cannot spawn without a shell on Windows).
- **Loader verification:** A file nothing loads is dead — grep the loader first (`loadProjectInstructions` in `src/context.ts`).
- **Self-reporting guards:** A guard containing the literal it searches for reports itself — spell the pattern in pieces and verify the guard file is clean (guard: `tests/repo-hygiene.test.mjs`).
