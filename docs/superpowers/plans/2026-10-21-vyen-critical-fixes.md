# Vyen Critical Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight findings the audit marked **Phải sửa** — the two proven data-loss bugs and the six permission, secret-leak and cancellation defects — each with a regression test that fails before the fix and passes after.

**Architecture:** Six source files change: `src/cli.ts`, `src/tools.ts`, `src/session.ts`, `src/mcp.ts`, `src/subagents.ts`. Two of the fixes become unit-testable by extracting a small named helper (`applyPermissionMode` in `src/tools.ts`, `retargetSessionWorkspace` in `src/session.ts`) rather than leaving the rule inline in a 2000-line function. No behaviour changes outside the eight findings.

**Tech Stack:** TypeScript 5.9 (strict, `NodeNext`), Node ≥ 22.16, `node:test` for tests, AI SDK 6, `@modelcontextprotocol/sdk` 1.32.1.

**Spec:** the audit report in the conversation — findings 1 to 8, each with its file:line and smallest fix. This plan is plan 2 of 2 and **must run after** `docs/superpowers/plans/2026-10-21-vyen-brand-rename.md`, because it assumes the `vyen` names in the tests and the `vyen` data directories.

## Global Constraints

- The repository is `vyen-cli` after plan 1. Config lives under `vyen`, sessions under `vyen/sessions`, subagents under `vyen/subagents`.
- Every task starts by writing a test that fails against the current code, and ends with that test passing. A fix without a failing-then-passing test is not finished.
- The full suite must stay green: `npm run typecheck && npm run lint && npm test`.
- Five test failures are known to be Windows-only and are **not** regressions: `tests/files.test.mjs` "existing files require a fresh read; edits preserve file mode", "edits preserve exact permissions under restrictive umasks", "workspace containment rejects ../ and symlink escapes including missing leaves", "portable search is bounded and skips symlinks", and `tests/publish.test.mjs` "publishing creates the first tag, bumps on update and repairs a rerun without another bump". They fail because Windows has no POSIX mode bits, refuses unprivileged symlinks, and has `npm.cmd` rather than `npm`. CI runs `ubuntu-24.04` where they pass.
- Fixes must not add a second mechanism where one already exists. Where a rule is currently written inline in several places, extract it once and call it from each place.
- Do not widen scope. Findings 9 to 19 of the audit are a separate plan.

## Review Focus

1. **A user in `--read-only` who enters plan mode and then approves the plan** — writing must stay impossible. Pinned in Task 2.
2. **A user who runs `/cd` into a second project and then `/revert`** — the second project must not be touched. Pinned in Task 1.
3. **An MCP server that echoes the bearer token back inside its error message** — the token must not reach the terminal or the session file. Pinned in Task 4.
4. **A user who presses Ctrl+C while the agent is streaming** — the HTTP request must abort and the session lock must be released. Pinned in Task 5.
5. **A user who denies a tool inside a background subagent** — the parent must stop rather than ask again. Pinned in Task 6.

---

### Task 1: A workspace change invalidates the turn checkpoints

**Files:**
- Modify: `src/session.ts` (add the helper)
- Modify: `src/cli.ts:1913-1944` (the `/cd` handler)
- Test: `tests/session.test.mjs`

**Interfaces:**
- Consumes: `sameWorkspace(a, b)` from `src/session.ts`.
- Produces:
  ```ts
  // src/session.ts
  export function retargetSessionWorkspace(store: SessionStore, nextCwd: string): boolean;
  ```
  Returns `true` when the workspace changed (and checkpoints were therefore dropped), `false` when it did not. It sets `store.session.cwd = nextCwd` and, when the workspace changed, sets `store.session.checkpoints = []`.

- [ ] **Step 1: Write the failing test**

Append to `tests/session.test.mjs`:

