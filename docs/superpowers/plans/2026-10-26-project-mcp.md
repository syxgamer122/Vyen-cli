# Project MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load project-scoped MCP servers from `.vyen/mcp.json` only after workspace trust, without letting a project widen approvals or replace a user-defined server.

**Architecture:** `src/mcp.ts` gains project path/load/save/merge helpers and a pure list formatter. `src/hooks.ts` extends the trust hash to cover the project MCP file and local command/script targets, and exposes one trust evaluation helper. `src/cli.ts` wires the merged config into `buildHarness`, the `mcp` subcommands and the TUI. Documentation and help are updated in the same change.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Zod, Node.js `node:test`, existing `@modelcontextprotocol/sdk` client.

**Spec:** `docs/superpowers/specs/2026-10-26-project-mcp-design.md`

## Global Constraints

- TypeScript 5.9 strict (NodeNext); no `@ts-ignore`, no reason-less `@ts-expect-error`, no `as any`.
- No BOM in source, test or documentation files.
- Every new behaviour test is written first and seen RED before the implementation.
- `npm run lint`, `npm run typecheck` and `npm test` must pass at the end; Windows platform skips are allowed.
- No new `src/*.ts` module: keep the new helpers in `src/mcp.ts` and `src/hooks.ts` so the guarded `28 modules` contract in `tests/docs-contract.test.mjs` stays true.
- Security decisions approved 2026-10-26:
  - A project entry whose name already exists in user config is ignored; the user definition wins.
  - Project config may not set `trust: true`; `loadProjectMcpConfig` rejects it.
  - Project `readOnlyTools` are accepted by the schema but never copied into the effective server; only user config grants approval exemptions.
  - Untrusted project-only servers stay in the merged config with `disabled: true` so they remain visible.
  - A corrupt project MCP file is reported; project servers are skipped and user servers still start.
  - With no `.vyen/mcp.json`, the trust hash is unchanged from the pre-feature hash, so existing workspace trust records remain valid.

## Review Focus

1. A repository that contains only `.vyen/mcp.json` cannot start a project server without explicit workspace trust; user MCP servers still start.
2. A project entry with the same name as a user server cannot change the user command, URL, credentials or approval fields.
3. A project server cannot auto-approve tools through `trust: true` or `readOnlyTools`; tool calls still ask for approval.
4. Untrusted project servers are visible as disabled with `source: "project"`; a corrupt project file is reported without hiding or disabling user servers.
5. The trust hash changes when `.vyen/mcp.json` or a referenced local script changes, tolerates corrupt JSON, and preserves existing trust when the file is absent.
6. `mcp add/remove --scope=project` write and remove only `.vyen/mcp.json`; `mcp list/get` report `source` and trust state.
7. The TUI `/mcp list` output marks `[user]` / `[project]` and `untrusted` state.
8. Project MCP config errors are actionable and never silently swallowed.

## Scenarios & Tests

**What the user sees:** `vyen mcp list` shows project servers tagged `[project]`, disabled until `--trust-workspace` is used. A project entry that reuses a user server name is ignored with a note. Project tools still require approval even when the repo asks for read-only or trust. A broken `.vyen/mcp.json` prints a warning while the user's own MCP servers keep working. `vyen mcp add --scope=project` writes only the project file.

| # | Criterion | Test |
|---|---|---|
| 1 | No project MCP server starts without workspace trust; user servers still start | tests/mcp.test.mjs › project MCP server does not start without workspace trust and user servers still start |
| 2 | A project entry cannot override a user server with the same name | tests/mcp.test.mjs › loadMergedMcpConfig keeps the user server when a project entry has the same name |
| 3 | Project MCP servers cannot grant trust or read-only approvals | tests/mcp.test.mjs › project MCP servers cannot grant trust or read-only approvals |
| 4 | Untrusted project MCP servers are listed as disabled with project source | tests/mcp.test.mjs › untrusted project MCP servers are listed as disabled with project source |
| 5 | Trust hash covers project MCP config and referenced scripts | tests/hooks.test.mjs › workspace trust hash covers project MCP config and referenced scripts |
| 6 | Project scope commands write/remove only the project config and list reports source | tests/mcp.test.mjs › mcp project scope commands write and remove only the project config and list reports source |
| 7 | TUI list formatter marks user and project servers and untrusted state | tests/mcp.test.mjs › formatMcpList marks user and project servers and untrusted state |
| 8 | Project MCP config errors are reported and do not block user servers | tests/mcp.test.mjs › project MCP config errors are reported and do not prevent user MCP servers from starting |

