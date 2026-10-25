# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

Loaded by `loadProjectInstructions` in `src/context.ts`. When an agent makes a mistake, append the entry here.

## 1. System Seams: The Four Execution Runners Rule
- **Anti-Pattern (CLI-Only):** Wiring policy/hooks only in `src/cli.ts` (and `src/subagents.ts`), leaving `src/network.ts` (Agent Network) and `src/workflow.ts` (Workflows) unmediated.
- **Consequence:** Network/workflow prompts bypass deny rules (e.g. `read_file(.env)`) and hooks.
- **Rule:** Every policy, permission, trust, or lifecycle feature MUST be wired to all 4 runners:
  1. `src/cli.ts` (interactive, headless, `/new`, `/resume`)
  2. `src/subagents.ts` (child harness inherits policy & hookBus)
  3. `src/network.ts` (peer network ToolRegistry attaches policy; Harness receives hookBus)
  4. `src/workflow.ts` (step harnesses inherit policy & hookBus)

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes
- **Anti-Pattern (Anchored Regex):** Using `^base(?:\\s+.*)?$` for `bash` deny matching (`bash(rm *)`).
- **Consequence:** Prepending commands (`echo a; rm -rf /`, `cd . && rm -rf /`, `sudo rm ...`, subshell `(rm -rf /)`) bypasses deny rules in auto mode.
- **Rule:** Bash deny matching MUST be segment-aware. Split on `;`, `&&`, `||`, `|`, `\n`, `$()`, backticks; strip subshells `(...)`, `{...}`, quotes, and wrappers (`sudo`, `env`, `sh -c`, `bash -c`, flags); deny if ANY segment matches.

## 3. Trust Coverage: Executables in Auto-Allow Rules
- **Anti-Pattern (Hooks-Only Hash):** Hashing only `layered.hooks`, omitting `permissions.allow` script targets (`allow: ["bash(./deploy.sh)"]`).
- **Consequence:** Once trusted, editing `./deploy.sh` leaves hash unchanged, auto-executing modified scripts.
- **Rule:** `calculateWorkspaceTrustHash` MUST tokenize and hash script targets from BOTH hooks and allow rules (including wildcard expansions like `./scripts/*.sh`). Non-existent scripts hash sentinel `file:<path>:missing` so subsequent creation revokes trust.

## 4. Fail-Closed vs. Fail-Open Architecture
- **Anti-Pattern (Permissive Fallback):** `isTrusted` defaulting to `true`, `PreToolUse` timeouts defaulting to `denied: false`, or `loadProjectSettings` catching errors into `{}`.
- **Consequence:** Hangs, crashes, or corrupt configs silently bypass security controls.
- **Rule:** Security controls MUST fail closed: `isTrusted` defaults to `false`; timeouts/crashes default to `denied: true`; corrupt configs abort startup with an error.

## 5. Lifecycle Synchronization: Process vs. Session Lifetime
- **Anti-Pattern (CLI-Exit Hook):** Dispatching `SessionEnd` only on CLI exit and `SessionStart` only on `messages.length === 0`, or storing started/ended flags on the `Harness` instance.
- **Consequence:** `/new` and `/resume` drop old `SessionEnd`; resumed sessions miss `SessionStart`; a rebuild (`/model`, `/effort`, `/cd`) over the same store restarts the session or loses its end.
- **Rule:** Key lifecycle state to the `SessionStore` (module-level `WeakSet`), never to the harness that happens to be running. Trigger `activeHarness.endSession()` before store swaps in `/new` and `/resume`, and in subagent cleanup. Nested runners inherit tool hooks but do not spam global session lifecycle hooks.
- **Guard:** tests/hooks.test.mjs › "Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once"

## 6. Testing Rigor: Negative Baselines & Adversarial Tests
- **Anti-Pattern (Happy-Path Mocks):** Testing only positive rule triggers without negative baselines (e.g. testing `ask: ['read_file']` without testing empty `{}` baseline).
- **Rule:** Always test negative baseline (unconfigured tools execute without prompt). Always test adversarial vectors (chaining, missing files, subshells, quotes).
