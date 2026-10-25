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
// A command position that starts with a substitution has no static command
// word; deny/ask rules must fail closed instead of guessing what it expands to.
const DYNAMIC_COMMAND_PREFIX_REGEX = /(?:^|[;&|\r\n])\s*(?:\$\(|`)/;
const WRAPPER_PREFIX_REGEX = /^(?:(?:(?:\/usr)?\/bin\/)?sudo(?:\s+(?:-[ugpCDRTrtU]\s+[^\s]+|-[a-zA-Z]+|--[a-zA-Z-]*(?:=[^\s]+)?))*\s+|(?:(?:\/usr)?\/bin\/)?env(?:\s+(?:-[uC]\s+[^\s]+|-[a-zA-Z0-9]+|--[a-zA-Z-]*(?:=[^\s]+)?|[a-zA-Z_][a-zA-Z0-9_]*=[^\s]*))*\s+|(?:[a-zA-Z_][a-zA-Z0-9_]*=[^\s]*\s+)+|(?:(?:\/usr)?\/bin\/)?(?:bash|sh)(?:\s+(?:--?[a-zA-Z][a-zA-Z0-9-]*))*\s+|(?:eval|exec|command|builtin)(?:\s+--?[a-zA-Z-]*)*\s+|(?:nohup|setsid)(?:\s+--?[a-zA-Z-]*)*\s+|time(?:\s+(?:-o\s+[^\s]+|-f\s+[^\s]+|-[a-zA-Z]+|--[a-zA-Z-]*(?:=[^\s]+)?))*\s+|nice(?:\s+(?:-n\s*\d+|-\d+|--adjustment=\d+|-[a-zA-Z]+|--[a-zA-Z-]*))*\s+|stdbuf(?:\s+(?:-[ioe]\s*[^\s]+|-[a-zA-Z]+|--[a-zA-Z-]*(?:=[^\s]+)?))*\s+|timeout(?:\s+(?:-[ks]\s*[^\s]+|-[a-zA-Z]+|--[a-zA-Z-]*(?:=[^\s]+)?))*\s+\d+(?:\.\d+)?[smhd]?\s+|xargs(?:\s+(?:-[0rtx]+|-[adEILnPs]\s*[^\s]+|--[a-zA-Z-]*(?:=[^\s]+)?))*\s+|(?:!|then|do|else|elif|if|while|until|for|select|case|function)\s+|(?:\d*(?:>>?|<<?|>&|<&)\s*(?:&?\d+|[^\s;&|]+)\s+)+)/i;

const SHELL_WORD_DELIMITER = /[\s;&|<>()`]/;

/**
 * Reads the command word of one shell segment the way bash would: quotes and
 * backslash escapes are removed, so `"rm"`, `r\m` and `r""m` all become `rm`.
 * `dynamic` marks a word built from an expansion (`$CMD`, `rm${IFS}-rf`): the
 * real command cannot be known before expansion, so deny/ask rules must fail
 * closed instead of guessing.
 */
function normalizeCommandWord(segment: string): { word: string; rest: string; dynamic: boolean } {
  let index = 0;
  let word = '';
  let dynamic = false;
  let quote: '"' | "'" | null = null;
  while (index < segment.length) {
    const char = segment[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = null; index += 1; continue; }
      if (char === '\\' && index + 1 < segment.length && '"\\$`'.includes(segment[index + 1])) {
        word += segment[index + 1];
        index += 2;
        continue;
      }
      if (char === '$' || char === '`') dynamic = true;
      word += char;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; index += 1; continue; }
    if (char === '\\') {
      if (index + 1 < segment.length) { word += segment[index + 1]; index += 2; }
      else index += 1;
      continue;
    }
    if (char === '$' || char === '`') { dynamic = true; word += char; index += 1; continue; }
    if (SHELL_WORD_DELIMITER.test(char)) break;
    word += char;
    index += 1;
  }
  return { word, rest: segment.slice(index), dynamic };
}

