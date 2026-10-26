# Project MCP Configuration, Workspace Trust & Merge Semantics — Design Specification

**Date:** 2026-10-26  
**Topic:** Implementation of Project MCP (`.vyen/mcp.json`), Workspace Trust Integration, Precedence Rules, and CLI Scoping (R1.3).  
**Status:** Approved for Implementation  
**Target:** Layered Merged Architecture with Origin Tracking and Trust Hash Extension (Approach 1).

---

## 1. Intent & The Why

Currently, Vyen only loads MCP (Model Context Protocol) servers from the user's global configuration file at `$XDG_CONFIG_HOME/vyen/mcp.json` (`~/.config/vyen/mcp.json`).

Teams and collaborative repositories frequently need project-specific MCP servers (e.g. repository indexers, database inspection tools, project dev servers, domain linters) defined directly in the workspace so every team member shares identical tooling without manual global setup.

However, loading MCP servers from a workspace introduces a major security risk:
1. **Remote Code Execution (RCE) via Git Clone:** An MCP server using `transport: "stdio"` executes local commands and scripts. If an untrusted repository defines a malicious command in `.vyen/mcp.json`, simply opening the repository could compromise the user's machine.
2. **Policy Bypass:** A project-level configuration must never be able to re-enable a server or bypass tool restrictions that the user has globally disabled or restricted in their user configuration ("User Deny Wins").

This design implements **R1.3 (Project MCP)** by providing:
- Structured project configuration at `<cwd>/.vyen/mcp.json`.
- Fail-closed loading with BOM stripping and schema validation (`AGENT_LEARNINGS.md` Rule 9).
- Mandatory workspace trust protection using cryptographic hashing (`calculateWorkspaceTrustHash`) covering the config and referenced local scripts.
- Deterministic merging where User Deny strictly wins over project definitions.
- Tamper-proof server origin tracking (`source: 'user' | 'project'`).
- Full CLI and TUI visibility in `vyen mcp list`, `vyen mcp get`, `vyen mcp add/remove --scope=project`, and `/mcp`.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Project MCP Storage & Path:** Support `<cwd>/.vyen/mcp.json` matching the existing `mcpConfigSchema` (allowing both `servers` and `mcpServers` formats).
- **Fail-Closed Reader:** `loadProjectMcpConfig(cwd)` must strip UTF-8 BOM, distinguish `ENOENT` (returning `{ servers: {} }`) from syntax/validation errors, and throw actionable errors when the file is corrupt or invalid.
- **Cryptographic Trust Hashing:** Extend `calculateWorkspaceTrustHash` in `src/hooks.ts` to cover:
  1. `<cwd>/.vyen/mcp.json` (or `mcp:none` if absent).
  2. Local command/script targets referenced by stdio project servers (including command words and script arguments).
  3. Non-existent local script references hashed as `file:<path>:missing` so creating the script later automatically invalidates trust.
- **Fail-Closed Execution:** Untrusted workspaces must never start project MCP servers. When untrusted, project servers are disabled and a clear diagnostic warning is displayed advising the user to run with `--trust-workspace`.
- **Deterministic Merge Semantics ("User Deny Wins"):**
  1. If a server is defined in user config with `disabled: true`, it remains disabled even if project config defines `disabled: false`.
  2. User-configured `readOnlyTools` cannot be removed by project configuration (they are unioned).
  3. If not disabled by the user, a project server can specialize parameters (command, args, env, cwd) for the project.
- **Tamper-Proof Origin Metadata:** The merged configuration tracks `sources[name]: 'user' | 'project'` in memory based on the loading boundary, not from untrusted properties inside the JSON.
- **CLI & TUI Scoping:**
  1. `vyen mcp list` outputs both `userPath` and `projectPath`, workspace trust status, and tags each server with `source: "user" | "project"`.
  2. `vyen mcp get <name>` displays the server definition along with its `source`.
  3. `vyen mcp add <name>` supports `--scope=project` (or `--project`) to write to `<cwd>/.vyen/mcp.json`.
  4. `vyen mcp remove <name>` supports `--scope=project` (or `--project`).
  5. Interactive `/mcp list` displays `[project]` or `[user]` badges and marks untrusted servers.
