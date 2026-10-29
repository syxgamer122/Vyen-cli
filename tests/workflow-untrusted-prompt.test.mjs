// A workflow step prompt is written by a model (or a workflow file), never typed
// by the user, so an image outside the workspace must not be attached to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Harness } from '../dist/harness.js';
import { SessionStore } from '../dist/session.js';
import { ToolRegistry } from '../dist/tools.js';
import { discoverWorkflows, executeWorkflow } from '../dist/workflow.js';
import { fixture, provider, sse } from './helpers.mjs';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

test('a workflow step prompt cannot attach an image from outside the workspace', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'private.png');
  await writeFile(outside, PNG);
  // A workspace workflow whose only step mentions an absolute outside path.
  await mkdir(join(f.cwd, '.vyen', 'workflows'), { recursive: true });
  await writeFile(join(f.cwd, '.vyen', 'workflows', 'look.md'), `# Look\n\nDescribe @${outside}\n`);

  const seen = [];
  const p = await provider(t, (body, response) => {
    seen.push(JSON.stringify(body).includes('"image_url"'));
    sse(response, { text: 'ok' });
  });
  const config = {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: p.url, apiKey: 'fake',
    contextWindow: 128000, maxOutputTokens: 8192, timeoutMs: 3000, runTokenBudget: 100000,
  };
  const store = await SessionStore.open(join(f.root, 'sessions'), config);
  t.after(() => store.close());

  const wf = (await discoverWorkflows(f.cwd)).find(w => w.name === 'look');
  assert.ok(wf, 'the workspace workflow must be discovered');
  await executeWorkflow(wf, '', {
    cwd: f.cwd,
    signal: AbortSignal.timeout(10_000),
    runPrompt: async (stepPrompt, step, signal) => {
      // Mirrors the run_workflow tool in src/cli.ts: the step text is model-written.
      const harness = new Harness(config, store, new ToolRegistry(f.cwd, async () => true));
      harness.untrustedPrompts = true;
      return harness.run(stepPrompt, signal);
    },
  });
  assert.deepEqual(seen, [false], 'the workflow request must not carry the outside image');
});

test('the run_workflow tool marks every step harness untrusted before it runs', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  // One harness per workflow runner: the run_workflow tool and the /workflow slash command.
  const assignments = [...source.matchAll(/(\w*[Hh]arness)\.untrustedPrompts = true;/g)].map(m => m[1]);
  assert.deepEqual(assignments.sort(), ['stepHarness', 'wfHarness'].sort());
});