---

### Task 1: Project MCP storage, merge semantics and list formatter

**Files:**
- Modify: `src/mcp.ts`
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export function projectMcpConfigPath(cwd: string): string;
  export async function loadProjectMcpConfig(cwd: string): Promise<McpConfig>;
  export async function saveProjectMcpConfig(cwd: string, config: McpConfig): Promise<void>;
  export interface MergedMcpConfig extends McpConfig {
    sources: Record<string, 'user' | 'project'>;
    userPath: string;
    projectPath: string;
    projectServers: Record<string, McpServerConfig>;
    projectPresent: boolean;
    untrusted: string[];
    ignoredProject: string[];
  }
  export interface LoadMergedMcpOptions {
    isTrusted?: boolean;
    userConfig?: McpConfig;
    projectConfig?: McpConfig;
  }
  export async function loadMergedMcpConfig(
    cwd: string,
    options?: LoadMergedMcpOptions,
  ): Promise<MergedMcpConfig>;
  export function projectMcpCommandCandidates(
    servers: Record<string, McpServerConfig>,
  ): string[];
  export function formatMcpList(
    config: MergedMcpConfig,
    statuses: McpServerStatus[],
  ): string;
  ```
- `loadProjectMcpConfig` returns `{ servers: {} }` on `ENOENT`, strips a UTF-8 BOM, throws
  `Failed to parse project MCP config at <path>: ...` on JSON errors, throws
  `Invalid project MCP config at <path>: ...` on schema errors, and rejects any server
  whose normalized `trust` is `true`.
- `loadMergedMcpConfig` defaults `isTrusted` to `false`, copies user servers first, records
  `sources`, ignores a project entry when the user already defines that name, and for a
  project-only server sets `disabled: !isTrusted || server.disabled`, `trust: false`,
  `readOnlyTools: []`. `untrusted` lists project-only servers forced disabled by trust;
  `ignoredProject` lists colliding project names.
- `saveProjectMcpConfig` applies the schema and rejects project `trust: true`; it writes
  through `atomicJson` (mode 0600) after creating `<cwd>/.vyen` with mode 0700.

- [ ] **Step 1: Write the failing tests**

Add to `tests/mcp.test.mjs` the four tests named in Review Focus rows 2, 3, 4 and 7.
The key assertions are:

```javascript
// loadProjectMcpConfig
const bom = '\uFEFF' + JSON.stringify({ servers: { proj: { command: process.execPath, args: [fixture, '--stdio'] } } });
await writeFile(projectPath, bom);
assert.equal((await loadProjectMcpConfig(f.cwd)).servers.proj.transport, 'stdio');
await writeFile(projectPath, '{broken');
await assert.rejects(loadProjectMcpConfig(f.cwd), /Failed to parse project MCP config/);
await writeFile(projectPath, JSON.stringify({ servers: { proj: { command: 'node', args: [], source: 'user' } } }));
await assert.rejects(loadProjectMcpConfig(f.cwd), /Invalid project MCP config/);
await writeFile(projectPath, JSON.stringify({ servers: { proj: { command: 'node', args: [], trust: true } } }));
await assert.rejects(loadProjectMcpConfig(f.cwd), /may not set trust/);

// merge
const userConfig = mcpConfigSchema.parse({ servers: { shared: { command: process.execPath, args: ['user.mjs'], readOnlyTools: ['echo'], trust: true } } });
const projectConfig = mcpConfigSchema.parse({ servers: {
  shared: { command: process.execPath, args: ['project.mjs'] },
  projectOnly: { command: process.execPath, args: ['project.mjs'], trust: true, readOnlyTools: ['echo'] },
} });
const untrusted = await loadMergedMcpConfig(f.cwd, { isTrusted: false, userConfig, projectConfig });
assert.equal(untrusted.servers.shared.command, process.execPath);
assert.deepEqual(untrusted.servers.shared.args, ['user.mjs']);
assert.equal(untrusted.sources.shared, 'user');
assert.deepEqual(untrusted.ignoredProject, ['shared']);
assert.equal(untrusted.servers.projectOnly.disabled, true);
assert.equal(untrusted.servers.projectOnly.trust, false);
assert.deepEqual(untrusted.servers.projectOnly.readOnlyTools, []);
assert.deepEqual(untrusted.untrusted, ['projectOnly']);
assert.equal(untrusted.sources.projectOnly, 'project');

