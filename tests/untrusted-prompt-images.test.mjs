// A prompt nobody typed (subagent task, workflow step, network round) may only
// attach workspace images. When that rule is missing, an image path outside the
// workspace is read straight into the request with no approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Harness } from '../dist/harness.js';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { AgentNetwork, AgentNetworkBus } from '../dist/network.js';
import { fixture, provider, sse } from './helpers.mjs';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);
// The OpenAI-compatible adapter serializes an image part as image_url.
const carriesImage = body => JSON.stringify(body).includes('"image_url"');
const config = (f, url, extra = {}) => ({
  cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: url, apiKey: 'fake',
  contextWindow: 128000, maxOutputTokens: 8192, timeoutMs: 3000, runTokenBudget: 100000, ...extra,
});

async function imageWatcher(t) {
  const seen = [];
  const p = await provider(t, (body, response) => {
    seen.push(carriesImage(body));
    sse(response, { text: 'ok' });
  });
  return { url: p.url, seen };
}

test('a prompt written by a model cannot attach an image from outside the workspace', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'private.png');
  await writeFile(outside, PNG);
  const { url, seen } = await imageWatcher(t);
  const store = await SessionStore.open(join(f.root, 'sessions'), config(f, url));
  t.after(() => store.close());
  const registry = new ToolRegistry(f.cwd, async () => true);

  const model = new Harness(config(f, url), store, registry);
  model.untrustedPrompts = true;
  await model.run(`describe @${outside}`, new AbortController().signal);
  assert.deepEqual(seen, [false], 'a model-written prompt may not attach an outside image');

  // The same path typed by the user still attaches: the rule is about who wrote it.
  await new Harness(config(f, url), store, registry).run(`describe @${outside}`, new AbortController().signal);
  assert.deepEqual(seen, [false, true]);
});

test('agent network rounds carry the untrusted-prompt rule, and their sessions still clean up', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'private.png');
  await writeFile(outside, PNG);
  const { url, seen } = await imageWatcher(t);
  const store = await SessionStore.open(join(f.root, 'sessions'), config(f, url));
  t.after(() => store.close());
  // A persona prompt quotes the topic; a topic containing an image path must not
  // turn into an attachment even though the topic originally came from the user.
  const net = new AgentNetwork(config(f, url, { dataDir: f.data }), store, new AgentNetworkBus());
  await net.brainstorm({
    topic: `look at @${outside}`,
    roles: ['architect', 'critic'],
    rounds: 1,
    exploreCodebase: false,
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(seen.length > 0, 'the network must have run a round');
  assert.ok(seen.every(v => v === false), 'no network request may carry an image');
});
