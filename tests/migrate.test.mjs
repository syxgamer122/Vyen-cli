import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyData, MIGRATION_MARKER } from '../dist/migrate.js';

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
