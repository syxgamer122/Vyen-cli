import type { PermissionRules } from './settings.js';
import type { PermissionMode } from './tools.js';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface ToolRequest {
  tool: string;
  input?: unknown;
}

export interface PolicyEvaluationContext {
  cliAllowed?: string[];
  cliDisallowed?: string[];
  userRules?: PermissionRules;
  projectRules?: PermissionRules;
  mode?: PermissionMode;
}

function normalizePathForMatching(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractToolArgumentString(tool: string, input: unknown): string {
  if (typeof input === 'string') return normalizePathForMatching(input.trim());
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (tool === 'bash' && typeof obj.command === 'string') {
    return obj.command.trim();
  }
  if (typeof obj.path === 'string') return normalizePathForMatching(obj.path.trim());
  if (typeof obj.file_path === 'string') return normalizePathForMatching(obj.file_path.trim());
  if (typeof obj.command === 'string') return obj.command.trim();
  return JSON.stringify(input);
}

function matchSimplePattern(pattern: string, text: string): boolean {
  const p = pattern.trim();
  if (p === '*' || p === '') return true;
  if (!p.includes('*')) {
    return p.toLowerCase() === text.toLowerCase();
  }
  const pieces = p.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  if (pieces.length === 2 && pieces[0].endsWith(' ') && pieces[1] === '') {
    const base = pieces[0].trimEnd();
    return new RegExp(`^${base}(?:\\s+.*)?$`, 'i').test(text);
  }
  return new RegExp(`^${pieces.join('.*')}$`, 'i').test(text);
}

/**
 * Checks whether a tool request matches a pattern.
 * Patterns can be:
 * - `*` (matches all tools)
 * - `tool_name` (e.g. `read_file`, `write_file`, `bash`)
 * - `tool_name*` (e.g. `mcp__*`)
 * - `tool_name(pattern)` (e.g. `bash(npm test *)`, `bash(git diff *)`, `read_file(docs/*)`)
 */
export function matchToolPattern(pattern: string, request: ToolRequest): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const parenIdx = trimmed.indexOf('(');
  if (parenIdx > 0 && trimmed.endsWith(')')) {
    const toolName = trimmed.slice(0, parenIdx).trim();
    const rawArgPattern = trimmed.slice(parenIdx + 1, -1).trim();
    const argPattern = toolName === 'bash' ? rawArgPattern : normalizePathForMatching(rawArgPattern);
    if (!matchSimplePattern(toolName, request.tool)) return false;
    const argStr = extractToolArgumentString(request.tool, request.input);
    return matchSimplePattern(argPattern, argStr);
  }
  return matchSimplePattern(trimmed, request.tool);
}

/**
 * Evaluates tool execution policy following strict precedence:
 * 1. CLI disallowed tools -> 'deny'
 * 2. CLI allowed tools -> 'allow'
 * 3. User deny rules -> 'deny' (cannot be widened by project rules)
 * 4. Project deny rules -> 'deny'
 * 5. User ask rules -> 'ask'
 * 6. Project ask rules -> 'ask'
 * 7. Project allow rules -> 'allow'
 * 8. User allow rules -> 'allow'
 * 9. Default -> 'ask' (falls through to mode / interactive confirmation)
 */
export function evaluateToolPolicy(
  request: ToolRequest,
  ctx: PolicyEvaluationContext,
): PolicyDecision {
  // 1. CLI disallowed
  if (ctx.cliDisallowed?.some(p => matchToolPattern(p, request))) {
    return 'deny';
  }
  // 2. CLI allowed
  if (ctx.cliAllowed?.some(p => matchToolPattern(p, request))) {
    return 'allow';
  }
  // 3. User deny
  if (ctx.userRules?.deny?.some(p => matchToolPattern(p, request))) {
    return 'deny';
  }
  // 4. Project deny
  if (ctx.projectRules?.deny?.some(p => matchToolPattern(p, request))) {
    return 'deny';
  }
  // 5. User ask
  if (ctx.userRules?.ask?.some(p => matchToolPattern(p, request))) {
    return 'ask';
  }
  // 6. Project ask
  if (ctx.projectRules?.ask?.some(p => matchToolPattern(p, request))) {
    return 'ask';
  }
  // 7. Project allow
  if (ctx.projectRules?.allow?.some(p => matchToolPattern(p, request))) {
    return 'allow';
  }
  // 8. User allow
  if (ctx.userRules?.allow?.some(p => matchToolPattern(p, request))) {
    return 'allow';
  }
  // Default to ask
  return 'ask';
}
