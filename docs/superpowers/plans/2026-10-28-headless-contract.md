# Headless Contract & Event Schema v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the versioned NDJSON event contract (`v1`), add `--output-format stream-json|text` and `--json-schema` structured output validation with fail-closed semantics, and extract `src/events.ts`.

**Architecture:** Create `src/events.ts` with Zod/Ajv schemas for `v1` stream events and structured output validation. Wire `--output-format` and `--json-schema` into `src/cli.ts`. Update docs contracts and test suite.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Zod, Ajv, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-28-headless-contract-design.md`

## Global Constraints

- TypeScript 5.9 strict (NodeNext); no `@ts-ignore`, no reason-less `@ts-expect-error`, no `as any`.
- No BOM in source, test or documentation files.
- Every new behavior test is written first and seen RED before implementation.
- `npm run lint`, `npm run typecheck` and `npm test` must pass at the end.
- Module count contract: update `tests/docs-contract.test.mjs`, `AGENTS.md §9`, and `docs/ROADMAP.md` atomically from 30 to 31 modules.
- Security decisions:
  - `--json-schema` failure (schema syntax, missing file, or model payload non-conformance) fails closed with exit code 1 and an error event.
  - No credentials or API keys leaked in error messages.
  - `--json` aliases to `--output-format stream-json`.

## Review Focus

1. `--output-format stream-json` emits the `v1` session event header and valid NDJSON events.
2. `--json-schema` with invalid syntax or missing file fails closed with exit code 1.
3. `--json-schema` with non-conforming model output emits an error event with validation errors and exits with code 1.
4. `--json-schema` with valid conforming model output emits `done` event containing `structuredOutput` and exits with code 0.
5. `--json` flag remains a backward-compatible alias for `--output-format stream-json`.

## Scenarios & Tests

**What the user sees:** `vyen -p "..." --output-format stream-json` emits versioned NDJSON events starting with `{"type":"session","version":"v1",...}`. Passing `--json-schema <schema>` ensures the agent returns validated structured data in `structuredOutput`; if the model fails the schema or the schema file is invalid, Vyen emits an error event and exits with code 1.

| # | Criterion | Test |
|---|---|---|
| 1 | stream-json output emits v1 session header and valid event union | tests/headless.test.mjs › stream-json output emits v1 session header and valid event union |
| 2 | json-schema with invalid syntax or missing file fails closed with exit code 1 | tests/headless.test.mjs › json-schema with invalid syntax or missing file fails closed with exit code 1 |
| 3 | json-schema with non-conforming model output emits error event and exits code 1 | tests/headless.test.mjs › json-schema with non-conforming model output emits error event and exits code 1 |
| 4 | json-schema with valid conforming model output emits done event with structuredOutput | tests/headless.test.mjs › json-schema with valid conforming model output emits done event with structuredOutput |
| 5 | json flag remains a backward-compatible alias for stream-json | tests/headless.test.mjs › json flag remains a backward-compatible alias for stream-json |

---

### Task 1: Create Test Suite `tests/headless.test.mjs` (Failing Tests / RED)

**Files:**
- Create: `tests/headless.test.mjs`

- [ ] **Step 1: Write `tests/headless.test.mjs` containing the 5 scenario test cases**
- [ ] **Step 2: Run `node --test tests/headless.test.mjs` to confirm test suite runs and fails (RED)**

---

### Task 2: Implement `src/events.ts` (Event Schema v1 & Ajv Validator)

**Files:**
- Create: `src/events.ts`
- Export: `src/index.ts`

**Interfaces:**
- Produces: `EVENT_SCHEMA_VERSION`, `streamJsonEventSchema`, `type StreamJsonEvent`, `validateStructuredOutput(schema, text)`

- [ ] **Step 1: Implement `src/events.ts` with Ajv schema validator and Zod event schemas**
- [ ] **Step 2: Export event types and helper from `src/index.ts`**
- [ ] **Step 3: Run typecheck and unit tests**

---

### Task 3: Wire `--output-format` and `--json-schema` into `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/help.ts`

- [ ] **Step 1: Add `--output-format` and `--json-schema` flags to `parseArgs` in `src/cli.ts`**
- [ ] **Step 2: Add validation for `--json-schema` loading and inject prompt instructions**
- [ ] **Step 3: Update `done` and `error` event emission in headless loop to validate structured output and set exitCode fail-closed**
- [ ] **Step 4: Update `src/help.ts` with `--output-format` and `--json-schema` options**
- [ ] **Step 5: Run `npm test` on `tests/headless.test.mjs` and confirm all 5 tests turn GREEN**

---

### Task 4: Documentation, Contracts & Version Bump to 0.5.0

**Files:**
- Modify: `tests/docs-contract.test.mjs`
- Modify: `AGENTS.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Update `tests/docs-contract.test.mjs` for 31 modules and Phase 1 completion**
- [ ] **Step 2: Update `AGENTS.md §9` quick map with `src/events.ts`**
- [ ] **Step 3: Update `docs/SPEC.md`, `README.md`, `docs/ROADMAP.md`, `CHANGELOG.md`**
- [ ] **Step 4: Bump `package.json` version to 0.5.0**

---

### Task 5: Final Verification Gate

- [ ] **Step 1: Run `npm run typecheck` (must exit 0)**
- [ ] **Step 2: Run `npm run lint` (must report zero errors)**
- [ ] **Step 3: Run `npm test` (all tests pass, 0 failures)**
