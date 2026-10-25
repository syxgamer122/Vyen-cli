import test from 'node:test';
import assert from 'node:assert/strict';
import { safeError } from '../dist/errors.js';

test('safeError redacts the configured key and truncates the message', () => {
  assert.equal(safeError(new Error('bad key sk-secret'), 'sk-secret'), 'bad key [REDACTED]');
  assert.equal(safeError(new Error('a sk-secret b'), 'sk-secret'), 'a [REDACTED] b');
  assert.equal(safeError(new Error('no secret'), 'sk-secret'), 'no secret');
  assert.equal(safeError('plain failure'), 'plain failure');
  assert.equal(safeError(new Error('x'.repeat(2_500))).length, 2_000);
  assert.equal(safeError(new Error('x'.repeat(2_500))).endsWith('x'), true);
});