- **Execution Runners & Directory Changes:** `buildHarness` in `src/cli.ts` supplies the merged config to `McpManager`. Changing directories via `/cd` recalculates trust and reloads the merged MCP config for the new directory.

### Non-Goals
- Remote MCP marketplace or remote plugin downloads (scheduled for Phase 4 / R4.2).
- Permitting subagents to run MCP tools (SPEC explicitly specifies subagents are tool-isolated without MCP).
- Modifying MCP SDK or transport protocols.

### Anti-Goals
- **No Fail-Open Defaults:** Project MCP servers must not run under the assumption that a workspace is trusted unless explicitly verified.
- **No Error Swallowing:** Do not wrap JSON parsing of `.vyen/mcp.json` in a generic `try/catch` that returns `{}` on syntax errors.
- **No Metadata Spoofing:** Do not allow JSON files to specify `"source": "user"` to evade project trust boundaries.

---

## 3. Approaches Considered & Trade-offs

### Approach 1: Layered Merged Architecture with Separate Origin Map (Selected)
- **Description:** 
  1. Maintain separate loader functions: `loadMcpConfig()` (user) and `loadProjectMcpConfig(cwd)` (project).
  2. Combine them via `loadMergedMcpConfig(cwd, { isTrusted })` returning a `MergedMcpConfig` containing `servers`, `sources: Record<string, 'user' | 'project'>`, `userPath`, and `projectPath`.
  3. Keep the Zod `mcpServerSchema` strict (`.strict()`) to prevent config pollution, keeping metadata (`source`) outside the server definition objects.
  4. Extend `calculateWorkspaceTrustHash` to inspect project MCP servers and `.vyen/mcp.json`.
- **Trade-offs:** Clean separation of concerns, zero chance of JSON config spoofing, completely backward compatible with existing `McpManager` constructor which accepts `{ servers: ... }`.

### Approach 2: Monolithic CLI-Only Merge
- **Description:** Load `.vyen/mcp.json` only inside `cli.ts` before starting `McpManager`, without dedicated helpers or structured typing in `src/mcp.ts`.
- **Trade-offs:** Rejected. Violates `AGENTS.md` modularity rules, leaves `src/mcp.ts` unaware of project configs, and duplicates logic across CLI subcommands and TUI runners.

---

## 4. System Seam Matrix for Project MCP

| Seam / Module | Exact Responsibilities | Failure Mode if Missing |
|---|---|---|
| `src/mcp.ts` | 1. `projectMcpConfigPath(cwd)`<br>2. `loadProjectMcpConfig(cwd)` with BOM stripping & fail-closed schema validation<br>3. `saveProjectMcpConfig(cwd, config)` with atomic write<br>4. `loadMergedMcpConfig(cwd, options)` with User Deny Wins & origin tracking | Project config cannot be read/saved cleanly; corrupt files swallowed. |
| `src/hooks.ts` | 1. Include `.vyen/mcp.json` in `calculateWorkspaceTrustHash`<br>2. Discover and hash all local executable commands and args in stdio project MCP servers<br>3. Hash missing script references as `file:<path>:missing` | Swapping a local MCP script or adding a malicious `.vyen/mcp.json` bypasses trust verification. |
| `src/cli.ts` (Core Runner) | 1. In `buildHarness`, check if project MCP exists and whether workspace is trusted<br>2. Warn if project MCP servers are disabled due to untrusted workspace<br>3. Pass merged MCP config to `McpManager`<br>4. Recompute trust and reload merged MCP config on `/cd` directory change | Project MCP servers run in untrusted workspace (RCE risk) or never load on directory switch. |
| `src/cli.ts` (CLI Commands) | 1. `vyen mcp list`: outputs `userPath`, `projectPath`, `source`, `trusted`<br>2. `vyen mcp get <name>`: displays server and `source`<br>3. `vyen mcp add`: supports `--scope=project` / `--project`<br>4. `vyen mcp remove`: supports `--scope=project` / `--project`<br>5. `vyen mcp check`: evaluates merged servers subject to trust | User cannot manage or inspect project-scoped MCP servers via CLI. |
| `src/cli.ts` (TUI Slash Commands) | 1. `/mcp` & `/mcp list`: renders `[project]` or `[user]` badge and `(untrusted)` state<br>2. `/mcp remove <name>`: removes from target scope<br>3. `/mcp reload`: rebuilds harness with merged config | TUI users cannot see where servers originate or remove project servers. |
| `src/help.ts` & Docs | Document `--scope user|project`, `--project` flag, and update `docs/MCP.md` & `docs/SPEC.md` | User documentation and CLI help drift from implementation. |
| `src/index.ts` | Export `projectMcpConfigPath`, `loadProjectMcpConfig`, `loadMergedMcpConfig`, `saveProjectMcpConfig` | Library consumers cannot access project MCP primitives. |

