import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePreset, listPresets } from '../dist/mcp-presets.js';
import { loadProjectMcpConfig, saveProjectMcpConfig } from '../dist/mcp.js';
import { fixture, cli } from './helpers.mjs';

test('resolvePreset returns valid stdio server configuration for official servers', () => {
  const memoryConfig = resolvePreset('memory');
  assert.equal(memoryConfig.transport, 'stdio');
  assert.ok(memoryConfig.command);
  assert.ok(Array.isArray(memoryConfig.args));

  const seqConfig = resolvePreset('sequentialthinking');
  assert.equal(seqConfig.transport, 'stdio');
  assert.ok(seqConfig.command);

  const fetchConfig = resolvePreset('fetch');
  assert.equal(fetchConfig.transport, 'stdio');
});

test('resolvePreset throws actionable error for unknown preset', () => {
  assert.throws(
    () => resolvePreset('unknown-preset-xyz'),
    /Unknown MCP preset: "unknown-preset-xyz"/i,
  );
});

test('listPresets returns catalog of available presets', () => {
  const list = listPresets();
  assert.ok(list.length >= 4);
  assert.ok(list.some(p => p.name === 'memory'));
  assert.ok(list.some(p => p.name === 'sequentialthinking'));
  assert.ok(list.some(p => p.name === 'fetch'));
  assert.ok(list.some(p => p.name === 'git'));
});

test('preset can be saved to project MCP configuration', async t => {
  const f = await fixture(t);
  const cfg = await loadProjectMcpConfig(f.cwd);
  cfg.servers['memory'] = resolvePreset('memory');
  await saveProjectMcpConfig(f.cwd, cfg);

  const reloaded = await loadProjectMcpConfig(f.cwd);
  assert.ok(reloaded.servers['memory']);
  assert.equal(reloaded.servers['memory'].transport, 'stdio');
});

test('preset CLI honours --trust flag for user servers', async t => {
  const f = await fixture(t);
  const userMcpPath = join(f.config, 'vyen', 'mcp.json');
  const res = await cli(f, false, ['mcp', 'add', '--preset', 'memory', '--trust'], { baseUrl: false }).done;
  assert.equal(res.code, 0, res.stderr);

  const raw = await readFile(userMcpPath, 'utf8');
  const json = JSON.parse(raw);
  assert.ok(json.servers.memory);
  assert.equal(json.servers.memory.trust, true);
});

test('mcp presets CLI command lists available presets as JSON', async t => {
  const f = await fixture(t);
  const res = await cli(f, false, ['mcp', 'presets'], { baseUrl: false }).done;
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some(p => p.name === 'memory'));
  assert.ok(parsed.some(p => p.name === 'sequentialthinking'));
});
