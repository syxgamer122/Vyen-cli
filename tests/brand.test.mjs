import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = new Set(['node_modules', '.git', '.next', 'dist', 'release-out', 'superpowers']);

// The pattern is spelled in pieces: a guard that contains the literal it
// searches for reports itself.
const BRAND = new RegExp(['g', 'o', 'o', 'n'].join(''), 'i');
const GUARD = fileURLToPath(new URL('./brand.test.mjs', import.meta.url));

// The legacy names that must survive. They are the OLD brand, and they are
// allowed only where they still mean "the goon installation we migrate from":
// the quoted directory value, the environment variable names, and the marker.
// The legacy names that must survive. They are the OLD brand, and they are
// allowed only where they still mean "the goon installation we migrate from":
// the environment variable names (GOON_*), the quoted directory value, the
// migration marker, and the upstream repository URL.
const legacyEnv = new RegExp(['G', 'O', 'O', 'N', '_'].join('') + '[A-Z_*]+');
const legacyDir = new RegExp("['\"`]" + ['g', 'o', 'o', 'n'].join('') + "['\"`]");
const legacyMarker = new RegExp(['migrated-from-', 'g', 'o', 'o', 'n'].join(''));
const legacyRepo = /binxgtl\/goon-cli/;
// Prose that mentions the legacy brand as a word, never as an identifier:
// `goon` not followed by a word character or a hyphen (which would make it
// a slug like `goon-cli` or a symbol like `goonTest`).
const legacyProse = /goon(?![\w-])/i;
const allowed = [legacyEnv, legacyDir, legacyMarker, legacyRepo, legacyProse];

// The migration's own code and test are about the legacy brand by definition.
const migrationFiles = new Set([
  fileURLToPath(new URL('../src/migrate.ts', import.meta.url)),
  fileURLToPath(new URL('./migrate.test.mjs', import.meta.url)),
]);

function scan(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { scan(full, out); continue; }
    if (!/\.(ts|mjs|md|json|yml|py)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

test('no live goon identifier survives the rename in shipped source', () => {
  const offenders = [];
  const scanned = [];
  for (const file of [
    ...scan(join(ROOT, 'src')), ...scan(join(ROOT, 'tests')), ...scan(join(ROOT, 'scripts')),
    ...scan(join(ROOT, 'bin')), ...scan(join(ROOT, 'docs')),
    join(ROOT, 'package.json'), join(ROOT, 'npm-shrinkwrap.json'),
  ]) {
    if (file === GUARD) continue;
    scanned.push(file);
    const text = readFileSync(file, 'utf8');
    if (migrationFiles.has(file)) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (!BRAND.test(line)) return;
      if (allowed.some(pattern => pattern.test(line))) return;
      offenders.push(`${relative(ROOT, file)}:${index + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.ok(scanned.length > 30, 'the scan must cover the shipped source');
  assert.deepEqual(offenders, [], 'live goon identifiers remain');
});

test('the package is the scoped name npm allows and the command is vyen', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@nguyenhuumanh/vyen');
  assert.equal(manifest.bin.vyen, 'bin/vyen.mjs');
});
