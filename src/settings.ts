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
 * If the file is missing or contains invalid JSON/schema, degrades safely
 * and returns an empty settings object.
 */
export async function loadProjectSettings(cwd: string): Promise<ProjectSettings> {
  const filePath = projectSettingsPath(cwd);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const result = projectSettingsSchema.safeParse(parsed);
    if (!result.success) return {};
    return result.data;
  } catch {
    return {};
  }
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