// no project approval grant
const registry = new ToolRegistry(f.cwd, async () => { approvals++; return false; });
const merged = await loadMergedMcpConfig(f.cwd, { isTrusted: true, userConfig: mcpConfigSchema.parse({ servers: {} }), projectConfig });
const manager = new McpManager(merged, f.cwd);
await manager.connect(registry);
const result = await registry.execute(call(mcpToolName('projectOnly', 'echo'), { text: 'x' }), signal());
assert.equal(result.denied, true);
assert.equal(approvals, 1);

// formatter
const text = formatMcpList(untrusted, []);
assert.match(text, /projectOnly\s+\[stdio\] \[project\] \(disabled, untrusted\)/);
assert.match(text, /shared\s+\[stdio\] \[user\]/);
assert.match(text, /Ignored project overrides.*shared/);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the helpers in `src/mcp.ts`**

Implement the interfaces above. Reuse `mcpConfigSchema.parse`/`safeParse`, `atomicJson`,
`dirname`, `existsSync`, and the existing `McpServerConfig` type. Keep the public
`McpConfig` shape unchanged so `McpManager` can accept `MergedMcpConfig` structurally.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: PASS, including all pre-existing MCP tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts tests/mcp.test.mjs
git commit -m "feat(mcp): add project MCP config, merge semantics and formatter"
```

### Task 2: Trust hash and trust evaluation for project MCP

**Files:**
- Modify: `src/hooks.ts`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkspaceTrustHashOptions {
    includeProjectMcp?: boolean;
  }
  export async function calculateWorkspaceTrustHash(
    cwd: string,
    commandCandidates: string[],
    options?: WorkspaceTrustHashOptions,
  ): Promise<string>;

  export interface WorkspaceTrustOptions {
    userPermissions?: PermissionRules;
    projectMcpServers?: Record<string, McpServerConfig>;
    projectMcpError?: boolean;
    includeProjectMcp?: boolean;
    trustWorkspace?: boolean;
  }
  export interface WorkspaceTrustState {
    layered: LayeredSettings;
    isTrusted: boolean;
    trustRequired: boolean;
    hash: string;
    reasons: string[];
  }
  export async function evaluateWorkspaceTrust(
    cwd: string,
    options?: WorkspaceTrustOptions,
  ): Promise<WorkspaceTrustState>;
  ```
- Hash order: settings token/bytes, then `mcp:` + raw file bytes when the file exists,
  then script candidates. When the file is absent, append nothing (do **not** append
  `mcp:none`); when it is unreadable for a reason other than `ENOENT`, append
  `mcp:unreadable`.
- `evaluateWorkspaceTrust` loads layered settings once, builds candidates from hook
  commands, project `permissions.allow` and `projectMcpCommandCandidates`, checks the
  stored hash, and records it only when `trustWorkspace` is true. `trustRequired` is
  true when project hooks, project allow rules, project MCP servers, or a project MCP
  error are present. `reasons` uses the existing warning wording plus
  ``${n} project MCP server(s)``.

- [ ] **Step 1: Write the failing test**

Add `tests/hooks.test.mjs › workspace trust hash covers project MCP config and referenced scripts`.
Assertions:

```javascript
const emptyHash = await calculateWorkspaceTrustHash(dir, []);
const expected = createHash('sha256').update('settings:none').digest('hex');
assert.equal(emptyHash, expected, 'absent mcp.json must not change the legacy hash');

await writeFile(join(dir, '.vyen', 'mcp.json'), JSON.stringify({ servers: { proj: { command: 'node', args: ['./server.mjs'] } } }));
const withMcp = await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']);
assert.notEqual(withMcp, emptyHash);
await writeFile(join(dir, '.vyen', 'mcp.json'), JSON.stringify({ servers: { proj: { command: 'node', args: ['./other.mjs'] } } }));
assert.notEqual(await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']), withMcp);

await writeFile(join(dir, 'server.mjs'), 'console.log(1)');
const before = await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']);
await writeFile(join(dir, 'server.mjs'), 'console.log(2)');
assert.notEqual(await calculateWorkspaceTrustHash(dir, ['node ./server.mjs']), before);

await writeFile(join(dir, '.vyen', 'mcp.json'), '{broken');
await assert.doesNotReject(calculateWorkspaceTrustHash(dir, []));
```

