# Seam Hardening Phase 3: Seam Integration and Lifecycle Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining execution-seam gaps so Agent Network turns obey the parent tool policy and hook bus, every hook payload identifies its session, and session lifecycle events stay balanced across `/new`, `/resume`, subagents, workflows, and ephemeral network sessions.

**Architecture:**
1. In `src/harness.ts`, track `sessionStarted` / `sessionEnded` / `sessionLifecycle`, so `SessionStart` fires on the first turn even for a resumed store, `SessionEnd` fires at most once and only after a start, and nested runners can opt out of global lifecycle events. Carry `sessionId` in every dispatched payload.
2. In `src/network.ts` and `src/subagents.ts`, thread the parent `ToolRegistry.policy` and `HookBus` into each persona/synthesis harness, and suppress global lifecycle events for ephemeral network sessions.
3. In `src/subagents.ts`, dispatch `SessionEnd` during subagent cleanup for both managed and direct child harnesses.
4. In `src/cli.ts`, end the active session before `/new` and `/resume` swap stores, and suppress lifecycle events for workflow child harnesses.
5. In `docs/SPEC.md`, state the hook payload envelope (`event`, `sessionId`, `timestamp`, `cwd`).

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node.js `node:test`, existing mock SSE provider in `tests/helpers.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-25-seam-hardening-and-security-closure-design.md` (Increment 3)

## Global Constraints

- TypeScript 5.9 strict (NodeNext), 0 `@ts-ignore`, 0 `@ts-expect-error` without reason, 0 `as any`.
- All new behavior gets a test proven RED before the fix.
- No lowering of the gate: the final task runs `npm run typecheck`, `npm run lint`, `npm test`.
- Source and test files stay BOM-free and ASCII.
- Ephemeral nested runners inherit tool hooks but never emit global `SessionStart` / `SessionEnd`.

## Review Focus

1. Every dispatched hook payload carries the active `sessionId`, including `PostToolUse` and `PostToolUseFailure`.
2. A resumed session (store already has messages) emits `SessionStart` on its first turn, and `SessionEnd` at most once and only after a start.
3. Agent Network persona turns enforce the parent tool policy and receive the parent `HookBus`, while emitting no global `SessionStart` / `SessionEnd`.
4. Subagent cleanup dispatches `SessionEnd` exactly once for the child session.
5. `/new`, `/resume`, and nested workflow harnesses end or suppress session lifecycle at the correct seam.

## Scenarios & Tests

**What the user sees:** Project deny rules and `PreToolUse` hooks now apply inside Agent Network runs; a subagent that finishes or crashes closes its session cleanly rather than leaving `SessionStart` without `SessionEnd`; hook scripts can correlate every event to one session id; switching sessions with `/new` or `/resume` no longer duplicates or drops lifecycle events.

| # | Criterion | Test |
|---|---|---|
| 1 | Prompt, tool, stop and compact payloads carry the session id | tests/hooks.test.mjs › hook payloads carry the session id for prompt, tool, stop and compact events |
| 1 | Failure payloads carry the session id for denied and thrown tool calls | tests/hooks.test.mjs › PostToolUseFailure payloads carry the session id for denied and thrown tool calls |
| 2 | Resumed sessions start once and end once | tests/hooks.test.mjs › Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once |
| 3 | Agent Network enforces policy and hooks without global lifecycle | tests/features.test.mjs › Agent Network enforces parent tool policy and hooks without emitting session lifecycle |
| 4 | Subagent cleanup dispatches one SessionEnd for the child | tests/subagents.test.mjs › subagent cleanup dispatches SessionEnd once for the child session |
| 5 | CLI ends sessions before store swaps and scopes workflow lifecycle | tests/features.test.mjs › CLI ends the active session before store swaps and suppresses lifecycle for nested workflow harnesses |

---

### Task 1: Hook Payload Session Id and Balanced Harness Lifecycle

**Files:**
- Modify: `src/harness.ts`
- Modify: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `HookBus.dispatch(event, payload)`, `SessionStore.session.id`
- Produces: `Harness.sessionLifecycle: boolean` (default `true`), idempotent `Harness.endSession(): Promise<void>`

