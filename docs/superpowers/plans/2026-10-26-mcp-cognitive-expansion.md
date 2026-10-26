# MCP Cognitive Expansion & Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Vyen's MCP implementation to fully support Prompts, Elicitation, and Bounded Sampling, while integrating Knowledge Graph Memory and Sequential Thinking reasoning tools referencing official `servers-main`.

**Architecture:** Layered expansion across `src/mcp.ts` (Prompts, Elicitation, Sampling RPC handlers), a dedicated `src/memory.ts` engine (JSONL-persisted Entity-Relation Knowledge Graph), a native `sequential_thinking` tool in `src/tools.ts`, and a preset catalog in `src/mcp-presets.ts` allowing instant configuration of official servers.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node >= 22.16, `@modelcontextprotocol/sdk`, AI SDK 6, Zod, node:test.

**Spec:** `docs/superpowers/specs/2026-10-26-mcp-cognitive-expansion-design.md`

## Global Constraints

- TypeScript strict typecheck must exit 0 (`npm run typecheck`).
- Oxlint must report zero errors (`npm run lint`).
- Node test suite must pass 100% with zero failures (`npm test`).
- Fail-closed security on all MCP project-scoped operations and sampling requests.
- No BOM injected on file writes; clean UTF-8 encoding across all JSON/JSONL storage.

## Review Focus

1. Disconnected server prompt query: `get_mcp_prompt` called for a disconnected or unknown server returns a structured error and does not terminate the harness loop.
2. Sampling token budget enforcement: MCP server sampling request cannot exceed 2,048 tokens and aborts cleanly when the timeout triggers.
3. Headless elicitation fail-closed: Server-initiated elicitation in headless `-p` mode fails closed (`declined: true`) and never wedges standard input.
4. Unreadable line preservation in Knowledge Graph: Malformed lines in `knowledge-graph.jsonl` are kept intact during graph mutations and do not crash `readGraph`.
5. Sequential thinking revision tracking: A thought marked `isRevision: true` updates understanding while keeping historical thought branches accessible.

## Scenarios & Tests

**What the user sees:** Users can browse and execute prompt templates from MCP servers via `/mcp prompts` and `/mcp prompt`. The agent remembers complex architectural relationships through persistent Knowledge Graph entities, reasons through hard problems step-by-step using `sequential_thinking`, handles interactive tool input questions via elicitation, and installs official MCP servers with `vyen mcp add --preset <name>`.

| # | Criterion | Test |
|---|---|---|
| 1 | Disconnected server prompt query returns structured error | tests/mcp-prompts.test.mjs › get_mcp_prompt returns structured error for unknown or disconnected server |
| 2 | Sampling token budget enforcement and timeout guard | tests/mcp-elicitation-sampling.test.mjs › sampling request enforces 2048 token limit and timeout guard |
| 3 | Headless elicitation fails closed without hanging stdin | tests/mcp-elicitation-sampling.test.mjs › headless elicitation fails closed with declined response |
| 4 | Unreadable line preservation during Knowledge Graph rewrite | tests/knowledge-graph.test.mjs › loadGraph preserves unreadable lines and handles valid entity mutations |
| 5 | Sequential thinking revision and branch tracking | tests/sequential-thinking.test.mjs › sequential_thinking tracks revision indices and maintains branch history |

---

### Task 1: MCP Prompts Surface (`list_mcp_prompts`, `get_mcp_prompt`, and TUI)

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/tui.ts`
- Test: `tests/mcp-prompts.test.mjs`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/client/index.js`, `ToolRegistry` (`src/tools.ts`).
- Produces:
  - `McpManager.prototype.listPrompts(server?: string)`: Promise<Record<string, unknown>>
  - `McpManager.prototype.getPrompt(server: string, name: string, args?: Record<string, string>)`: Promise<unknown>
  - Tools: `list_mcp_prompts`, `get_mcp_prompt` registered on `ToolRegistry`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-prompts.test.mjs` testing `list_mcp_prompts` and `get_mcp_prompt` with mock MCP servers exposing prompt endpoints.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-prompts.test.mjs`
Expected: FAIL (tools not registered or methods undefined).

- [ ] **Step 3: Implement Prompts methods and tool registration in `src/mcp.ts` and slash commands in `src/tui.ts`**

Implement `client.listPrompts()`, `client.getPrompt()`, register tools `list_mcp_prompts` and `get_mcp_prompt` in `registerTools()`, and wire `/mcp prompts` in `src/tui.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mcp-prompts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-prompts.test.mjs src/mcp.ts src/tui.ts
git commit -m "feat(mcp): support MCP prompt listing, execution, and TUI commands"
```

---

