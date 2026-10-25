import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialsPath, loadConfig, loadCredentials, saveCredential } from '../dist/config.js';
import { fixture } from './helpers.mjs';

async function withConfigHome(t) {
  const f = await fixture(t);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = f.config;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  return f;
}

test('loadCredentials reads a BOM-prefixed file and saveCredential keeps every stored key', async t => {
  await withConfigHome(t);
  const file = credentialsPath();
  await writeFile(
    file,
    '\uFEFF' + JSON.stringify({ VYEN_API_KEY: 'sk-old', ANTHROPIC_API_KEY: 'sk-other' }),
    'utf8',
  );

  assert.deepEqual(await loadCredentials(), { VYEN_API_KEY: 'sk-old', ANTHROPIC_API_KEY: 'sk-other' });

  await saveCredential('VYEN_API_KEY', 'sk-new');
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')),
    { VYEN_API_KEY: 'sk-new', ANTHROPIC_API_KEY: 'sk-other' },
  );
});

test('saveCredential refuses to overwrite a corrupt credentials file', async t => {
  await withConfigHome(t);
  const file = credentialsPath();
  const corrupt = '{"VYEN_API_KEY": "sk-old", broken';
  await writeFile(file, corrupt, 'utf8');

  await assert.rejects(saveCredential('VYEN_API_KEY', 'sk-new'), /Failed to parse credentials/);
  assert.equal(await readFile(file, 'utf8'), corrupt, 'a failed load must not be replaced by a partial save');
});

test('loadCredentials throws on schema errors instead of returning an empty store', async t => {
  await withConfigHome(t);
  await writeFile(credentialsPath(), JSON.stringify({ VYEN_API_KEY: 123 }), 'utf8');
  await assert.rejects(loadCredentials(), /Invalid credentials/);
});

test('loadConfig accepts a BOM-prefixed config.json', async t => {
  await withConfigHome(t);
  await writeFile(
    join(process.env.XDG_CONFIG_HOME, 'vyen', 'config.json'),
    '\uFEFF' + JSON.stringify({ model: 'bom-model' }),
    'utf8',
  );
  assert.equal((await loadConfig()).model, 'bom-model');
});