Also cover `evaluateWorkspaceTrust`: with a project MCP server and no trust record it
returns `isTrusted === false` and a reason containing `project MCP server`; with
`trustWorkspace: true` it records and returns `isTrusted === true`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/hooks.test.mjs`
Expected: FAIL because the new option/helper do not exist, or because the hash changes when `mcp.json` is absent.

- [ ] **Step 3: Implement the hash extension and helper**

Import `projectMcpConfigPath` and `projectMcpCommandCandidates` from `./mcp.js`, and
`loadLayeredSettings`/`LayeredSettings`/`PermissionRules` from `./settings.js`.
Keep the existing tokenisation for hook/allow candidates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/hooks.test.mjs`
Expected: PASS, including every existing trust test.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts tests/hooks.test.mjs
git commit -m "feat(hooks): cover project MCP in workspace trust"
```

### Task 3: Wire merged project MCP into the harness

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- Consumes: `evaluateWorkspaceTrust`, `loadProjectMcpConfig`, `loadMergedMcpConfig`,
  `projectMcpConfigPath`, `MergedMcpConfig`.
- Produces: `buildHarness` passes a `MergedMcpConfig` to `McpManager`; keeps
  `mergedMcp`, `mcpProjectError`, `mcpTrusted` and `mcpFingerprint` in the interactive
  scope for `/mcp list` and reuse decisions.
- Reuse condition becomes: no `--no-mcp`, same cwd, not an explicit reconnect, same trust
  state, same merged-config fingerprint, and no project config error. A trust revocation
  or project config edit therefore restarts the servers.

- [ ] **Step 1: Write the failing tests**

Add `tests/mcp.test.mjs › project MCP server does not start without workspace trust and user servers still start`
and `tests/mcp.test.mjs › project MCP config errors are reported and do not prevent user MCP servers from starting`.

Test shape:

```javascript
// User server in f.config/vyen/mcp.json, project server in f.cwd/.vyen/mcp.json.
const p = await provider(t, (body, res) => {
  assert(body.tools.some(t => t.function.name === mcpToolName('user', 'echo')));
  assert(!body.tools.some(t => t.function.name === mcpToolName('project', 'echo')));
  sse(res, { text: 'Done.' });
});
const result = await cli(f, p.url, ['-p', 'hello']).done;
assert.equal(result.code, 0, result.stderr);
assert.match(result.stderr, /project MCP server.*not trusted|project MCP server.*disabled/);
```

For the error test, write `{broken` to `.vyen/mcp.json`, keep the user server, and assert
the user tool is present, the project tool absent, and stderr contains
`MCP warning: could not load project MCP config`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: FAIL because project MCP is ignored and `buildHarness` still calls `loadMcpConfig()`.

- [ ] **Step 3: Implement the wiring**

Replace the inline `hasProjectHooks`/`hasProjectAllow` trust block with
`evaluateWorkspaceTrust`. Load user and project MCP configs once, catch project parse
errors, warn, and pass `projectConfig: { servers: {} }` to `loadMergedMcpConfig` on error.
Keep `--no-mcp` behaviour: it skips project MCP loading and excludes the project MCP file
from the trust hash. Add the new warning reason to the existing warning line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/mcp.test.mjs
git commit -m "feat(cli): load trusted project MCP servers in the harness"
```

### Task 4: Project-scoped CLI commands and TUI list/remove

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- `mcp list` JSON adds `userPath`, `projectPath`, `path` (alias of `userPath`), `trusted`,
  `trustRequired`, optional `projectError`, per-server `source`, optional `untrusted`, and
  `ignoredProject`.
- `mcp get <name>` adds `source` and optional `untrusted`.
- `mcp add/remove` accept `--scope=user|project` and `--project`; default is `user`.
  `mcp add --scope=project --trust` fails with an actionable error.
- `mcp check [name]` evaluates merged trust; an explicitly requested untrusted project
  server fails with a message naming `--trust-workspace`.
- TUI `/mcp list` uses `formatMcpList`; `/mcp remove <name> [--project]` removes from the
  selected scope and rebuilds the harness.

- [ ] **Step 1: Write the failing tests**

Add `tests/mcp.test.mjs › mcp project scope commands write and remove only the project config and list reports source`.
Use the `cli()` helper with `mcp add`, `mcp list`, `mcp get`, `mcp remove`, `--scope=project`
and `--project`; assert `.vyen/mcp.json` exists, the user config is unchanged, `list` JSON
contains `source: "project"`, and `get` names the source. Add `--trust` to a project add and
assert exit code 1 and the error text.

The TUI formatter is already covered by Task 1; add one assertion that a project server
with `untrusted` renders the exact `[project] (disabled, untrusted)` badge.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: FAIL because the subcommands only read user config and the flags are unknown.

- [ ] **Step 3: Implement the subcommand and TUI wiring**

Add `scope`/`project` to the early `mcp add` parser (plus `cwd`/`base-url`/`model` so the
test helper's global flags do not become command tokens) and to the main parser. Share a
`loadMcpView(cwd)` helper inside `main` for list/get/check. Keep the user path as the
default for backward compatibility. `mcp list` prints JSON and sets exit code 1 when
`projectError` is present; `get`/`check` throw that error.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/mcp.test.mjs
git commit -m "feat(cli): scope MCP commands to user or project config"
```

### Task 5: Docs, help, exports and final gate

**Files:**
- Modify: `src/index.ts`, `src/help.ts`, `README.md`, `docs/MCP.md`, `docs/SPEC.md`,
  `docs/ROADMAP.md`, `CHANGELOG.md`
- Test: `tests/docs-contract.test.mjs`

**Interfaces:**
- Export `projectMcpConfigPath`, `loadProjectMcpConfig`, `saveProjectMcpConfig`,
  `loadMergedMcpConfig`, `projectMcpCommandCandidates`, `formatMcpList`, and
  `MergedMcpConfig` from `src/index.ts`.
- Help documents `--scope=user|project`, `--project`, and the extended
  `--trust-workspace` meaning.
- Docs state that project servers are disabled until trust, that user server definitions
  win, that project tools still require approval, and that trusting a workspace permits
  repository-defined commands to run.

- [ ] **Step 1: Write the failing docs contract**

Add `tests/docs-contract.test.mjs › docs contract covers project MCP trust and scope`.
Assert `docs/MCP.md` contains `.vyen/mcp.json`, `--trust-workspace`, `--scope=project`;
`docs/SPEC.md` mentions project MCP trust; `README.md` mentions `.vyen/mcp.json`;
`src/help.ts` mentions `--scope`; `docs/ROADMAP.md` marks `R1.3` completed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/docs-contract.test.mjs`
Expected: FAIL on the missing project MCP documentation.

- [ ] **Step 3: Update the documentation and exports**

Update the stale `docs/MCP.md` limits at the same time (64 servers, 1024 tools default /
2048 hard cap, 32 continuation pages, 32 MiB buffer, as implemented in `src/mcp.ts`).
Do not change the historical validation record in `docs/VALIDATION.md`.

- [ ] **Step 4: Run the full gate**

Run:
```bash
npm run lint
npm run typecheck
npm test
```
Expected: lint has no errors; typecheck exits 0; `npm test` exits 0 with 0 failures
(Windows platform skips allowed).

- [ ] **Step 5: Move this plan to its final name**

```bash
git mv docs/superpowers/plans/draft-2026-10-26-project-mcp.md docs/superpowers/plans/2026-10-26-project-mcp.md
```

Only do this after every test title in this plan exists; `tests/plan-traceability.test.mjs`
checks the table against real `test(...)` titles.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/help.ts README.md docs/MCP.md docs/SPEC.md docs/ROADMAP.md CHANGELOG.md tests/docs-contract.test.mjs
git commit -m "docs(mcp): document project scope and workspace trust"
```
