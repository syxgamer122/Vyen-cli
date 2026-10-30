import { open, mkdir, readFile, readdir, unlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { modelMessageSchema, type ModelMessage, type ToolResultPart } from 'ai';
import { z } from 'zod';
import { atomicJson } from './config.js';
import { redactObject } from './errors.js';

export const fileBackupSchema = z.object({
  path: z.string(),
  existed: z.boolean(),
  content: z.string().optional(),
  mode: z.number().int().optional(),
  afterHash: z.string().optional(),
  /** Content dropped to keep the session file bounded (see pruneCheckpointBackups). */
  pruned: z.boolean().optional(),
});
export type FileBackup = z.infer<typeof fileBackupSchema>;

export const turnCheckpointSchema = z.object({
  id: z.number().int().positive(),
  createdAt: z.string().datetime(),
  prompt: z.string(),
  messageIndex: z.number().int().nonnegative(),
  tokensBefore: z.number().nonnegative(),
  files: z.array(fileBackupSchema),
});
export type TurnCheckpoint = z.infer<typeof turnCheckpointSchema>;

export const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const sessionGoalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);
export type SessionGoalStatus = z.infer<typeof sessionGoalStatusSchema>;

export const sessionGoalSchema = z.object({
  goalId: z.string().optional(),
  objective: z.string().min(1),
  status: sessionGoalStatusSchema.default('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tokensAtStart: z.number().nonnegative().default(0),
  tokensUsed: z.number().nonnegative().default(0),
  timeUsedSeconds: z.number().nonnegative().default(0),
  tokenBudget: z.number().positive().optional(),
});
export type SessionGoal = z.infer<typeof sessionGoalSchema>;

export const GOAL_USAGE = 'Usage: /goal [<objective>|--budget <tokens> <objective>|clear|edit|pause|resume]';

export function goalStatusLabel(status: SessionGoalStatus): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'stalled';
    case 'usage_limited':
      return 'usage limited';
    case 'budget_limited':
      return 'limited by budget';
    case 'complete':
      return 'complete';
  }
}

