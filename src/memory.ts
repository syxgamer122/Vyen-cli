import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configDir } from './config.js';
import { limitText } from './files.js';
import type { ToolRegistry } from './tools.js';

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export const EntitySchema = z.object({
  name: z.string().min(1),
  entityType: z.string().min(1),
  observations: z.array(z.string()).default([]),
});

export const RelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.string().min(1),
});

function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

export async function loadGraph(filePath: string): Promise<{ graph: KnowledgeGraph; unreadable: string[] }> {
  const graph: KnowledgeGraph = { entities: [], relations: [] };
  const unreadable: string[] = [];

  if (!existsSync(filePath)) {
    return { graph, unreadable };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { graph, unreadable };
    }
    throw err;
  }

  const lines = stripBom(raw).split(/\r?\n/).filter(line => line.trim().length > 0);
  for (const line of lines) {
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      unreadable.push(line);
      continue;
    }

    if (typeof item !== 'object' || item === null) {
      unreadable.push(line);
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type === 'entity') {
      const parsed = EntitySchema.safeParse(item);
      if (parsed.success) {
        graph.entities.push(parsed.data);
      } else {
        unreadable.push(line);
      }
    } else if (record.type === 'relation') {
      const parsed = RelationSchema.safeParse(item);
      if (parsed.success) {
        graph.relations.push(parsed.data);
      } else {
        unreadable.push(line);
      }
    } else {
      unreadable.push(line);
    }
  }

  return { graph, unreadable };
}

export async function saveGraph(
  filePath: string,
  graph: KnowledgeGraph,
  unreadable: string[] = [],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const lines: string[] = [];

  for (const line of unreadable) {
    lines.push(line);
  }

  for (const entity of graph.entities) {
    lines.push(JSON.stringify({ type: 'entity', ...entity }));
  }

  for (const relation of graph.relations) {
    lines.push(JSON.stringify({ type: 'relation', ...relation }));
  }

  const content = lines.length ? `${lines.join('\n')}\n` : '';
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    throw err;
  }
}

export interface KnowledgeGraphManagerOptions {
  userGraphPath?: string;
  projectGraphPath?: string;
  legacyMemoryPath?: string;
  isTrusted?: boolean;
}