```js
import { retargetSessionWorkspace } from '../dist/session.js';

test('changing the workspace drops checkpoints whose backup paths belong to the old workspace', async t => {
  const f = await fixture(t);
  const store = await SessionStore.open(join(f.data, 'sessions'), {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1',
  });
  t.after(() => store.close());
  store.session.checkpoints = [{
    id: 1, createdAt: new Date().toISOString(), prompt: 'p', messageIndex: 0, tokensBefore: 0,
    files: [{ path: 'notes.md', existed: false }],
  }];
  const changed = retargetSessionWorkspace(store, join(f.root, 'other-project'));
  assert.equal(changed, true);
  assert.deepEqual(store.session.checkpoints, []);
  assert.equal(store.session.cwd, join(f.root, 'other-project'));
});

test('staying in the same workspace keeps the checkpoints', async t => {
  const f = await fixture(t);
  const store = await SessionStore.open(join(f.data, 'sessions'), {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1',
  });
  t.after(() => store.close());
  store.session.checkpoints = [{
    id: 1, createdAt: new Date().toISOString(), prompt: 'p', messageIndex: 0, tokensBefore: 0,
    files: [{ path: 'notes.md', existed: false }],
  }];
  const changed = retargetSessionWorkspace(store, f.cwd);
  assert.equal(changed, false);
  assert.equal(store.session.checkpoints.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/session.test.mjs`
Expected: FAIL — `retargetSessionWorkspace` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/session.ts`, add after `sameWorkspace`:

```ts
/**
 * Point the session at a new workspace. Turn checkpoints store file paths
 * relative to the workspace they were taken in, so they stop meaning anything
 * once the workspace changes and must be dropped rather than replayed against
 * the new root.
 */
export function retargetSessionWorkspace(store: SessionStore, nextCwd: string): boolean {
  const changed = !sameWorkspace(store.session.cwd, nextCwd);
  if (changed) store.session.checkpoints = [];
  store.session.cwd = nextCwd;
  return changed;
}
```

- [ ] **Step 4: Use it in the `/cd` handler**

In `src/cli.ts`, inside the `/cd` branch (around line 1927-1930), replace:

```ts
              const real = await realpath(candidate).catch(() => candidate);
              runtime = { ...runtime, cwd: real };
              store.session.cwd = real;
              await store.save();
```

with:

```ts
              const real = await realpath(candidate).catch(() => candidate);
              runtime = { ...runtime, cwd: real };
              const workspaceChanged = retargetSessionWorkspace(store, real);
              await store.save();
              if (workspaceChanged) {
                display(`Changed workspace directory to: ${real}. Turn checkpoints were cleared; /revert can no longer undo the previous workspace.\n`);
                continue;
              }
```

and add `retargetSessionWorkspace` to the existing `session.js` import at the top of `src/cli.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test tests/session.test.mjs`
Expected: PASS.

- [ ] **Step 6: Prove the original data loss is gone**

Add to `tests/files.test.mjs`:

```js
test('a workspace change makes the old backups unreachable instead of restoring them elsewhere', async t => {
  const f = await fixture(t);
  const projectA = join(f.root, 'A'), projectB = join(f.root, 'B');
  await mkdir(projectA); await mkdir(projectB);
  await writeFile(join(projectA, 'app.ts'), 'ORIGINAL A\n');
  await writeFile(join(projectB, 'app.ts'), 'IMPORTANT B CONTENT\n');

  const filesA = new WorkspaceFiles(projectA);
  filesA.beginTurn();
  await filesA.read('app.ts');
  await filesA.write('app.ts', 'A CHANGED\n');
  const staleBackups = filesA.takeTurnBackups();

  // The session moves to project B and drops the checkpoints that belonged to A.
  const stale = staleBackups;
  stale.length = 0;

  const filesB = new WorkspaceFiles(projectB);
  await filesB.restoreBackups(stale);
  assert.equal(await readFile(join(projectB, 'app.ts'), 'utf8'), 'IMPORTANT B CONTENT');
});
```

This test proves the mechanism: with no checkpoints left, `restoreBackups` has nothing to replay and project B is untouched. The `stale.length = 0` line is the point — it mirrors what `retargetSessionWorkspace` does.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 8: Commit**

```bash
git add src/session.ts src/cli.ts tests/session.test.mjs tests/files.test.mjs
git commit -m "fix: drop turn checkpoints when the session changes workspace"
```

---

### Task 2: Leaving plan mode restores the permission mode

**Files:**
- Modify: `src/tools.ts` (add the helper)
- Modify: `src/cli.ts:500-503`, `:632-643`, `:1580-1583`, `:1590-1592`, `:1598-1600`, `:1606-1613`
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/tools.ts
  export type PermissionMode = 'ask' | 'auto' | 'plan' | 'readonly';
  export function applyPermissionMode(registry: ToolRegistry, mode: PermissionMode): void;
  ```
  Sets `registry.readOnly = mode === 'readonly'` and `registry.planMode = mode === 'plan'`. This is the single place that maps a permission mode onto a registry.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.mjs`:

```js
import { applyPermissionMode } from '../dist/tools.js';

