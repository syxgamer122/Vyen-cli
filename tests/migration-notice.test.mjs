// The migration notice is a single stderr line: it must end with a real newline,
// not the two characters `\` and `n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cli } from './helpers.mjs';

test('the legacy-migration notice ends with a real newline', async t => {
  const f = await fixture(t);
  // Legacy goon data lives at $XDG_CONFIG_HOME/goon and is copied into .../vyen on first run.
  const legacyConfig = join(f.config, 'goon');
  await mkdir(legacyConfig, { recursive: true });
  await writeFile(join(legacyConfig, 'memories.json'), '[]\n');
  const run = await cli(f, 'http://127.0.0.1:9/v1', ['-p', 'hi']).done;
  const line = run.stderr.split('\n').find(l => l.includes('migrated ') || l.includes('could not migrate'));
  assert.ok(line, `no migration notice in stderr: ${JSON.stringify(run.stderr.slice(0, 300))}`);
  assert.doesNotMatch(line, /\\n/, 'the notice must not print a literal backslash-n');
});
