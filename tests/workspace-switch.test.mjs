// After /cd, the next model request must name the new absolute workspace root
// and warn that earlier relative paths are stale.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceChangedNotice } from '../dist/context.js';
import { SessionStore } from '../dist/session.js';
import { fixture, provider, sse } from './helpers.mjs';

test('buildWorkspaceChangedNotice names the new root and warns only when it changed', () => {
  const changed = buildWorkspaceChangedNotice('/work/project-b', true);
  assert.match(changed, /workspace root is now \/work\/project-b/);
  assert.match(changed, /relative to the previous root; do not reuse them/);
  const same = buildWorkspaceChangedNotice('/work/project-a', false);
  assert.doesNotMatch(same, /do not reuse them/);
  assert.match(same, /still refer to the same directory/);
});

test('/cd puts the new absolute root into the history the next request sends', async t => {
  const f = await fixture(t);
  const other = join(f.root, 'other-project');
  await mkdir(other, { recursive: true });
  const p = await provider(t, (body, response) => sse(response, { text: 'ok' }));
  const store = await SessionStore.open(join(f.root, 'sessions'), {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: p.url,
  });
  t.after(() => store.close());

  // Exactly what the /cd handler does: retarget, then record the notice.
  const { retargetSessionWorkspace, sameWorkspace } = await import('../dist/session.js');
  const changed = retargetSessionWorkspace(store, other);
  assert.equal(changed, true);
  store.session.messages.push({ role: 'user', content: buildWorkspaceChangedNotice(other, changed) });
  await store.save();

  const saved = JSON.parse(await readFile(join(f.root, 'sessions', `${store.session.id}.json`), 'utf8'));
  assert.equal(saved.cwd, other);
  assert.equal(sameWorkspace(saved.cwd, other), true);
  assert.match(saved.messages.at(-1).content, new RegExp(`workspace root is now ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('the /cd handler records the notice before it rebuilds the harness', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const workspaceChanged = retargetSessionWorkspace(store, real);');
  assert.ok(start > -1, 'the /cd handler must retarget through the shared helper');
  const block = source.slice(start, source.indexOf('await rebuildHarness({ reconnectMcp: true });', start));
  assert.match(block, /buildWorkspaceChangedNotice\(real, workspaceChanged\)/);
});

