# Short Design: Hook Bus Fail-Closed & Workflow Env Sanitization

**Date:** 2026-10-25  
**Topic:** Security hardening for `HookBus` and workflow shell execution  
**Status:** Pending Approval  

---

## 1. Intent & Why
Following the security audit findings in `vyen`, two internal security boundaries need hardening:
1. **`HookBus` Fail-Closed Invariant:** `PreToolUse` hooks are gatekeepers. If a `PreToolUse` hook crashes (spawn error) or times out, the hook execution result must explicitly declare `denied: true` at the source so callers never accidentally fail-open.
2. **Workflow Shell Environment Hygiene:** Workflow shell steps currently inherit ambient `process.env` directly, potentially exposing sensitive ambient environment credentials (tokens, secret keys) to workflow shell commands.

---

## 2. Goals & Non-Goals

### Goals
- Ensure `HookBus.dispatch('PreToolUse', ...)` marks results with `denied: true` when a spawn error or timeout occurs.
- Ensure non-blocking lifecycle hooks (`PostToolUse`, `SessionStart`, etc.) do not report `denied: true` on timeout/error.
- Sanitize the base environment in `executeWorkflow()` for shell steps by reusing `sanitizeEnvironment()` from `src/hooks.ts`.
- Preserve existing workflow variables (`VYEN_WF_*`) and Git/SSH identity variables (`SSH_AUTH_SOCK`, `GIT_*`).

### Non-Goals
- Modifying the default gateway URL in `src/config.ts` (explicitly excluded by user preference).
- Altering the policy evaluation rules in `src/policy.ts` or approval rules in `src/approval.ts`.

### Anti-Goals
- Breaking workflow commands that rely on standard, non-secret system environment variables.
- Breaking non-blocking lifecycle hooks by falsely denying operations when logging or telemetry hooks fail.

---

## 3. Constraints
- Strict TypeScript compilation (`strict: true`, `NodeNext`).
- Zero new external dependencies.
- Maintain existing tests passing and prevent any regression.
- Code changes must be surgical and adhere to `AGENTS.md`.

---

## 4. Approaches Considered

- **Approach 1 (Selected):** Context-aware fail-closed handling in `HookBus` based on hook event type (`PreToolUse` sets `denied: true` on timeout or spawn error) + reusing `sanitizeEnvironment()` in `executeWorkflow()`.
  - *Tradeoff:* Surgical, targeted to the authorization boundary, reuses existing tested code.
- **Approach 2 (Rejected):** Blanket `denied: true` on all hook events + strict fixed allowlist for workflow env.
  - *Tradeoff:* Too aggressive; disrupts non-blocking hooks and breaks legitimate environment variables needed by developer workflows.

---

## 5. Specification of Changes

### A. `src/hooks.ts`
- In `HookBus.dispatch(event, payload, signal)`: pass `event` into `this.executeCommand(...)`.
- In `executeCommand(event, command, inputJson, env, timeoutMs, signal)`:
  - If `child.on('error')` occurs: if `event === 'PreToolUse'`, return `denied: true`.
  - If `child.on('close')` occurs: if `timedOut && event === 'PreToolUse'`, return `denied: true`.

### B. `src/workflow.ts`
- Import `sanitizeEnvironment` from `./hooks.js`.
- In `executeWorkflow()`, when setting up `wfEnv` for `step.type === 'shell'`:
  - Start from `sanitizeEnvironment(process.env)` instead of `{ ...process.env }`.
  - Inject `VYEN_WF_INPUT`, `VYEN_WF_PREV`, `VYEN_WF_ARG_*`, `VYEN_WF_VAR_*` on top of the sanitized environment.
