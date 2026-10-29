// /revert counts turns that changed files. A read-only turn after an edit must
// not spend the user's revert budget, and the edit must actually come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Harness } from '../dist/harness.js';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { fixture, provider, sse } from './helpers.mjs';

test('revert steps count turns that touched files, not read-only turns', async t => {
  const f = await fixture(t);
  const p = await provider(t, (body, response) => {
    const asked = body.messages.filter(m => m.role === 'user').map(m => m.content).join(' | ');
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    if (asked.includes('write it') && !hasToolResult) {
      return sse(response, { calls: [{ id: 'w', name: 'write_file', input: { path: 'a.txt', content: 'v1\n' } }] });
    }
    if (asked.includes('read only')) return sse(response, { text: 'read done' });
    return sse(response, { text: 'done' });
  });
  const config = {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: p.url, apiKey: 'fake',
    contextWindow: 128000, maxOutputTokens: 8192, timeoutMs: 3000, runTokenBudget: 100000,
  };
  const store = await SessionStore.open(join(f.root, 'sessions'), config);
  t.after(() => store.close());
  const harness = new Harness(config, store, new ToolRegistry(f.cwd, async () => true));

  await harness.run('write it', new AbortController().signal);
  assert.equal(await readFile(join(f.cwd, 'a.txt'), 'utf8'), 'v1\n');
  await harness.run('read only, no tools', new AbortController().signal);
  assert.equal(store.session.checkpoints.length, 2);

  const rev = await harness.revert({ steps: 1, scope: 'both' });
  assert.equal(rev.turnsReverted, 1);
  assert.deepEqual(rev.deletedFiles, ['a.txt'], 'the file the edit created must be removed');
  await assert.rejects(readFile(join(f.cwd, 'a.txt'), 'utf8'));
  assert.equal(store.session.checkpoints.length, 0, 'the newer read-only turn went with it');
});
