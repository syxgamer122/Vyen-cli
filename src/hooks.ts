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

export class HookBus {
  constructor(
    readonly options: {
      hooks: HookDefinition[];
      cwd: string;
      isTrusted?: boolean;
      timeoutMs?: number;
    },
  ) {}

  async dispatch(
    _event: HookEvent,
    _payload: Record<string, unknown>,
  ): Promise<HookExecutionResult[]> {
    return [];
  }
}