### Task 2: MCP Elicitation & Bounded Sampling Bridge

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/harness.ts`
- Test: `tests/mcp-elicitation-sampling.test.mjs`

**Interfaces:**
- Consumes: `createModel` (`src/provider.ts`), `@modelcontextprotocol/sdk`.
- Produces:
  - Client elicitation handler answering `elicitation/create` and `input_required`.
  - Client sampling handler answering `sampling/createMessage` with 2,048 token hard cap and 30s timeout.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-elicitation-sampling.test.mjs` asserting sampling cap, 30s timeout, and headless elicitation fail-closed.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-elicitation-sampling.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement elicitation and sampling handlers in `src/mcp.ts`**

Register request handlers on client instances during `openServer()`. Route sampling to `generateText` with `maxTokens: 2048`. In headless mode, respond to elicitation with `action: 'decline'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mcp-elicitation-sampling.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-elicitation-sampling.test.mjs src/mcp.ts src/harness.ts
git commit -m "feat(mcp): implement interactive elicitation and bounded sampling handlers"
```

---

### Task 3: Knowledge Graph Memory Engine (`Entity`, `Relation`, `Observation`)

**Files:**
- Create: `src/memory.ts`
- Modify: `src/context.ts`
- Modify: `src/session.ts`
- Test: `tests/knowledge-graph.test.mjs`

**Interfaces:**
- Consumes: `atomicJson` (`src/config.ts`), `calculateWorkspaceTrustHash` (`src/hooks.ts`).
- Produces:
  - `class KnowledgeGraphManager`:
    - `loadGraph(scope?: 'user' | 'project'): Promise<KnowledgeGraph>`
    - `createEntities(entities: Entity[], scope?: 'user' | 'project'): Promise<void>`
    - `createRelations(relations: Relation[], scope?: 'user' | 'project'): Promise<void>`
    - `addObservations(observations: { entityName: string; contents: string[] }[], scope?: 'user' | 'project'): Promise<void>`
    - `searchNodes(query: string): Promise<{ entities: Entity[]; relations: Relation[] }>`
  - Tools registered: `mcp_create_entities`, `mcp_create_relations`, `mcp_add_observations`, `mcp_read_graph`, `mcp_search_nodes`.

- [ ] **Step 1: Write the failing test**

Create `tests/knowledge-graph.test.mjs` testing entity/relation creation, observation addition, unreadable line preservation, and migration from flat memories.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knowledge-graph.test.mjs`
Expected: FAIL (`src/memory.ts` missing).

- [ ] **Step 3: Implement `src/memory.ts` and integrate with `src/context.ts`**

Implement JSONL reading/writing, memory migration from `memories.json`, entity/relation CRUD, and register tools on `ToolRegistry`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knowledge-graph.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/knowledge-graph.test.mjs src/memory.ts src/context.ts src/session.ts
git commit -m "feat(memory): add Knowledge Graph engine and persistent JSONL store"
```

---

### Task 4: Sequential Thinking Dynamic Reasoning Tool

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/context.ts`
- Test: `tests/sequential-thinking.test.mjs`

**Interfaces:**
- Consumes: `ToolRegistry` (`src/tools.ts`).
- Produces:
  - Tool `sequential_thinking`:
    - `thought`: string
    - `thoughtNumber`: number
    - `totalThoughts`: number
    - `nextThoughtNeeded`: boolean
    - `isRevision`: boolean (optional)
    - `revisesThought`: number (optional)
    - `branchFromThought`: number (optional)
    - `branchId`: string (optional)
  - System prompt guidance in `src/context.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/sequential-thinking.test.mjs` asserting state evolution, revisions, and branching.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sequential-thinking.test.mjs`
Expected: FAIL (`sequential_thinking` not registered).

- [ ] **Step 3: Implement `sequential_thinking` in `src/tools.ts` and add prompt guidance in `src/context.ts`**

Add tool schema, in-session thought tracking state, and guidance block in system prompt.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sequential-thinking.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/sequential-thinking.test.mjs src/tools.ts src/context.ts
git commit -m "feat(reasoning): add sequential thinking tool for dynamic multi-step reasoning"
```

---

### Task 5: Official Preset Catalog & Documentation

**Files:**
- Create: `src/mcp-presets.ts`
- Modify: `src/cli.ts`
- Modify: `src/help.ts`
- Modify: `docs/MCP.md`
- Modify: `README.md`
- Test: `tests/mcp-presets.test.mjs`

**Interfaces:**
- Consumes: `loadMcpConfig`, `loadProjectMcpConfig` (`src/mcp.ts`).
- Produces:
  - `resolvePreset(name: string): McpServerConfig`
  - CLI command `vyen mcp add --preset <name> [--scope=user|project]`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-presets.test.mjs` testing preset resolution and configuration persistence.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-presets.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `src/mcp-presets.ts`, wire CLI flag in `src/cli.ts`, and update docs**

Support presets: `memory`, `sequentialthinking`, `fetch`, `git`. Update `docs/MCP.md`, `README.md`, and `src/help.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mcp-presets.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-presets.test.mjs src/mcp-presets.ts src/cli.ts src/help.ts docs/MCP.md README.md
git commit -m "feat(mcp): add official server preset catalog and quick installation command"
```