export class KnowledgeGraphManager {
  private userGraphPath: string;
  private projectGraphPath: string;
  private legacyMemoryPath: string;
  private isTrusted: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: KnowledgeGraphManagerOptions = {}) {
    this.userGraphPath = options.userGraphPath ?? join(configDir(), 'knowledge-graph.jsonl');
    this.projectGraphPath = options.projectGraphPath ?? join(process.cwd(), '.vyen', 'knowledge-graph.jsonl');
    this.legacyMemoryPath = options.legacyMemoryPath ?? join(configDir(), 'memories.json');
    this.isTrusted = options.isTrusted ?? false;
  }

  private checkTrust(scope: 'user' | 'project'): void {
    if (scope === 'project' && !this.isTrusted) {
      throw new Error('Project Knowledge Graph requires workspace trust. Run with --trust-workspace to enable.');
    }
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => fn();
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(() => {}, () => {});
    return next;
  }

  private resolvePath(scope: 'user' | 'project' = 'user'): string {
    return scope === 'project' ? this.projectGraphPath : this.userGraphPath;
  }

  async readGraph(scope: 'user' | 'project' = 'user'): Promise<KnowledgeGraph> {
    this.checkTrust(scope);
    const filePath = this.resolvePath(scope);
    const { graph, unreadable } = await loadGraph(filePath);

    // Auto-migrate legacy memories if user graph is completely empty
    if (scope === 'user' && graph.entities.length === 0 && existsSync(this.legacyMemoryPath)) {
      try {
        const legacyRaw = await readFile(this.legacyMemoryPath, 'utf8');
        const legacyMemories = JSON.parse(stripBom(legacyRaw));
        if (Array.isArray(legacyMemories) && legacyMemories.length > 0) {
          graph.entities.push({
            name: 'global_user_memory',
            entityType: 'system_memory',
            observations: legacyMemories.map(m => String(m)),
          });
          await this.withWriteLock(async () => {
            await saveGraph(filePath, graph, unreadable);
          });
        }
      } catch {
        // Ignore legacy parse errors
      }
    }

    return graph;
  }

  async createEntities(entities: Entity[], scope: 'user' | 'project' = 'user'): Promise<Entity[]> {
    this.checkTrust(scope);
    return this.withWriteLock(async () => {
      const filePath = this.resolvePath(scope);
      const { graph, unreadable } = await loadGraph(filePath);
      const created: Entity[] = [];

      for (const entity of entities) {
        const existing = graph.entities.find(e => e.name.toLowerCase() === entity.name.toLowerCase());
        if (existing) {
          // Merge observations without duplicates
          const existingObs = new Set(existing.observations);
          for (const obs of entity.observations) {
            if (!existingObs.has(obs)) existing.observations.push(obs);
          }
          created.push(existing);
        } else {
          graph.entities.push(entity);
          created.push(entity);
        }
      }

      await saveGraph(filePath, graph, unreadable);
      return created;
    });
  }

  async createRelations(relations: Relation[], scope: 'user' | 'project' = 'user'): Promise<Relation[]> {
    this.checkTrust(scope);
    return this.withWriteLock(async () => {
      const filePath = this.resolvePath(scope);
      const { graph, unreadable } = await loadGraph(filePath);
      const created: Relation[] = [];

      for (const rel of relations) {
        const exists = graph.relations.some(
          r => r.from.toLowerCase() === rel.from.toLowerCase() &&
               r.to.toLowerCase() === rel.to.toLowerCase() &&
               r.relationType.toLowerCase() === rel.relationType.toLowerCase(),
        );
        if (!exists) {
          graph.relations.push(rel);
          created.push(rel);
        }
      }

      await saveGraph(filePath, graph, unreadable);
      return created;
    });
  }

  async addObservations(
    observations: Array<{ entityName: string; contents: string[] }>,
    scope: 'user' | 'project' = 'user',
  ): Promise<void> {
    this.checkTrust(scope);
    return this.withWriteLock(async () => {
      const filePath = this.resolvePath(scope);
      const { graph, unreadable } = await loadGraph(filePath);

      for (const obs of observations) {
        let entity = graph.entities.find(e => e.name.toLowerCase() === obs.entityName.toLowerCase());
        if (!entity) {
          entity = {
            name: obs.entityName,
            entityType: 'generic',
            observations: [],
          };
          graph.entities.push(entity);
        }
        const existingObs = new Set(entity.observations);
        for (const content of obs.contents) {
          if (!existingObs.has(content)) {
            entity.observations.push(content);
          }
        }
      }

      await saveGraph(filePath, graph, unreadable);
    });
  }

  async searchNodes(
    query: string,
    scope: 'user' | 'project' = 'user',
  ): Promise<{ entities: Entity[]; relations: Relation[] }> {
    this.checkTrust(scope);
    const graph = await this.readGraph(scope);
    const q = query.toLowerCase();

    const matchedEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.entityType.toLowerCase().includes(q) ||
      e.observations.some(obs => obs.toLowerCase().includes(q)),
    );

    const matchedEntityNames = new Set(matchedEntities.map(e => e.name.toLowerCase()));

    const matchedRelations = graph.relations.filter(r =>
      r.relationType.toLowerCase().includes(q) ||
      r.from.toLowerCase().includes(q) ||
      r.to.toLowerCase().includes(q) ||
      matchedEntityNames.has(r.from.toLowerCase()) ||
      matchedEntityNames.has(r.to.toLowerCase()),
    );

    return { entities: matchedEntities, relations: matchedRelations };
  }

  registerTools(registry: ToolRegistry): void {
    registry.register('mcp_create_entities', {
      description: 'Create new entities in the Knowledge Graph memory.',
      schema: z.object({
        entities: z.array(EntitySchema).min(1).describe('List of entities to create'),
        scope: z.enum(['user', 'project']).default('user').describe('Target graph scope'),
      }),
      readOnly: false,
      execute: async (input) => {
        const created = await this.createEntities(input.entities, input.scope);
        return limitText(JSON.stringify({ created }, null, 2));
      },
    });

    registry.register('mcp_create_relations', {
      description: 'Create relations between existing entities in the Knowledge Graph memory.',
      schema: z.object({
        relations: z.array(RelationSchema).min(1).describe('List of relations to create'),
        scope: z.enum(['user', 'project']).default('user').describe('Target graph scope'),
      }),
      readOnly: false,
      execute: async (input) => {
        const created = await this.createRelations(input.relations, input.scope);
        return limitText(JSON.stringify({ created }, null, 2));
      },
    });

    registry.register('mcp_add_observations', {
      description: 'Add new observations to existing entities in the Knowledge Graph memory.',
      schema: z.object({
        observations: z.array(z.object({
          entityName: z.string().min(1),
          contents: z.array(z.string()).min(1),
        })).min(1).describe('Observations to append'),
        scope: z.enum(['user', 'project']).default('user').describe('Target graph scope'),
      }),
      readOnly: false,
      execute: async (input) => {
        await this.addObservations(input.observations, input.scope);
        return limitText(JSON.stringify({ success: true, count: input.observations.length }, null, 2));
      },
    });

    registry.register('mcp_read_graph', {
      description: 'Read the complete Knowledge Graph memory for a given scope.',
      schema: z.object({
        scope: z.enum(['user', 'project']).default('user').describe('Graph scope to read'),
      }),
      readOnly: true,
      execute: async (input) => {
        const graph = await this.readGraph(input.scope);
        return limitText(JSON.stringify(graph, null, 2));
      },
    });

    registry.register('mcp_search_nodes', {
      description: 'Search entities and relations in the Knowledge Graph memory by query string.',
      schema: z.object({
        query: z.string().min(1).describe('Search term to match entity names, types, or observations'),
        scope: z.enum(['user', 'project']).default('user').describe('Target graph scope'),
      }),
      readOnly: true,
      execute: async (input) => {
        const results = await this.searchNodes(input.query, input.scope);
        return limitText(JSON.stringify(results, null, 2));
      },
    });
  }
}