- [ ] **Step 1: Update the existing SessionEnd test and add the three failing tests**

Replace the body of `Harness endSession dispatches SessionEnd hook` so it runs a turn before calling `endSession`; then add:

```js
test('Harness emits SessionStart once on the first turn of a resumed session and SessionEnd at most once', async t => {
  const f = await fixture(t);
  const p = await provider(t, (req, res) => { sse(res, { text: 'Answer.' }); });
  const config = { model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000 };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);

  const firstEvents = [];
  const firstBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  firstBus.dispatch = async event => { firstEvents.push(event); return []; };
  await new Harness(config, store, tools, () => {}, undefined, firstBus).run('first', AbortSignal.timeout(10_000));

  assert.equal(firstEvents.filter(e => e === 'SessionStart').length, 1);
  assert.equal(firstEvents.filter(e => e === 'SessionEnd').length, 0);

  // Resumed store: messages already exist, yet the first turn must open a session.
  const secondEvents = [];
  const secondBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  secondBus.dispatch = async event => { secondEvents.push(event); return []; };
  const resumed = new Harness(config, store, tools, () => {}, undefined, secondBus);
  await resumed.run('second', AbortSignal.timeout(10_000));
  assert.equal(secondEvents.filter(e => e === 'SessionStart').length, 1, 'resumed session must start');

  await resumed.endSession();
  await resumed.endSession();
  assert.equal(secondEvents.filter(e => e === 'SessionEnd').length, 1, 'SessionEnd must be idempotent');
  t.after(() => store.close());
});

test('hook payloads carry the session id for prompt, tool, stop and compact events', async t => {
  const f = await fixture(t);
  const p = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'c1', name: 'list_files', input: { path: '.' } }] });
    else sse(res, { text: 'Done.' });
  });
  const config = { model: 'mock-model', provider: 'openai', baseUrl: p.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: f.data, maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000 };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  const tools = new ToolRegistry(f.cwd, async () => true, false);
  const seen = [];
  const bus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  bus.dispatch = async (event, payload) => { seen.push({ event, payload }); return []; };
  const harness = new Harness(config, store, tools, () => {}, undefined, bus);

  await harness.run('Inspect.', AbortSignal.timeout(10_000));
  await harness.compact(AbortSignal.timeout(10_000));

  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact']) {
    const entry = seen.find(e => e.event === event);
    assert.ok(entry, `${event} must dispatch`);
    assert.equal(entry.payload.sessionId, store.session.id, `${event} payload must carry sessionId`);
  }
  t.after(() => store.close());
});

test('PostToolUseFailure payloads carry the session id for denied and thrown tool calls', async t => {
  const f = await fixture(t);
  const deniedProvider = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'w1', name: 'write_file', input: { path: '../escape.txt', content: 'no' } }] });
    else sse(res, { text: 'Stopped.' });
  });
  const deniedConfig = { model: 'mock-model', provider: 'openai', baseUrl: deniedProvider.url, apiKey: 'mock-key',
    cwd: f.cwd, dataDir: join(f.data, 'denied'), maxOutputTokens: 2048, contextWindow: 8192, timeoutMs: 10000 };
  const deniedStore = await SessionStore.open(join(f.data, 'denied', 'sessions'), deniedConfig);
  const deniedEvents = [];
  const deniedBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  deniedBus.dispatch = async (event, payload) => { deniedEvents.push({ event, payload }); return []; };
  await new Harness(deniedConfig, deniedStore, new ToolRegistry(f.cwd, async () => false, false), () => {}, undefined, deniedBus)
    .run('Try escape.', AbortSignal.timeout(10_000));
  const denied = deniedEvents.find(e => e.event === 'PostToolUseFailure');
  assert.ok(denied, 'denied tool must dispatch PostToolUseFailure');
  assert.equal(denied.payload.sessionId, deniedStore.session.id);
  t.after(() => deniedStore.close());

  // A read of a directory throws inside ToolRegistry.execute, hitting the catch path.
  const thrownProvider = await provider(t, async (req, res, n) => {
    if (n === 1) sse(res, { calls: [{ id: 'r1', name: 'read_file', input: { path: '.' } }] });
    else sse(res, { text: 'Done.' });
  });
  const thrownConfig = { ...deniedConfig, baseUrl: thrownProvider.url, dataDir: join(f.data, 'thrown') };
  const thrownStore = await SessionStore.open(join(f.data, 'thrown', 'sessions'), thrownConfig);
  const thrownEvents = [];
  const thrownBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  thrownBus.dispatch = async (event, payload) => { thrownEvents.push({ event, payload }); return []; };
  await new Harness(thrownConfig, thrownStore, new ToolRegistry(f.cwd, async () => true, false), () => {}, undefined, thrownBus)
    .run('Read a directory.', AbortSignal.timeout(10_000));
  const thrown = thrownEvents.find(e => e.event === 'PostToolUseFailure');
  assert.ok(thrown, 'thrown tool must dispatch PostToolUseFailure');
  assert.equal(thrown.payload.sessionId, thrownStore.session.id);
  t.after(() => thrownStore.close());
});
```

