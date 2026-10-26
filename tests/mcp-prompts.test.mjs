import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpManager, mcpConfigSchema } from '../dist/mcp.js';
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
      ...extra,
    },
  },
});

test('list_mcp_prompts returns available prompts from connected server', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd);
  const manager = new McpManager(stdio(), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  assert.ok(manager.connected);
  const result = await registry.execute(call('list_mcp_prompts', {}), signal());
  const parsed = JSON.parse(result.text);
  assert.ok(parsed.local);
  assert.ok(Array.isArray(parsed.local.prompts));
  assert.equal(parsed.local.prompts[0].name, 'code_review');
});

test('get_mcp_prompt executes prompt on connected server and returns messages', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd);
  const manager = new McpManager(stdio(), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  const result = await registry.execute(
    call('get_mcp_prompt', { server: 'local', name: 'code_review', arguments: { diff: 'fix bug' } }),
    signal(),
  );
  const parsed = JSON.parse(result.text);
  assert.ok(parsed.messages);
  assert.equal(parsed.messages[0].role, 'user');
  assert.match(parsed.messages[0].content.text, /Please review:\s*fix bug/);
});

test('get_mcp_prompt returns structured error for unknown or disconnected server', async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd);
  const manager = new McpManager(stdio(), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  await assert.rejects(
    registry.execute(call('get_mcp_prompt', { server: 'nonexistent', name: 'any' }), signal()),
    /Unknown or disconnected MCP server: nonexistent/i,
  );
});
