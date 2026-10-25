# AGENT_LEARNINGS.md — Empirical Lessons & Anti-Patterns for AI Agents

This file is automatically loaded into the system prompt by `loadProjectInstructions` in `src/context.ts`.
Whenever an agent makes a mistake, experiences a review finding, or discovers an unhandled edge case, the mistake, root cause, and concrete anti-pattern MUST be appended here.

---

## 1. System Seams: The Four Execution Runners Rule

### [Anti-Pattern] The "CLI-Only" Blind Spot
- **The Mistake:** Implementing a policy, hook, or security permission only in `src/cli.ts` (and possibly `src/subagents.ts`), while completely omitting `src/network.ts` (Agent Network) and `src/workflow.ts` (Workflows).
- **Consequence:** Model prompts executing via the Agent Network bypass all user deny rules (e.g. `deny: ["read_file(.env)"]`) and audit hooks.
- **Root Cause:** AI focuses narrowly on the interactive terminal flow where it tests, forgetting that `ToolRegistry` and `Harness` are instantiated in 4 independent seams.
- **Rule:** Every policy, permission, trust, or lifecycle feature MUST be wired to all 4 execution runners:
  1. `src/cli.ts` (interactive, headless, and session swap via `/new`, `/resume`)
  2. `src/subagents.ts` (child harness inherits policy & hookBus)
  3. `src/network.ts` (peer network ToolRegistry attaches policy; Harness receives hookBus)
  4. `src/workflow.ts` (step harnesses inherit policy & hookBus)

---

## 2. Shell Security: Segment-Aware Matching vs. Start-Anchored Regexes

### [Anti-Pattern] Start-Anchored Regexes in Deny Rules (`^...$`)
- **The Mistake:** Using `^base(?:\\s+.*)?$` for `bash` deny matching (e.g., `bash(rm *)`).
- **Consequence:** Prepending ANY benign command (`echo hi; rm -rf /`, `cd . && rm -rf /`, `sudo rm ...`) bypasses the deny rule completely, auto-executing destructive commands in auto mode.
- **Root Cause:** Testing only with happy-path strings (e.g., `rm -rf tmp`), without thinking like an attacker trying to bypass the check.
- **Rule:**
  - Bash deny matching MUST be **segment-aware**.
  - Split command strings on `;`, `&&`, `||`, `|`, `\n`, `$()`, and backticks.
  - Strip wrappers (`sudo`, `sh -c`, `bash -c`).
  - Match EVERY segment against deny patterns: if ANY segment matches, block execution immediately.

---

## 3. Trust Coverage: Executables in Auto-Allow Rules

### [Anti-Pattern] Hashing Hooks but Omitting `permissions.allow` Script Targets
- **The Mistake:** Calculating workspace trust by hashing only `layered.hooks.map(h => h.command)`, ignoring scripts referenced in `permissions.allow` (e.g., `allow: ["bash(./scripts/deploy.sh)"]`).
- **Consequence:** Once a workspace is trusted, replacing or editing `./scripts/deploy.sh` does not change the trust hash, auto-executing the modified untrusted script without user confirmation.
- **Rule:**
  - `calculateWorkspaceTrustHash` MUST tokenize and discover local script paths from BOTH `layered.hooks` AND `layered.projectPermissions.allow`.
  - If a referenced script does not yet exist on disk, record a sentinel `file:<path>:missing`. When the script is subsequently created or checked out, the hash automatically changes and revokes trust.

---

## 4. Fail-Closed vs. Fail-Open Architecture

### [Anti-Pattern] Defaulting to Permissive on Errors, Missing Arguments, or Timeouts
- **The Mistakes:**
  1. `HookBus.isTrusted` defaulted to `options.isTrusted ?? true` (fails open if caller forgets).
  2. `PreToolUse` hook timeout or crash resulted in `denied: false` (allows tool execution if security hook hangs).
  3. `loadProjectSettings` caught all errors and returned `{}` (silently wipes out user deny rules on JSON syntax error or BOM).
- **Rule:**
  - Security controls MUST ALWAYS **fail closed**:
    - `isTrusted` defaults to `false`.
    - `PreToolUse` timeout or error defaults to `denied: true` (block tool execution).
    - Malformed `.vyen/settings.json` must throw and abort CLI startup with a clear error; it must NEVER silently drop security rules.

---

## 5. Lifecycle Synchronization: Process vs. Session Lifetime

### [Anti-Pattern] Tying Session Lifecycle Events to CLI Process Exit
- **The Mistake:** Emitting `SessionEnd` only in CLI process shutdown (`cli.ts:3299`), and emitting `SessionStart` only when `session.messages.length === 0`.
- **Consequence:** Replacing the store via `/new` or `/resume` never triggers `SessionEnd` for the old session, and resumed sessions never trigger `SessionStart`. Subagents leave sessions open.
- **Rule:**
  - Track `sessionStarted` on the `Harness` instance.
  - Trigger `activeHarness.endSession()` before switching stores in `/new` and `/resume`.
  - Trigger `endSession()` in subagent cleanup before closing the store.
  - Ephemeral nested runners (`AgentNetwork`, `Workflows`) inherit tool-level hooks but do NOT emit global `SessionStart`/`SessionEnd` hooks to prevent notification spam.

---

## 6. Testing Rigor: Negative Baselines and Adversarial Tests

### [Anti-Pattern] Unit Tests with Isolated Mocks and Missing Negative Baselines
- **The Mistake:** Testing that an explicit rule triggers approval (`ask: ['read_file(x)']`), but failing to test the negative baseline: that an empty rule set `{}` does NOT trigger approval.
- **Consequence:** Conflating default fallback with explicit `ask` rules, causing all read-only tools to require interactive approval.
- **Rule:**
  - Every positive test for a rule MUST be accompanied by a negative baseline test proving unconfigured cases behave according to default contracts.
  - Test adversarial vectors: chained commands, missing files, corrupted settings, and timeouts.
