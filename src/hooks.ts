import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configDir } from './config.js';
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
  injectedContext?: string;
  error?: string;
}

function trustedWorkspacesFile(): string {
  return join(configDir(), 'trusted_workspaces.json');
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

  // 2. Discover and hash any local files referenced in hook commands
  const checkedFiles = new Set<string>();
  for (const cmd of hookCommands) {
    const tokens = cmd.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      // Strip potential quotes
      const cleanToken = token.replace(/^['"]|['"]$/g, '');
      const potentialPath = resolve(normalizedCwd, cleanToken);
      if (checkedFiles.has(potentialPath)) continue;
      checkedFiles.add(potentialPath);

      try {
        const fileStat = await stat(potentialPath);
        if (fileStat.isFile()) {
          const content = await readFile(potentialPath);
          hasher.update(`file:${cleanToken}:`);
          hasher.update(content);
        }
      } catch {
        // Not a readable local file; skip
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
    const normalized = resolve(cwd);
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

  records[resolve(cwd)] = hash;
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(storePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

import { spawn } from 'node:child_process';

/**
 * Creates a sanitized environment object that strips API keys and credentials
 * so child hook processes cannot accidentally or maliciously access them.
 */
export function sanitizeEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  const sensitivePattern = /API[_-]?KEY|TOKEN|SECRET|AUTH|PASSWORD|CREDENTIAL|PRIVATE/i;

  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key || sensitivePattern.test(key) || key === 'VYEN_API_KEY') {
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
    const toolName = typeof payload.tool === 'string' ? payload.tool : '';
    if (matcher === toolName) return true;
    if (matcher.endsWith('*') && toolName.startsWith(matcher.slice(0, -1))) return true;
    return false;
  }

  return true;
}

export class HookBus {
  readonly hooks: HookDefinition[];
  readonly cwd: string;
  readonly isTrusted: boolean;
  readonly defaultTimeoutMs: number;

  constructor(options: {
    hooks: HookDefinition[];
    cwd: string;
    isTrusted?: boolean;
    timeoutMs?: number;
  }) {
    this.hooks = options.hooks;
    this.cwd = resolve(options.cwd);
    this.isTrusted = options.isTrusted ?? true;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Dispatches an event to all matching hooks sequentially.
   * If any hook exits with code 2, it signals tool denial.
   * Broken or timing-out hooks capture errors without throwing exceptions.
   */
  async dispatch(
    event: HookEvent,
    payload: Record<string, unknown>,
  ): Promise<HookExecutionResult[]> {
    if (!this.isTrusted) {
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
      const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
      const result = await this.executeCommand(hook.command, inputJson, sanitizedEnv, timeoutMs);
      results.push(result);
    }

    return results;
  }

  private executeCommand(
    command: string,
    inputJson: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<HookExecutionResult> {
    return new Promise<HookExecutionResult>(resolvePromise => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(command, {
        cwd: this.cwd,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already ended
        }
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolvePromise({
          executed: false,
          exitCode: 1,
          stdout,
          stderr,
          denied: false,
          error: err.message,
        });
      });

      child.on('close', code => {
        clearTimeout(timer);
        const exitCode = code ?? (timedOut ? 124 : 1);
        const denied = exitCode === 2;
        const injectedContext =
          exitCode === 0 && stdout.trim().length > 0 ? stdout.trim() : undefined;
        let error: string | undefined;

        if (timedOut) {
          error = `Hook timed out after ${timeoutMs}ms`;
        } else if (exitCode !== 0 && exitCode !== 2) {
          error = stderr.trim() || `Hook exited with code ${exitCode}`;
        }

        resolvePromise({
          executed: true,
          exitCode,
          stdout,
          stderr,
          denied,
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
