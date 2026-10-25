# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce fail-closed semantics for PreToolUse hooks upon spawn errors or timeouts, and sanitize the shell execution environment in workflows to protect ambient credentials.

**Architecture:** Thread the hook event identifier into `HookBus.executeCommand()` so that `PreToolUse` hook failures (spawn crashes or timeouts) immediately yield `denied: true` at the bus layer. In `executeWorkflow()`, sanitize the base environment with `sanitizeEnvironment()` before injecting workflow-specific template variables.

**Tech Stack:** TypeScript 5.9, Node.js ≥ 22.16 (Node test runner `node:test`), child_process.

**Spec:** [docs/superpowers/specs/2026-10-25-security-hardening-design.md](file:///c:/Users/Admin/Downloads/Vyen-cli-main/docs/superpowers/specs/2026-10-25-security-hardening-design.md)

## Global Constraints

- Strict TypeScript compilation (`strict: true`, `NodeNext`).
- Zero new external runtime dependencies.
- No lowering of the gate (no `@ts-ignore`, no unjustified `@ts-expect-error`, no `as any`).
- Files must be UTF-8 without BOM.
- Preserve existing workflow template variables (`VYEN_WF_*`) and Git/SSH environment variables.

## Review Focus

1. PreToolUse hook spawn error marks execution result as denied: true
2. PreToolUse hook timeout marks execution result as denied: true
3. Non-PreToolUse hook timeout or error preserves denied: false
4. Workflow shell execution sanitizes ambient sensitive environment variables
5. Workflow shell execution preserves explicit workflow arguments and variables

## Scenarios & Tests

**What the user sees:** When a PreToolUse hook fails to spawn or times out, the tool execution is immediately rejected with a permission denial without relying on external checks; workflow shell steps execute cleanly without leaking ambient tokens or API keys to child commands.

| # | Criterion | Test |
|---|---|---|
| 1 | PreToolUse hook spawn error marks execution result as denied: true | tests/hooks.test.mjs › PreToolUse hook spawn error marks execution result as denied |
| 2 | PreToolUse hook timeout marks execution result as denied: true | tests/hooks.test.mjs › PreToolUse hook timeout marks execution result as denied |
| 3 | Non-PreToolUse hook timeout or error preserves denied: false | tests/hooks.test.mjs › Non-PreToolUse hook timeout or error preserves denied false |
| 4 | Workflow shell execution sanitizes ambient sensitive environment variables | tests/features.test.mjs › workflow shell step sanitizes ambient sensitive environment variables |
| 5 | Workflow shell execution preserves explicit workflow arguments and variables | tests/features.test.mjs › workflow shell step preserves explicit workflow arguments and variables |

---

### Task 1: HookBus Fail-Closed on PreToolUse Spawn Error and Timeout

**Files:**
- Modify: `src/hooks.ts`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `HookEvent`, `HookExecutionResult`, `HookBus` from `src/hooks.ts`
- Produces: `HookExecutionResult.denied === true` when `event === 'PreToolUse'` and `timedOut || error`

- [ ] **Step 1: Write the failing tests in `tests/hooks.test.mjs`**

Add tests for:
- `PreToolUse hook spawn error marks execution result as denied`
- `PreToolUse hook timeout marks execution result as denied`
- `Non-PreToolUse hook timeout or error preserves denied false`

```javascript
test('PreToolUse hook spawn error marks execution result as denied', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'non_existent_command_12345' }],
  });
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].denied, true, 'PreToolUse spawn error must fail-closed with denied: true');
});

test('PreToolUse hook timeout marks execution result as denied', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    timeoutMs: 100,
    hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'node -e "setTimeout(() => {}, 5000)"' }],
  });
  const results = await bus.dispatch('PreToolUse', { tool: 'bash', input: {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].denied, true, 'PreToolUse timeout must fail-closed with denied: true');
});

test('Non-PreToolUse hook timeout or error preserves denied false', async () => {
  const bus = new HookBus({
    cwd: process.cwd(),
    isTrusted: true,
    hooks: [{ event: 'SessionStart', command: 'non_existent_command_12345' }],
  });
  const results = await bus.dispatch('SessionStart', {});
  assert.equal(results.length, 1);
  assert.equal(results[0].denied, false, 'Non-PreToolUse spawn error must not mark denied: true');
});
```

- [ ] **Step 2: Verify tests fail (RED)**

Run the targeted tests using node test runner:
`node --test --test-name-pattern="PreToolUse hook spawn error|PreToolUse hook timeout|Non-PreToolUse hook timeout" tests/hooks.test.mjs`
Expected: FAIL on the first two assertions (`assert.equal(results[0].denied, true)` received `false`).

- [ ] **Step 3: Implement context-aware fail-closed in `src/hooks.ts`**

Update `executeCommand` signature in `HookBus` to accept `event: HookEvent`:
```typescript
private executeCommand(
  event: HookEvent,
  command: string,
  inputJson: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HookExecutionResult>
```
In `child.on('error')`:
```typescript
child.on('error', err => {
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  resolvePromise({
    executed: false,
    exitCode: 1,
    stdout,
    stderr,
    denied: event === 'PreToolUse',
    error: err.message,
  });
});
```
In `child.on('close')`:
```typescript
const exitCode = code ?? (timedOut ? 124 : (aborted ? 130 : 1));
const isPreToolUse = event === 'PreToolUse';
const denied = exitCode === 2 || (isPreToolUse && Boolean(timedOut));
```

- [ ] **Step 4: Verify tests pass (GREEN)**

Run: `node --test --test-name-pattern="PreToolUse hook spawn error|PreToolUse hook timeout|Non-PreToolUse hook timeout" tests/hooks.test.mjs`
Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts tests/hooks.test.mjs
git commit -m "fix(hooks): fail-closed with denied: true on PreToolUse errors and timeouts"
```

---

### Task 2: Workflow Shell Environment Sanitization

**Files:**
- Modify: `src/workflow.ts`
- Test: `tests/features.test.mjs`

**Interfaces:**
- Consumes: `sanitizeEnvironment` from `src/hooks.ts`
- Produces: Sanitized environment in `executeWorkflow()` for shell steps, retaining `VYEN_WF_*` and Git/SSH variables while stripping sensitive tokens.

- [ ] **Step 1: Write the failing tests in `tests/features.test.mjs`**

Add tests for:
- `workflow shell step sanitizes ambient sensitive environment variables`
- `workflow shell step preserves explicit workflow arguments and variables`

```javascript
test('workflow shell step sanitizes ambient sensitive environment variables', async t => {
  const f = await fixture(t);
  const prevToken = process.env.GITHUB_TOKEN;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.GITHUB_TOKEN = 'ghp_secret_token_123';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret_key_456';

  try {
    const wf = {
      name: 'env-check',
      description: 'Check env sanitization',
      scope: 'workspace',
      steps: [
        {
          id: 's1',
          type: 'shell',
          command: 'node -e "process.stdout.write(JSON.stringify(process.env))"',
        },
      ],
    };

    const res = await executeWorkflow(wf, '', {
      cwd: f.cwd,
      signal: new AbortController().signal,
      effectiveReadOnly: false,
    });

    assert.equal(res.status, 'completed');
    const captured = JSON.parse(res.steps[0].output.replace(/^Exit code: 0\s*/, ''));
    assert.equal(captured.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must be stripped in workflow shell step');
    assert.equal(captured.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY must be stripped in workflow shell step');
  } finally {
    if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
    else delete process.env.GITHUB_TOKEN;
    if (prevSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    else delete process.env.AWS_SECRET_ACCESS_KEY;
  }
});

test('workflow shell step preserves explicit workflow arguments and variables', async t => {
  const f = await fixture(t);
  const wf = {
    name: 'var-check',
    description: 'Check workflow variables',
    inputs: { target: 'default-target' },
    scope: 'workspace',
    steps: [
      {
        id: 's1',
        type: 'shell',
        command: 'node -e "process.stdout.write(JSON.stringify({ input: process.env.VYEN_WF_INPUT, target: process.env.VYEN_WF_VAR_TARGET }))"',
      },
    ],
  };

  const res = await executeWorkflow(wf, 'target=prod my-arg', {
    cwd: f.cwd,
    signal: new AbortController().signal,
    effectiveReadOnly: false,
  });

  assert.equal(res.status, 'completed');
  const captured = JSON.parse(res.steps[0].output.replace(/^Exit code: 0\s*/, ''));
  assert.equal(captured.input, 'target=prod my-arg');
  assert.equal(captured.target, 'prod');
});
```

- [ ] **Step 2: Verify tests fail (RED)**

Run: `node --test --test-name-pattern="workflow shell step sanitizes ambient|workflow shell step preserves explicit" tests/features.test.mjs`
Expected: FAIL on the first test (`assert.equal(captured.GITHUB_TOKEN, undefined)` fails because it currently inherits `process.env`).

- [ ] **Step 3: Implement environment sanitization in `src/workflow.ts`**

Import `sanitizeEnvironment` from `./hooks.js`:
```typescript
import { sanitizeEnvironment } from './hooks.js';
```
In `executeWorkflow()`, update the construction of `wfEnv`:
```typescript
const baseEnv = sanitizeEnvironment(process.env);
const wfEnv: NodeJS.ProcessEnv = {
  ...baseEnv,
  VYEN_WF_INPUT: parsedArgs.fullInput,
  VYEN_WF_PREV: prevOutput,
};
```

- [ ] **Step 4: Verify tests pass (GREEN)**

Run: `node --test --test-name-pattern="workflow shell step sanitizes ambient|workflow shell step preserves explicit" tests/features.test.mjs`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/workflow.ts tests/features.test.mjs
git commit -m "fix(workflow): sanitize sensitive environment variables in shell steps"
```