- [ ] **Step 2: Run the new tests to verify RED**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="session id|resumed session|endSession" tests/hooks.test.mjs`
Expected: FAIL on the new assertions (missing `sessionId`, resumed session start, idempotent end, updated endSession test).

- [ ] **Step 3: Implement in `src/harness.ts`**

- Add `sessionLifecycle = true`, `private sessionStarted = false`, `private sessionEnded = false`.
- `endSession()` returns early unless a hook bus exists, `sessionLifecycle` is on, the session started, and it has not ended; set `sessionEnded = true` before dispatch.
- Open the session on the first `run()` when `!sessionStarted && sessionLifecycle`, regardless of `messages.length`; set `sessionStarted = true`.
- Add `sessionId` to `UserPromptSubmit`, `PreCompact` (manual and token limit), `Stop` (all three reasons), `PreToolUse`, `PostToolUse`, and both `PostToolUseFailure` paths.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `node node_modules/typescript/bin/tsc && node --test tests/hooks.test.mjs`
Expected: all hooks tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/harness.ts tests/hooks.test.mjs docs/superpowers/plans/2026-10-25-seam-hardening-phase-3-seam-integration-and-lifecycle.md
git commit -m "feat(hooks): carry session id in every payload and balance session lifecycle"
```

### Task 2: Agent Network Policy and Hook Seam

**Files:**
- Modify: `src/network.ts`
- Modify: `src/subagents.ts`
- Modify: `tests/features.test.mjs`

**Interfaces:**
- Consumes: `ToolRegistry.policy`, `HookBus`, `Harness.hookBus`, `Harness.sessionLifecycle`
- Produces: `AgentNetwork(config, parent, bus, emitEvent?, policy?, hookBus?)`

- [ ] **Step 1: Add the failing seam test**

Append to `tests/features.test.mjs`:

```js
test('Agent Network enforces parent tool policy and hooks without emitting session lifecycle', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'secret.txt'), 'TOP-SECRET-CONTENT');
  const p = await provider(t, (body, response) => {
    if (!body.messages.some(m => m.role === 'tool')) {
      return sse(response, { calls: [{ id: 'read-secret', name: 'read_file', input: { path: 'secret.txt' } }] });
    }
    return sse(response, { text: 'blocked-observed' });
  });
  const config = {
    cwd: f.cwd, dataDir: f.data, provider: 'openai-compatible', model: 'test-model', baseUrl: p.url,
    apiKey: 'fake', contextWindow: 128000, maxOutputTokens: 8192, timeoutMs: 5000, runTokenBudget: 0,
  };
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const policy = request => request.tool === 'read_file' ? 'deny' : 'default';
  const seen = [];
  const hookBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  hookBus.dispatch = async (event, payload) => { seen.push({ event, payload }); return []; };

  const net = new AgentNetwork(config, store, new AgentNetworkBus(), () => {}, policy, hookBus);
  const result = await net.brainstorm({
    topic: 'Policy probe', roles: ['critic'], rounds: 1, exploreCodebase: true,
    signal: AbortSignal.timeout(10_000),
  });

  assert.equal(result.contributions.length, 1);
  assert.doesNotMatch(result.contributions[0].response, /TOP-SECRET-CONTENT/);
  const toolMessage = p.requests.at(-1).messages.find(m => m.role === 'tool');
  assert.match(toolMessage.content, /Permission denied by policy/);
  assert(seen.some(e => e.event === 'PreToolUse' && e.payload.tool === 'read_file'));
  assert.equal(seen.filter(e => e.event === 'SessionStart' || e.event === 'SessionEnd').length, 0,
    'ephemeral network turns must not emit global session lifecycle');

  const tools = new ToolRegistry(f.cwd, async () => true);
  tools.policy = policy;
  const sub = new Subagents(config, store, tools, () => {}, hookBus);
  t.after(() => sub.closeAll());
  assert.equal(sub.network.policy, policy, 'Subagents must hand its policy to the network');
  assert.equal(sub.network.hookBus, hookBus, 'Subagents must hand its hook bus to the network');
});
```

