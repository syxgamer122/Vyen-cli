import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpManager, mcpConfigSchema, mcpToolName } from '../dist/mcp.js';
import { ToolRegistry } from '../dist/tools.js';
import { fixture } from './helpers.mjs';

const call = (toolName, input = {}) => ({ toolName, input, toolCallId: 'fixture' });
const signal = () => new AbortController().signal;

const stdio = extra => mcpConfigSchema.parse({
  servers: {
    local: {
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'],
      readOnlyTools: ['sample', 'elicit'],
      ...extra,
    },
  },
});

test('sampling request enforces 2048 token limit and timeout guard', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd);
  const manager = new McpManager(stdio(), f.cwd);
  t.after(() => manager.close());

  let observedLimit = 0;
  manager.setSamplingHandler(async (params, tokenLimit) => {
    observedLimit = tokenLimit;
    return {
      model: 'test-model',
      stopReason: 'endTurn',
      role: 'assistant',
      content: { type: 'text', text: 'sampled-result' },
    };
  });

  await manager.connect(registry);

  const res = await registry.execute(
    call(mcpToolName('local', 'sample'), { maxTokens: 99999 }),
    signal(),
  );

  const parsed = JSON.parse(res.text);
  assert.equal(observedLimit, 2048, 'Sampling must cap tokens at 2048');
  assert.equal(parsed.content.text, 'sampled-result');
});

test('headless elicitation fails closed with declined response', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd);
  const manager = new McpManager(stdio(), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  const res = await registry.execute(
    call(mcpToolName('local', 'elicit'), {}),
    signal(),
  );

  const parsed = JSON.parse(res.text);
  assert.equal(parsed.action, 'decline', 'Headless elicitation must decline by default');
});
