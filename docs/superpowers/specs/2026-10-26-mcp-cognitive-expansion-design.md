# MCP Protocol Expansion & Cognitive Tools Integration — Design Specification

**Date:** 2026-10-26  
**Topic:** MCP Protocol Expansion (Prompts, Elicitation, Sampling, Resources) and Cognitive Tools Integration (Knowledge Graph Memory & Sequential Thinking) referencing `servers-main`.  
**Status:** In Review (Brainstorming Phase)  
**Target:** Comprehensive MCP Client & Cognitive Reasoning Engine (Approach 1).

---

## 1. Intent & The Why

Vyen recently completed Milestone R1.3 (Project MCP and Workspace Trust), providing robust loading of MCP servers from both user (`~/.config/vyen/mcp.json`) and project (`.vyen/mcp.json`) scopes.

However, existing terminal coding agents (most notably **Claude Code**) treat the Model Context Protocol (MCP) as a narrow "tool runner":
1. They ignore **Prompts** (`prompts/list`, `prompts/get`), which allow MCP servers to provide domain-specific prompt templates and parameter auto-completions.
2. They do not handle **Elicitation** (`input_required`, `elicitation/create`), which allows MCP tools to ask human users interactive clarifying questions or request authentication.
3. They lack **Sampling** (`sampling/createMessage`), preventing servers from requesting sub-completions from the agent's LLM.
4. Their cognitive layer remains flat: project memory is stored as raw unstructured text strings (`memories.json` or `CLAUDE.md`), and the agent's reasoning loop is single-turn and linear, without dynamic hypothesis testing or branching.

By referencing the official Anthropic MCP server implementations in `servers-main` (specifically `src/memory`, `src/sequentialthinking`, and `src/everything`), this specification defines how Vyen will become the most comprehensive MCP-native agent harness:
- Full adherence to the complete MCP triad: **Tools**, **Resources**, and **Prompts**.
- Interactive human-in-the-loop **Elicitation** and bounded **Sampling**.
- **Knowledge Graph Memory** (`Entity`, `Relation`, `Observation`) to maintain deep architectural and semantic relationships across sessions.
- **Sequential Thinking** (`sequentialthinking`) dynamic reasoning scratchpad to evaluate and course-correct complex architectural decisions before writing code.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Full MCP Surface Support in `src/mcp.ts`:**
  1. **Prompts:** Implement `client.listPrompts()` and `client.getPrompt({ name, arguments })`. Expose them via `list_mcp_prompts` and `get_mcp_prompt` tools in the agent loop, and as interactive `/mcp prompt <server> <name>` commands in the TUI.
  2. **Resources UX:** Enhance `list_mcp_resources` and `read_mcp_resource` so resource URIs can be referenced directly in user prompts (e.g. `@mcp://server/resource`).
  3. **Elicitation Bridge:** Implement client-side elicitation request handlers. When an MCP tool or task returns `input_required` or calls `elicitation/create`, Vyen surfaces an interactive prompt in the TUI/CLI and delivers the user's response back to the server.
  4. **Bounded Sampling:** Implement `sampling/createMessage` routing server generation requests through `src/provider.ts`, protected by strict token limits, timeout guards, and user notification.
- **Knowledge Graph Memory Integration:**
  1. Implement graph schema (`Entity`, `Relation`, `KnowledgeGraph`) compatible with `servers-main/src/memory`.
  2. Provide dual storage support: Global graph (`~/.config/vyen/knowledge-graph.jsonl`) and Project graph (`.vyen/knowledge-graph.jsonl`).
  3. Support tools: `mcp_create_entities`, `mcp_create_relations`, `mcp_add_observations`, `mcp_read_graph`, `mcp_search_nodes`.
- **Sequential Thinking Tool:**
  1. Add built-in `sequential_thinking` tool into `src/tools.ts` (or packaged preset), based on `servers-main/src/sequentialthinking`, providing dynamic parameters: `thought`, `thoughtNumber`, `totalThoughts`, `nextThoughtNeeded`, `isRevision`, `revisesThought`, `branchFromThought`.
- **CLI & Preset Catalog:**
  1. Support `vyen mcp add --preset <memory|sequentialthinking|fetch|git>` to instantly configure official servers with zero manual JSON editing.

### Non-Goals
- Transforming Vyen into a standalone headless MCP Server daemon (Approach 2 — deferred to Phase 4).
- Automatic unsanctioned tool downloads from unverified third-party registries.
- Bypassing workspace trust: Project-level MCP servers providing prompts/resources remain strictly gated behind workspace trust verification.

### Anti-Goals
- **No Unbounded Sampling:** Never allow external MCP servers to consume unlimited LLM tokens without user awareness and hard caps.
- **No Memory Data Loss:** When reading or updating the Knowledge Graph JSONL, all writes must use atomic temporary files (`atomicJson` / atomic append) to prevent file corruption.
- **No Breaking Changes:** Existing `memories.json` (flat string array) must continue to load cleanly alongside or migrate seamlessly to the Knowledge Graph.

---

## 3. Approaches Considered & Selected

### Approach 1: Full MCP Protocol & Cognitive Tools (Selected)
- **Scope:**
  - Complete MCP client capabilities (Tools + Resources + Prompts + Elicitation + Bounded Sampling).
  - Native Knowledge Graph memory engine + Sequential Thinking reasoning loop.
  - Zero-config preset installer (`vyen mcp add --preset`).
- **Trade-offs:** Touches `src/mcp.ts`, `src/tools.ts`, `src/context.ts`, and `src/tui.ts`. Delivers maximum intelligence and protocol completeness on terminal CLI.
- **Decision:** Selected by user. Directly surpasses Claude Code's MCP capabilities while solving real reasoning and context problems.

