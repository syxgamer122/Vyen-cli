import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyData, MIGRATION_MARKER } from '../dist/migrate.js';
import { loadConfig, resolveApiKey } from '../dist/config.js';
import { resolveExecutable } from '../dist/process.js';

const dirs = async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-migrate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyConfigDir = join(root, 'goon-config');
  const legacyDataDir = join(root, 'goon-data');
  const configDir = join(root, 'vyen-config');
  const dataDir = join(root, 'vyen-data');
  await mkdir(legacyConfigDir, { recursive: true });
  await mkdir(legacyDataDir, { recursive: true });
  await writeFile(join(legacyConfigDir, 'config.json'), '{"model":"legacy-model"}');
  await writeFile(join(legacyConfigDir, 'credentials.json'), '{"GOON_API_KEY":"legacy-secret"}');
  await mkdir(join(legacyConfigDir, 'skills', 'demo'), { recursive: true });
  await writeFile(join(legacyConfigDir, 'skills', 'demo', 'SKILL.md'), '# demo');
  await mkdir(join(legacyDataDir, 'sessions'), { recursive: true });
  await writeFile(join(legacyDataDir, 'sessions', 'a.json'), '{}');
  return { legacyConfigDir, legacyDataDir, configDir, dataDir };
};

test('migration copies legacy config, skills and sessions into the vyen directories', async t => {
  const d = await dirs(t);
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(report.error, undefined);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"legacy-model"}');
  assert.equal(await readFile(join(d.configDir, 'credentials.json'), 'utf8'), '{"GOON_API_KEY":"legacy-secret"}');
  assert.equal(await readFile(join(d.configDir, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# demo');
  assert.equal(await readFile(join(d.dataDir, 'sessions', 'a.json'), 'utf8'), '{}');
  assert.ok((await readdir(d.configDir)).includes(MIGRATION_MARKER));
});

test('migration never overwrites a file that already exists in the new directory', async t => {
  const d = await dirs(t);
  await mkdir(d.configDir, { recursive: true });
  await writeFile(join(d.configDir, 'config.json'), '{"model":"hand-edited"}');
  await migrateLegacyData(d);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"hand-edited"}');
});

test('an interrupted migration resumes because the marker, not the directory, gates it', async t => {
  const d = await dirs(t);
  await mkdir(d.configDir, { recursive: true });
  await writeFile(join(d.configDir, 'config.json'), '{"model":"partial"}');
  // No marker: the previous run died before writing one.
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(await readFile(join(d.configDir, 'credentials.json'), 'utf8'), '{"GOON_API_KEY":"legacy-secret"}');
});

test('a completed migration is skipped on the next launch', async t => {
  const d = await dirs(t);
  await migrateLegacyData(d);
  await writeFile(join(d.legacyConfigDir, 'config.json'), '{"model":"changed-after-migration"}');
  const report = await migrateLegacyData(d);
  assert.equal(report.skipped, true);
  assert.equal(report.migrated, false);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"legacy-model"}');
});

test('migration copies a malformed legacy config file without parsing it', async t => {
  const d = await dirs(t);
  await writeFile(join(d.legacyConfigDir, 'config.json'), 'not json');
  const report = await migrateLegacyData(d);
  assert.equal(report.error, undefined); // a bad legacy file is still copied, not parsed
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), 'not json');
});

// --- config directory, environment variables and key resolution ---

// Both XDG roots are isolated: the migration reads the legacy data directory
// too, and an unisolated test would copy the developer's real sessions.
const isolate = async (t, prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    data: process.env.XDG_DATA_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = join(root, 'data');
  t.after(() => {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
  });
  return root;
};

test('the vyen config directory is used and the legacy goon directory is migrated', async t => {
  const root = await isolate(t, 'vyen-config-test-');
  const legacy = join(root, 'config', 'goon');
  const fresh = join(root, 'config', 'vyen');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'config.json'), '{"model":"legacy-model","keyEnv":"GOON_API_KEY"}');
  const previousKey = process.env.VYEN_API_KEY;
  delete process.env.VYEN_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = previousKey;
  });

  // The CLI migrates once at startup; loadConfig itself only reads.
  await migrateLegacyData({
    legacyConfigDir: join(root, 'config', 'goon'),
    legacyDataDir: join(root, 'data', 'goon'),
    configDir: fresh,
    dataDir: join(root, 'data', 'vyen'),
  });
  const config = await loadConfig();
  assert.equal(config.model, 'legacy-model');
  assert.equal(config.keyEnv, 'GOON_API_KEY');
  // The migrated copy lives under the vyen directory.
  assert.equal(JSON.parse(await readFile(join(fresh, 'config.json'), 'utf8')).model, 'legacy-model');
});

test('VYEN_* environment variables win and GOON_* remain honoured as a fallback', async t => {
  await isolate(t, 'vyen-env-test-');
  const previous = { model: process.env.VYEN_MODEL, legacy: process.env.GOON_MODEL };
  process.env.VYEN_MODEL = 'new-model';
  process.env.GOON_MODEL = 'legacy-model';
  t.after(() => {
    if (previous.model === undefined) delete process.env.VYEN_MODEL; else process.env.VYEN_MODEL = previous.model;
    if (previous.legacy === undefined) delete process.env.GOON_MODEL; else process.env.GOON_MODEL = previous.legacy;
  });

  assert.equal((await loadConfig()).model, 'new-model');
  delete process.env.VYEN_MODEL;
  assert.equal((await loadConfig()).model, 'legacy-model');
});

