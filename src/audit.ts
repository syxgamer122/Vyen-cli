import { mkdir, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir } from './config.js';

export const toolDecisionSchema = z.enum(['allow', 'deny', 'ask_approved', 'ask_denied']);
export type ToolDecision = z.infer<typeof toolDecisionSchema>;

export const toolAuditRecordSchema = z.object({
  type: z.literal('tool_decision'),
  timestamp: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  decision: toolDecisionSchema,
  durationMs: z.number().optional(),
  tokens: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    total: z.number().optional(),
  }).optional(),
  errorClass: z.string().optional(),
  subagentId: z.string().optional(),
}).strict();
export type ToolAuditRecord = z.infer<typeof toolAuditRecordSchema>;

export const pairActionSchema = z.enum(['session_start', 'session_stop', 'remote_approve', 'remote_deny']);
export type PairAction = z.infer<typeof pairActionSchema>;

export const pairAuditRecordSchema = z.object({
  type: z.literal('pair_event'),
  timestamp: z.string(),
  sessionId: z.string(),
  action: pairActionSchema,
  origin: z.string().optional(),
  tool: z.string().optional(),
}).strict();
export type PairAuditRecord = z.infer<typeof pairAuditRecordSchema>;

export const auditRecordSchema = z.discriminatedUnion('type', [
  toolAuditRecordSchema,
  pairAuditRecordSchema,
]);
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export interface AuditLoggerOptions {
  baseDir?: string;
  maxFileSizeBytes?: number;
  secretKeys?: string[];
  enabled?: boolean;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class AuditLogger {
  public readonly baseDir: string;
  private readonly maxFileSizeBytes: number;
  private readonly secretKeys: string[];
  private readonly enabled: boolean;
  private writeQueue: Promise<void> = Promise.resolve();
  private dirCreated = false;

  constructor(options: AuditLoggerOptions = {}) {
    this.baseDir = options.baseDir ?? join(dataDir(), 'audit');
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.secretKeys = (options.secretKeys ?? []).filter(k => typeof k === 'string' && k.length > 0);
    this.enabled = options.enabled ?? (process.env.VYEN_AUDIT !== 'off');
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public addSecretKey(key?: string): void {
    if (key && !this.secretKeys.includes(key)) {
      this.secretKeys.push(key);
    }
  }

  public async recordToolDecision(data: Omit<ToolAuditRecord, 'type' | 'timestamp'> & { timestamp?: string }): Promise<void> {
    if (!this.enabled) return;

    let errorClass = data.errorClass;
    if (errorClass && this.secretKeys.length > 0) {
      for (const key of this.secretKeys) {
        errorClass = errorClass.split(key).join('[REDACTED]');
      }
    }

    const record: ToolAuditRecord = {
      type: 'tool_decision',
      timestamp: data.timestamp ?? new Date().toISOString(),
      sessionId: data.sessionId,
      tool: data.tool,
      decision: data.decision,
      durationMs: data.durationMs,
      tokens: data.tokens,
      errorClass,
      subagentId: data.subagentId,
    };

    return this.enqueueWrite(record);
  }

  public async recordPairEvent(data: Omit<PairAuditRecord, 'type' | 'timestamp'> & { timestamp?: string }): Promise<void> {
    if (!this.enabled) return;

    const record: PairAuditRecord = {
      type: 'pair_event',
      timestamp: data.timestamp ?? new Date().toISOString(),
      sessionId: data.sessionId,
      action: data.action,
      origin: data.origin,
      tool: data.tool,
    };

    return this.enqueueWrite(record);
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueWrite(record: AuditRecord): Promise<void> {
    const operation = async () => {
      try {
        if (!this.dirCreated) {
          await mkdir(this.baseDir, { recursive: true });
          this.dirCreated = true;
        }

        const filePath = await this.resolveActiveFilePath();
        const line = JSON.stringify(record) + '\n';
        await appendFile(filePath, line, 'utf8');
      } catch {
        // Audit log writes must never crash the caller or agent run
      }
    };

    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  private async resolveActiveFilePath(): Promise<string> {
    const dateStr = new Date().toISOString().slice(0, 10);
    let index = 0;

    while (true) {
      const fileName = index === 0 ? `audit-${dateStr}.jsonl` : `audit-${dateStr}.${index}.jsonl`;
      const candidatePath = join(this.baseDir, fileName);

      try {
        const stats = await stat(candidatePath);
        if (stats.size < this.maxFileSizeBytes) {
          return candidatePath;
        }
        index++;
      } catch {
        return candidatePath;
      }
    }
  }
}

let globalAuditLogger: AuditLogger | undefined;

export function getAuditLogger(options?: AuditLoggerOptions): AuditLogger {
  if (!globalAuditLogger || (options?.baseDir && options.baseDir !== globalAuditLogger.baseDir)) {
    globalAuditLogger = new AuditLogger(options);
  } else if (options?.secretKeys) {
    for (const key of options.secretKeys) {
      globalAuditLogger.addSecretKey(key);
    }
  }
  return globalAuditLogger;
}
