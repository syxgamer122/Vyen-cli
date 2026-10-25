import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const permissionRulesSchema = z.object({
  allow: z.array(z.string().trim()).optional(),
  ask: z.array(z.string().trim()).optional(),
  deny: z.array(z.string().trim()).optional(),
}).strict();

export type PermissionRules = z.infer<typeof permissionRulesSchema>;

export const hookEventSchema = z.enum([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'Stop',
]);

export type HookEvent = z.infer<typeof hookEventSchema>;

export const hookDefinitionSchema = z.object({
  event: hookEventSchema,
  matcher: z.string().trim().optional(),
  command: z.string().trim(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

export type HookDefinition = z.infer<typeof hookDefinitionSchema>;

export const projectSettingsSchema = z.object({
  $schema: z.string().optional(),
  permissions: permissionRulesSchema.optional(),
  hooks: z.array(hookDefinitionSchema).optional(),
}).passthrough();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export interface LayeredSettings {
  projectPermissions: PermissionRules;
  userPermissions?: PermissionRules;
  hooks: HookDefinition[];
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, '.vyen', 'settings.json');
}

/**
 * Loads project-level settings from `<cwd>/.vyen/settings.json`.
 * Strips UTF-8 BOM if present. If the file is missing (ENOENT), returns an empty
 * settings object. If the file contains malformed JSON or invalid schema, throws
 * an error to fail closed and prevent silent security rule bypass.
 */
export async function loadProjectSettings(cwd: string): Promise<ProjectSettings> {
  const filePath = projectSettingsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const cleaned = raw.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Failed to parse project settings at ${filePath}: ${(error as Error).message}`);
  }

  const result = projectSettingsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid project settings schema at ${filePath}: ${issues}`);
  }
  return result.data;
}

/**
 * Loads layered settings combining project and optional user settings.
 */
export async function loadLayeredSettings(
  cwd: string,
  userPermissions?: PermissionRules,
): Promise<LayeredSettings> {
  const project = await loadProjectSettings(cwd);
  return {
    projectPermissions: project.permissions ?? {},
    userPermissions,
    hooks: project.hooks ?? [],
  };
}