export function formatGoalElapsedSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h ${remMinutes}m`;
  }
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

export function formatGoalTokensCompact(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatGoalUsageSummary(goal: SessionGoal): string {
  const parts = [`Objective: ${goal.objective}`];
  const timeSec = goal.timeUsedSeconds ?? 0;
  if (timeSec > 0) {
    parts.push(`Time: ${formatGoalElapsedSeconds(timeSec)}.`);
  }
  if (goal.tokenBudget !== undefined) {
    parts.push(
      `Tokens: ${formatGoalTokensCompact(goal.tokensUsed ?? 0)}/${formatGoalTokensCompact(goal.tokenBudget)}.`,
    );
  }
  return parts.join(' ');
}

export function formatGoalStatusIndicator(goal: SessionGoal, activeTurnSeconds = 0): string {
  const tokensUsed = goal.tokensUsed ?? 0;
  const timeUsed =
    (goal.timeUsedSeconds ?? 0) + (goal.status === 'active' ? Math.max(0, Math.floor(activeTurnSeconds)) : 0);
  switch (goal.status) {
    case 'active': {
      const usage = goal.tokenBudget
        ? `${formatGoalTokensCompact(tokensUsed)} / ${formatGoalTokensCompact(goal.tokenBudget)}`
        : formatGoalElapsedSeconds(timeUsed);
      return `Pursuing goal (${usage})`;
    }
    case 'paused':
      return 'Goal paused (/goal resume)';
    case 'blocked':
      return 'Goal stalled (/goal resume)';
    case 'usage_limited':
      return 'Goal hit usage limits (/goal resume)';
    case 'budget_limited':
      return goal.tokenBudget
        ? `Goal unmet (${formatGoalTokensCompact(tokensUsed)} / ${formatGoalTokensCompact(goal.tokenBudget)} tokens)`
        : 'Goal abandoned';
    case 'complete': {
      const usage = goal.tokenBudget
        ? `${formatGoalTokensCompact(tokensUsed)} tokens`
        : formatGoalElapsedSeconds(timeUsed);
      return `Goal achieved (${usage})`;
    }
  }
}

export function formatGoalSummaryLines(goal: SessionGoal, currentSessionTokens = 0): string {
  const tokensUsed =
    (goal.tokensUsed ?? 0) > 0
      ? goal.tokensUsed
      : Math.max(0, currentSessionTokens - (goal.tokensAtStart ?? 0));
  const wallSec = Math.max(0, Math.floor((Date.now() - Date.parse(goal.createdAt)) / 1000));
  const timeSec = (goal.timeUsedSeconds ?? 0) > 0 ? goal.timeUsedSeconds : wallSec;
  const lines = [
    'Goal',
    `  Status: ${goalStatusLabel(goal.status)}`,
    `  Objective: ${goal.objective}`,
    `  Time used: ${formatGoalElapsedSeconds(timeSec)}`,
    `  Tokens used: ${formatGoalTokensCompact(tokensUsed)}`,
  ];
  if (goal.tokenBudget !== undefined) {
    lines.push(`  Token budget: ${formatGoalTokensCompact(goal.tokenBudget)}`);
  }
  const commandHint =
    goal.status === 'active'
      ? 'Commands: /goal edit, /goal pause, /goal clear'
      : goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'usage_limited'
        ? 'Commands: /goal edit, /goal resume, /goal clear'
        : 'Commands: /goal edit, /goal clear';
  lines.push('');
  lines.push(`  ${commandHint}`);
  return lines.join('\n');
}

export function parseGoalDraftArgs(
  rawArg: string,
): { objective: string; tokenBudget?: number } | { error: string } {
  let rest = rawArg.trim();
  let tokenBudget: number | undefined;
  const parseTokenNumber = (val: string): number | undefined => {
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(val.trim());
    if (!m) return undefined;
    const base = Number(m[1]);
    const mult = !m[2] ? 1 : m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const out = Math.round(base * mult);
    return Number.isFinite(out) && out > 0 ? out : undefined;
  };
  const eqMatch = /^--(?:token-)?budget=(\S+)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (eqMatch) {
    tokenBudget = parseTokenNumber(eqMatch[1]);
    if (tokenBudget === undefined) {
      return { error: `Invalid --budget "${eqMatch[1]}". Expected a positive token count (e.g. 50000 or 50k).` };
    }
    rest = (eqMatch[2] ?? '').trim();
  } else if (/^--(?:token-)?budget(?:\s|$)/i.test(rest)) {
    const spMatch = /^--(?:token-)?budget\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(rest);
    if (!spMatch) {
      return { error: `Missing value for --budget.\n${GOAL_USAGE}` };
    }
    tokenBudget = parseTokenNumber(spMatch[1]);
    if (tokenBudget === undefined) {
      return { error: `Invalid --budget "${spMatch[1]}". Expected a positive token count (e.g. 50000 or 50k).` };
    }
    rest = (spMatch[2] ?? '').trim();
  }
  return { objective: rest, tokenBudget };
}

const sessionSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), cwd: z.string(),
  title: z.string().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  provider: z.string(), model: z.string(), baseUrl: z.string(),
  messages: z.array(modelMessageSchema), tokens: z.number().nonnegative(), compactions: z.number().int().nonnegative(),
  checkpoints: z.array(turnCheckpointSchema).optional(),
  todos: z.array(todoItemSchema).optional(),
  goal: sessionGoalSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export type SessionSummary = Pick<Session, 'id' | 'cwd' | 'updatedAt' | 'model' | 'title'> & {
  messagesCount?: number;
  preview?: string;
};

function firstUserPreview(messages: ModelMessage[]): string | undefined {
  for (const m of messages) {
    if (!m || typeof m !== 'object' || m.role !== 'user') continue;
    const raw = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : '')).join(' ')
        : '';
    const cleaned = raw.startsWith('<codex_internal_context source="goal">')
      ? ''
      : raw.startsWith('<codex_internal_context source="user_goal">')
        ? ((/User set the goal:\s*"([^"]+)"/.exec(raw)?.[1]?.trim()) ? `Goal: ${/User set the goal:\s*"([^"]+)"/.exec(raw)![1].replace(/\s+/g, ' ').trim()}` : '')
        : raw.replace(/<referenced_file[\s\S]*?<\/referenced_file>/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned.slice(0, 72);
  }
  return undefined;
}

/**
 * Sessions written before images were stored as base64 contain a Buffer serialized by JSON
 * (`{"type":"Buffer","data":[…]}`) or a Uint8Array serialized as `{"0":…,"1":…}`. Neither passes
 * the message schema, which made such sessions disappear from listings and impossible to resume.
 * This converts those payloads back to base64 in place before validation.
 */
