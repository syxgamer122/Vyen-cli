import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectVersion, setManifestVersion, parseVersion } from '../scripts/release-version.mjs';

test('first release, automatic patches and numeric ordering use distinct immutable tags', () => {
  assert.equal(selectVersion('0.1.0', [], 'A'), '0.1.0');
  assert.equal(selectVersion('0.1.0', [{ name: 'v0.1.0', sha: 'A' }], 'B'), '0.1.1');
  assert.equal(selectVersion('0.1.9', [{ name: 'v0.1.9', sha: 'A' }, { name: 'v0.1.10', sha: 'B' }], 'C'), '0.1.11');
  assert.equal(selectVersion('0.1.0', [{ name: 'v0.4.9', sha: 'A' }], 'B'), '0.4.10');
});

test('reruns reuse the same tagged commit and explicit higher versions are respected', () => {
  const tags = [{ name: 'v0.1.0', sha: 'A' }, { name: 'v0.1.1', sha: 'B' }, { name: 'unrelated', sha: 'C' }];
  assert.equal(selectVersion('0.1.1', tags, 'B'), '0.1.1');
  assert.equal(selectVersion('0.2.0', tags, 'C'), '0.2.0');
  assert.equal(selectVersion('0.1.1', tags, 'C'), '0.1.2');
  assert.throws(() => parseVersion('1.0.0-beta'), /stable/);
  assert.throws(() => parseVersion('01.0.0'), /stable/);
});

test('version synchronization preserves dependencies and rejects a divergent lockfile', () => {
  const manifest = { name: 'vyen', version: '0.1.0', dependencies: { ai: '6.0.193' } };
  const lock = { version: '0.1.0', packages: { '': { version: '0.1.0', name: 'vyen' }, 'node_modules/ai': { version: '6.0.193' } } };
  const next = setManifestVersion(manifest, lock, '0.1.1');
  assert.equal(next.manifest.version, '0.1.1');
  assert.equal(next.lock.version, '0.1.1');
  assert.equal(next.lock.packages[''].version, '0.1.1');
  assert.deepEqual(next.manifest.dependencies, manifest.dependencies);
  assert.deepEqual(next.lock.packages['node_modules/ai'], lock.packages['node_modules/ai']);
  assert.equal(manifest.version, '0.1.0');
  assert.throws(() => setManifestVersion(manifest, { ...lock, version: '0.2.0' }, '0.1.1'), /disagree/);
});

test('CLI version comes from the installed package manifest', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('npm-shrinkwrap.json', 'utf8'));
  assert.equal(lock.version, manifest.version, 'npm-shrinkwrap.json version must match package.json');
  assert.equal(lock.packages?.['']?.version, manifest.version, 'npm-shrinkwrap.json root package version must match package.json');
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/vyen.mjs', '--version']);
  assert.equal(stdout.trim(), `vyen cli ${manifest.version}`);
});

test('the published archive lists the shipped docs explicitly so internal plans cannot leak', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(!manifest.files.includes('docs'), 'listing the whole docs directory would ship internal plan documents');
  for (const doc of ['docs/SPEC.md', 'docs/MCP.md', 'docs/VALIDATION.md', 'docs/REFERENCE_REVIEW.md']) {
    assert.ok(manifest.files.includes(doc), `${doc} must still be published`);
  }
});

test('the README documents an install command that can actually work', async () => {
  const readme = await readFile('README.md', 'utf8');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  if (manifest.private) {
    assert.doesNotMatch(readme, new RegExp(`npm install -g ${manifest.name}(?!-)`), 'a private package cannot be installed from the npm registry');
    assert.match(readme, /releases\/latest\/download\/vyen\.tgz/);
  } else {
    assert.match(readme, new RegExp(`npm install -g ${manifest.name}(?!-)`), 'a published package must be installable from the registry');
  }
});
