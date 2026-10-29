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
test('safeError extracts actionable upstream detail from provider responseBody and statusCode', () => {
  // 1. OpenRouter rate limit format with metadata.raw
  const openRouterErr = new Error('Provider returned error');
  openRouterErr.statusCode = 429;
  openRouterErr.responseBody = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 429,
      metadata: {
        raw: 'recursive/flint-v1.0:free is temporarily rate-limited upstream. Please retry shortly.',
      },
    },
  });
  assert.equal(
    safeError(openRouterErr),
    '[429] recursive/flint-v1.0:free is temporarily rate-limited upstream. Please retry shortly.'
  );

  // 2. OpenAI / standard error format with error.message and key redaction
  const standardErr = new Error('Provider returned error');
  standardErr.statusCode = 401;
  standardErr.responseBody = JSON.stringify({
    error: {
      message: 'Incorrect API key provided: sk-secret-12345',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });
  assert.equal(
    safeError(standardErr, 'sk-secret-12345'),
    '[401] Incorrect API key provided: [REDACTED]'
  );

  // 3. Fallback when responseBody is plain text
  const rawErr = new Error('Provider returned error');
  rawErr.statusCode = 502;
  rawErr.responseBody = 'Bad Gateway: upstream timed out';
  assert.equal(safeError(rawErr), '[502] Bad Gateway: upstream timed out');

  // 4. Normal errors without responseBody keep original message
  const normalErr = new Error('Network timeout after 5000ms');
  assert.equal(safeError(normalErr), 'Network timeout after 5000ms');
});

test('safeError never prints [object Object] for a thrown provider payload', () => {
  // The AI SDK re-throws the provider's raw JSON when a stream fails mid-way.
  assert.equal(
    safeError({ type: 'invalid_request_error', message: 'upstream rejected key sk-live-abcdefghijklmnopqrstuv' }),
    'upstream rejected key [REDACTED]',
  );
  assert.equal(safeError({ error: { message: 'context length exceeded' } }), 'context length exceeded');
  assert.equal(safeError({ status: 500 }), '{"status":500}');
  assert.equal(safeError({}), 'Unknown provider error.');
  assert.equal(safeError({ responseBody: 'quota exhausted' }), 'quota exhausted');
  const cyclic = { message: '' };
  cyclic.self = cyclic;
  assert.equal(safeError(cyclic), 'Unknown provider error.');
});
