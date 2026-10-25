import { createHash } from 'node:crypto';
import { readFile, mkdir, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { normalizeToolName } from './tools.js';
import { childEnv } from './process.js';
import { configDir, atomicJson } from './config.js';
import {
  type HookEvent,
  type HookDefinition,
  hookEventSchema,
  hookDefinitionSchema,
  projectSettingsPath,
} from './settings.js';

export {
  type HookEvent,
  type HookDefinition,
  hookEventSchema,
  hookDefinitionSchema,
};

export interface HookPayload {
  event: HookEvent;
  sessionId?: string;
  timestamp: string;
  cwd: string;
  [key: string]: unknown;
}

export interface HookExecutionResult {
  executed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  denied?: boolean;
  timedOut?: boolean;
  injectedContext?: string;
  error?: string;
}

export interface HookBusOptions {
  hooks: HookDefinition[];
  cwd: string;
  isTrusted?: boolean;
  timeoutMs?: number;
  onWarning?: (warning: string) => void;
}

function trustedWorkspacesFile(): string {
  return join(configDir(), 'trusted_workspaces.json');
}

function normalizeWorkspaceDir(cwd: string): string {
  const resolved = resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Computes a SHA-256 trust hash covering `<cwd>/.vyen/settings.json` and any local
 * files/scripts directly referenced in hook commands.
 */
export async function calculateWorkspaceTrustHash(
  cwd: string,
  hookCommands: string[],
): Promise<string> {
  const hasher = createHash('sha256');
  const normalizedCwd = resolve(cwd);

  // 1. Hash .vyen/settings.json if present
  const settingsFile = projectSettingsPath(normalizedCwd);
  try {
    const settingsData = await readFile(settingsFile);
    hasher.update('settings:');
    hasher.update(settingsData);
  } catch {
    hasher.update('settings:none');
  }

  // 2. Discover and hash any local files referenced in hook commands or allow rules
  const checkedFiles = new Set<string>();
  for (const rawCmd of hookCommands) {
    const cmdStr = rawCmd.trim();
    if (!cmdStr) continue;

    // Unpack wrapper patterns like bash(...) or read_file(...)
    const parenIdx = cmdStr.indexOf('(');
    const candidateStrings = [cmdStr];
    if (parenIdx > 0 && cmdStr.endsWith(')')) {
      candidateStrings.push(cmdStr.slice(parenIdx + 1, -1).trim());
    }

    for (const str of candidateStrings) {
      const tokens = str.match(/[^\s"']+|"[^"]*"|'[^']*'/g) || [];
      for (const token of tokens) {
        // Strip potential quotes
        const cleanToken = token.replace(/^['"]|['"]$/g, '');
        if (!cleanToken || cleanToken === '*' || cleanToken === '.') continue;

        const isExplicitScriptOrPath =
          cleanToken.startsWith('./') ||
          cleanToken.startsWith('../') ||
          cleanToken.includes('/') ||
          cleanToken.includes('\\') ||
          /\.(?:sh|bash|zsh|fish|ps1|js|mjs|cjs|ts|py|rb|pl|exe|bat|cmd)$/i.test(cleanToken);

        // Expand wildcards if present in script path e.g. ./scripts/*.sh
        let candidateFiles = [cleanToken];
        if (isExplicitScriptOrPath && (cleanToken.includes('*') || cleanToken.includes('?'))) {
          const dirPart = dirname(cleanToken);
          const resolvedDir = resolve(normalizedCwd, dirPart);
          try {
            const entries = await readdir(resolvedDir, { withFileTypes: true });
            const patternPiece = basename(cleanToken);
            const patRegex = new RegExp('^' + patternPiece.split('*').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$', 'i');
            const matched = entries.filter(e => e.isFile() && patRegex.test(e.name)).map(e => join(dirPart, e.name).replace(/\\/g, '/')).sort();
            candidateFiles = matched.length > 0 ? matched : [];
            if (matched.length === 0) {
              hasher.update(`file:${cleanToken}:empty`);
            }
          } catch {
            candidateFiles = [];
            hasher.update(`file:${cleanToken}:missing`);
          }
        }

        for (const fileCandidate of candidateFiles) {
          const potentialPath = resolve(normalizedCwd, fileCandidate);
          if (checkedFiles.has(potentialPath)) continue;
          checkedFiles.add(potentialPath);

          try {
            const fileStat = await stat(potentialPath);
            if (fileStat.isFile()) {
              const content = await readFile(potentialPath);
              hasher.update(`file:${fileCandidate}:`);
              hasher.update(content);
            }
          } catch {
            // If it was an explicit script path that does not exist, hash a missing sentinel
            // so creating the file later immediately invalidates the trust hash
            if (isExplicitScriptOrPath) {
              hasher.update(`file:${fileCandidate}:missing`);
            }
          }
        }
      }
    }
  }

  return hasher.digest('hex');
}

/**
 * Checks if the workspace at `cwd` is trusted for the given expected hash.
 */
export async function isWorkspaceTrusted(
  cwd: string,
  expectedHash: string,
): Promise<boolean> {
  const storePath = trustedWorkspacesFile();
  try {
    const raw = await readFile(storePath, 'utf8');
    const records = JSON.parse(raw) as Record<string, string>;
    const normalized = normalizeWorkspaceDir(cwd);
    return records[normalized] === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Records workspace trust for `cwd` with the calculated hash.
 */
export async function recordWorkspaceTrust(
  cwd: string,
  hash: string,
): Promise<void> {
  const storePath = trustedWorkspacesFile();
  let records: Record<string, string> = {};
  try {
    const raw = await readFile(storePath, 'utf8');
    records = JSON.parse(raw) as Record<string, string>;
  } catch {
    records = {};
  }

  records[normalizeWorkspaceDir(cwd)] = hash;
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await atomicJson(storePath, records);
}

import { spawn } from 'node:child_process';

const PRESERVED_ENV_KEYS = new Set([
  'SSH_AUTH_SOCK',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

/**
 * Creates a sanitized environment object that strips API keys and credentials
 * so child hook processes cannot accidentally or maliciously access them,
 * while preserving essential Git identity and SSH authentication sockets.
 */
export function sanitizeEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const protectedBase = childEnv(baseEnv);
  const clean: NodeJS.ProcessEnv = {};
  const sensitivePattern = /KEY|TOKEN|SECRET|AUTH|PASS|CREDENTIAL|PRIVATE/i;

  for (const [key, value] of Object.entries(protectedBase)) {
    if (!key) continue;
    if (PRESERVED_ENV_KEYS.has(key)) {
      clean[key] = value;
      continue;
    }
    if (sensitivePattern.test(key) || key === 'VYEN_API_KEY') {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Checks whether a hook's matcher matches the given event and payload.
 */
export function matchesHook(
  matcher: string | undefined,
  event: HookEvent,
  payload: Record<string, unknown>,
): boolean {
  if (!matcher || matcher === '*' || matcher === '') {
    return true;
  }

  if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const rawTool = typeof payload.tool === 'string' ? payload.tool : '';
    const toolName = rawTool.toLowerCase();
    const m = matcher.toLowerCase();
    if (m === toolName || normalizeToolName(m) === toolName) return true;
    if (m.endsWith('*') && toolName.startsWith(m.slice(0, -1))) return true;
    return false;
  }

  return true;
}

export class HookBus {
  readonly hooks: HookDefinition[];
  readonly cwd: string;
  readonly isTrusted: boolean;
  readonly defaultTimeoutMs: number;
  onWarning?: (warning: string) => void;

  constructor(options: HookBusOptions) {
    this.hooks = options.hooks;
    this.cwd = resolve(options.cwd);
    this.isTrusted = options.isTrusted ?? false;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    this.onWarning = options.onWarning;
  }

  /**
   * Dispatches an event to all matching hooks sequentially.
   * If any hook exits with code 2, it signals tool denial.
   * Broken or timing-out hooks capture errors without throwing exceptions.
   */
  async dispatch(
    event: HookEvent,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult[]> {
    if (!this.isTrusted || signal?.aborted) {
      return [];
    }

    const matching = this.hooks.filter(
      h => h.event === event && matchesHook(h.matcher, event, payload),
    );

    const results: HookExecutionResult[] = [];
    const sanitizedEnv = sanitizeEnvironment();

    const basePayload: HookPayload = {
      event,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      ...payload,
    };
    const inputJson = `${JSON.stringify(basePayload)}\n`;

    for (const hook of matching) {
      if (signal?.aborted) break;
      const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
      const result = await this.executeCommand(event, hook.command, inputJson, sanitizedEnv, timeoutMs, signal);
      if (result.error && this.onWarning) {
        this.onWarning(`[Hook error (${hook.event})]: ${result.error}`);
      }
      results.push(result);
    }

    return results;
  }

  private executeCommand(
    event: HookEvent,
    command: string,
    inputJson: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    return new Promise<HookExecutionResult>(resolvePromise => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      const MAX_OUTPUT = 1024 * 1024; // 1MB buffer ceiling

      const child = spawn(command, {
        cwd: this.cwd,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      child.stdin.on('error', () => {
        // Prevent unhandled stream error (e.g. EPIPE) if child exits before reading stdin
      });

      const killChild = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          try {
            const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            taskkill.on('error', () => {
              try { child.kill('SIGKILL'); } catch { /* ignore */ }
            });
            child.kill('SIGKILL');
            try { child.stdout?.destroy(); } catch { /* ignore */ }
            try { child.stderr?.destroy(); } catch { /* ignore */ }
            try { child.stdin?.destroy(); } catch { /* ignore */ }
          } catch {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }
          }
        }
      };

      const onAbort = () => {
        aborted = true;
        killChild();
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', chunk => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
      });

      child.on('error', err => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolvePromise({
          executed: false,
          exitCode: 1,
          stdout,
          stderr,
          denied: event === 'PreToolUse',
          error: err.message,
        });
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        const exitCode = timedOut ? 124 : (code ?? (aborted ? 130 : 1));
        const isPreToolUse = event === 'PreToolUse';
        const denied = exitCode === 2 || (isPreToolUse && (exitCode !== 0 || Boolean(timedOut)));
        const injectedContext =
          exitCode === 0 && stdout.trim().length > 0 ? stdout.trim() : undefined;
        let error: string | undefined;

        if (timedOut) {
          error = `Hook timed out after ${timeoutMs}ms`;
        } else if (aborted) {
          error = 'Hook execution aborted';
        } else if (exitCode !== 0 && exitCode !== 2) {
          error = stderr.trim() || `Hook exited with code ${exitCode}`;
        }

        resolvePromise({
          executed: true,
          exitCode,
          stdout,
          stderr,
          denied,
          timedOut: Boolean(timedOut),
          injectedContext,
          error,
        });
      });

      try {
        child.stdin.write(inputJson, 'utf8');
        child.stdin.end();
      } catch {
        // Child could exit before writing
      }
    });
  }
}