### Approach 2: Two-Way Hub & Server Mode (Rejected for now)
- **Scope:** Exposing Vyen's harness as an MCP Server (`vyen mcp serve`) for external IDEs (Cursor, Windsurf).
- **Trade-offs:** High complexity in multi-client session isolation; does not improve Vyen's own terminal coding performance.

### Approach 3: Preset Catalog Wrapper Only (Rejected)
- **Scope:** Simple CLI installer scripts for `servers-main`.
- **Trade-offs:** Superficial convenience; leaves protocol gaps (missing Prompts, Elicitation) and weak memory architecture unaddressed.

---

## 4. Architectural & Implementation Details

### 4.1 MCP Prompts & Resources (`src/mcp.ts`)
- **Connection Interface:**
  - Store registered prompts discovered during `client.listPrompts()`.
  - Expose tools:
    - `list_mcp_prompts`: returns prompt definitions, parameter schemas, and descriptions.
    - `get_mcp_prompt`: executes `client.getPrompt({ name, arguments })`, returning rendered user/assistant message arrays.
- **TUI Integration:**
  - `/mcp prompts`: lists available prompts across all connected servers.
  - `/mcp run-prompt <server> <prompt-name>`: prompts for required arguments in TUI, then injects the resulting message template into the active session.

### 4.2 Interactive Elicitation & Bounded Sampling (`src/mcp.ts`)
- **Elicitation Handler:**
  - Support both 2025-era RPC handler (`client.setRequestHandler(ElicitRequestSchema, ...)`) and modern 2026-era in-band tool result status (`status === 'input_required'`).
  - In CLI/TUI mode: Render question/form and pause tool execution until user inputs data or cancels.
  - In headless `-p` mode: Fail closed with `declined: true` unless an answer is provided via standard input.
- **Sampling Handler (`sampling/createMessage`):**
  - Verify server is trusted and user has not set `disableSampling: true`.
  - Use `createModel(runtimeConfig)` from `src/provider.ts` and `generateText` from the AI SDK with an explicit hard cap (max 2,048 tokens per sampling request) and a 30s timeout guard.
  - Log sampling event to session audit log.

### 4.3 Knowledge Graph Memory Architecture (`src/memory.ts`)
- **JSONL Wire Format (matching `servers-main/src/memory`):**
  - Each line is a self-contained JSON object:
    - `{ "type": "entity", "name": string, "entityType": string, "observations": string[] }`
    - `{ "type": "relation", "from": string, "to": string, "relationType": string }`
  - Unreadable or unrecognized lines are preserved during rewrites without silent truncation.
- **Migration from Legacy `memories.json`:**
  - Existing flat strings in `~/.config/vyen/memories.json` are retained and automatically ingested as observations under an entity named `global_user_memory` (`entityType: "system_memory"`). Zero data loss.
- **Storage Locations:**
  - User level: `~/.config/vyen/knowledge-graph.jsonl`
  - Project level: `<cwd>/.vyen/knowledge-graph.jsonl` (guarded by workspace trust)
- **Operations:**
  - `createEntities(entities: Entity[])`: Merges observations if entity exists; appends new entities.
  - `createRelations(relations: Relation[])`: Stores directed edges between known entities.
  - `addObservations(observations: { entityName: string; contents: string[] }[])`: Appends observations.
  - `searchNodes(query: string)`: Searches entity names, types, and observation text.
  - `readGraph()`: Returns the full graph or neighborhood subgraph.

### 4.4 Sequential Thinking Tool (`src/tools.ts`)
- Registered in `ToolRegistry` as `sequential_thinking`.
- **Input Schema:**
  - `thought`: `string` (Current reasoning step)
  - `thoughtNumber`: `number` (Current step sequence)
  - `totalThoughts`: `number` (Estimated total steps needed, dynamically adjustable)
  - `nextThoughtNeeded`: `boolean` (Whether more thinking is required)
  - `isRevision`: `boolean` (Optional, flags if revising a prior step)
  - `revisesThought`: `number` (Optional, index of thought being revised)
  - `branchFromThought`: `number` (Optional, branching step index)
  - `branchId`: `string` (Optional, identifier for reasoning branch)
- **Behavior:**
  - Maintains state within the turn/session.
  - Emits clear progress indicators in the TUI stream without cluttering the final output message.

### 4.5 Preset Catalog (`src/mcp-presets.ts`)
- Pre-packaged definitions for official servers:
  - `memory`: Local in-process or stdio wrapper.
  - `sequentialthinking`: Built-in or stdio.
  - `fetch`: `@modelcontextprotocol/server-fetch`.
  - `git`: `@modelcontextprotocol/server-git`.
- Command: `vyen mcp add --preset <name> [--scope=user|project]` automatically writes normalized server definitions to the appropriate `mcp.json`.

---

## 5. Constraints & Security Boundaries

1. **Gate Invariants (`AGENTS.md`):**
   - Zero lint errors (`npm run lint`).
   - Clean typecheck (`npm run typecheck`).
   - Clean test run (`npm test`).
   - Fail-closed security rules for sampling and project-level knowledge graphs.
2. **Workspace Trust Protection:**
   - Any project-level Knowledge Graph (`.vyen/knowledge-graph.jsonl`) or project MCP servers must be covered by `calculateWorkspaceTrustHash` in `src/hooks.ts`.
3. **No BOM & UTF-8 Encoding:**
   - All JSON and JSONL operations must strip BOM on read and write clean UTF-8 without BOM.

---

## 6. What's Left to the Builder

- Detailed JSONL parser optimization for very large knowledge graphs (>10,000 entities).
- TUI autocomplete rendering details for MCP prompt arguments.
- Fine-tuning exact prompt wording in `src/context.ts` to instruct the LLM on when to prefer `sequential_thinking` vs immediate tool calls.
