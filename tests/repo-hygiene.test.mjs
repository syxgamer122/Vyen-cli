import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// plan-traceability:guarded-by-repo-hygiene
// The counterpart guard (tests/plan-traceability.test.mjs) asserts that this
// marker is still present: deleting or neutering this file must turn that test
// red, so neither guard can be removed on its own.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRS = ['src', 'tests', 'scripts', 'bin'];
const SCANNED_EXT = /\.(ts|mjs|js|cjs)$/;
// The two directives are spelled in pieces on purpose. This file is scanned by
// its own rule, so a contiguous literal in a title, a message or a comment
// would make the guard report itself instead of the code it guards.
const TS_IGNORE = '@ts-' + 'ignore';
const TS_EXPECT_ERROR = '@ts-expect' + '-error';

async function sourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...await sourceFiles(join(dir, entry.name)));
    } else if (SCANNED_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

test('source files carry no byte-order mark', async () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const bytes = await readFile(join(ROOT, file));
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, [], `BOM found in: ${offenders.join(', ')}`);
});

test(`no ${TS_IGNORE} is used to silence the type checker`, async () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const text = await readFile(join(ROOT, file), 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(TS_IGNORE)) offenders.push(`${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `${TS_IGNORE} found at: ${offenders.join(', ')}`);
});

test(`every ${TS_EXPECT_ERROR} states a reason on the same line`, async () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const text = await readFile(join(ROOT, file), 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.includes(TS_EXPECT_ERROR)) return;
        // The reason is the text that follows the directive on the same line.
        // It does not have to be another comment marker: the directive is
        // usually the comment itself, so "— the type is wrong here" counts.
        const reason = line.slice(line.indexOf(TS_EXPECT_ERROR) + TS_EXPECT_ERROR.length).trim();
        if (!reason) offenders.push(`${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `${TS_EXPECT_ERROR} without a reason at: ${offenders.join(', ')}`);
});

test('the two guards protect each other', async () => {
  const hygiene = await readFile(new URL('./repo-hygiene.test.mjs', import.meta.url), 'utf8');
  const traceability = await readFile(new URL('./plan-traceability.test.mjs', import.meta.url), 'utf8');
  assert.ok(
    hygiene.includes('plan-traceability:guarded-by-repo-hygiene'),
    'tests/repo-hygiene.test.mjs lost its marker — the tripwire is broken.',
  );
  assert.ok(
    traceability.includes('repo-hygiene:guarded-by-plan-traceability'),
    'tests/plan-traceability.test.mjs lost its marker — the tripwire is broken.',
  );
});
