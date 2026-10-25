import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, dataDir } from './config.js';
import { childEnv } from './process.js';
import { VERSION } from './version.js';

// The registered name; a rename must reach package.json, this constant and the
// release workflow together.
export const PACKAGE_NAME = '@nguyenhuumanh/vyen';
export const INSTALL_METHODS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];
export type UpdatePolicy = 'disable' | 'notify' | 'auto';
export type UpdateAction = 'none' | 'notify' | 'auto';
export const UPDATE_CHECK_TTL_MS = 86_400_000;
export const UPDATE_CACHE_FILE = 'update-check.json';

export interface ParsedVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

export interface UpgradeCommand {
  command: string;
  args: string[];
}

export interface UpdateCacheEntry {
  checkedAt: string;
  latest: string;
}

export interface UpdateCheckOptions {
  policy: UpdatePolicy;
  current: string;
  cacheFile?: string;
  now?: number;
  fetchLatest?: () => Promise<string | undefined>;
}

export interface UpdateCheckResult {
  action: UpdateAction;
  latest?: string;
  refresh?: Promise<void>;
}

export interface UpgradeOptions {
  target?: string;
  method?: string;
  dryRun?: boolean;
  stdout: TextSink;
  stderr: TextSink;
  current?: string;
  detect?: () => Promise<InstallMethod | undefined>;
  fetchLatest?: () => Promise<string | undefined>;
}

export interface TextSink {
  write(chunk: string): unknown;
}

export type RunCapture = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

// OpenCode's upgrade command asks the package manager to replace the package the
// running process came from. vyen ships only through npm, so the same four
// managers cover every supported installation.
const LISTING: Record<InstallMethod, { command: string; args: string[] }> = {
  npm: { command: 'npm', args: ['list', '--global', '--depth=0', PACKAGE_NAME] },
  pnpm: { command: 'pnpm', args: ['list', '--global', '--depth=0', PACKAGE_NAME] },
  yarn: { command: 'yarn', args: ['global', 'list'] },
  bun: { command: 'bun', args: ['pm', 'ls', '--global'] },
};

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function hasLeadingZero(value: string): boolean {
  return value.length > 1 && value.startsWith('0');
}

/** Strict-enough semver parse: release versions only, no leading zeros, 256-char cap. */
export function parseVersion(input: string): ParsedVersion | undefined {
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  if (!value || value.length > 256) return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const [, major, minor, patch] = match;
  if ([major, minor, patch].some(hasLeadingZero)) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(identifier => /^\d+$/.test(identifier) && hasLeadingZero(identifier))) return undefined;
  return { major, minor, patch, prerelease };
}

function compareNumeric(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return compareNumeric(left, right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Returns -1, 0 or 1; build metadata is ignored; invalid input compares as equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return compareNumeric(left.major, right.major)
    || compareNumeric(left.minor, right.minor)
    || compareNumeric(left.patch, right.patch)
    || comparePrerelease(left.prerelease, right.prerelease);
}

export function updateAction(current: string, latest: string, policy: UpdatePolicy): UpdateAction {
  if (policy === 'disable') return 'none';
  if (!parseVersion(current) || !parseVersion(latest)) return 'none';
  return compareVersions(latest, current) > 0 ? policy : 'none';
}

export function updateNotice(current: string, latest: string): string {
  return `vyen ${latest} is available (installed ${current}). Run: vyen upgrade`;
}

export function upgradeCommand(method: InstallMethod, version: string): UpgradeCommand {
  const spec = `${PACKAGE_NAME}@${version.replace(/^v/, '')}`;
  switch (method) {
    case 'npm': return { command: 'npm', args: ['install', '--global', spec, '--no-audit', '--no-fund'] };
    case 'pnpm': return { command: 'pnpm', args: ['add', '--global', spec] };
    case 'yarn': return { command: 'yarn', args: ['global', 'add', spec] };
    case 'bun': return { command: 'bun', args: ['install', '--global', spec] };
  }
}

/**
 * Cheap hint from the running package path. It is never trusted alone:
 * detectInstallMethod still asks the manager's global listing.
 */
export function methodFromPath(path: string): InstallMethod | undefined {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/global/')) return 'bun';
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/global/') || normalized.includes('/pnpm-global/')) return 'pnpm';
  if (normalized.includes('/yarn/global/') || normalized.includes('/.config/yarn/')) return 'yarn';
  if (normalized.includes('/node_modules/@nguyenhuumanh/vyen/')) return 'npm';
  return undefined;
}

function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

function captureCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise(resolvePromise => {
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, output });
    };
    let child: ChildProcess;
    try {
      // npm/pnpm/yarn/bun are .cmd shims on Windows and cannot be spawned
      // without a shell there (EINVAL since the Node 18 security change).
      child = spawn(command, args, {
        shell: process.platform === 'win32',
        windowsHide: true,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolvePromise({ code: 1, output: '' });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(1);
    }, timeoutMs);
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.once('error', () => finish(1));
    child.once('close', code => finish(code ?? 1));
  });
}

