import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrateLegacyData } from './migrate.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const configSchema = z.object({
  provider: z.enum(['openai-compatible', 'openai-responses', 'anthropic']).default('openai-compatible'),
  baseUrl: z.string().url().optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  keyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('VYEN_API_KEY'),
  contextWindow: z.number().int().min(8192).max(2_000_000).default(128_000),
  maxOutputTokens: z.number().int().min(128).max(131_072).default(16_384),
  timeoutMs: z.number().int().min(1000).max(1_800_000).default(300_000),
  runTokenBudget: z.number().int().min(0).default(0),
  inlineReasoning: z.enum(['leading-think', 'off']).default('leading-think'),
  showReasoning: z.boolean().default(false),
  approvalMode: z.enum(['ask', 'auto', 'plan', 'readonly']).optional(),
  viewMode: z.enum(['normal', 'verbose', 'transcript']).optional(),
}).strict();
export type Config = z.infer<typeof configSchema>;
export interface RuntimeConfig extends Config { cwd: string; apiKey: string; dataDir: string; baseUrl: string; model: string }
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vyen');
export const configPath = () => join(configDir(), 'config.json');
export const credentialsPath = () => join(configDir(), 'credentials.json');
export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vyen');
export const legacyConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goon');
export const legacyDataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'goon');

const credentialsSchema = z.record(z.string(), z.string());

export async function loadCredentials(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    return credentialsSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return {};
  }
}

export async function saveCredential(keyEnv: string, apiKey: string): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadCredentials();
  const trimmed = apiKey.trim();
  if (trimmed) existing[keyEnv] = trimmed;
  await atomicJson(credentialsPath(), existing);
}

export async function resolveApiKey(config: Config): Promise<string | undefined> {
  const fromEnv = process.env[config.keyEnv]?.trim();
  if (fromEnv) return fromEnv;
  // A goon installation kept its key in GOON_API_KEY. Honour it so an
  // existing shell profile still works after the rename.
  if (config.keyEnv !== 'GOON_API_KEY') {
    const legacy = process.env.GOON_API_KEY?.trim();
    if (legacy) return legacy;
  }
  const stored = await loadCredentials();
  const fromStore = stored[config.keyEnv]?.trim();
  if (fromStore) return fromStore;
  if (config.keyEnv !== 'GOON_API_KEY') return stored['GOON_API_KEY']?.trim() || undefined;
  return undefined;
}

export const DEFAULT_GATEWAY_URL = 'https://api.yuristore.xyz/v1';

export function normalizeGatewayUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    const isKnownGatewayRoot =
      parsed.hostname === 'api.yuristore.xyz' ||
      parsed.host === '127.0.0.1:8000' ||
      parsed.host === 'localhost:8000';
    if ((parsed.pathname === '/' || parsed.pathname === '') && isKnownGatewayRoot) {
      return `${trimmed}/v1`;
    }
  } catch {
    // Keep original if URL parsing fails; loadConfig validates URL format
  }
  return trimmed;
}

export async function loadConfig(overrides: Record<string, unknown> = {}): Promise<Config> {
  // Migrate first: the legacy config.json has to exist at the new path before
  // it is read below.
  await migrateLegacyData({
    legacyConfigDir: legacyConfigDir(),
    legacyDataDir: legacyDataDir(),
    configDir: configDir(),
    dataDir: dataDir(),
  });
  let stored: unknown = {};
  try { stored = JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const validated = configSchema.parse(stored);
  const env: Record<string, unknown> = {};
  // VYEN_* wins; the older GOON_* names stay honoured so an existing shell
  // profile keeps working after the rename.
  const ENV_SOURCES: Record<string, string[]> = {
    provider: ['VYEN_PROVIDER', 'GOON_PROVIDER'],
    baseUrl: ['VYEN_BASE_URL', 'GOON_BASE_URL'],
    model: ['VYEN_MODEL', 'GOON_MODEL'],
    effort: ['VYEN_EFFORT', 'GOON_EFFORT'],
    keyEnv: ['VYEN_KEY_ENV', 'GOON_KEY_ENV'],
    contextWindow: ['VYEN_CONTEXT_WINDOW', 'GOON_CONTEXT_WINDOW'],
    maxOutputTokens: ['VYEN_MAX_OUTPUT_TOKENS', 'GOON_MAX_OUTPUT_TOKENS'],
    timeoutMs: ['VYEN_TIMEOUT_MS', 'GOON_TIMEOUT_MS'],
    runTokenBudget: ['VYEN_RUN_TOKEN_BUDGET', 'GOON_RUN_TOKEN_BUDGET'],
    inlineReasoning: ['VYEN_INLINE_REASONING', 'GOON_INLINE_REASONING'],
  };
  const NUMERIC_KEYS = ['contextWindow', 'maxOutputTokens', 'timeoutMs', 'runTokenBudget'];
  for (const [key, names] of Object.entries(ENV_SOURCES)) {
    for (const name of names) {
      if (process.env[name] === undefined) continue;
      env[key] = NUMERIC_KEYS.includes(key) ? Number(process.env[name]) : process.env[name];
      break;
    }
  }
  const merged = { ...validated, ...env, ...overrides };
  if (env.runTokenBudget === undefined && overrides.runTokenBudget === undefined) {
    merged.runTokenBudget = 0;
  }
  const explicitMaxOut =
    (stored && typeof stored === 'object' && 'maxOutputTokens' in stored) ||
    env.maxOutputTokens !== undefined ||
    overrides.maxOutputTokens !== undefined;
  if (!explicitMaxOut && typeof merged.contextWindow === 'number' && merged.contextWindow > 0 && merged.maxOutputTokens >= merged.contextWindow / 2) {
    merged.maxOutputTokens = Math.max(128, Math.floor(merged.contextWindow / 4));
  }
  const config = configSchema.parse(merged);
  if (config.maxOutputTokens >= config.contextWindow / 2) throw new Error('maxOutputTokens must be less than half contextWindow.');
  if (config.baseUrl) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl must be HTTP(S), without credentials, query or fragment.');
    }
    config.baseUrl = normalizeGatewayUrl(config.baseUrl);
  }
  return config;
}

export async function resolveRuntime(config: Config, cwd: string): Promise<RuntimeConfig> {
  if (!config.model) throw new Error('Missing model. Run "vyen setup" or "vyen init --model MODEL --base-url URL".');
  const apiKey = await resolveApiKey(config);
  if (!apiKey) throw new Error(`Missing ${config.keyEnv}. Run "vyen setup" or set ${config.keyEnv} in your shell.`);
  const baseUrl = config.baseUrl ? normalizeGatewayUrl(config.baseUrl) : DEFAULT_GATEWAY_URL;
  return { ...config, model: config.model, baseUrl, apiKey, cwd: await realpath(resolve(cwd)), dataDir: dataDir() };
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, file); }
  catch (error) { const { unlink } = await import('node:fs/promises'); await unlink(temporary).catch(() => {}); throw error; }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await atomicJson(configPath(), configSchema.parse(config));
}
