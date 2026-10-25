import { resolve } from 'node:path';
import type { PermissionRules } from './settings.js';
import { normalizeToolName } from './tools.js';

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
  cwd?: string;
  platform?: NodeJS.Platform;
}

const CHAINING_PATTERN = /[\r\n;&|`><]|\$\(|\$\{/;
const COMPOUND_SPLIT_REGEX = /[;\r\n|&]+|\$\(|[<>]+\(|`/g;
const WRAPPER_PREFIX_REGEX = /^(?:(?:(?:\/usr)?\/bin\/)?sudo(?:\s+(?:-[a-zA-Z0-9]+(?:\s+[^\s]+)?|--))*\s+|(?:(?:\/usr)?\/bin\/)?(?:env\s+)?(?:[a-zA-Z_][a-zA-Z0-9_]*=[^\s]*\s+)+|(?:(?:\/usr)?\/bin\/)?(?:bash|sh)(?:\s+-[a-zA-Z0-9]+)*\s*|(?:eval|exec)\s+)/i;

function cleanCommandSegment(seg: string): string {
  let cleaned = seg.trim();
  let prev = '';
  while (prev !== cleaned) {
    prev = cleaned;
    // Strip subshell groupings e.g. (cmd) or { cmd; }
    cleaned = cleaned.replace(/^[\s({]+|[\s)}]+$/g, '').trim();
    // Strip leading or trailing quotes from split strings e.g. "cmd or cmd"
    cleaned = cleaned.replace(/^['"]+|['"]+$/g, '').trim();
    // Strip wrappers e.g. sudo, env, sh -c, bash -c, flags
    cleaned = cleaned.replace(WRAPPER_PREFIX_REGEX, '').trim();
    cleaned = cleaned.replace(/^[\s({]+|[\s)}]+$/g, '').trim();
    cleaned = cleaned.replace(/^['"]+|['"]+$/g, '').trim();
  }
  return cleaned;
}

function normalizePathForMatching(raw: string, cwd = process.cwd(), platform = process.platform): string {
  const clean = raw.trim().replace(/\\/g, '/');
  if (!clean) return '';
  const normalizedCwd = resolve(cwd).replace(/\\/g, '/');
  const resolved = resolve(cwd, clean).replace(/\\/g, '/');
  const isWin = platform === 'win32';
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

function extractToolArgumentString(tool: string, input: unknown, cwd?: string, platform = process.platform): string {
  if (typeof input === 'string') return tool === 'bash' ? input.trim() : normalizePathForMatching(input, cwd, platform);
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command.trim();
  if (typeof obj.path === 'string') return normalizePathForMatching(obj.path, cwd, platform);
  if (typeof obj.file_path === 'string') return normalizePathForMatching(obj.file_path, cwd, platform);
  return JSON.stringify(input);
}

function matchSimplePattern(pattern: string, text: string, caseSensitive = false): boolean {
  const p = pattern.trim();
  if (p === '*' || p === '') return true;
  if (!p.includes('*')) {
    return caseSensitive ? p === text : p.toLowerCase() === text.toLowerCase();
  }
  const pieces = p.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const flags = caseSensitive ? '' : 'i';
  if (pieces.length === 2 && pieces[0].endsWith(' ') && pieces[1] === '') {
    const base = pieces[0].trimEnd();
    return new RegExp(`^${base}(?:\\s+.*)?$`, flags).test(text);
  }
  return new RegExp(`^${pieces.join('.*')}$`, flags).test(text);
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
  options: { isAllow?: boolean; cwd?: string; platform?: NodeJS.Platform } = {},
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const parenIdx = trimmed.indexOf('(');
  const canonicalRequestTool = normalizeToolName(request.tool);
  const platform = options.platform ?? process.platform;
  if (parenIdx > 0 && trimmed.endsWith(')')) {
    const toolName = trimmed.slice(0, parenIdx).trim();
    const canonicalTool = normalizeToolName(toolName);
    if (!matchSimplePattern(canonicalTool, canonicalRequestTool)) return false;
    const rawArgPattern = trimmed.slice(parenIdx + 1, -1).trim();
    const argStr = extractToolArgumentString(canonicalRequestTool, request.input, options.cwd, platform);
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
    const isPathCaseSensitive = platform !== 'win32';
    const normalizedPattern = normalizePathForMatching(rawArgPattern, options.cwd, platform);
    return matchSimplePattern(normalizedPattern, argStr, isPathCaseSensitive);
  }
  const canonicalPatternTool = normalizeToolName(trimmed);
  if (!matchSimplePattern(canonicalPatternTool, canonicalRequestTool)) return false;
  if (canonicalRequestTool === 'bash' && options.isAllow) {
    const argStr = extractToolArgumentString(canonicalRequestTool, request.input, options.cwd, platform);
    if (CHAINING_PATTERN.test(argStr)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates tool execution policy following strict precedence:
 * 1. CLI disallowed tools -> 'deny'
 * 2. User deny rules -> 'deny' (cannot be widened by project rules or CLI allow)
 * 3. Project deny rules -> 'deny'
 * 4. CLI allowed tools -> 'allow' (overrides ask and allow, but NOT persistent deny)
 * 5. User ask rules -> 'ask'
 * 6. Project ask rules -> 'ask'
 * 7. Project allow rules -> 'allow'
 * 8. User allow rules -> 'allow'
 * 9. Default -> 'default' (falls through to ToolRegistry permission mode check)
 */
export function evaluateToolPolicy(
  request: ToolRequest,
  ctx: PolicyEvaluationContext,
): PolicyDecision {
  const allowOpts = { isAllow: true, cwd: ctx.cwd, platform: ctx.platform };
  const denyOpts = { isAllow: false, cwd: ctx.cwd, platform: ctx.platform };

  // 1. CLI disallowed
  if (ctx.cliDisallowed?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 2. User deny
  if (ctx.userRules?.deny?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 3. Project deny
  if (ctx.projectRules?.deny?.some(p => matchToolPattern(p, request, denyOpts))) {
    return 'deny';
  }
  // 4. CLI allowed (overrides ask and allow, but NOT persistent deny)
  if (ctx.cliAllowed?.some(p => matchToolPattern(p, request, allowOpts))) {
    return 'allow';
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