---

## 5. Detailed Merge & Precedence Specification

Given:
- `userConfig = await loadMcpConfig()`
- `projectConfig = await loadProjectMcpConfig(cwd)`
- `isTrusted = options.isTrusted ?? false`

Algorithm:
1. Initialize `mergedServers = {}` and `sources = {}`.
2. First, populate all servers from `userConfig.servers`:
   - For each `[name, server]` in `userConfig.servers`:
     - `mergedServers[name] = { ...server }`
     - `sources[name] = 'user'`
3. If `!isTrusted`:
   - If `projectConfig.servers` has servers:
     - Project servers are **not active**. If any project server is present, they may either be omitted from active execution or retained with `disabled: true` and marked untrusted for inspection.
     - For active tool execution in `McpManager`, only trusted servers connect.
4. If `isTrusted`:
   - For each `[name, server]` in `projectConfig.servers`:
     - If `userConfig.servers[name]` exists:
       - **User Deny Wins:** If `userConfig.servers[name].disabled === true`, then `mergedServers[name].disabled = true`. The project cannot re-enable it.
       - **Read-Only Preservation:** `readOnlyTools` = `Array.from(new Set([...userConfig.servers[name].readOnlyTools, ...server.readOnlyTools]))`.
       - If user server is not disabled, project server overrides execution fields (`transport`, `command`, `args`, `env`, `url`, `headers`, etc.) to provide project context.
       - `sources[name] = 'project'` (or note overridden state if user disabled).
     - If `userConfig.servers[name]` does not exist:
       - `mergedServers[name] = { ...server }`
       - `sources[name] = 'project'`

---

## 6. Trust Hash Algorithm for Project MCP

In `calculateWorkspaceTrustHash(cwd, hookCommands)` in `src/hooks.ts`:
1. Hash `<cwd>/.vyen/settings.json` if present, else `'settings:none'`.
2. **New:** Hash `<cwd>/.vyen/mcp.json` if present:
   ```ts
   const mcpFile = projectMcpConfigPath(normalizedCwd);
   try {
     const mcpData = await readFile(mcpFile);
     hasher.update('mcp:');
     hasher.update(mcpData);
   } catch {
     hasher.update('mcp:none');
   }
   ```
3. Extract candidate commands and script paths from `hookCommands` (existing) **AND** project MCP servers:
   - For each stdio server in project config:
     - Add `server.command` to candidates.
     - Add each entry in `server.args` to candidates.
4. For each local script candidate:
   - If file exists: hash `file:<candidate>:<content>`.
   - If file is missing but represents an explicit script path: hash `file:<candidate>:missing`.

---

## 7. What is Left to the Builder

- Exact CLI message styling for `vyen mcp add --project` (following Vyen's standard output conventions).
- Internal helper structure in `src/mcp.ts` for extracting stdio command candidates.
- Specific unit and integration test fixtures in `tests/mcp.test.mjs`.
