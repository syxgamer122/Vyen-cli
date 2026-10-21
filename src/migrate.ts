import { constants, copyFile, mkdir, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MIGRATION_MARKER = '.migrated-from-goon';

const CONFIG_ENTRIES = ['config.json', 'credentials.json', 'mcp.json', 'memories.json', 'presets.json'];
const CONFIG_DIRECTORIES = ['skills'];
const DATA_DIRECTORIES = ['sessions', 'subagents'];

export interface MigrationReport {
  migrated: boolean;
  skipped: boolean;
  copied: string[];
  error?: string;
}

/** ENOENT means "not there"; every other errno is a real problem to report. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Creates the target only when it is absent, so an existing file is never overwritten. */
async function copyFileExclusive(from: string, to: string): Promise<boolean> {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Copies a directory tree file by file. A recursive copy that dies half way
 * leaves a partial directory behind, and a directory-level skip would then
 * skip it forever; merging per file lets the next run finish the job.
 */
async function copyTree(from: string, to: string): Promise<boolean> {
  const entries = await readdir(from, { withFileTypes: true });
  await mkdir(to, { recursive: true, mode: 0o700 });
  let copied = false;
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      if (await copyTree(source, target)) copied = true;
    } else if (entry.isFile()) {
      if (await copyFileExclusive(source, target)) copied = true;
    }
  }
  return copied;
}

/**
 * Copies a legacy goon installation's data into the vyen directories.
 *
 * The marker file, not the existence of the target directory, decides whether
 * a migration still has to run: a run interrupted halfway leaves a partial
 * copy behind, and the next launch has to finish it. Existing files in the
 * target are never overwritten, so a hand-edited vyen config survives.
 *
 * The legacy directory is copied, never moved or deleted, so rolling back
 * stays possible. Nothing here throws — a failed migration is reported.
 */
export async function migrateLegacyData(options: {
  legacyConfigDir: string;
  legacyDataDir: string;
  configDir: string;
  dataDir: string;
}): Promise<MigrationReport> {
  const { legacyConfigDir, legacyDataDir, configDir, dataDir } = options;
  const copied: string[] = [];
  try {
    const marker = join(configDir, MIGRATION_MARKER);
    if (await exists(marker)) return { migrated: false, skipped: true, copied: [] };
    if (!await exists(legacyConfigDir) && !await exists(legacyDataDir)) {
      return { migrated: false, skipped: false, copied: [] };
    }
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    for (const name of CONFIG_ENTRIES) {
      const from = join(legacyConfigDir, name);
      const to = join(configDir, name);
      if (await exists(from) && await copyFileExclusive(from, to)) copied.push(name);
    }
    for (const name of CONFIG_DIRECTORIES) {
      const from = join(legacyConfigDir, name);
      const to = join(configDir, name);
      if (await exists(from) && await copyTree(from, to)) copied.push(name);
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    for (const name of DATA_DIRECTORIES) {
      const from = join(legacyDataDir, name);
      const to = join(dataDir, name);
      if (await exists(from) && await copyTree(from, to)) copied.push(name);
    }
    try {
      await writeFile(
        marker,
        `${JSON.stringify({ migratedAt: new Date().toISOString(), source: legacyConfigDir }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      // Another process finished the migration first; that is a success.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return { migrated: true, skipped: false, copied };
  } catch (error) {
    return { migrated: false, skipped: false, copied, error: error instanceof Error ? error.message : String(error) };
  }
}
