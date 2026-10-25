# Layered Settings and Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement layered project settings (`.vyen/settings.json`), allow/ask/deny policy evaluation (`src/policy.ts`, `src/settings.ts`), and CLI flags (`--allowed-tools`, `--disallowed-tools`).

**Architecture:** Add `src/settings.ts` to discover and parse project-level `.vyen/settings.json` merged with user configuration; add `src/policy.ts` to evaluate tool permissions (`allow` | `ask` | `deny`) with strict precedence (CLI flags > user deny > project deny > project allow > user allow); integrate the policy evaluation into `src/cli.ts`'s tool approval callback and add CLI flags.

**Tech Stack:** TypeScript 5.9 strict (NodeNext), Zod, node:test, oxlint, tsc.

**Spec:** `docs/ROADMAP.md` R1.1, `docs/SPEC.md`.

## Global Constraints

- TypeScript 5.9 strict (NodeNext), zero lint errors (`oxlint`), clean `tsc --noEmit`.
- No new external dependencies; use existing `zod` and node built-ins.
- User-level deny rules can never be overridden or widened by project rules.
- Deny rules must take effect even in `auto` approval mode.
- Missing or invalid project settings files must degrade gracefully without crashing the agent.
- `AGENTS.md` and `tests/docs-contract.test.mjs` must be kept in sync with the new modules (`src/settings.ts`, `src/policy.ts`).

## Review Focus

1. A project allow rule skips approval for matching tool calls.
2. A user deny rule cannot be overridden by project allow.
3. A deny rule blocks execution even in auto mode.
4. CLI allowed and disallowed tool flags override layered settings.
5. Missing or malformed project settings file degrades safely.

## Scenarios & Tests

**What the user sees:** when `.vyen/settings.json` defines `permissions.allow`, approved tools run without confirmation prompts; when `permissions.deny` defines a tool or pattern, it is blocked immediately even with `--yes` (`auto` mode); CLI flags `--allowed-tools` and `--disallowed-tools` grant or restrict tool execution on demand.

| # | Criterion | Test |
|---|---|---|
| 1 | A project allow rule skips | `tests/policy.test.mjs` › project allow rule skips approval for matching tool calls |
| 2 | A user deny rule cannot | `tests/policy.test.mjs` › user deny rule cannot be overridden by project allow |
| 3 | A deny rule blocks execution | `tests/policy.test.mjs` › deny rule blocks execution even in auto mode |
| 4 | CLI allowed and disallowed tool | `tests/policy.test.mjs` › CLI allowed and disallowed tool flags override layered settings |
| 5 | Missing or malformed project settings | `tests/policy.test.mjs` › missing or malformed project settings file degrades safely |

---

## Tasks

### Task 1: Layered settings loader (`src/settings.ts`)

**Files:**
- Create: `src/settings.ts`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Produces:
  - `export interface PermissionRules { allow?: string[]; ask?: string[]; deny?: string[]; }`
  - `export interface ProjectSettings { permissions?: PermissionRules; }`
  - `export function projectSettingsPath(cwd: string): string`
  - `export async function loadProjectSettings(cwd: string): Promise<ProjectSettings>`
  - `export async function loadLayeredSettings(cwd: string, userConfig?: Config): Promise<LayeredSettings>`