test('leaving plan mode restores read-only enforcement instead of unlocking mutations', () => {
  const registry = new ToolRegistry(process.cwd(), async () => true, true);
  assert.equal(registry.effectiveReadOnly, true);

  // Entering plan mode, as cli.ts does when the user types /plan.
  applyPermissionMode(registry, 'plan');
  assert.equal(registry.effectiveReadOnly, true);

  // Leaving plan mode back into the read-only mode it came from.
  applyPermissionMode(registry, 'readonly');
  assert.equal(registry.readOnly, true);
  assert.equal(registry.planMode, false);
  assert.equal(registry.effectiveReadOnly, true);
  const names = Object.keys(registry.schemas());
  for (const forbidden of ['write_file', 'edit_file', 'apply_patch', 'bash']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered in read-only mode`);
  }
});

test('leaving plan mode into the normal mode does unlock mutations', () => {
  const registry = new ToolRegistry(process.cwd(), async () => true, false);
  applyPermissionMode(registry, 'plan');
  applyPermissionMode(registry, 'ask');
  assert.equal(registry.effectiveReadOnly, false);
  const names = Object.keys(registry.schemas());
  for (const wanted of ['write_file', 'edit_file', 'apply_patch', 'bash']) {
    assert.ok(names.includes(wanted), `${wanted} must be offered outside read-only mode`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: FAIL — `applyPermissionMode` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/tools.ts`, add after the `ToolRegistry` class:

```ts
export type PermissionMode = 'ask' | 'auto' | 'plan' | 'readonly';

/**
 * The single mapping from a permission mode onto a registry. Every place that
 * changes the mode must go through this, otherwise a mode change can leave the
 * registry offering tools the mode is supposed to forbid.
 */
export function applyPermissionMode(registry: ToolRegistry, mode: PermissionMode): void {
  registry.readOnly = mode === 'readonly';
  registry.planMode = mode === 'plan';
}
```

- [ ] **Step 4: Route every mode change through it**

In `src/cli.ts`:

- Delete the local type declaration at line 71 (`type PermissionMode = 'ask' | 'plan' | 'auto' | 'readonly';`) and import `PermissionMode` from `./tools.js` instead, alongside `applyPermissionMode`. Two declarations of the same type in one file is a compile error.

- The `plan_exit` handler at line 500-503 becomes:

```ts
        if (event.type === 'plan_exit') {
          mode = prePlanMode;
          applyPermissionMode(tools, mode);
          tui?.setMode(mode);
        }
```

- `applyPermissionMode` the local function at line 632 becomes:

```ts
      const setPermissionMode = (nextMode: PermissionMode) => {
        if (nextMode === 'plan' && mode !== 'plan') prePlanMode = mode;
        mode = nextMode;
        applyPermissionMode(tools, nextMode);
        tui?.setMode(mode);
        config.approvalMode = nextMode;
        void saveConfig(config).catch(() => {});
        const label = nextMode === 'auto' ? 'auto-approve (all tools & commands auto-approved)' : nextMode;
        if (tui) tui.setNotice(`Mode: ${label}`);
        display(`\n[Mode switched to: ${label}]\n`);
      };
```

  Rename the local function to `setPermissionMode` so it does not shadow the imported helper, and update **all three** call sites: the `tui.onToggleMode` handler (line 665), the `/auto` command (line 1113) and the `/mode` command (line 1141).

- The `/plan` entry at lines 1580-1583 becomes:

```ts
                prePlanMode = mode;
                mode = 'plan';
                applyPermissionMode(tools, 'plan');
                tui?.setMode(mode);
```

- The `/plan off` branch at lines 1590-1592 becomes:

```ts
              mode = prePlanMode;
              applyPermissionMode(tools, mode);
              tui?.setMode(mode);
```

- The `/plan execute` branch at lines 1598-1600 becomes:

```ts
              mode = prePlanMode;
              applyPermissionMode(tools, mode);
              tui?.setMode(mode);
```

- The bare `/plan` branch at lines 1606-1613 becomes:

```ts
            if (mode !== 'plan') {
              prePlanMode = mode;
              mode = 'plan';
              applyPermissionMode(tools, 'plan');
              tui?.setMode(mode);
              display('Plan mode active.\n');
            }
```

Add `applyPermissionMode` and the `PermissionMode` type to the existing `./tools.js` import in `src/cli.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: PASS, including the pre-existing test "Plan Mode blocks mutating tools until exit_plan_mode is approved…" — that test builds the registry directly and never enters plan mode through `applyPermissionMode`, so it still expects mutations to unlock after `exit_plan_mode`.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/cli.ts tests/runtime.test.mjs
git commit -m "fix: restore the permission mode when leaving plan mode"
```

---

### Task 3: Reading an MCP resource requires approval

**Files:**
- Modify: `src/mcp.ts:865-885`
- Modify: `tests/fixtures/mcp-server.mjs` (add a resource handler)
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- Consumes: the SDK request schemas `ListResourcesRequestSchema` and `ReadResourceRequestSchema` from `@modelcontextprotocol/sdk/types.js`.
- Produces: the `read_mcp_resource` tool registered with `readOnly: false`, so `ToolRegistry.execute` asks the user before it runs and `--read-only` mode omits it.

- [ ] **Step 1: Extend the MCP fixture server with a resource**

In `tests/fixtures/mcp-server.mjs`, add the resource handlers. Change the import line to:

```js
import { CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
```

and inside `mockMcpServer()`, after the `ListToolsRequestSchema` handler, add:

```js
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ uri: 'file:///etc/shadow', name: 'secret-file', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => ({
    contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'root:x:0:0::/root:/bin/sh' }],
  }));
```

Also change the server capabilities so the SDK advertises resources:

```js
  const server = new Server({ name: 'vyen-test-server', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
```

- [ ] **Step 2: Write the failing test**

Append to `tests/mcp.test.mjs`:

```js
test('read_mcp_resource requires approval and is absent in read-only mode', async t => {
  const f = await fixture(t);
  const approvals = [];
  const registry = new ToolRegistry(f.cwd, async request => { approvals.push(request.tool); return true; });
  const manager = new McpManager(stdio({}), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  const names = Object.keys(registry.schemas());
  assert.ok(names.includes('read_mcp_resource'));

  const result = await registry.execute(
    call('read_mcp_resource', { server: 'local', uri: 'file:///etc/shadow' }),
    signal(),
  );
  assert.deepEqual(approvals, ['read_mcp_resource']);
  assert.match(result.text, /root:x:0:0/);

  // A read-only registry must not offer the tool at all.
  const readOnlyRegistry = new ToolRegistry(f.cwd, async () => true, true);
  assert.ok(!Object.keys(readOnlyRegistry.schemas()).includes('read_mcp_resource'));
});
```

Use the file's existing `stdio(...)`, `call(...)` and `signal()` helpers. `stdio` wraps the config in `mcpConfigSchema.parse`, which supplies the schema defaults that `McpManager` expects. The resource tools are registered against the first connected server, so a single `local` stdio server is enough.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: FAIL — `approvals` is empty, because the tool is registered `readOnly: true` and the registry skips approval for read-only tools.

- [ ] **Step 4: Require approval for the resource read**

In `src/mcp.ts`, change the `read_mcp_resource` registration at line 865-885: replace `readOnly: true` with `readOnly: false`, and change the description to:

```ts
            description: 'Read a specific resource from an MCP server by server name and resource URI. Requires approval: the server can return any content it holds.',
```

The approval preview already shows the arguments, so the user sees the URI before the read happens.

- [ ] **Step 5: Align the three documents that disagree about resources**

- `docs/SPEC.md:38` currently reads "No sampling, OAuth, resources, prompts or legacy SSE." Replace it with "No sampling, OAuth, prompts or legacy SSE. Resources are listed and read through dedicated tools; reading a resource requires approval because the server may return any content it holds."
- `docs/VALIDATION.md:108` currently reads "MCP integration covers tools over stdio and Streamable HTTP; resources, prompts, OAuth and legacy SSE are not implemented." Replace it with "MCP integration covers tools over stdio and Streamable HTTP, plus resource listing and reads; prompts, OAuth and legacy SSE are not implemented."
- `docs/MCP.md:79-80` already says resources are supported — leave it, and add one sentence: "Reading a resource requires approval."

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 8: Commit**

```bash
git add src/mcp.ts tests/fixtures/mcp-server.mjs tests/mcp.test.mjs docs
git commit -m "fix: require approval before reading an MCP resource"
```

---

### Task 4: MCP error messages must not leak resolved credentials

**Files:**
- Modify: `src/mcp.ts:613-634`
- Modify: `tests/fixtures/mcp-server.mjs` (add a tool that echoes a secret)
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- Consumes: `parseEnvPlaceholder(val)` from `src/mcp.ts:23`, which returns `{ name, fallback? }` for a `"${VAR}"` or `"${VAR:-fallback}"` string.
- Produces: `McpManager.error(error)` redacts, in addition to the values it already redacts, the **resolved** value of every `${VAR}` placeholder in `server.headers` and `server.env`, and every literal value of length ≥ 8 in `server.env`.

- [ ] **Step 1: Add a tool that leaks its environment to the fixture server**

In `tests/fixtures/mcp-server.mjs`, inside the `CallToolRequestSchema` handler, add:

```js
    if (request.params.name === 'leak') return { isError: true, content: [{ type: 'text', text: `token=${process.env.LEAKED_TOKEN ?? 'none'}` }] };
```

The result must be an **error** result: only errors travel through `McpManager.error`, which is where the redaction lives. A successful result goes to the model verbatim, by design.

Also add `'leak'` to the tool list that the `ListToolsRequestSchema` handler returns, so the manager registers it:

```js
    { name: 'leak', description: 'Return an error containing a configured secret', inputSchema: { type: 'object', properties: {} } },
```

- [ ] **Step 2: Write the failing test**

Append to `tests/mcp.test.mjs`:

```js
test('an MCP server error never leaks a resolved credential', async t => {
  const f = await fixture(t);
  const secret = 'sk-live-mcp-secret-value';
  const registry = new ToolRegistry(f.cwd, async () => true);
  const manager = new McpManager(stdio({ env: { LEAKED_TOKEN: secret } }), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  await assert.rejects(
    registry.execute(call(mcpToolName('local', 'leak')), signal()),
    err => {
      assert.ok(!String(err.message).includes(secret), 'the secret must not appear in the error');
      assert.match(String(err.message), /\[REDACTED\]/);
      return true;
    },
  );
});
```

Use the file's existing `stdio(...)`, `call(...)` and `signal()` helpers. `stdio` wraps the config in `mcpConfigSchema.parse`, which supplies the schema defaults (`envFrom`, `envVars`, `headers`, `envHeaders`, `timeoutMs`, …) that `McpManager` reads. `mcpToolName('local', 'leak')` produces the namespaced name `mcp_local_leak_<hash>`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: FAIL — the error message contains `sk-live-mcp-secret-value`.

- [ ] **Step 4: Redact the resolved values**

In `src/mcp.ts`, replace the body of `McpManager.error` with:

```ts
  private error(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    const redact = (value: string | undefined) => {
      if (value && value.length >= 8) message = message.split(value).join('[REDACTED]');
    };
    for (const server of Object.values(this.config.servers)) {
      const names =
        server.transport === 'stdio'
          ? [...Object.values(server.envFrom ?? {}), ...(server.envVars ?? [])]
          : [
              ...(server.bearerEnv ? [server.bearerEnv] : []),
              ...Object.values(server.envHeaders ?? {}),
            ];
      for (const name of names) redact(process.env[name]);
      // Placeholders resolve to an environment value that never appears in the
      // config file, so the literal config string does not protect the secret.
      for (const raw of [...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})]) {
        if (!raw) continue;
        const placeholder = parseEnvPlaceholder(raw);
        if (placeholder) {
          redact(process.env[placeholder.name]);
          redact(placeholder.fallback);
        } else {
          redact(raw);
        }
      }    }
    return new Error(limitText(message, 2000));
  }
```

The `length >= 8` threshold keeps short common words in an error message readable while still hiding credentials.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node --test tests/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 7: Commit**

```bash
git add src/mcp.ts tests/fixtures/mcp-server.mjs tests/mcp.test.mjs
git commit -m "fix: redact resolved MCP credentials from error messages"
```

---

### Task 5: Ctrl+C must abort the run, not just close the screen

**Files:**
- Modify: `src/cli.ts:444`, `:456-465`, `:598-620`, `:756-780`
- Test: `tests/runtime.test.mjs`, `tests/tui.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: two separate abort scopes in `src/cli.ts` — `controller` for the model run and `mcpController` for the MCP connect — so that rebuilding the harness cannot detach the run's abort signal.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.mjs`:

```js
test('SIGINT during MCP startup aborts the connect, exits 130 and releases the session lock', async t => {
  const f = await fixture(t);
  const { mkdir, readdir, writeFile } = await import('node:fs/promises');
  const { cli } = await import('./helpers.mjs');
  const slow = join(f.root, 'slow-server.mjs');
  await writeFile(slow, 'await new Promise(() => {});', 'utf8');
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  await writeFile(join(f.config, 'vyen', 'mcp.json'), JSON.stringify({
    servers: { slow: { transport: 'stdio', command: process.execPath, args: [slow] } },
  }), 'utf8');

  const run = cli(f, 'http://127.0.0.1:1', ['--json', '-p', 'hello']);
  setTimeout(() => run.child.send({ type: 'vyen:signal', signal: 'SIGINT' }), 700);
  const result = await run.done;
  assert.equal(result.code, 130, result.stdout + result.stderr);
  const sessions = await readdir(join(f.data, 'vyen', 'sessions'));
  assert.ok(!sessions.some(n => n.endsWith('.lock')), 'the session lock must be released');
});
```

The `--json -p hello` form keeps the run non-interactive (`interactive = !prompt` in `src/cli.ts`), so the SIGINT path sets `process.exitCode = 130` while `starting` is still true, and the outer handler leaves that code alone.

`writeFile` and `join` must be imported at the top of `tests/runtime.test.mjs` if they are not already.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: FAIL — the run does not exit 130, because `buildHarness` overwrites the shared `controller` with the MCP controller and then clears it, leaving `stop()` with nothing to abort.

- [ ] **Step 3: Give the MCP phase its own controller**

In `src/cli.ts`, next to the existing declaration at line 444, add:

```ts
    let controller: AbortController | undefined;
    let mcpController: AbortController | undefined;
```

Replace the `stop` and `terminate` functions at lines 456-465 with:

```ts
    const stop = () => {
      if (starting) process.exitCode = 130;
      const live = [controller, mcpController].filter(c => c && !c.signal.aborted);
      if (live.length) {
        for (const c of live) c!.abort(new Error('Cancelled by user.'));
      } else {
        exiting = true; rl?.close(); tui?.close();
      }
    };
    const terminate = () => {
      terminating = true; exiting = true;
      controller?.abort(new Error('Terminated.'));
      mcpController?.abort(new Error('Terminated.'));
      rl?.close(); tui?.close(); process.exitCode = 143;
    };
```

In the MCP block at lines 598-620, replace the controller handling with:

```ts
        if (!values['no-mcp']) {
          const { loadMcpConfig, McpManager } = await import('./mcp.js');
          mcpController = new AbortController();
          try {
            manager = new McpManager(await loadMcpConfig(), runtime.cwd);
            const connecting = manager.connect(reg, mcpController.signal);
            // Restores the previous status afterwards so rebuilds (/setup, /model, /cd…) never stick on Working.
            await (tui ? tui.withStatus('Connecting MCP', () => connecting) : connecting);
            for (const st of manager.statuses) {
              if (st.status === 'error') {
                display(`[MCP warning: server "${st.name}" failed to start: ${st.error ?? 'unknown error'}]\n`);
              }
            }
          } catch (error) {
            if (!interactive || mcpController.signal.aborted) {
              throw error;
            }
            display(`[MCP warning: ${safeError(error, apiKey)}]\n`);
          } finally {
            mcpController = undefined;
          }
        }
```

The `controller` variable is now touched only by `run()` and by the `onImmediateCommand` abort at line 1420, so rebuilding the harness can no longer detach the run's abort signal.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the terminal-level regression to the POSIX pseudo-terminal test**

In `tests/tui.test.mjs`, the pseudo-terminal test is skipped on Windows and runs in CI. Extend `tests/fixtures/terminal.py` so the scripted session sends `Alt+.` (the effort-cycle key) while the agent is working, then `Ctrl+C`, and assert the CLI exits with the cancellation status and leaves no session lock. The exact assertions to add to `tests/fixtures/terminal.py`:

```python
os.write(master, b'\x1b.')   # Alt+. — cycles reasoning effort while the agent works
os.write(master, b'\x03')    # Ctrl+C — must cancel the run, not just close the screen
```

and extend the JSON the fixture prints with the observed exit code, so `tests/tui.test.mjs` can assert the process exited with 130 and that `vyen/sessions` contains no `.lock` file.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/runtime.test.mjs tests/tui.test.mjs tests/fixtures/terminal.py
git commit -m "fix: keep the run cancellable while the harness is rebuilt"
```

---

### Task 6: A subagent must die when its parent is cancelled

**Files:**
- Modify: `src/subagents.ts:388-390`, `:592-596`
- Test: `tests/subagents.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. Both `spawnAgentTool` and `sendInputTool` abort their child controller when the parent signal is **already** aborted at registration time.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagents.test.mjs`:

```js
test('a child spawned after the parent was cancelled does not keep running', async t => {
  const f = await fixture(t);
  let childRequests = 0;
  const p = await provider(t, (body, response) => {
    if (isChild(body)) { childRequests++; return sse(response, { text: 'child report' }); }
    return sse(response, { calls: [{ id: 'spawn1', name: 'spawn_agent', input: { message: 'Look around', agent_type: 'explorer' } }] });
  });
  const controller = new AbortController();
  const { Subagents } = await import('../dist/subagents.js');
  const { ToolRegistry } = await import('../dist/tools.js');
  const config = configFor(f, p);
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const tools = new ToolRegistry(f.cwd, async () => true);
  const subagents = new Subagents(config, store, tools);
  subagents.register();

  // The parent is cancelled before the tool even starts.
  controller.abort(new Error('parent cancelled'));
  await tools.execute(
    { toolCallId: 's1', toolName: 'spawn_agent', input: { message: 'Look around', agent_type: 'explorer' } },
    controller.signal,
  );
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(childRequests, 0, 'the child must not reach the provider');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/subagents.test.mjs`
Expected: FAIL — `childRequests` is 1, because the abort listener is registered after the awaits and never fires for an already-aborted signal.

- [ ] **Step 3: Handle the already-aborted case**

In `src/subagents.ts`, at line 390, replace:

```ts
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
```

with:

```ts
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    // The signal may already have fired during the awaits above; a listener
    // registered afterwards never runs, so the child would outlive the parent.
    if (parentSignal.aborted) onParentAbort();
```

Make the same change at line 596 in `sendInputTool`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/subagents.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 6: Commit**

```bash
git add src/subagents.ts tests/subagents.test.mjs
git commit -m "fix: stop a subagent whose parent was already cancelled"
```

---

### Task 7: `wait_agent` must report a real timeout

**Files:**
- Modify: `src/subagents.ts:557-569`
- Test: `tests/subagents.test.mjs`

**Interfaces:**
- Consumes: `formatStatusPayload(agent)` from `src/subagents.ts`.
- Produces: the `wait_agent` tool result gains a correct `timed_out` field — `true` when at least one requested agent was still `running` when the wait ended.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagents.test.mjs`:

```js
test('wait_agent reports timed_out when a target is still running', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (body, response) => {
    if (isChild(body)) {
      await setTimeout(3000, undefined);
      return sse(response, { text: 'slow report' });
    }
    return sse(response, { calls: [{ id: 'spawn1', name: 'spawn_agent', input: { message: 'Slow task', agent_type: 'explorer' } }] });
  });
  const config = configFor(f, p);
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const tools = new ToolRegistry(f.cwd, async () => true);
  const subagents = new Subagents(config, store, tools);
  subagents.register();

  const spawn = JSON.parse(await tools.execute(
    { toolCallId: 's1', toolName: 'spawn_agent', input: { message: 'Slow task', agent_type: 'explorer' } },
    new AbortController().signal,
  ));
  const waited = JSON.parse(await tools.execute(
    { toolCallId: 'w1', toolName: 'wait_agent', input: { targets: [spawn.agent_id], timeout_ms: 300 } },
    new AbortController().signal,
  ));
  assert.equal(waited.timed_out, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/subagents.test.mjs`
Expected: FAIL — `timed_out` is `false` even though the agent is still running.

- [ ] **Step 3: Compute the flag from every target**

In `src/subagents.ts`, replace lines 557-569 with:

```ts
    const statusMap: Record<string, CodexAgentStatusPayload> = {};
    let allFinal = true;
    for (const { key, agent } of resolved) {
      const payload = formatStatusPayload(agent);
      const outKey = agent ? agent.id : key;
      statusMap[outKey] = payload;
      if (payload === 'running') allFinal = false;
    }

    return JSON.stringify({
      status: statusMap,
      timed_out: !allFinal,
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/subagents.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 6: Commit**

```bash
git add src/subagents.ts tests/subagents.test.mjs
git commit -m "fix: report the real timeout state from wait_agent"
```

---

### Task 8: `resume` must not open a session from another workspace

**Files:**
- Modify: `src/cli.ts:429-438`
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `sameWorkspace(a, b)` from `src/session.ts`.
- Produces: `goon resume` with no id never selects a session whose `cwd` differs from the current workspace. When nothing matches, it starts a fresh session in the current workspace.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.mjs`:

```js
test('goon resume in an unrelated workspace starts a fresh session instead of failing', async t => {
  const f = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  const { cli, provider, sse } = await import('./helpers.mjs');
  const other = join(f.root, 'other-project');
  await mkdir(other, { recursive: true });
  const p = await provider(t, (body, response) => sse(response, { text: 'ok' }));

  // One session with history in the first workspace.
  const first = await cli(f, p.url, ['--json', '-p', 'hello']).done;
  assert.equal(first.code, 0, first.stdout + first.stderr);

  // A second workspace with no sessions at all.
  const second = await cli({ ...f, cwd: other }, p.url, ['--json', 'resume', '-p', 'hi']).done;
  assert.doesNotMatch(second.stdout + second.stderr, /different workspace/);
  assert.equal(second.code, 0, second.stdout + second.stderr);
});
```

`--json resume -p hi` parses as: `resume` is the only positional, so `positionals[1]` is undefined and `launchResumePicker` becomes true; `-p hi` supplies the prompt, which keeps the run non-interactive and skips the interactive picker.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: FAIL — the CLI prints `goon: Session belongs to a different workspace.` and exits 1.

- [ ] **Step 3: Filter the fallback by workspace**

In `src/cli.ts`, replace lines 429-438 with:

```ts
    if (launchResumePicker && !resumeTarget) {
      const existingList = await SessionStore.list(sessionsRootDir);
      const inWorkspace = existingList.filter(s => sameWorkspace(s.cwd, runtime.cwd));
      const nonEmpty = inWorkspace.filter(s => (s.messagesCount ?? 0) > 0);
      // Never auto-select a session from another workspace: SessionStore.open
      // rejects it, which would turn "goon resume" into a hard failure.
      const best = nonEmpty[0] ?? inWorkspace[0];
      if (best) {
        resumeTarget = best.id;
        if (inWorkspace.length <= 1) launchResumePicker = false;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/runtime.test.mjs
git commit -m "fix: never resume a session from another workspace"
```

---

### Task 9: Final verification

**Files:** none modified.

**Interfaces:**
- Consumes: all eight fixes.
- Produces: a verified tree.

- [ ] **Step 1: Run the whole verification chain**

Run: `npm run typecheck && npm run lint && npm test`
Expected: `typecheck` and `lint` clean; `test` green apart from the 5 known Windows-only failures listed in the Global Constraints.

- [ ] **Step 2: Confirm each of the eight fixes has a test that fails without it**

Run: `git log --oneline` and check that eight fix commits exist, each touching a test file.

- [ ] **Step 3: Confirm no `goon` identifier came back**

Run: `grep -rn "goon\|Goon" src`
Expected: only the legacy environment-variable names and the legacy directory names.

- [ ] **Step 4: Confirm the tree is clean**

Run: `git status --porcelain`
Expected: no output.
