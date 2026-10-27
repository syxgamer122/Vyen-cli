# Code Review Guide (`REVIEW.md`)

Working agreement and reviewer checklist for `vyen-cli`. Derived from recurring defects, review remediations, and regressions across the repository commit history.

## 1. Review Comment Rule

**Every review comment must cite the exact `file:line`** (e.g., `src/hooks.ts:408`).
Findings without an exact file and line location are rejected as non-actionable feedback. Re-read behavior, not author intent.

---

## 2. What Counts as a Bug

Flag these patterns as blocking bugs. Every item represents a spot that has broken repeatedly across recent commits:

### A. Security & Fail-Closed Invariants
- **Fail-Open Hooks or Policy (`src/hooks.ts:408`, `src/policy.ts:165`):** HookBus (`PreToolUse`) or security policies returning `denied: false` on spawn crashes, unhandled errors, or execution timeouts. `PreToolUse` must strictly fail closed (`denied: true`).
- **Shell Deny Bypasses (`src/policy.ts:54`):** Bash commands evaluated against `deny` rules without splitting compound chains (`;`, `&&`, `||`, `|`, newlines), process substitutions (`<()`, `>()`), command substitutions (`$()`, backticks), or stripping command wrappers (`sudo`, `env`, `eval`, `exec`).
- **Policy Precedence Inversion (`src/policy.ts:175`):** Allowing CLI flags (`--allowed-tools`) to override persistent project or user `deny` rules.

### B. Credential & Environment Leaks
- **Unsanitized Execution Environments (`src/workflow.ts:641`):** Spawning child processes or workflow shell steps with un-sanitized `process.env` rather than `sanitizeEnvironment()` (leaking `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, provider keys).
- **Secret Forwarding in MCP (`src/mcp.ts:873`):** Allowing user or project MCP configurations to forward protected provider secrets (`isSecretEnv()`) via `envFrom`, `envVars`, `envHeaders`, or `bearerEnv`.
- **Credential Echo (`src/errors.ts:5`, `src/mcp.ts:920`):** Error handlers, logs, or TUI displays echoing resolved bearer tokens or API keys instead of redacting them.

### C. Seam Incompleteness (The 4 Runners & 4 Places)
- **Runner Desynchronization (`src/cli.ts:1237`, `src/subagents.ts:520`, `src/network.ts:750`, `src/workflow.ts:637`):** Adding a tool, policy, or hook to CLI interactive mode while omitting it from the other 3 runners: subagents, Agent Network, or workflow steps.
- **Subagent Child Toolset Desynchronization (`src/subagents.ts:855`, `tests/subagents.test.mjs:31`):** Injecting tools into subagent child registries without synchronizing subagent tool isolation tests that assert hardcoded tool lists.
- **Missing Registration Seams (`src/tools.ts:60`, `src/context.ts:744`, `src/harness.ts:886`, `src/tui.ts:166`, `src/help.ts:59`):** Registering a tool without updating all four places: registry/schema/aliases (`src/tools.ts`), active tools prompt (`src/context.ts`), TUI meta summary (`src/harness.ts`), and slash/CLI help (`src/tui.ts`/`src/help.ts`).

### D. State Concurrency & Serialization Races
- **Stateful Tools Marked Read-Only (`src/tools.ts:60`):** Classifying a tool as `isReadOnly: true` when it mutates internal state (e.g., `sequential_thinking` updating branch history). Stateful tools must return `false` from `isReadOnly` so harness tool-batching treats them as serial mutation barriers rather than executing them in parallel.
- **Un-normalized Model Aliases (`src/tools.ts:168`):** Omitting snake_case argument mappings in `normalizeToolInput` (models frequently emit `snake_case` despite camelCase schemas, resulting in silent `undefined` values).
- **Mutating Operations in Read-Only Mode (`src/memory.ts:335`):** Allowing mutation tools (e.g. knowledge graph entity creation/deletion) to execute when the registry is in read-only mode.

### E. Session Lifecycle & Checkpoint Safety
- **Store Swap Without Awaiting Session End (`src/cli.ts:77`):** Triggering `/new`, `/resume`, or `/delete` store replacements without first awaiting `activeHarness?.endSession()` to flush lifecycle hooks.
- **Stale Checkpoints Across Workspaces (`src/session.ts:45`, `src/cli.ts:1920`):** Retargeting `/cd` without clearing turn checkpoints (`retargetSessionWorkspace`), which corrupts file reverts across directory boundaries.

### F. Data Corruption & Fallback Anti-Patterns
- **Reader Converting Corruption to Empty State (`src/config.ts:35`, `src/settings.ts:80`):** Catching parse or BOM errors in config/credential readers (`loadCredentials`, `loadProjectSettings`) and falling back to `{}` instead of throwing. Readers that feed writers must never turn file corruption into an empty document (which wipes existing user keys on save).

### G. Contract & Plan Traceability Drift
- **Renaming Bound Test Titles (`tests/plan-traceability.test.mjs:122`, `tests/docs-contract.test.mjs:153`):** Modifying test titles in `tests/*.test.mjs` that are linked in historical plan tables in `docs/superpowers/plans/`.
- **Documentation Drift (`docs/SPEC.md:65`, `docs/ROADMAP.md:20`, `README.md:140`):** Introducing capabilities or CLI flags without synchronizing `docs/SPEC.md`, `README.md`, and `docs/ROADMAP.md`.

---

## 3. Which Nits to Skip

Do **not** block PRs or open review findings for:
- **Baseline Lint Warnings:** Oxlint warnings are baseline (`npm run lint` enforces zero errors, not zero warnings). Do not report them.
- **Windows Platform Skips:** Cleanly skipped POSIX file-mode bit and unprivileged symlink tests in `tests/files.test.mjs` and `tests/audit.test.mjs` when `process.platform === 'win32'`.
- **Speculative Hardening:** Edge cases or theoretical failures without a measurable exploit vector or testable failure condition (`AGENTS.md §1.2`).
- **Stylistic / Cosmetic Preferences:** Formatting or variable naming choices that satisfy `tsc --noEmit` and Oxlint rules and do not violate BOM/typing constraints.
- **Existing Untouched Dead Code:** Dead code in adjacent files outside the diff scope (`AGENTS.md §6`). Note it in the report, but do not block the turn.

---

## 4. Which Paths to Ignore

Reviewers must ignore changes or skip reviewing the following paths:
- `docs/superpowers/plans/*`: Completed implementation plans are historical records; never request changes to past plans.
- `docs/superpowers/specs/*`: Historical design specifications.
- `tests/fixtures/*`: Mock servers, test scripts, and synthetic runtimes used exclusively for test fixtures.
- `dist/`, `node_modules/`: Generated build output and external dependencies.
- `npm-shrinkwrap.json`: Package lockfile.
- `src/migrate.ts`: Legacy `goon` migration logic unless the change explicitly targets the migration subsystem.
