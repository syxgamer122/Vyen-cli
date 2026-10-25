# Seam Hardening & Security Audit Gap Closure — Design Specification

**Date:** 2026-10-25  
**Topic:** Resolving all 19 architectural and security audit findings across R1.1/R1.2 and establishing a System Seam Matrix.  
**Target:** Phased Surgical TDD Remediation (Approach 2).

---

## 1. Intent & The Why

A comprehensive cross-system security and architectural audit identified 19 concrete vulnerabilities, unlinked seams, error-swallowing behaviors, and contract divergences in `vyen`.
Most critically:
1. `deny` rules in `src/policy.ts` are start-anchored (`^...$`), allowing chained commands like `echo hi; rm -rf /` or `cd . && rm -rf /` to bypass auto-deny.
2. `calculateWorkspaceTrustHash` in `src/hooks.ts` and `src/cli.ts` hashes only hook commands, completely ignoring executable scripts referenced by `permissions.allow` (e.g. `bash(./deploy.sh)`), enabling remote code execution via modified untrusted scripts.
3. Errors in `.vyen/settings.json` (such as a UTF-8 BOM or schema validation errors) are silently swallowed into `{}`, silently stripping all security and `deny` rules.
4. `Agent Network` (`src/network.ts`) creates harnesses and tool registries without policy and hooks, allowing model-driven network prompts to read sensitive files like `.env`.
5. Lifecycle hooks (`SessionStart`/`SessionEnd`) are tied to CLI process exit rather than session lifetime, desynchronizing on `/new` and `/resume`.

The root cause of repeated failures is **isolated feature implementation without a cross-cutting seam checklist**. When adding features, developers connect them to the interactive CLI, but omit the other execution seams (`subagents`, `network`, `workflows`), while isolated unit tests provide false confidence.

This design establishes a permanent **System Seam Matrix** in `AGENTS.md` and systematically resolves all 19 audit findings in 4 strictly verified TDD increments.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Eliminate All 19 Audit Findings:** Address every item from Critical 1–2, Important 3–10, and Minor 11–19.
- **Segment-Aware Deny Matching:** Make bash deny matching segment-aware (splitting on `;`, `&&`, `||`, `|`, `\n`, `$()`, backticks) so that any compound command containing a denied segment is blocked, even when preceded by benign commands (`echo hi; rm -rf /`) or `sudo`.
- **Comprehensive Trust Hashing:** Include all local script/executable paths referenced in `permissions.allow` in `calculateWorkspaceTrustHash`. Modifying a script or creating a previously missing script must invalidate trust.
- **Fail-Closed Settings Loading:** Strip UTF-8 BOM, distinguish `ENOENT` (missing file is ok) from parse/schema errors. If `.vyen/settings.json` exists but is invalid, fail-closed with an actionable error message so users never run unprotected without their intended deny rules.
- **Fail-Closed Hook Timeouts & Errors:** When a `PreToolUse` security hook times out or fails with an error, treat it as `denied: true` to prevent fail-open execution.
- **Complete Seam Integration:** Wire `Policy` and `HookBus` into `src/network.ts`. Emit `SessionEnd` when replacing sessions on `/new` and `/resume`, and emit `SessionStart` on resumed sessions via a per-harness `sessionStarted` flag.
- **Living Seam Matrix:** Document the 4 execution seams (CLI, Subagents, Network, Workflows) in `AGENTS.md` as a mandatory checklist before declaring any tool or permission feature "done".

### Non-Goals
- Full 1:1 Claude Code compatibility: The Claude Code hook contract will be clearly disclosed in `docs/ROADMAP.md` and `docs/SPEC.md` as "inspired by" with explicit documentation of parameter differences rather than bloating the schema with unused aliases.
- Rewriting the parser engine: Deny segment splitting will leverage standard POSIX shell command separators without introducing an external shell AST dependency.

### Anti-Goals
- **Monolithic Big-Bang Edits:** No attempting to edit 10 files simultaneously without isolating each increment.
- **Symptom Patching:** No adding special-case `if` statements that only fix the specific strings in test cases without fixing the underlying mechanism.
- **Breaking Read-Only Defaults:** Preserving the fix where read-only tools default to silent execution while explicit `ask` rules prompt.

---

## 3. Approaches Considered & Trade-offs