export async function detectInstallMethod(options: {
  packageRoot?: string;
  run?: RunCapture;
} = {}): Promise<InstallMethod | undefined> {
  const root = options.packageRoot ?? packageRoot();
  const run = options.run ?? ((command: string, args: string[]) => captureCommand(command, args, 8000));
  const hint = methodFromPath(root);
  if (hint) {
    const listing = LISTING[hint];
    const result = await run(listing.command, listing.args).catch(() => ({ code: 1, output: '' }));
    if (result.code === 0 && result.output.includes(PACKAGE_NAME)) return hint;
  }
  const candidates = INSTALL_METHODS.filter(method => method !== hint);
  const results = await Promise.all(candidates.map(async method => {
    const listing = LISTING[method];
    const result = await run(listing.command, listing.args).catch(() => ({ code: 1, output: '' }));
    return { method, found: result.code === 0 && result.output.includes(PACKAGE_NAME) };
  }));
  return results.find(result => result.found)?.method;
}

export function registryUrl(): string {
  const configured = process.env.VYEN_REGISTRY
    ?? process.env.GOON_REGISTRY
    ?? process.env.npm_config_registry
    ?? 'https://registry.npmjs.org';
  return configured.trim().replace(/\/+$/, '') || 'https://registry.npmjs.org';
}

export async function fetchLatestVersion(options: { registry?: string } = {}): Promise<string | undefined> {
  const registry = (options.registry ?? registryUrl()).replace(/\/+$/, '');
  const url = `${registry}/${PACKAGE_NAME.replace('/', '%2F')}/latest`;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === 'string' && parseVersion(body.version) ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export function updateCachePath(): string {
  return join(dataDir(), UPDATE_CACHE_FILE);
}

export async function readUpdateCache(file = updateCachePath()): Promise<UpdateCacheEntry | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return undefined;
    const { checkedAt, latest } = raw;
    if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) return undefined;
    if (typeof latest !== 'string' || !parseVersion(latest)) return undefined;
    return { checkedAt, latest };
  } catch {
    return undefined;
  }
}

export async function writeUpdateCache(file: string, entry: UpdateCacheEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await atomicJson(file, entry);
}

/**
 * Reads the local cache and returns immediately. A stale or missing cache starts
 * `refresh` (never rejected); the caller can ignore it and the next start sees
 * the fresh value. Network work never delays the caller.
 */
export async function checkForUpdates(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  if (options.policy === 'disable') return { action: 'none' };
  const file = options.cacheFile ?? updateCachePath();
  const now = options.now ?? Date.now();
  const cache = await readUpdateCache(file);
  const fresh = cache !== undefined && now - Date.parse(cache.checkedAt) <= UPDATE_CHECK_TTL_MS;
  let refresh: Promise<void> | undefined;
  if (!fresh) {
    refresh = (async () => {
      const latest = await (options.fetchLatest ?? fetchLatestVersion)();
      if (!latest || !parseVersion(latest)) return;
      await writeUpdateCache(file, { checkedAt: new Date(now).toISOString(), latest });
    })().catch(() => {});
  }
  const action = cache ? updateAction(options.current, cache.latest, options.policy) : 'none';
  return action === 'none' ? { action, refresh } : { action, latest: cache?.latest, refresh };
}

function installTarget(parsed: ParsedVersion): string {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join('.')}` : ''}`;
}

function spawnInherit(command: string, args: string[]): Promise<number> {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
      env: childEnv(),
    });
    child.once('error', () => resolvePromise(1));
    child.once('close', code => resolvePromise(code ?? 1));
  });
}

export async function runUpgrade(options: UpgradeOptions): Promise<number> {
  let method: InstallMethod | undefined;
  if (options.method !== undefined) {
    const requested = options.method.trim().toLowerCase();
    if (!INSTALL_METHODS.includes(requested as InstallMethod)) {
      options.stderr.write(`vyen: unknown install method "${options.method}". Use npm, pnpm, yarn or bun.\n`);
      return 1;
    }
    method = requested as InstallMethod;
  }

  let target = options.target?.trim().replace(/^v/, '');
  if (!target) {
    const latest = await (options.fetchLatest ?? fetchLatestVersion)();
    if (!latest) {
      options.stderr.write('vyen: could not read the latest version from the registry. Pass a version explicitly: vyen upgrade 0.3.1\n');
      return 1;
    }
    target = latest;
  }
  const parsed = parseVersion(target);
  if (!parsed) {
    options.stderr.write(`vyen: invalid version "${target}". Pass a version like 0.3.1.\n`);
    return 1;
  }
  target = installTarget(parsed);

  const current = options.current ?? VERSION;
  if (compareVersions(target, current) === 0) {
    options.stdout.write(`vyen ${current} is already installed.\n`);
    return 0;
  }

  method ??= await (options.detect ?? detectInstallMethod)();
  if (!method) {
    options.stderr.write('vyen: could not detect how vyen was installed. Re-run with --method npm|pnpm|yarn|bun.\n');
    return 1;
  }

  const command = upgradeCommand(method, target);
  const line = `${command.command} ${command.args.join(' ')}`;
  options.stdout.write(`Installing ${PACKAGE_NAME}@${target} with ${method}...\n`);
  if (options.dryRun) {
    options.stdout.write(`${line}\n`);
    return 0;
  }
  const code = await spawnInherit(command.command, command.args);
  if (code !== 0) {
    options.stderr.write(`vyen: ${command.command} exited with code ${code}. Run it yourself: ${line}\n`);
    return code;
  }
  options.stdout.write(`Installed ${PACKAGE_NAME}@${target}. Restart vyen to use it.\n`);
  return 0;
}