Add `HookBus` to the `../dist/index.js` import list if absent.

- [ ] **Step 2: Run the test to verify RED**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="Agent Network enforces parent tool policy" tests/features.test.mjs`
Expected: FAIL — `AgentNetwork` ignores the extra arguments, so the secret reaches the model and/or no `PreToolUse` fires.

- [ ] **Step 3: Implement in `src/network.ts` and `src/subagents.ts`**

- `AgentNetwork` constructor: add `readonly policy?: ToolRegistry['policy']` and `readonly hookBus?: HookBus` after `emitEvent`.
- In `runPersonaTurn` and `runSynthesis`: set `tools.policy = this.policy`; build the harness as `new Harness(this.config, store, tools, this.emitEvent, undefined, this.hookBus)` and set `harness.sessionLifecycle = false` before `run`.
- In `Subagents` constructor: `new AgentNetwork(this.config, this.parent, this.bus, () => {}, this.registry.policy, this.hookBus)`.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="Agent Network enforces parent tool policy" tests/features.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/network.ts src/subagents.ts tests/features.test.mjs
git commit -m "fix(security): enforce policy and hooks inside Agent Network turns"
```

### Task 3: Subagent SessionEnd Cleanup

**Files:**
- Modify: `src/subagents.ts`
- Modify: `tests/subagents.test.mjs`

**Interfaces:**
- Consumes: `Harness.endSession()`
- Produces: exactly one `SessionEnd` dispatch per subagent harness

- [ ] **Step 1: Add the failing test**

Append to `tests/subagents.test.mjs` (import `HookBus` from `../dist/hooks.js`):

```js
test('subagent cleanup dispatches SessionEnd once for the child session', async t => {
  const f = await fixture(t);
  const p = await provider(t, (body, response) => {
    if (isChild(body)) return sse(response, { text: 'Child report.' });
    return sse(response, { calls: [{ id: 'delegate1', name: 'delegate_task', input: { tasks: ['Inspect alpha'] } }] });
  });
  const config = configFor(f, p);
  const store = await SessionStore.open(join(f.data, 'sessions'), config);
  t.after(() => store.close());
  const tools = new ToolRegistry(f.cwd, async () => true);
  const seen = [];
  const hookBus = new HookBus({ cwd: f.cwd, isTrusted: true, hooks: [] });
  hookBus.dispatch = async (event, payload) => { seen.push({ event, payload }); return []; };
  new Subagents(config, store, tools, () => {}, hookBus).register();

  await new Harness(config, store, tools, () => {}, undefined, hookBus)
    .run('delegate', AbortSignal.timeout(10_000));

  const ends = seen.filter(e => e.event === 'SessionEnd');
  assert.equal(ends.length, 1, 'child cleanup must end its session once');
  assert.notEqual(ends[0].payload.sessionId, store.session.id, 'SessionEnd must identify the child session');
  assert(seen.some(e => e.event === 'SessionStart' && e.payload.sessionId === ends[0].payload.sessionId));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="subagent cleanup dispatches SessionEnd" tests/subagents.test.mjs`
