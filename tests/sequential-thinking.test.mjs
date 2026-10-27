import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../dist/tools.js';
import { fixture } from './helpers.mjs';

const call = (toolName, input = {}) => ({ toolName, input, toolCallId: 'fixture' });
const signal = () => new AbortController().signal;

test('sequential_thinking tracks revision indices and maintains branch history', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd, async () => true, false);

  // Thought 1: Initial hypothesis
  const res1 = await registry.execute(
    call('sequential_thinking', {
      thought: 'Hypothesis: The race condition occurs during connection initialization.',
      thoughtNumber: 1,
      totalThoughts: 3,
      nextThoughtNeeded: true,
    }),
    signal(),
  );
  const parsed1 = JSON.parse(res1.text);
  assert.equal(parsed1.thoughtNumber, 1);
  assert.equal(parsed1.totalThoughts, 3);
  assert.equal(parsed1.nextThoughtNeeded, true);
  assert.equal(parsed1.historyLength, 1);

  // Thought 2: Revising thought 1 with new evidence
  const res2 = await registry.execute(
    call('sequential_thinking', {
      thought: 'Correction: The race condition actually happens during shutdown, not initialization.',
      thoughtNumber: 2,
      totalThoughts: 3,
      nextThoughtNeeded: true,
      isRevision: true,
      revisesThought: 1,
    }),
    signal(),
  );
  const parsed2 = JSON.parse(res2.text);
  assert.equal(parsed2.thoughtNumber, 2);
  assert.equal(parsed2.isRevision, true);
  assert.equal(parsed2.revisesThought, 1);
  assert.equal(parsed2.historyLength, 2);

  // Thought 3: Branching into alternative solution
  const res3 = await registry.execute(
    call('sequential_thinking', {
      thought: 'Branch: Exploring mutex locking instead of atomic booleans.',
      thoughtNumber: 3,
      totalThoughts: 4,
      nextThoughtNeeded: false,
      branchFromThought: 2,
      branchId: 'mutex-approach',
    }),
    signal(),
  );
  const parsed3 = JSON.parse(res3.text);
  assert.equal(parsed3.thoughtNumber, 3);
  assert.equal(parsed3.branchFromThought, 2);
  assert.equal(parsed3.branchId, 'mutex-approach');
  assert.ok(parsed3.branches.includes('mutex-approach'));
  assert.equal(parsed3.historyLength, 3);
});

test('sequential_thinking is available in readOnly mode and serializes state transitions', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd, async () => false, true); // readOnly = true
  assert.equal(registry.canBatchParallel('sequential_thinking'), false, 'must return false to serialize state transitions');
  assert.equal(registry.isReadOnly('sequential_thinking'), true, 'must return true as read-only tool');

  // Must execute without throwing "Tool is not available in read-only mode"
  const res = await registry.execute(
    call('sequential_thinking', {
      thought: 'Analyzing code in read-only mode.',
      thoughtNumber: 1,
      totalThoughts: 1,
      nextThoughtNeeded: false,
    }),
    signal(),
  );
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.thoughtNumber, 1);
});

test('sequential_thinking resets history on a fresh thought sequence', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd, async () => true, false);

  // Sequence 1: 2 thoughts
  await registry.execute(call('sequential_thinking', {
    thought: 'First query step 1',
    thoughtNumber: 1,
    totalThoughts: 2,
    nextThoughtNeeded: true,
  }), signal());
  await registry.execute(call('sequential_thinking', {
    thought: 'First query step 2',
    thoughtNumber: 2,
    totalThoughts: 2,
    nextThoughtNeeded: false,
  }), signal());
  assert.equal(registry.thoughtHistory.length, 2);

  // Sequence 2: starts fresh with thoughtNumber 1
  const freshRes = await registry.execute(call('sequential_thinking', {
    thought: 'Second query step 1',
    thoughtNumber: 1,
    totalThoughts: 1,
    nextThoughtNeeded: false,
  }), signal());
  const parsed = JSON.parse(freshRes.text);
  assert.equal(parsed.historyLength, 1, 'history must reset on fresh sequence');
  assert.equal(registry.thoughtHistory.length, 1);
});

test('sequential_thinking normalizes snake_case aliases from model calls', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd, async () => true, false);

  const res = await registry.execute(
    call('sequential_thinking', {
      thought: 'Testing snake_case normalization',
      thought_number: 1,
      total_thoughts: 2,
      next_thought_needed: true,
      branch_id: 'test-branch',
    }),
    signal(),
  );
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.thoughtNumber, 1);
  assert.equal(parsed.totalThoughts, 2);
  assert.equal(parsed.nextThoughtNeeded, true);
  assert.equal(parsed.branchId, 'test-branch');
});