test('an API key exported as GOON_API_KEY still resolves after the rename', async t => {
  await isolate(t, 'vyen-key-test-');
  const previous = { legacy: process.env.GOON_API_KEY, current: process.env.VYEN_API_KEY };
  process.env.GOON_API_KEY = 'legacy-secret';
  delete process.env.VYEN_API_KEY;
  t.after(() => {
    if (previous.legacy === undefined) delete process.env.GOON_API_KEY; else process.env.GOON_API_KEY = previous.legacy;
    if (previous.current === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = previous.current;
  });

  const config = await loadConfig();
  assert.equal(config.keyEnv, 'VYEN_API_KEY');
  assert.equal(await resolveApiKey(config), 'legacy-secret');
});

// --- regressions for the final review ---

test('migration copies the subagents tree so prior child transcripts stay visible', async t => {
  const d = await dirs(t);
  await mkdir(join(d.legacyDataDir, 'subagents', 'parent-1'), { recursive: true });
  await writeFile(join(d.legacyDataDir, 'subagents', 'parent-1', 'child.json'), '{"id":"child"}');
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(await readFile(join(d.dataDir, 'subagents', 'parent-1', 'child.json'), 'utf8'), '{"id":"child"}');
});

test('an interrupted directory copy resumes because files are merged one by one', async t => {
  const d = await dirs(t);
  // The previous run copied one session file and died before the rest.
  await mkdir(join(d.dataDir, 'sessions'), { recursive: true });
  await writeFile(join(d.dataDir, 'sessions', 'a.json'), '{"copied":true}');
  await writeFile(join(d.legacyDataDir, 'sessions', 'b.json'), '{"b":1}');
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(await readFile(join(d.dataDir, 'sessions', 'a.json'), 'utf8'), '{"copied":true}');
  assert.equal(await readFile(join(d.dataDir, 'sessions', 'b.json'), 'utf8'), '{"b":1}');
});

test('two simultaneous first launches both succeed and leave a valid tree', async t => {
  const d = await dirs(t);
  const [first, second] = await Promise.all([migrateLegacyData(d), migrateLegacyData(d)]);
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"legacy-model"}');
  assert.equal(await readFile(join(d.dataDir, 'sessions', 'a.json'), 'utf8'), '{}');
});

test('a migrated goon keyEnv still resolves a vyen API key from the environment', async t => {
  const root = await isolate(t, 'vyen-keyenv-test-');
  const legacy = join(root, 'config', 'goon');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'config.json'), JSON.stringify({ model: 'm', keyEnv: 'GOON_API_KEY' }));
  const previous = { vyen: process.env.VYEN_API_KEY, legacy: process.env.GOON_API_KEY };
  process.env.VYEN_API_KEY = 'vyen-secret';
  delete process.env.GOON_API_KEY;
  t.after(() => {
    if (previous.vyen === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = previous.vyen;
    if (previous.legacy === undefined) delete process.env.GOON_API_KEY; else process.env.GOON_API_KEY = previous.legacy;
  });

  await migrateLegacyData({
    legacyConfigDir: join(root, 'config', 'goon'),
    legacyDataDir: join(root, 'data', 'goon'),
    configDir: join(root, 'config', 'vyen'),
    dataDir: join(root, 'data', 'vyen'),
  });
  const config = await loadConfig();
  assert.equal(config.keyEnv, 'GOON_API_KEY');
  assert.equal(await resolveApiKey(config), 'vyen-secret');
});

test('the vyen key wins over a stale legacy key in the environment', async t => {
  const root = await isolate(t, 'vyen-key-priority-test-');
  const previous = { vyen: process.env.VYEN_API_KEY, legacy: process.env.GOON_API_KEY };
  delete process.env.VYEN_API_KEY;
  process.env.GOON_API_KEY = 'stale-legacy-secret';
  t.after(() => {
    if (previous.vyen === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = previous.vyen;
    if (previous.legacy === undefined) delete process.env.GOON_API_KEY; else process.env.GOON_API_KEY = previous.legacy;
  });

  const config = await loadConfig();
  await mkdir(join(root, 'config', 'vyen'), { recursive: true });
  await writeFile(join(root, 'config', 'vyen', 'credentials.json'), JSON.stringify({ VYEN_API_KEY: 'stored-secret' }));
  assert.equal(await resolveApiKey(config), 'stored-secret');
});

test('resolveExecutable falls back to GOON_BASH when VYEN_BASH is unset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-bash-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'bash.exe');
  await writeFile(fake, '');
  const previous = { vyen: process.env.VYEN_BASH, legacy: process.env.GOON_BASH };
  delete process.env.VYEN_BASH;
  process.env.GOON_BASH = fake;
  t.after(() => {
    if (previous.vyen === undefined) delete process.env.VYEN_BASH; else process.env.VYEN_BASH = previous.vyen;
    if (previous.legacy === undefined) delete process.env.GOON_BASH; else process.env.GOON_BASH = previous.legacy;
  });
  assert.equal(resolveExecutable('bash'), fake);
});