### Approach 1: Single-Pass Monolithic Overhaul
- **Description:** Edit all 10+ files across the repo in one massive turn, updating policy, hooks, settings, network, cli, harness, tests, and documentation at once.
- **Trade-offs:** Rejected. Enormous blast radius. High risk of introducing new unlinked seams and regressions. Impossible to cleanly prove RED-GREEN TDD for 19 distinct behaviors.

### Approach 2: Phased Surgical TDD Remediation (Selected)
- **Description:** Group the 19 findings into 4 distinct, cohesive increments. Each increment writes a RED test proving the flaw first, implements the surgical fix, verifies GREEN, and checks integration seams.
- **Trade-offs:** Requires disciplined discipline across 4 phases, but provides 100% verification fidelity, zero regressions, and closes all audit findings permanently.

---

## 4. Comprehensive 19 Audit Findings Matrix & Acceptance Criteria

| # | Severity | Category | Description | Specific File & Lines | Acceptance Criterion & Test |
|---|---|---|---|---|---|
| **1** | **Critical** | Security | Trust hash omits executables referenced in `permissions.allow` | `src/cli.ts:816-818`, `src/hooks.ts:61-102` | `calculateWorkspaceTrustHash` covers all scripts extracted from `permissions.allow`. Modifying or creating script invalidates trust and forces approval. |
| **2** | **Critical** | Security | Deny rules are start-anchored; compound commands bypass deny | `src/policy.ts:52-64,89-95,138-143` | Bash deny matching splits command by separators (`;&|` etc.) and wrappers (`sudo`, `sh -c`). Denies `echo hi; rm -rf /`, `cd . && rm -rf /`. |
| **3** | **Important** | Resilience | Malformed `.vyen/settings.json` or BOM silently discards all rules | `src/settings.ts:58-68`, `src/cli.ts:810-815` | Strip BOM on read. Distinguish `ENOENT` from parse/validation errors. Fail-closed on corrupted file with clear diagnostic on stderr. |
| **4** | **Important** | Security | `HookBus` constructor defaults `isTrusted` to `true` when omitted | `src/hooks.ts:193-199` | Default `isTrusted` to `false`. When `isTrusted: false`, dispatch skips all hooks and spawns 0 child processes. |
| **5** | **Important** | Lifecycle | Lifecycle events tied to process exit instead of session | `src/cli.ts:3299`, `src/harness.ts:494-502` | `/new` and `/resume` trigger `activeHarness.endSession()`. Resumed session triggers `SessionStart`. Subagents trigger `endSession()` on cleanup. |
| **6** | **Important** | Seam | Agent Network harnesses bypass policy and hooks entirely | `src/network.ts:635,675,700,721` | Pass active `policy` and `hookBus` to network ToolRegistry and Harness. Test that `.env` reads in network prompts obey deny rules. |
| **7** | **Important** | Docs | SPEC/README overstate hook exit semantics and omit user permissions | `docs/SPEC.md:31-37`, `README.md:93-96` | Document per-event table (payload, exit 2 denial, exit 0 context injection), user-level permissions, and allow trust requirement. |
| **8** | **Important** | Contract | Promised Claude Code subset neither implemented nor disclosed | `docs/ROADMAP.md:306-308`, `src/hooks.ts:22-28` | Normalize matcher casing (e.g. `Bash` -> `bash`). Disclose in ROADMAP/SPEC that format is "inspired by" with exact differences. |
| **9** | **Important** | Security | Timed-out or crashed `PreToolUse` hook fails open | `src/hooks.ts:313-335`, `src/harness.ts:745` | Add `timedOut?: boolean` to hook result. If PreToolUse hook times out or fails (`h.denied || h.timedOut || h.error`), block tool execution. |
| **10** | **Important** | Verification | Acceptance tests test mocked units instead of criteria | `tests/hooks.test.mjs`, `tests/policy.test.mjs` | Add real fixture `.vyen/settings.json` integration tests, CLI flag parsing (`--allowed-tools`), untrusted dispatch, and lifecycle triggers. |
| **11** | **Minor** | Code Clean | `PolicyEvaluationContext.mode` is unused; comments disagree | `src/policy.ts:17,110-121,161-162` | Clean up unused `mode` field in context, update comments to describe the `'default'` handoff to ToolRegistry. |
| **12** | **Minor** | Precision | Path matching is case-insensitive on POSIX, widening allow | `src/policy.ts:28-38,52-63` | Make path matching case-sensitive on POSIX (`process.platform !== 'win32'`) while keeping tool names canonical. |
| **13** | **Minor** | Security | Environment sanitization denylist over/under-strips | `src/hooks.ts:150-161` | Preserve essential git/SSH vars (`SSH_AUTH_SOCK`, `GIT_AUTHOR_*`) while stripping credentials (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`). |
| **14** | **Minor** | Test Clean | Trust test writes to real user `~/.config/vyen` directory | `tests/hooks.test.mjs:18-56` | Isolate `XDG_CONFIG_HOME` to a temporary directory in `tests/hooks.test.mjs` and restore in `t.after`. |
| **15** | **Minor** | Robustness | Hook execution is not cancellable; SessionEnd warnings lost | `src/hooks.ts:206-239`, `src/cli.ts:3295` | Support `AbortSignal` in `HookBus.dispatch`; ensure SessionEnd warnings are flushed to stderr before exit. |
| **16** | **Minor** | Traceability | Most hook payloads omit `sessionId` | `src/harness.ts:503,644,679,741,768` | Include `sessionId: this.session.id` in all event payloads emitted by Harness. |
| **17** | **Minor** | Contract | Hook plan promises user-config hooks, but schema rejects | `docs/superpowers/plans/2026-10-24-hook-bus.md` | Align plan and docs: hooks are project-level in `.vyen/settings.json`. User config `config.json` only holds permissions. |
| **18** | **Minor** | Consistency | CLI-allow vs deny precedence internally inconsistent | `src/policy.ts:133-140` | Clarify precedence: CLI disallowed/allowed flags represent explicit user command invocation; persistent deny takes strict precedence over allow. |
| **19** | **Minor** | Clarity | `--trust-workspace` re-records trust on every run | `src/cli.ts:819-822` | Document that `--trust-workspace` is an explicit override that re-hashes and re-trusts current settings. |

---

## 5. Detailed Implementation Architecture (The 4 Increments)

### Increment 1: Critical Security Closure (Items 1 & 2)
1. **Segment-Aware Deny Rules (`src/policy.ts`):**
   - In `matchToolPattern`, when evaluating bash requests against `deny` rules:
     - Split the incoming command string by compound separators: `/[;\r\n|&]+|\$\(|\`/`.
     - Strip whitespace and command wrappers (`sudo`, `sh -c`, `bash -c`).
     - Check each segment against the deny pattern using `matchSimplePattern`.
     - If ANY segment matches a deny rule, return `true` (denied).
   - Proven RED with tests: `echo hi; rm -rf /`, `cd . && rm -rf /`, `sudo rm -rf /`, `sh -c "rm -rf /"`.
2. **Allow Script Trust Hashing (`src/hooks.ts`, `src/cli.ts`):**
   - Update `calculateWorkspaceTrustHash(cwd, commands)` to accept both hook commands and allow rule strings.
   - For any token matching a relative or local path:
     - If file exists: hash `file:<token>:<sha256(content)>`.
     - If file does NOT exist: hash `file:<token>:missing`.
     - If an attacker creates the file later, the hash changes from `missing` to content hash, immediately revoking trust.
   - Proven RED with test: Modifying `./scripts/deploy.sh` referenced in `allow: ["bash(./scripts/deploy.sh)"]` invalidates stored trust and forces a prompt.

### Increment 2: Configuration Resilience & Safe Defaults (Items 3, 4, 9, 13, 14)
1. **Fail-Closed Settings Loading (`src/settings.ts`, `src/cli.ts`):**
   - Strip leading UTF-8 BOM (`content.replace(/^\uFEFF/, '')`) before `JSON.parse`.
   - Distinguish `ENOENT` (missing file = normal `{}`) from parse errors or schema invalidity.
   - When a parse or validation error occurs, throw an informative diagnostic error and abort CLI startup so security rules are never bypassed.
2. **Untrusted HookBus Default (`src/hooks.ts`):**
   - Change `this.isTrusted = options.isTrusted ?? false` (default to untrusted).
   - Test that omitting `isTrusted` runs 0 project hooks and spawns 0 child processes.
3. **Fail-Closed Hook Timeouts (`src/hooks.ts`, `src/harness.ts`):**
   - Add `timedOut?: boolean` to `HookExecutionResult`.
   - In `src/harness.ts:745`, if `PreToolUse` hook has `h.denied || h.timedOut || Boolean(h.error)`, block tool execution with an explicit denial message.
4. **Environment Sanitization & Test Isolation (`src/hooks.ts`, `tests/hooks.test.mjs`):**
   - Preserve `SSH_AUTH_SOCK`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` in `sanitizeEnvironment`.
   - Isolate `process.env.XDG_CONFIG_HOME` to a temporary directory in `tests/hooks.test.mjs`.

### Increment 3: Seam Integration & Lifecycle Synchronization (Items 5, 6, 15, 16)
1. **Agent Network Seams (`src/network.ts`):**
   - In `src/network.ts` lines 635, 675, 700, 721: pass the active `policy` evaluator and `hookBus` into `ToolRegistry` and `Harness`.
   - Tool execution hooks (`PreToolUse`, `PostToolUse`) fire normally, ensuring project deny rules (like `read_file(.env)`) are enforced.
2. **Balanced Session Lifecycle (`src/cli.ts`, `src/harness.ts`, `src/subagents.ts`):**
   - Track `sessionStarted` on `Harness` instance. Resumed sessions emit `SessionStart` on their first turn.
   - In `src/cli.ts`, call `activeHarness.endSession()` before switching stores in `/new` and `/resume`.
   - In `src/subagents.ts`, ensure `endSession()` is invoked in the subagent cleanup block.
   - Inject `sessionId: this.session.id` into all hook payloads.
   - Ephemeral nested runners (`AgentNetwork`, `Workflows`) inherit tool-level hooks but do not trigger global `SessionStart`/`SessionEnd` hooks.

### Increment 4: Test Fixtures, Contract Truth & Minor Polish (Items 7, 8, 10, 11, 12, 17, 18, 19)
1. **Contract Truth & Docs Sync (`docs/SPEC.md`, `README.md`, `docs/ROADMAP.md`):**
   - Table of all 8 hook events with payload properties, exit 2 denial behavior, and stdout context injection behavior.
   - Document user-level `config.json` permissions and note that project `allow` rules require `--trust-workspace`.
   - Disclose Claude Code compatibility as inspired-by with documented differences.
2. **Real Acceptance Fixtures (`tests/integration-seams.test.mjs`):**
   - Test untrusted dispatch, CLI flag parsing (`--allowed-tools`), real fixture `.vyen/settings.json`, and broken-hook continuation in Harness.
3. **Minor Polish:**
   - Case-sensitivity on POSIX in `src/policy.ts` (Item 12).
   - Clean up dead `mode` in `PolicyEvaluationContext` (Item 11).

---

## 6. System Seam Matrix (Added to AGENTS.md)

| Feature Type | CLI (`src/cli.ts`) | Subagents (`src/subagents.ts`) | Agent Network (`src/network.ts`) | Workflows (`src/workflow.ts`) |
| :--- | :---: | :---: | :---: | :---: |
| **Tool Policy** | `evaluateToolPolicy` | Inherits `reg.policy` | Must attach `reg.policy` | Inherits `reg.policy` |
| **HookBus** | Passed to Harness | Passed to Harness | Must pass to Harness | Passed to Harness |
| **Workspace Trust** | Checked & Hashed | Inherited | Must respect parent trust | Inherited |
| **Lifecycle** | `start` / `endSession` | `endSession` in cleanup | `endSession` on close | `endSession` on step end |

---

## 7. Decided Architecture Choices (Human Partner Approved)

1. **Corrupted Settings Failure Mode:** Fail-closed. If `.vyen/settings.json` exists but cannot be parsed/validated, CLI aborts startup with an actionable error so users never run unprotected without their intended deny rules.
2. **Child Harness Lifecycle:** Ephemeral child harnesses (Agent Network rounds, Workflow steps) inherit the parent HookBus for tool interception (`PreToolUse`, `PostToolUse`), but do not trigger global `SessionStart` / `SessionEnd` hooks, preventing webhook spam.
3. **Missing File Sentinel in Trust Hash:** Non-existent script targets hash as `file:<path>:missing`. Creating the file later revokes trust automatically.
4. **PreToolUse Fail-Closed:** Hook timeouts or spawn crashes treat tool calls as denied.
5. **POSIX Case Sensitivity:** Path matching is case-sensitive on POSIX (`process.platform !== 'win32'`), while tool names remain canonical lowercase.
