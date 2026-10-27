import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KnowledgeGraphManager,
  loadGraph,
  saveGraph,
} from '../dist/memory.js';
import { ToolRegistry } from '../dist/tools.js';
import { fixture } from './helpers.mjs';

const call = (toolName, input = {}) => ({ toolName, input, toolCallId: 'fixture' });
const signal = () => new AbortController().signal;

test('loadGraph preserves unreadable lines and handles valid entity mutations', async t => {
  const f = await fixture(t);
  const memoryFile = join(f.cwd, 'knowledge-graph.jsonl');

  // Pre-populate with one valid entity, one unreadable line, and one valid relation
  const initialContent = [
    JSON.stringify({ type: 'entity', name: 'AuthService', entityType: 'service', observations: ['uses JWT'] }),
    'MALFORMED_CORRUPT_JSON_LINE{{{',
    JSON.stringify({ type: 'relation', from: 'AuthService', to: 'Database', relationType: 'connects_to' }),
  ].join('\n') + '\n';

  await writeFile(memoryFile, initialContent, 'utf8');

  const { graph, unreadable } = await loadGraph(memoryFile);
  assert.equal(graph.entities.length, 1);
  assert.equal(graph.entities[0].name, 'AuthService');
  assert.equal(graph.relations.length, 1);
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0], 'MALFORMED_CORRUPT_JSON_LINE{{{');

  // Add another entity and save
  graph.entities.push({ name: 'Database', entityType: 'storage', observations: ['PostgreSQL 16'] });
  await saveGraph(memoryFile, graph, unreadable);

  const rawSaved = await readFile(memoryFile, 'utf8');
  assert.ok(rawSaved.includes('MALFORMED_CORRUPT_JSON_LINE{{{'), 'Unreadable lines must be preserved verbatim');
  assert.ok(rawSaved.includes('Database'));

  // Reload and verify
  const reloaded = await loadGraph(memoryFile);
  assert.equal(reloaded.graph.entities.length, 2);
  assert.equal(reloaded.unreadable.length, 1);
});

test('KnowledgeGraphManager migrates legacy memories.json into global_user_memory entity', async t => {
  const f = await fixture(t);
  const legacyFile = join(f.cwd, 'memories.json');
  const graphFile = join(f.cwd, 'knowledge-graph.jsonl');

  await writeFile(legacyFile, JSON.stringify(['prefer typescript', 'use tabs']), 'utf8');

  const manager = new KnowledgeGraphManager({
    userGraphPath: graphFile,
    legacyMemoryPath: legacyFile,
  });

  const graph = await manager.readGraph('user');
  const userEntity = graph.entities.find(e => e.name === 'global_user_memory');
  assert.ok(userEntity, 'Must create global_user_memory entity');
  assert.deepEqual(userEntity.observations, ['prefer typescript', 'use tabs']);
});

test('KnowledgeGraph tools registered on ToolRegistry allow CRUD operations', async t => {
  const f = await fixture(t);
  const graphFile = join(f.cwd, 'knowledge-graph.jsonl');
  const manager = new KnowledgeGraphManager({
    userGraphPath: graphFile,
  });

  const registry = new ToolRegistry(f.cwd, async () => true, false);
  manager.registerTools(registry);

  // 1. Create entities
  await registry.execute(
    call('mcp_create_entities', {
      entities: [
        { name: 'PaymentGateway', entityType: 'gateway', observations: ['Stripe webhook'] },
      ],
    }),
    signal(),
  );

  // 2. Add observations
  await registry.execute(
    call('mcp_add_observations', {
      observations: [
        { entityName: 'PaymentGateway', contents: ['supports Apple Pay'] },
      ],
    }),
    signal(),
  );

  // 3. Search nodes
  const searchRes = await registry.execute(
    call('mcp_search_nodes', { query: 'Apple Pay' }),
    signal(),
  );
  const searchData = JSON.parse(searchRes.text);
  assert.equal(searchData.entities.length, 1);
  assert.equal(searchData.entities[0].name, 'PaymentGateway');
  assert.deepEqual(searchData.entities[0].observations, ['Stripe webhook', 'supports Apple Pay']);
});

test('KnowledgeGraph tools normalize snake_case aliases and allow read operations in read-only mode', async t => {
  const f = await fixture(t);
  const graphFile = join(f.cwd, 'knowledge-graph.jsonl');
  const manager = new KnowledgeGraphManager({ userGraphPath: graphFile });

  const mutatingRegistry = new ToolRegistry(f.cwd, async () => true, false);
  manager.registerTools(mutatingRegistry);

  await mutatingRegistry.execute(call('mcp_create_entities', {
    entities: [{ name: 'UserMod', entity_type: 'module', observations: ['initial'] }],
  }), signal());
  await mutatingRegistry.execute(call('mcp_create_relations', {
    relations: [{ from: 'UserMod', to: 'AuthMod', relation_type: 'depends_on' }],
  }), signal());
  await mutatingRegistry.execute(call('mcp_add_observations', {
    observations: [{ entity_name: 'UserMod', contents: ['added feature'] }],
  }), signal());

  const readOnlyRegistry = new ToolRegistry(f.cwd, async () => false);
  readOnlyRegistry.planMode = true; // plan mode is read-only
  manager.registerTools(readOnlyRegistry);

  const readRes = await readOnlyRegistry.execute(call('mcp_read_graph', { scope: 'user' }), signal());
  const graphData = JSON.parse(readRes.text);
  assert.equal(graphData.entities.length, 1);
  assert.equal(graphData.entities[0].entityType, 'module');
  assert.equal(graphData.relations.length, 1);
  assert.equal(graphData.relations[0].relationType, 'depends_on');

  const searchRes = await readOnlyRegistry.execute(call('mcp_search_nodes', { query: 'depends_on' }), signal());
  const searchData = JSON.parse(searchRes.text);
  assert.equal(searchData.relations.length, 1);
});

test('project scope requires workspace trust and refuses untrusted access', async t => {
  const f = await fixture(t);
  const projectGraph = join(f.cwd, '.vyen', 'knowledge-graph.jsonl');

  // Untrusted manager (isTrusted: false)
  const untrusted = new KnowledgeGraphManager({
    projectGraphPath: projectGraph,
    isTrusted: false,
  });

  await assert.rejects(
    () => untrusted.readGraph('project'),
    /requires workspace trust/i,
  );
  await assert.rejects(
    () => untrusted.createEntities([{ name: 'MaliciousNode', entityType: 'exploit', observations: [] }], 'project'),
    /requires workspace trust/i,
  );

  // Trusted manager (isTrusted: true)
  const trusted = new KnowledgeGraphManager({
    projectGraphPath: projectGraph,
    isTrusted: true,
  });

  await trusted.createEntities([{ name: 'SafeNode', entityType: 'service', observations: ['trusted'] }], 'project');
  const read = await trusted.readGraph('project');
  assert.equal(read.entities.length, 1);
  assert.equal(read.entities[0].name, 'SafeNode');

  const raw = await readFile(projectGraph, 'utf8');
  assert.ok(raw.includes('SafeNode'));
});
