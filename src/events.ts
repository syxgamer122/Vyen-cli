import { z } from 'zod';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sessionGoalSchema, todoItemSchema } from './session.js';

// The canonical shapes live next to the code that produces them; this module
// owns their wire representation so the stream contract cannot drift from the
// session/harness types without a type error.
export { sessionGoalSchema, todoItemSchema };

export const EVENT_SCHEMA_VERSION = 'v1';

export const sessionEventSchema = z.object({
  type: z.literal('session'),
  version: z.literal(EVENT_SCHEMA_VERSION),
  id: z.string(),
  cwd: z.string(),
});

export const textEventSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const reasoningEventSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  source: z.enum(['inline', 'provider']),
});

export const toolStreamEventSchema = z.object({
  type: z.literal('tool_stream'),
  name: z.string(),
  id: z.string(),
  state: z.enum(['start', 'delta']),
  preview: z.string(),
});

export const TOOL_EVENT_KINDS = ['read', 'list', 'search', 'exec', 'edit', 'other'] as const;

export const toolEventMetaSchema = z.object({
  kind: z.enum(TOOL_EVENT_KINDS),
  summary: z.string(),
  durationMs: z.number().optional(),
  outputPreview: z.array(z.string()).optional(),
  omittedLines: z.number().optional(),
  diff: z.string().optional(),
  added: z.number().optional(),
  removed: z.number().optional(),
  verb: z.enum(['Added', 'Edited', 'Deleted']).optional(),
});

export type ToolEventMeta = z.infer<typeof toolEventMetaSchema>;

export const toolEventSchema = z.object({
  type: z.literal('tool'),
  name: z.string(),
  id: z.string(),
  state: z.enum(['start', 'done', 'error']),
  meta: toolEventMetaSchema.optional(),
});

export const usageEventSchema = z.object({
  type: z.literal('usage'),
  input: z.number(),
  output: z.number(),
  total: z.number(),
});

export const compactionEventSchema = z.object({
  type: z.literal('compaction'),
  count: z.number(),
});

export const todoEventSchema = z.object({
  type: z.literal('todo'),
  todos: z.array(todoItemSchema),
});

export const goalEventSchema = z.object({
  type: z.literal('goal'),
  goal: sessionGoalSchema.optional(),
});

export const planExitEventSchema = z.object({
  type: z.literal('plan_exit'),
  plan: z.string(),
});

export const retryEventSchema = z.object({
  type: z.literal('retry'),
  attempt: z.number(),
  maxRetries: z.number(),
  message: z.string(),
});

export const stoppedEventSchema = z.object({
  type: z.literal('stopped'),
  reason: z.string(),
});

export const doneEventSchema = z.object({
  type: z.literal('done'),
  text: z.string(),
  denied: z.boolean(),
  sessionId: z.string(),
  structuredOutput: z.unknown().optional(),
});

export const schemaErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  schemaErrors: z.array(schemaErrorDetailSchema).optional(),
});

export const subagentEventSchema = z.object({
  type: z.literal('subagent'),
  id: z.string(),
  state: z.enum(['start', 'progress', 'done', 'error']),
  task: z.string().optional(),
  event: z.record(z.string(), z.unknown()).optional(),
});

export const workflowDoneEventSchema = z.object({
  type: z.literal('workflow_done'),
  result: z.unknown(),
  sessionId: z.string(),
});

export const networkDoneEventSchema = z.object({
  type: z.literal('network_done'),
  synthesis: z.string(),
  rounds: z.number(),
});

export const streamJsonEventSchema = z.discriminatedUnion('type', [
  sessionEventSchema,
  textEventSchema,
  reasoningEventSchema,
  toolStreamEventSchema,
  toolEventSchema,
  usageEventSchema,
  compactionEventSchema,
  todoEventSchema,
  goalEventSchema,
  planExitEventSchema,
  retryEventSchema,
  stoppedEventSchema,
  doneEventSchema,
  errorEventSchema,
  subagentEventSchema,
  workflowDoneEventSchema,
  networkDoneEventSchema,
]);

export type StreamJsonEvent = z.infer<typeof streamJsonEventSchema>;

export type StructuredOutputResult =
  | { valid: true; data: unknown; rawText: string }
  | { valid: false; errors: Array<{ path: string; message: string }>; rawText: string };

function schemaErrorPath(error: ErrorObject): string {
  const missingProperty = (error.params as { missingProperty?: unknown } | undefined)?.missingProperty;
  if (typeof missingProperty === 'string') {
    return `${error.instancePath}/${missingProperty}`;
  }
  return error.instancePath || error.schemaPath || '';
}

export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid JSON Schema: ${(error as Error).message}`);
  }
}

export function extractJsonFromText(rawText: string): string {
  const trimmed = rawText.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed;
  }
  const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText);
  if (codeBlockMatch) {
    const blockContent = codeBlockMatch[1].trim();
    if ((blockContent.startsWith('{') && blockContent.endsWith('}')) || (blockContent.startsWith('[') && blockContent.endsWith(']'))) {
      return blockContent;
    }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }
  return trimmed;
}

export function validateStructuredOutput(
  schema: Record<string, unknown>,
  rawText: string,
): StructuredOutputResult {
  let parsed: unknown;
  const jsonString = extractJsonFromText(rawText);
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: '', message: `Output could not be parsed as JSON: ${(error as Error).message}` }],
      rawText,
    };
  }

  let validate: ValidateFunction;
  try {
    validate = compileJsonSchema(schema);
  } catch (compileErr) {
    return {
      valid: false,
      errors: [{ path: '', message: (compileErr as Error).message }],
      rawText,
    };
  }

  const isValid = Boolean(validate(parsed));
  if (isValid) {
    return {
      valid: true,
      data: parsed,
      rawText,
    };
  }

  const errors: Array<{ path: string; message: string }> = (validate.errors ?? []).map(err => ({
    path: schemaErrorPath(err),
    message: err.message || 'Validation failed',
  }));

  return {
    valid: false,
    errors: errors.length > 0 ? errors : [{ path: '', message: 'Unknown schema validation error' }],
    rawText,
  };
}

export async function loadJsonSchema(raw: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse inline JSON Schema: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('JSON Schema must be an object.');
    }
    compileJsonSchema(parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  }

  const targetPath = resolve(cwd, trimmed);
  let content: string;
  try {
    content = await readFile(targetPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read JSON Schema file at "${targetPath}": ${(err as Error).message}`);
  }

  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in schema file "${targetPath}": ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON Schema file must contain a JSON object.');
  }
  compileJsonSchema(parsed as Record<string, unknown>);
  return parsed as Record<string, unknown>;
}
