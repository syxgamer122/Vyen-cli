# Design Document: Local Audit Log (R2.1)

**Date:** 2026-10-28  
**Status:** Pending Approval  
**Author:** Antigravity  
**Target Release:** Vyen 0.6.0 (Phase 2: Safety and Operations)  
**Tracking Issue:** R2.1 (`docs/ROADMAP.md`)

---

## 1. Intent & Purpose

As coding agents execute autonomous file mutations, shell commands, and remote pairing sessions, users and engineering teams require a tamper-resistant, auditable record of what decisions were made, by whom (local user, autonomous policy, or remote pair), and the resources consumed.

The goal of **R2.1 (Local Audit Log)** is to provide an observable, structured JSONL audit stream stored locally under the user's data directory without degrading CLI performance or leaking sensitive secrets/prompts.

---

## 2. Goals, Non-Goals, & Anti-Goals

### 2.1 Goals
- **Structured JSONL Audit Stream:** Store audit records as newline-delimited JSON under `$XDG_DATA_HOME/vyen/audit/` (via `join(dataDir(), 'audit')`).
- **Complete Tool Decision Tracking:** Record every tool invocation with its timestamp, sessionId, tool name, decision (`allow`, `deny`, `ask_approved`, `ask_denied`), duration, token usage delta, and error classification.
- **Pairing Lifecycle & Remote Approvals:** Log remote pair session starts, stops, and approvals/denials with client origin metadata.
- **Daily Rotation & Size Bounds:** Rotate log files daily (`audit-YYYY-MM-DD.jsonl`) with a size cap (10MB threshold) splitting into indexed chunks (`audit-YYYY-MM-DD.1.jsonl`).
- **Zero-Friction Opt-Out:** Completely disable audit logging when `VYEN_AUDIT=off` is set in the environment or disabled via config.
- **Performance Budget (< 1ms):** Execute log writes asynchronously off the critical path (`appendFile` fire-and-forget) to ensure zero perceptible latency in the harness loop.

### 2.2 Non-Goals
- **Centralized Cloud Ingestion / SIEM:** R2.1 is strictly local-first. Remote OTEL export or HTTP log shippers belong to future extensions.
- **Full Shell Output / Prompt Storage:** Prompts and raw tool output are omitted by default to respect privacy and avoid unbounded storage growth.

### 2.3 Anti-Goals
- **No Secret Leakage:** Configured API keys and credentials must NEVER appear in audit records.
- **No Blocking or Crashing:** An audit write failure (e.g. disk full, read-only filesystem) must fail closed or log a warning, but never crash the core agent run.

---

## 3. Evaluated Approaches & Selection

### Approach 1 (Selected): HookBus-Driven Event Listener & Direct Pair Seam
- **Architecture:** `AuditLogger` subscribes as an internal listener to `HookBus` lifecycle events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`). Pairing events (`pair_session_start`, `remote_approval`, etc.) are recorded via a dedicated helper `recordPairAudit(...)` called by `src/pair.ts`.
- **Pros:** Reuses existing lifecycle wiring across all 4 runners (interactive CLI, subagents, agent network, and workflows) without polluting `harness.ts`.
- **Trade-offs:** Requires standardizing hook context into the audit record format.

### Approach 2 (Rejected): Direct Harness Interceptor
- **Architecture:** Directly inject `auditLogger.log()` calls inside `src/harness.ts` before and after tool execution.
- **Cons:** Bypasses the unified `HookBus` abstraction; requires manually threading logger instances into subagent and network harnesses.

---

## 4. Technical Specification

### 4.1 Audit Record Schema

Each line in the `.jsonl` file conforms to the following TypeScript / Zod definition:

```ts
export type ToolDecision = 'allow' | 'deny' | 'ask_approved' | 'ask_denied';

export interface BaseAuditRecord {
  timestamp: string;      // ISO-8601 string (e.g., 2026-10-28T15:00:00.000Z)
  sessionId: string;      // Session UUID
}

export interface ToolAuditRecord extends BaseAuditRecord {
  type: 'tool_decision';
  tool: string;           // Tool name (e.g., 'bash', 'write_file')
  decision: ToolDecision;
  durationMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  errorClass?: string;    // Name of error or summary if failed
  subagentId?: string;    // Populated if invoked by a subagent
}

export interface PairAuditRecord extends BaseAuditRecord {
  type: 'pair_event';
  action: 'session_start' | 'session_stop' | 'remote_approve' | 'remote_deny';
  origin?: string;        // Client IP or Origin header or tunnel identifier
  tool?: string;          // Tool for which approval was granted/denied
}

export type AuditRecord = ToolAuditRecord | PairAuditRecord;
```

### 4.2 File Management & Rotation
- **Directory:** `join(dataDir(), 'audit')`
- **File Naming:** `audit-YYYY-MM-DD.jsonl`
- **Size Cap & Chunking:** Before appending, check if current active file exceeds 10MB (`10 * 1024 * 1024` bytes). If so, append an index suffix (`audit-YYYY-MM-DD.1.jsonl`, etc.).
- **Opt-Out Check:**
  ```ts
  if (process.env.VYEN_AUDIT === 'off') {
    return; // Fast path: zero filesystem operations
  }
  ```

### 4.3 Integration Points
1. **`src/audit.ts` (New Module #32):**
   - Owns `AuditLogger` class, file path calculation, non-blocking queue/append, size rotation, and formatting.
2. **`src/hooks.ts`:**
   - Attach `AuditLogger` listener to `HookBus` so that tool calls and policy decisions automatically trigger audit entries.
3. **`src/pair.ts`:**
   - Call `auditLogger.recordPairEvent(...)` on connection start, disconnect, and remote approval/denial callbacks.
4. **`src/cli.ts`:**
   - Initialize and pass `auditLogger` into runtime context.
5. **Contract Updates:**
   - Bump module count from 31 to 32 in `tests/docs-contract.test.mjs`, `docs/ROADMAP.md`, and `AGENTS.md`.

---

## 5. Verification Plan

1. **Unit & Scenario Tests (`tests/audit-log.test.mjs`):**
   - Tool run writes one JSONL record with valid schema, duration, tokens, and decision.
   - Pair session start/stop and remote approval write records with remote origin.
   - `VYEN_AUDIT=off` writes zero files.
   - Secret redaction test: Ensure configured API keys are never written to audit rows even on error.
   - Rotation test: File rolls over when exceeding size limit.
2. **Full Repository Gate:**
   - `npm run lint` (0 errors)
   - `npm run typecheck` (0 errors)
   - `npm test` (330+ tests, all passing, 0 failures)
   - Hygiene & traceability guards pass.
