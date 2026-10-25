import { resolve } from 'node:path';
import type { PermissionRules } from './settings.js';
import { type PermissionMode, normalizeToolName } from './tools.js';

export type PolicyDecision = 'allow' | 'ask' | 'deny' | 'default';

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
  cwd?: string;
}

const CHAINING_PATTERN = /[\r\n;&|`><]|\$\(|\$\{/;
const COMPOUND_SPLIT_REGEX = /[;\r\n|&]+|\$\(|\`/g;
const WRAPPER_PREFIX_REGEX = /^(?:sudo(?:\s+-[a-zA-Z0-9]+)*|env(?:\s+[a-zA-Z0-9_]+=[^\s]+)*|sh\s+-c|bash\s+-c)\s+/i;

function cleanCommandSegment(seg: string): string {
  let cleaned = seg.trim();
  // Strip trailing parens or quotes from substitutions like $(rm -rf /)
  cleaned = cleaned.replace(/\)+$/, '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  let prev = '';
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned.replace(WRAPPER_PREFIX_REGEX, '').trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    cleaned = cleaned.replace(/\)+$/, '').trim();
  }
  return cleaned;
}

function normalizePathForMatching(raw: string, cwd = process.cwd()): string {
  const clean = raw.trim().replace(/\\/g, '/');
  if (!clean) return '';
  const normalizedCwd = resolve(cwd).replace(/\\/g, '/');
  const resolved = resolve(cwd, clean).replace(/\\/g, '/');
  const isWin = process.platform === 'win32';
  if (isWin ? resolved.toLowerCase() === normalizedCwd.toLowerCase() : resolved === normalizedCwd) {
    return '.';
  }
  const prefix = normalizedCwd + '/';
  const matchesPrefix = isWin
    ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
    : resolved.startsWith(prefix);
  if (matchesPrefix) {
    return resolved.slice(prefix.length);
  }
  return resolved;
}

function extractToolArgumentString(tool: string, input: unknown, cwd?: string): string {
  if (typeof input === 'string') return tool === 'bash' ? input.trim() : normalizePathForMatching(input, cwd);
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command.trim();
  if (typeof obj.path === 'string') return normalizePathForMatching(obj.path, cwd);
  if (typeof obj.file_path === 'string') return normalizePathForMatching(obj.file_path, cwd);
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
 * - `tool_name` (e.g. `read_file`, `write_file`, `bash`, `write`, `read`, `sh`)
 * - `tool_name*` (e.g. `mcp__*`)
 * - `tool_name(pattern)` (e.g. `bash(npm test *)`, `bash(git diff *)`, `read_file(docs/*)`)
 */
export function matchToolPattern(
  pattern: string,
  request: ToolRequest,
  options: { isAllow?: boolean; cwd?: string } = {},
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const parenIdx = trimmed.indexOf('(');
  const canonicalRequestTool = normalizeToolName(request.tool);
  if (parenIdx > 0 && trimmed.endsWith(')')) {
    const toolName = trimmed.slice(0, parenIdx).trim();
    const canonicalTool = normalizeToolName(toolName);
    if (!matchSimplePattern(canonicalTool, canonicalRequestTool)) return false;
    const rawArgPattern = trimmed.slice(parenIdx + 1, -1).trim();
    const argStr = extractToolArgumentString(canonicalRequestTool, request.input, options.cwd);
    if (canonicalRequestTool === 'bash') {
      if (options.isAllow) {
        // Security: In allow rules, wildcard patterns must never match compound or chained commands
        if (rawArgPattern.includes('*') && CHAINING_PATTERN.test(argStr)) {
          return false;
        }
        return matchSimplePattern(rawArgPattern, argStr);
      }
      // Security: In deny/ask rules, match if either full command or ANY segment matches
      if (matchSimplePattern(rawArgPattern, argStr)) return true;
      const rawSegments = argStr.split(COMPOUND_SPLIT_REGEX);
      for (const seg of rawSegments) {
        const cleaned = cleanCommandSegment(seg);
        if (cleaned && matchSimplePattern(rawArgPattern, cleaned)) {
          return true;
        }
      }
      return false;
    }
    const normalizedPattern = normalizePathForMatching(rawArgPattern, options.cwd);
    return matchSimplePattern(normalizedPattern, argStr);
  }
  const canonicalPatternTool = normalizeToolName(trimmed);
  if (!matchSimplePattern(canonicalPatternTool, canonicalRequestTool)) return false;
  if (canonicalRequestTool === 'bash' && options.isAllow) {
    const argStr = extractToolArgumentString(canonicalRequestTool, request.input, options.cwd);
    if (CHAINING_PATTERN.test(argStr)) {
      return false;
    }
  }
  return true;
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
  const allowOpts = { isAllow: true, cwd: ctx.cwd };
  const denyOpts = { isAllow: false, cwd: ctx.cwd };

  // 1. CLI disallowed
  if (ctx.cliDisallowed?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 2. CLI allowed
  if (ctx.cliAllowed?.some(p => matchToolPattern(p, request, allowOpts))) {
    return 'allow';
  }
  // 3. User deny
  if (ctx.userRules?.deny?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 4. Project deny
  if (ctx.projectRules?.deny?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 5. User ask
  if (ctx.userRules?.ask?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'ask';
  }
  // 6. Project ask
  if (ctx.projectRules?.ask?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'ask';
  }
  // 7. Project allow
  if (ctx.projectRules?.allow?.some(p => matchToolPattern(p, request, allowOpts))) {
    return 'allow';
  }
  // 8. User allow
  if (ctx.userRules?.allow?.some(p => matchToolPattern(p, request, allowOpts))) {
    return 'allow';
  }
  // Default when no rule matches
  return 'default';
}