function cleanCommandSegment(
  segment: string,
  depth = 0,
  platform: NodeJS.Platform = process.platform,
): { texts: string[]; dynamic: boolean } {
  let cleaned = segment.trim();
  // `{a,b}` is brace expansion: the shell builds the command word, so deny/ask
  // rules must fail closed instead of reading it as a literal name.
  if (/^\{[^\s}]*,[^\s}]*\}/.test(cleaned)) return { texts: [cleaned], dynamic: true };
  let previous = '';
  while (previous !== cleaned) {
    previous = cleaned;
    // Strip subshell groupings e.g. (cmd) or { cmd; }
    cleaned = cleaned.replace(/^[\s({]+|[\s)}]+$/g, '').trim();
    // Strip wrappers e.g. sudo, env, nohup, sh -c, command, eval, redirections
    cleaned = cleaned.replace(WRAPPER_PREFIX_REGEX, '').trim();
  }
  if (!cleaned) return { texts: [], dynamic: false };
  const { word, rest, dynamic } = normalizeCommandWord(cleaned);
  if (!word) return { texts: [cleaned], dynamic };
  const text = `${word}${rest}`.trim();
  const texts = [text];
  // `/bin/rm` and `C:/bin/rm.exe` run the same program as `rm`; a deny rule
  // written for the bare name must still see it.
  const baseWord = word.split(/[\\/]/).pop() ?? word;
  const alternateWord = platform === 'win32' ? baseWord.replace(/\.exe$/i, '') : baseWord;
  const alternate = `${alternateWord}${rest}`.trim();
  if (alternate !== text) texts.push(alternate);
  // A wrapper such as `bash -c` leaves its whole command as one quoted word.
  // Re-read it so `bash -c 'FOO=1 rm -rf /'` is judged by the command it runs.
  if (depth < 8 && !rest.trim() && /\s/.test(word)) {
    const inner = cleanCommandSegment(word, depth + 1, platform);
    texts.push(...inner.texts);
    if (inner.dynamic) return { texts, dynamic: true };
  }
  // `find ... -exec rm ...` runs the command after -exec.
  if (depth < 8 && /^find(?:\.exe)?$/i.test(baseWord)) {
    const exec = /\s-(?:exec|execdir|ok|okdir)\s+/i.exec(rest);
    if (exec) {
      const inner = cleanCommandSegment(rest.slice(exec.index + exec[0].length), depth + 1, platform);
      texts.push(...inner.texts);
      if (inner.dynamic) return { texts, dynamic: true };
    }
  }
  return { texts, dynamic };
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
      // A backslash-newline is removed by the shell before tokenization.
      // Leading assignments are not commands; a simple `x=$(date)` prefix is
      // removed so the command after it is still judged (and a nested one fails
      // closed below).
      const commandText = argStr
        .replace(/\\\r?\n/g, '')
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\$\([^()]*\)|[^\s]*)\s+)+/, '');
      // Security: In deny/ask rules, match if either full command or ANY segment matches
      if (matchSimplePattern(rawArgPattern, commandText)) return true;
      // A command substitution in command position has no static command word.
      if (DYNAMIC_COMMAND_PREFIX_REGEX.test(commandText)) return true;
      // A nested substitution inside an assignment prefix could not be removed.
      if (/^[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(commandText)) return true;
      const rawSegments = commandText.split(COMPOUND_SPLIT_REGEX);
      for (const seg of rawSegments) {
        // Match the untouched segment too: a deny rule written for a wrapper
        // (`sudo *`) must still see the wrapper after it is stripped below.
        const raw = seg.trim();
        if (raw && matchSimplePattern(rawArgPattern, raw)) return true;
        const cleaned = cleanCommandSegment(seg, 0, platform);
        if (!cleaned.texts.length) continue;
        // A command word built from an expansion cannot be known before expansion:
        // deny/ask must fail closed, never treat it as "no match".
        if (cleaned.dynamic) return true;
        if (cleaned.texts.some(text => matchSimplePattern(rawArgPattern, text))) return true;
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
