# Headless Contract & Event Schema v1 Design Specification

Status: draft for review
Date: 2026-10-28
Baseline: Vyen 0.4.0 (`package.json`)
Roadmap items: R1.4 (Headless contract) & R1.5 (Extract on touch)

---

## 1. Intent & Why

Vyen provides non-interactive automation via `-p/--prompt` and `--json`. However:
1. **Unversioned NDJSON Stream:** The NDJSON output stream has no formal schema version, preventing downstream consumers (CI/CD pipelines, agent coordinators, external IDE plugins) from validating event streams deterministically.
2. **Lack of Structured Outputs:** External scripts often require strictly typed JSON responses (e.g., security scan results or test matrices). Without `--json-schema`, callers must parse unstructured text and hope the model respected formatting conventions.
3. **Monolithic CLI File:** Event formatting and streaming logic are embedded directly in `src/cli.ts` (>3,650 lines), violating the roadmap's "Extract on touch" architectural seam principle (R1.5).

This feature completes **Phase 1** by:
- Formalizing the versioned NDJSON event contract (`v1`).
- Introducing `--output-format stream-json|text` (aliasing `--json` to `stream-json`).
- Providing `--json-schema` validation with fail-closed error semantics via `ajv`.
- Extracting event schemas and validators into a standalone module: `src/events.ts`.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Extract `src/events.ts` to own all headless event definitions, Zod schemas, JSON Schema exports, and Ajv-based output validation.
- Implement `--output-format stream-json|text` with `--json` as an alias for `--output-format stream-json`.
- Implement `--json-schema <inline-json|path-to-file>` to steer the model and validate the final assistant output fail-closed.
- Emit a versioned `session` event (`version: 'v1'`) at the start of every `stream-json` run.
- Embed `structuredOutput` into the `done` event upon successful schema validation.
- Exit with code `1` and emit a structured `error` event if `--json-schema` is violated or invalid.
- Document and test the existing `--run-token-budget` within the headless contract.

### Non-Goals
- Changing the interactive TUI rendering logic or TUI event dispatch.
- Adding interactive multi-turn session prompting inside `--output-format stream-json` (headless remains single-turn or autonomous goal driven).
- Building an HTTP/REST server (reserved for Phase 4 MCP/ACP server).

### Anti-Goals
- **Fail-open validation:** Emitting a `done` event with unvalidated text when `--json-schema` fails.
- **Credential leaks in errors:** Echoing raw environment or auth headers when schema parsing fails.
- **Swallowed reader corruption:** Returning empty `{}` or default objects on corrupt JSON schema files.

---

## 3. Constraints & Operating Agreements

- **TypeScript 5.9 (strict, NodeNext):** No `@ts-ignore`, no reason-less `@ts-expect-error`, no `as any`.
- **Zero BOM:** All source and test files must be UTF-8 without BOM (`tests/repo-hygiene.test.mjs`).
- **Module Count Contract:** Adding `src/events.ts` brings total source files from 30 to 31. `tests/docs-contract.test.mjs`, `AGENTS.md §9`, and `docs/ROADMAP.md` must be updated atomically to maintain contract truth.
- **Fail-Closed Security (`REVIEW.md §2.A, §2.F`):** Invalid `--json-schema`, missing schema file, or model payload failing schema validation exits with code `1` and emits an explicit error event.
- **Testing Rigor (`AGENTS.md §2`):** Every new behavior is proven RED before GREEN in `tests/headless.test.mjs`.

---

## 4. Approaches & Decision

### Approach 1 (Selected): Dedicated `src/events.ts` Module
- Extract all event types, Zod schemas, Ajv compilation, and structured output parsing into `src/events.ts`.
- Satisfies R1.4 (Headless contract) and R1.5 (Extract on touch).
- Updates `sourceFiles.length` in `tests/docs-contract.test.mjs` from 30 to 31 with explanation.

### Approach 2 (Rejected): Inlining into `src/harness.ts` and `src/cli.ts`
- Avoids touching module counts, but bloats `harness.ts` and `cli.ts`, directly violating R1.5.

---

## 5. Detailed Specification

### 5.1 `src/events.ts`
- **Schema Version:** `EVENT_SCHEMA_VERSION = 'v1'`.
- **Event Union (`StreamJsonEvent`):**
  - `session`: `{ type: 'session', version: 'v1', id: string, cwd: string }`
  - `text`: `{ type: 'text', text: string }`
  - `reasoning`: `{ type: 'reasoning', text: string, source: 'inline' | 'provider' }`
  - `tool_stream`: `{ type: 'tool_stream', name: string, id: string, state: 'start' | 'delta', preview: string }`
  - `tool`: `{ type: 'tool', name: string, id: string, state: 'start' | 'done' | 'error', meta?: ToolEventMeta }`
  - `usage`: `{ type: 'usage', input: number, output: number, total: number }`
  - `compaction`: `{ type: 'compaction', count: number }`
  - `todo`: `{ type: 'todo', todos: TodoItem[] }`
  - `goal`: `{ type: 'goal', goal?: SessionGoal }`
  - `plan_exit`: `{ type: 'plan_exit', plan: string }`
  - `retry`: `{ type: 'retry', attempt: number, maxRetries: number, message: string }`
  - `stopped`: `{ type: 'stopped', reason: string }`
  - `done`: `{ type: 'done', text: string, denied: boolean, sessionId: string, structuredOutput?: unknown }`
  - `error`: `{ type: 'error', message: string, schemaErrors?: Array<{ path: string; message: string }> }`
- **Ajv Validation Function:**
  ```typescript
  export function validateStructuredOutput(
    schema: Record<string, unknown>,
    rawText: string,
  ): { valid: true; data: unknown } | { valid: false; errors: Array<{ path: string; message: string }>; rawText: string };
  ```
  Extracts JSON from `rawText` (handling Markdown ```` ```json ... ```` blocks if present) and validates against the compiled Ajv validator.

### 5.2 CLI Integration (`src/cli.ts`)
- Parse options:
  - `--output-format`: string (`text` | `stream-json`, default `text` when non-interactive without `--json`).
  - `--json-schema`: string (inline JSON or path to file).
- Handle `--json`: sets `outputFormat = 'stream-json'`.
- If `--json-schema` is provided:
  - Load schema via `loadJsonSchema(raw)`. If invalid JSON or ENOENT, throw immediately (fail closed).
  - Inject structured output instruction into the prompt:
    ```
    Your final answer must strictly adhere to the following JSON schema:
    <SCHEMA>
    Provide ONLY valid JSON (optionally enclosed in ```json ... ```).
    ```
  - When turn completes:
    - If `validateStructuredOutput` fails:
      - Emit `{ type: 'error', message: 'Final output does not conform to --json-schema', schemaErrors: result.errors }`.
      - Set `process.exitCode = 1`.
    - If valid:
      - Emit `{ type: 'done', text: outText, denied, sessionId, structuredOutput: result.data }`.

---

## 6. What's Left to the Builder

- The exact regex for extracting JSON from markdown code blocks in `validateStructuredOutput`.
- Writing the comprehensive end-to-end test suite in `tests/headless.test.mjs`.
- Updating documentation (`docs/SPEC.md`, `README.md`, `docs/ROADMAP.md`, `AGENTS.md`) and package version to `0.5.0`.
