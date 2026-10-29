# Transcript Secret Scrubbing (R2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redact configured API keys and common secret token patterns (OpenAI, Anthropic, GitHub, Bearer tokens) before writing session transcripts, NDJSON streams, and audit records to disk.

**Architecture:** Extend `src/errors.ts` with reusable `redactSecrets(text, options)` and `redactObject(obj, options)` functions matching exact configured keys and common token regexes. Wire secret scrubbing into `SessionStore.writeNow()` (`src/session.ts`) to ensure persisted session JSON and checkpoints are sanitized, into `AuditLogger` (`src/audit.ts`) to sanitize all audit record fields, and into NDJSON event output (`src/cli.ts` / `src/events.ts`).

**Tech Stack:** TypeScript strict, Node.js (`fs/promises`, `path`), Regex token patterns, Node test runner (`node:test`).

**Spec:** [`docs/ROADMAP.md`](file:///c:/Users/Admin/Downloads/Vyen-cli-main/docs/ROADMAP.md) § Phase 2 (R2.2), [`docs/SPEC.md`](file:///c:/Users/Admin/Downloads/Vyen-cli-main/docs/SPEC.md).

## Global Constraints
- Target platform: Node >= 22.16, TypeScript 5.9 strict (NodeNext), Linux/Termux/Windows compatible.
- Zero secret leakage: configured API keys and sensitive tokens must never appear in persisted files.
- Safe persistence: credentials in `~/.config/vyen/credentials.json` must NOT be redacted when saved; only transcripts, checkpoints, audit logs, and external stream outputs are scrubbed.
- Instruction budget: keep combined `AGENTS.md` + `AGENT_LEARNINGS.md` under 24,000 characters.
- Gate before done: `npm run lint` 0 errors, `npm run typecheck` exit 0, `npm test` 0 failures.

## Review Focus
1. Configured API keys are redacted from persisted session checkpoints.
2. Common token patterns are scrubbed from persisted sessions.
3. Resuming a session cannot recover the raw secret from disk.
4. Headless stream-json output redacts secrets from event payloads.
5. Audit log and error traces sanitize configured keys across all fields.

## Scenarios & Tests

**What the user sees:** When Vyen saves session history, checkpoints, or audit logs, any API keys or access tokens mentioned in user prompts, model responses, or tool outputs are automatically sanitized to `[REDACTED]`. Even if the session is saved and resumed, the raw secrets can never be recovered from files on disk.

| # | Criterion | Test |
|---|---|---|
| 1 | Configured API keys are redacted from persisted session checkpoints | tests/secret-scrubbing.test.mjs › configured API keys are redacted from persisted session checkpoints |
| 2 | Common token patterns are scrubbed from persisted sessions | tests/secret-scrubbing.test.mjs › common token patterns are scrubbed from persisted sessions |
| 3 | Resuming a session cannot recover the raw secret from disk | tests/secret-scrubbing.test.mjs › resuming a session cannot recover the raw secret from disk |
| 4 | Headless stream-json output redacts secrets from event payloads | tests/secret-scrubbing.test.mjs › headless stream-json output redacts secrets from event payloads |
| 5 | Audit log and error traces sanitize configured keys across all fields | tests/secret-scrubbing.test.mjs › audit log and error traces sanitize configured keys across all fields |

---

### Task 1: Create Test Suite `tests/secret-scrubbing.test.mjs` (Failing Tests / RED)

**Files:**
- Create: `tests/secret-scrubbing.test.mjs`

**Interfaces:**
- Consumes: `redactSecrets`, `safeError` from `../dist/errors.js`, `SessionStore` from `../dist/session.js`, `AuditLogger` from `../dist/audit.js`.
- Produces: Failing unit and scenario tests demonstrating RED before implementation.

- [ ] **Step 1: Write `tests/secret-scrubbing.test.mjs` covering all 5 criteria**
- [ ] **Step 2: Run `node --test tests/secret-scrubbing.test.mjs` to confirm tests fail (RED)**
- [ ] **Step 3: Commit initial test suite**

---

### Task 2: Implement Redaction Engine in `src/errors.ts`

**Files:**
- Modify: `src/errors.ts`

**Interfaces:**
- Export `COMMON_SECRET_PATTERNS`: Array of regex patterns covering OpenAI (`sk-proj-...`, `sk-...`), Anthropic (`sk-ant-...`), Google (`AIza...`), GitHub (`gh[pousr]_...`), GitLab (`glpat-...`), and HTTP Bearer tokens.
- Export `redactSecrets(text: string, options?: { secretKeys?: string[]; redactPatterns?: boolean }): string`.
- Export `redactObject<T>(obj: T, options?: { secretKeys?: string[]; redactPatterns?: boolean }): T`.
- Update `safeError(error: unknown, apiKey?: string)` to leverage `redactSecrets`.

- [ ] **Step 1: Implement `COMMON_SECRET_PATTERNS`, `redactSecrets`, and `redactObject` in `src/errors.ts`**
- [ ] **Step 2: Update `safeError` to sanitize common secret patterns in addition to explicit `apiKey`**
- [ ] **Step 3: Compile and run test 4 and test 5 partial checks**

---

### Task 3: Wire Secret Scrubbing into `SessionStore` & `Harness`

**Files:**
- Modify: `src/session.ts`
- Modify: `src/harness.ts`

**Interfaces:**
- In `SessionStore` (`src/session.ts`):
  - Support `options.secretKeys?: string[]` and `addSecretKey(key: string): void`.
  - In `SessionStore.writeNow()`: apply `redactObject` before writing JSON to disk.
- In `Harness` (`src/harness.ts`):
  - Ensure `store.addSecretKey(this.apiKey)` is registered when initializing harness.

- [ ] **Step 1: Add `secretKeys` handling and redaction to `SessionStore.writeNow()`**
- [ ] **Step 2: Ensure Harness passes runtime API keys to `SessionStore`**
- [ ] **Step 3: Run `node --test tests/secret-scrubbing.test.mjs` to verify tests 1, 2, and 3 turn GREEN**

---

### Task 4: Wire Secret Scrubbing into `AuditLogger` & NDJSON Events

**Files:**
- Modify: `src/audit.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- In `AuditLogger` (`src/audit.ts`):
  - Apply `redactSecrets` across all string fields of `ToolAuditRecord` (`tool`, `errorClass`) and `PairAuditRecord` (`tool`, `origin`).
- In `src/cli.ts`:
  - When `--output-format stream-json` prints event payloads, ensure text output passes through `redactSecrets`.

- [ ] **Step 1: Update `AuditLogger` methods to sanitize records using `redactSecrets`**
- [ ] **Step 2: Verify `tests/secret-scrubbing.test.mjs` test 5 passes**
- [ ] **Step 3: Run full gate: `npm run lint`, `npm run typecheck`, `npm test`**

---

### Task 5: Documentation & Validation

**Files:**
- Modify: `docs/ROADMAP.md` (mark R2.2 completed)
- Modify: `docs/SPEC.md` (document transcript secret scrubbing contract)

- [ ] **Step 1: Update `docs/SPEC.md` and `docs/ROADMAP.md`**
- [ ] **Step 2: Verify plan traceability and repo hygiene: `node --test tests/plan-traceability.test.mjs tests/repo-hygiene.test.mjs`**
- [ ] **Step 3: Commit and run independent code review**