export function repairBinaryPayloads(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  const toBase64 = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.type === 'Buffer' && Array.isArray(record.data)) {
      return Buffer.from(record.data as number[]).toString('base64');
    }
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((k, i) => k === String(i)) && keys.every(k => typeof record[k] === 'number')) {
      return Buffer.from(keys.map(k => record[k] as number)).toString('base64');
    }
    return undefined;
  };
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== 'object') continue;
      const key = part.type === 'image' ? 'image' : part.type === 'file' ? 'data' : undefined;
      if (!key) continue;
      const repaired = toBase64(part[key]);
      if (repaired !== undefined) {
        part[key] = repaired;
        changed = true;
      }
    }
  }
  return changed;
}

/** Parses and validates a stored session, repairing legacy binary payloads first. */
export function parseSession(text: string): Session {
  const raw = JSON.parse(text) as unknown;
  repairBinaryPayloads(raw);
  return sessionSchema.parse(raw);
}

export function repairInterrupted(messages: ModelMessage[]): boolean {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call' && !part.providerExecuted) pending.set(part.toolCallId, part.toolName);
      if (part.type === 'tool-result') pending.delete(part.toolCallId);
    }
  }
  if (!pending.size) return false;
  const content: ToolResultPart[] = [...pending].map(([toolCallId, toolName]) => ({
    type: 'tool-result', toolCallId, toolName,
    output: { type: 'error-text', value: 'Previous process was interrupted. Execution status unknown; inspect the workspace before retrying.' },
  }));
  messages.push({ role: 'tool', content });
  return true;
}

/**
 * Point the session at a new workspace. Turn checkpoints store file paths
 * relative to the workspace they were taken in, so they stop meaning anything
 * once the workspace changes and must be dropped rather than replayed against
 * the new root.
 */
export function retargetSessionWorkspace(store: SessionStore, nextCwd: string): boolean {
  const changed = !sameWorkspace(store.session.cwd, nextCwd);
  if (changed) store.session.checkpoints = [];
  store.session.cwd = nextCwd;
  return changed;
}

