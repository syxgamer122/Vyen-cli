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
  const manifest = { name: '@nguyenhuumanh/vyen', version: '0.1.0', dependencies: { ai: '6.0.193' } };
  const lock = { version: '0.1.0', packages: { '': { version: '0.1.0', name: '@nguyenhuumanh/vyen' }, 'node_modules/ai': { version: '6.0.193' } } };
  const next = setManifestVersion(manifest, lock, '0.1.1');
  assert.equal(next.manifest.version, '0.1.1');
  assert.equal(next.lock.version, '0.1.1');
  assert.equal(next.lock.packages[''].version, '0.1.1');
  assert.deepEqual(next.manifest.dependencies, manifest.dependencies);
  assert.deepEqual(next.lock.packages['node_modules/ai'], lock.packages['node_modules/ai']);
  assert.equal(manifest.version, '0.1.0');
  assert.throws(() => setManifestVersion(manifest, { ...lock, version: '0.2.0' }, '0.1.1'), /disagree/);
});

test('the manifest is publishable: not private, declaring its repository, and exposing the vyen command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.notEqual(manifest.private, true, 'npm refuses to publish a package marked private');
  assert.equal(manifest.name, '@nguyenhuumanh/vyen');
  assert.equal(manifest.bin?.vyen, 'bin/vyen.mjs');
  assert.equal(
    manifest.repository?.url,
    'https://github.com/syxgamer122/Vyen-cli',
    'npm provenance rejects a package whose repository.url does not match the publishing workflow',
  );
});

test('the documented install command names the package that is actually published', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const documented = [...readme.matchAll(/npm install -g\s+([^\s`]+)/g)]
    .map(match => match[1])
    .filter(name => name.startsWith('@') || /^[a-z][a-z0-9._-]*(\/|$)/i.test(name))
    .filter(name => name !== '.');
  assert.ok(documented.length > 0, 'the README must document an install command');
  for (const name of documented) {
    assert.equal(name, manifest.name, `the README installs ${name}, but package.json publishes ${manifest.name}`);
  }
  const notes = await readFile(new URL('../scripts/publish-release.mjs', import.meta.url), 'utf8');
  const fromNotes = [...notes.matchAll(/npm install -g\s+([^\s`\\]+)/g)]
    .map(match => match[1])
    .filter(name => name.startsWith('@'));
  assert.ok(fromNotes.length > 0, 'the release notes must document an install command');
  for (const name of fromNotes) assert.equal(name, manifest.name);
});

test('CLI version comes from the installed package manifest', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('npm-shrinkwrap.json', 'utf8'));
  assert.equal(lock.version, manifest.version, 'npm-shrinkwrap.json version must match package.json');
  assert.equal(lock.packages?.['']?.version, manifest.version, 'npm-shrinkwrap.json root package version must match package.json');
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/vyen.mjs', '--version']);
  assert.equal(stdout.trim(), `vyen cli ${manifest.version}`);
});