- [ ] **Step 1: Write the failing tests in `tests/policy.test.mjs`**
  Add unit tests for `loadProjectSettings` discovering `.vyen/settings.json` in `cwd`, handling non-existent directory, malformed JSON, and returning parsed permissions.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/policy.test.mjs`
  Expected: FAIL importing non-existent `dist/settings.js`.
- [ ] **Step 3: Implement `src/settings.ts`**
  Implement Zod schema for `projectSettingsSchema` with `permissions: z.object({ allow: z.array(z.string()).optional(), ask: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict().optional()`.
  Implement `loadProjectSettings(cwd: string)` using `readFile` from `join(cwd, '.vyen', 'settings.json')`, safely catching `ENOENT` or JSON parse errors.
- [ ] **Step 4: Build and run test to verify it passes**
  Run: `npm run build && node --test --test-name-pattern="missing or malformed project settings" tests/policy.test.mjs`
  Expected: PASS.

### Task 2: Policy evaluator (`src/policy.ts`)

**Files:**
- Create: `src/policy.ts`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: `ProjectSettings`, `PermissionRules` from `src/settings.ts`
- Produces:
  - `export type PolicyDecision = 'allow' | 'ask' | 'deny';`
  - `export interface ToolRequest { tool: string; input?: unknown; }`
  - `export interface PolicyEvaluationContext { cliAllowed?: string[]; cliDisallowed?: string[]; userRules?: PermissionRules; projectRules?: PermissionRules; mode?: PermissionMode; }`
  - `export function matchToolPattern(pattern: string, request: ToolRequest): boolean`
  - `export function evaluateToolPolicy(request: ToolRequest, ctx: PolicyEvaluationContext): PolicyDecision`

- [ ] **Step 1: Write the failing tests in `tests/policy.test.mjs`**
  Add assertions proving:
  - `evaluateToolPolicy` returns `'deny'` if `cliDisallowed` matches tool.
  - `evaluateToolPolicy` returns `'deny'` if `userRules.deny` matches tool even if `projectRules.allow` matches.
  - `evaluateToolPolicy` returns `'deny'` even when `ctx.mode === 'auto'`.
  - `evaluateToolPolicy` returns `'allow'` when `projectRules.allow` matches (unless denied).
- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/policy.test.mjs`
  Expected: FAIL importing `dist/policy.js`.
- [ ] **Step 3: Implement `src/policy.ts`**
  Implement pattern matching for tool names and tool invocations (e.g. `write_file`, `bash`, `bash(git diff *)`).
  Implement precedence evaluation:
  1. CLI disallowed -> `deny`
  2. CLI allowed -> check if user/project denied; if not -> `allow`
  3. User deny -> `deny`
  4. Project deny -> `deny`
  5. Project allow -> `allow`
  6. User allow -> `allow`
  7. Default -> `ask`
- [ ] **Step 4: Build and run test to verify it passes**
  Run: `npm run build && node --test tests/policy.test.mjs`
  Expected: All 5 tests in `tests/policy.test.mjs` PASS.

### Task 3: CLI flags and harness approval integration (`src/cli.ts`, `src/help.ts`)

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/help.ts`
- Test: `tests/policy.test.mjs`, `tests/help.test.mjs`

**Interfaces:**
- Consumes: `loadProjectSettings` from `src/settings.ts`, `evaluateToolPolicy` from `src/policy.ts`

- [ ] **Step 1: Write integration tests in `tests/policy.test.mjs`**
  Assert that CLI flags `--allowed-tools` and `--disallowed-tools` are parsed, project `.vyen/settings.json` is loaded during CLI startup, and tool registry approval callback calls `evaluateToolPolicy`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/policy.test.mjs`
  Expected: FAIL with missing CLI flag or wiring.
- [ ] **Step 3: Implement CLI wiring in `src/cli.ts` and `src/help.ts`**
  - In `src/cli.ts`: add `'allowed-tools': { type: 'string' }`, `'disallowed-tools': { type: 'string' }` to `parseArgs`.
  - Parse comma-separated strings into lists.
  - Load project settings for `runtime.cwd`.
  - In `ToolRegistry` approval callback: call `evaluateToolPolicy`. If decision is `'deny'`, reject/return `false` immediately; if `'allow'`, return `true` immediately; if `'ask'`, proceed to interactive/session checks.
  - In `src/help.ts`: document `--allowed-tools` and `--disallowed-tools`.
- [ ] **Step 4: Build and test**
  Run: `npm run build && node --test tests/help.test.mjs tests/policy.test.mjs`
  Expected: PASS.

### Task 4: Documentation and contract synchronization

**Files:**
- Modify: `AGENTS.md` (Quick map: add `src/settings.ts` and `src/policy.ts`)
- Modify: `docs/SPEC.md` (document `.vyen/settings.json`, allow/ask/deny rules, `--allowed-tools`, `--disallowed-tools`)
- Modify: `README.md` (document project settings and tool flags)
- Modify: `tests/docs-contract.test.mjs` (update sourceFiles.length from 25 to 27)

- [ ] **Step 1: Write test assertion update in `tests/docs-contract.test.mjs`**
  Update expected source files count to 27 and verify `AGENTS.md` lists `src/settings.ts` and `src/policy.ts`.
- [ ] **Step 2: Update documentation files**
  Update `docs/SPEC.md`, `README.md`, and `AGENTS.md` (keeping `AGENTS.md` strictly under character budget).
- [ ] **Step 3: Verify contracts and guards**
  Run: `node --test tests/plan-traceability.test.mjs tests/repo-hygiene.test.mjs tests/docs-contract.test.mjs`
  Expected: PASS.

### Task 5: Full verification gate

**Files:** All

- [ ] **Step 1: Run typecheck**
  Run: `npm run typecheck`
  Expected: exit code 0.
- [ ] **Step 2: Run linter**
  Run: `npm run lint`
  Expected: 0 errors, 0 warnings.
- [ ] **Step 3: Run full test suite**
  Run: `npm test`
  Expected: 199+ pass, only known 5 Windows failures, 3 skipped.