export function sameWorkspace(a: string, b: string): boolean {
  const na = a.normalize('NFC').replace(/[\\/]+$/, '');
  const nb = b.normalize('NFC').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export interface SessionStoreInput {
  cwd: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export class SessionStore {
  private closed = false;
  readonly secretKeys: string[] = [];
  constructor(readonly root: string, readonly session: Session, private readonly lock: string, secretKeys: string[] = []) {
    this.secretKeys = [...secretKeys];
  }
  addSecretKey(key?: string): void {
    if (key && !this.secretKeys.includes(key)) {
      this.secretKeys.push(key);
    }
  }
  static resolveSessionId(
    list: SessionSummary[],
    target: string,
    options?: { cwd?: string; excludeId?: string },
  ): string | undefined {
    const trimmed = target.trim();
    if (!trimmed) return undefined;

    const inWorkspace = options?.cwd ? (s: SessionSummary) => sameWorkspace(s.cwd, options.cwd!) : () => true;
    const resumable = (s: SessionSummary) => (s.messagesCount ?? 0) > 0 || Boolean(s.title);

    if (trimmed === 'latest') {
      const wsNonEmpty = list.filter(s => inWorkspace(s) && s.id !== options?.excludeId && resumable(s));
      const wsAll = list.filter(s => inWorkspace(s) && s.id !== options?.excludeId);
      if (options?.cwd) return wsNonEmpty[0]?.id ?? wsAll[0]?.id;
      const anyNonEmpty = list.filter(s => s.id !== options?.excludeId && resumable(s));
      return wsNonEmpty[0]?.id ?? wsAll[0]?.id ?? anyNonEmpty[0]?.id ?? list.find(s => s.id !== options?.excludeId)?.id;
    }

    if (/^\d{1,3}$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      const wsNonEmpty = list.filter(s => inWorkspace(s) && s.id !== options?.excludeId && resumable(s));
      const wsAll = list.filter(s => inWorkspace(s) && s.id !== options?.excludeId);
      const candidates = wsNonEmpty.length ? wsNonEmpty : wsAll;
      return candidates[idx]?.id;
    }

    const lower = trimmed.toLowerCase();
    const exact = list.find(s => s.id.toLowerCase() === lower);
    if (exact) return exact.id;

    if (/^[0-9a-f-]{4,36}$/i.test(trimmed)) {
      const wsMatches = list.filter(s => inWorkspace(s) && s.id.toLowerCase().startsWith(lower));
      if (wsMatches.length === 1) return wsMatches[0].id;
      const allMatches = list.filter(s => s.id.toLowerCase().startsWith(lower));
      if (allMatches.length === 1) return allMatches[0].id;
    }

    return undefined;
  }
  static async open(root: string, input: SessionStoreInput, resume?: string, excludeId?: string, options?: { secretKeys?: string[] }): Promise<SessionStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let id = resume?.trim();
    if (id && (id === 'latest' || /^\d{1,3}$/.test(id) || !z.string().uuid().safeParse(id).success)) {
      const list = await SessionStore.list(root);
      id = SessionStore.resolveSessionId(list, id, { cwd: input.cwd, excludeId });
    }
    if (resume && !id) throw new Error('No matching session to resume in this workspace.');
    if (id && !z.string().uuid().safeParse(id).success) throw new Error('Invalid session ID.');
    id ??= randomUUID();
    const lock = join(root, `${id}.lock`);
    // Never steal an existing lock. A stale lock can only be removed after its
    // owner PID is proven dead; races fail closed via exclusive creation.
    try { await SessionStore.acquire(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const recovery = `${lock}.recovery`;
      // Serialize stale-lock recovery: two reclaimers must not unlink the new
      // live owner's lock between the first unlink and exclusive reacquisition.
      await SessionStore.withRecoveryLock(recovery, async () => {
        const pid = Number(await readFile(lock, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid session lock: ${lock}`);
        if (SessionStore.isProcessAlive(pid)) throw new Error('Session is already open in another process.');
        await unlink(lock);
        await SessionStore.acquire(lock);
      });
      const secretKeys = [...(options?.secretKeys ?? [])];
      if (input.apiKey && !secretKeys.includes(input.apiKey)) {
        secretKeys.push(input.apiKey);
      }
      return SessionStore.load(root, input, id, lock, !!resume, secretKeys);
    }
    const secretKeys = [...(options?.secretKeys ?? [])];
    if (input.apiKey && !secretKeys.includes(input.apiKey)) {
      secretKeys.push(input.apiKey);
    }
    return SessionStore.load(root, input, id, lock, !!resume, secretKeys);
  }
  private static async acquire(lock: string) {
    const handle = await open(lock, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
  }
  /** True while a process with this PID exists. ESRCH is the only "gone" errno. */
  private static isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  /**
   * Runs `action` while holding the recovery lock. A recovery lock left behind
   * by a crashed process would otherwise block the session forever, so an
   * existing one is reclaimed only once its owner is proven dead; an
   * unreadable one is treated as abandoned.
   */
  private static async withRecoveryLock<T>(recovery: string, action: () => Promise<T>): Promise<T> {
    const reclaim = async (): Promise<void> => {
      const pid = Number(await readFile(recovery, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0 && SessionStore.isProcessAlive(pid)) {
        throw new Error('Session is locked or undergoing recovery.');
      }
      await unlink(recovery).catch(() => {});
      await SessionStore.acquire(recovery);
    };
    try { await SessionStore.acquire(recovery); }
    catch { await reclaim(); }
    try { return await action(); }
    finally { await unlink(recovery).catch(() => {}); }
  }
  private static async load(root: string, input: SessionStoreInput, id: string, lock: string, resume: boolean, secretKeys: string[] = []) {
    try {
      const now = new Date().toISOString();
      // Copy an explicit allowlist, never the caller's runtime configuration:
      // structural typing permits extra fields such as credentials at runtime.
      const route = { cwd: input.cwd, provider: input.provider, model: input.model, baseUrl: input.baseUrl };
      const session: Session = resume ? parseSession(await readFile(join(root, `${id}.json`), 'utf8')) : {
        version: 1, id, ...route, createdAt: now, updatedAt: now, messages: [], tokens: 0, compactions: 0,
      };
      if (session.id !== id || !sameWorkspace(await realpath(session.cwd), input.cwd)) throw new Error('Session belongs to a different workspace.');
      const store = new SessionStore(root, session, lock, secretKeys);
      repairInterrupted(session.messages);
      // Provider changes are explicit CLI/config choices, not restored secrets.
      Object.assign(session, route);
      await store.save();
      return store;
    } catch (error) { await unlink(lock); throw error; }
  }
  /**
   * Lists session summaries. Summaries are cached in `.index.json` keyed by file size and mtime,
   * so only new or changed sessions are read; a listing no longer re-parses every message of
   * every saved session (hundreds of MB for long-time users).
   */
  static async list(root: string): Promise<SessionSummary[]> {
    let names: string[];
    try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const indexPath = join(root, SESSION_INDEX_FILE);
    let index: SessionIndex = { version: SESSION_INDEX_VERSION, entries: {} };
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as SessionIndex;
      if (parsed?.version === SESSION_INDEX_VERSION && parsed.entries && typeof parsed.entries === 'object') index = parsed;
    } catch { /* missing or corrupt cache: rebuild */ }
    const nextEntries: SessionIndex['entries'] = {};
    let dirty = false;
    const sessionNames = names.filter(n => /^[0-9a-f-]{36}\.json$/.test(n));
    const summaries = await mapLimit(sessionNames, 8, async name => {
      const file = join(root, name);
      let info;
      try { info = await stat(file); } catch { return undefined; }
      const cached = index.entries[name];
      // Files modified in the last few seconds are always re-read: coarse filesystem timestamps
      // (FAT/exFAT storage, some network mounts) could otherwise hide a same-size rewrite.
      const settled = Date.now() - info.mtimeMs > 3_000;
      if (cached && settled && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        nextEntries[name] = cached;
        return cached.summary ?? undefined;
      }
      dirty = true;
      const summary = await summarizeSessionFile(file);
      nextEntries[name] = { size: info.size, mtimeMs: info.mtimeMs, summary: summary ?? null };
      return summary;
    });
    if (dirty || Object.keys(index.entries).length !== Object.keys(nextEntries).length) {
      await atomicJson(indexPath, { version: SESSION_INDEX_VERSION, entries: nextEntries }, { compact: true }).catch(() => {});
    }
    return summaries.filter((s): s is SessionSummary => !!s).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  static async deleteSession(root: string, idOrPrefix: string, options?: { cwd?: string; excludeId?: string }): Promise<string> {
    const trimmed = idOrPrefix.trim();
    if (!trimmed) throw new Error('Session id is required.');
    const list = await SessionStore.list(root);
    let resolvedId: string | undefined;
    if (/^\d{1,3}$/.test(trimmed) || trimmed === 'latest') {
      resolvedId = SessionStore.resolveSessionId(list, trimmed, options);
      if (!resolvedId) throw new Error(`No saved session matches "${trimmed}".`);
    }
    const lower = (resolvedId ?? trimmed).toLowerCase();
    const exact = list.find(s => s.id.toLowerCase() === lower);
    const matches = exact ? [exact] : list.filter(s => s.id.toLowerCase().startsWith(lower));
    if (!matches.length) throw new Error(`No saved session matches "${trimmed}".`);
    // Deleting is irreversible: an ambiguous prefix must never pick a session at random.
    if (matches.length > 1) {
      throw new Error(`Session prefix "${idOrPrefix.trim()}" is ambiguous (${matches.length} matches: ${matches.slice(0, 4).map(m => m.id.slice(0, 8)).join(', ')}${matches.length > 4 ? ', ...' : ''}). Use more characters.`);
    }
    const match = matches[0];
    if (options?.excludeId && match.id === options.excludeId) {
      throw new Error('Cannot delete active session.');
    }
    const lock = join(root, `${match.id}.lock`);
    // A live owner keeps writing this session; removing its lock would let two processes share it.
    try {
      const pid = Number(await readFile(lock, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && SessionStore.isProcessAlive(pid)) {
        throw new Error(`Session ${match.id.slice(0, 8)} is open in another vyen process (pid ${pid}).`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await unlink(join(root, `${match.id}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A crashed recovery leaves this behind; the session is gone, so must the lock.
    for (const file of [lock, `${lock}.recovery`]) {
      await unlink(file).catch(() => {});
    }
    return match.id;
  }
  async forkToNewFile(title?: string): Promise<string> {
    pruneCheckpointBackups(this.session);
    const forkedId = randomUUID();
    const now = new Date().toISOString();
    const forked: Session = {
      ...structuredClone(this.session),
      id: forkedId,
      createdAt: now,
      updatedAt: now,
      ...(title ? { title } : this.session.title ? { title: `${this.session.title} (fork)` } : {}),
    };
    const scrubbed = redactObject(forked, { secretKeys: this.secretKeys });
    await atomicJson(join(this.root, `${forkedId}.json`), scrubbed, { compact: true });
    return forkedId;
  }
  async archiveCompaction(compactionIndex: number): Promise<void> {
    const scrubbed = redactObject(this.session, { secretKeys: this.secretKeys });
    await atomicJson(join(this.root, `${this.session.id}.compact-${compactionIndex}.json`), scrubbed, { compact: true });
  }
  /**
   * Saves are serialized: overlapping callers (tool batches, goal updates, UI commands) share one
   * in-flight write and at most one queued follow-up, so the latest state always lands last and a
   * burst of saves never rewrites a multi-MB file once per caller.
   */
  async save(): Promise<void> {
    if (this.saving) {
      this.saveQueued ??= this.saving.catch(() => {}).then(() => {
        this.saveQueued = undefined;
        return this.writeNow();
      });
      return this.saveQueued;
    }
    return this.writeNow();
  }
  private saving?: Promise<void>;
  private saveQueued?: Promise<void>;
  private async writeNow(): Promise<void> {
    this.session.updatedAt = new Date().toISOString();
    pruneCheckpointBackups(this.session);
    const scrubbed = redactObject(this.session, { secretKeys: this.secretKeys });
    const write = atomicJson(join(this.root, `${this.session.id}.json`), scrubbed, { compact: true });
    this.saving = write;
    try { await write; } finally { if (this.saving === write) this.saving = undefined; }
  }
  async discardIfEmpty() {
    if (this.session.messages.length === 0 && !this.session.title) {
      try { await unlink(join(this.root, `${this.session.id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await unlink(this.lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

const SESSION_INDEX_FILE = '.index.json';
const SESSION_INDEX_VERSION = 1;
interface SessionIndex {
  version: number;
  entries: Record<string, { size: number; mtimeMs: number; summary: SessionSummary | null }>;
}

const summaryHeaderSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), cwd: z.string(), title: z.string().optional(),
  updatedAt: z.string().datetime(), model: z.string(), messages: z.array(z.unknown()),
});

/**
 * Builds a listing summary without validating every message: only the fields a listing shows are
 * checked. A session that cannot be resumed still fails loudly in `SessionStore.open`.
 */
async function summarizeSessionFile(file: string): Promise<SessionSummary | undefined> {
  try {
    const parsed = summaryHeaderSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) return undefined;
    const s = parsed.data;
    const preview = firstUserPreview(s.messages as ModelMessage[]);
    return {
      id: s.id,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      model: s.model,
      messagesCount: s.messages.length,
      ...(s.title ? { title: s.title } : {}),
      ...(preview ? { preview } : {}),
    };
  } catch {
    return undefined; // Invalid/incomplete entries never become resumable sessions.
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Total bytes of file content kept for /undo across all checkpoints of one session. */
export const MAX_CHECKPOINT_BACKUP_BYTES = 32 * 1024 * 1024;

/**
 * Every turn stores the pre-edit content of each file it changed, and every save rewrites the
 * session file. Without a bound a long session grows by megabytes per turn. Beyond the budget the
 * oldest checkpoints lose their file contents (newest turns stay fully revertible); a pruned
 * backup is marked so /revert reports it instead of silently skipping it.
 */
export function pruneCheckpointBackups(session: Session, maxBytes = MAX_CHECKPOINT_BACKUP_BYTES): number {
  const checkpoints = session.checkpoints;
  if (!checkpoints?.length) return 0;
  let total = 0;
  for (const cp of checkpoints) for (const f of cp.files) total += f.content?.length ?? 0;
  if (total <= maxBytes) return 0;
  let pruned = 0;
  for (const cp of checkpoints) {
    if (total <= maxBytes) break;
    for (const f of cp.files) {
      if (f.content === undefined) continue;
      total -= f.content.length;
      delete f.content;
      f.pruned = true;
      pruned++;
    }
  }
  return pruned;
}