Expected: FAIL — `ends.length` is 0.

- [ ] **Step 3: Implement in `src/subagents.ts`**

Hoist `let childHarness: Harness | undefined` in both `executeManagedTurn` and `child`, assign it where the harness is built, and in the cleanup block call `await childHarness?.endSession().catch(() => {})` before `store?.close()`.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node node_modules/typescript/bin/tsc && node --test tests/subagents.test.mjs`
Expected: all subagent tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/subagents.ts tests/subagents.test.mjs
git commit -m "fix(hooks): end subagent sessions during cleanup"
```

### Task 4: CLI Store-Swap and Workflow Lifecycle Seams

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/features.test.mjs`

**Interfaces:**
- Consumes: `Harness.endSession()`, `Harness.sessionLifecycle`
- Produces: balanced lifecycle across `/new`, `/resume`, and workflow child harnesses

- [ ] **Step 1: Add the failing seam guard**

Append to `tests/features.test.mjs`:

```js
test('CLI ends the active session before store swaps and suppresses lifecycle for nested workflow harnesses', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');

  for (const marker of ["if (input === '/new'", "input === '/resume' || input.startsWith('/resume ')"]) {
    const start = source.indexOf(marker);
    assert.ok(start > -1, `missing branch ${marker}`);
    const block = source.slice(start, source.indexOf('rebuildHarness', start));
    const endCall = block.indexOf('activeHarness?.endSession()');
    const swap = block.indexOf('store = newStore');
    assert.ok(endCall > -1, `${marker} must end the active session`);
    assert.ok(swap > -1, `${marker} must swap the store`);
    assert.ok(endCall < swap, `${marker} must end the session before the store swap`);
  }

  const childStart = source.indexOf('const childTools = new ToolRegistry(runtime.cwd, req => reg.approve(req));');
  assert.ok(childStart > -1, 'workflow runPrompt child harness must exist');
  const childBlock = source.slice(childStart, source.indexOf('await childStore.close()', childStart));
  assert.match(childBlock, /sessionLifecycle = false/);

  const stepStart = source.indexOf('const stepHarness = step.effort');
  assert.ok(stepStart > -1, 'workflow step harness must exist');
  const stepBlock = source.slice(stepStart, source.indexOf('return await stepHarness.run', stepStart));
  assert.match(stepBlock, /stepHarness !== harness[\s\S]*sessionLifecycle = false/);
});
```

- [ ] **Step 2: Run the guard to verify RED**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="CLI ends the active session" tests/features.test.mjs`
Expected: FAIL — no `endSession`/`sessionLifecycle` at those seams.

- [ ] **Step 3: Implement in `src/cli.ts`**

- `/new`: `await activeHarness?.endSession().catch(() => {});` immediately before `const oldStore = store;`.
- `/resume`: same immediately before `const oldStore = store;`.
- Workflow `runPrompt` child harness: assign to a local `childHarness`, set `childHarness.sessionLifecycle = false`, then `await childHarness.run(...)`.
- Workflow step harness: after `const stepHarness = step.effort ? ... : harness;`, add `if (stepHarness !== harness) stepHarness.sessionLifecycle = false;`.

- [ ] **Step 4: Run the guard to verify GREEN**

Run: `node node_modules/typescript/bin/tsc && node --test --test-name-pattern="CLI ends the active session" tests/features.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/features.test.mjs
git commit -m "fix(hooks): end active session before store swaps and scope nested lifecycle"
```

### Task 5: Contract Docs and Full Gate

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Document the payload envelope**

In `docs/SPEC.md` line 33, after "Hooks receive JSON payload on stdin with", state that every payload includes `event`, `sessionId`, `timestamp`, and `cwd`, and that nested ephemeral runners (Agent Network, workflow steps) inherit tool hooks without global `SessionStart`/`SessionEnd`.

- [ ] **Step 2: Run the gate**

Run: `npm run typecheck`, `npm run lint`, `npm test`
Expected: typecheck exit 0; lint zero errors; `npm test` exit 0 with only the five documented Windows platform skips.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): state the hook payload envelope and nested lifecycle rule"
```
