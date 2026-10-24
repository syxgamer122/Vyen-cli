import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// repo-hygiene:guarded-by-plan-traceability
// The counterpart guard (tests/repo-hygiene.test.mjs) asserts that this marker
// is still present, and this file asserts the same for the other guard. The
// check runs in both directions: deleting either file turns the other red.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLANS_DIR = join(ROOT, 'docs', 'superpowers', 'plans');
// The rule was adopted on this date. Plans written before it are history and are
// not retrofitted (AGENTS.md §4: a completed plan is not rewritten); from this
// date on, every plan must carry the traceability table.
const RULE_ADOPTED = '2026-10-22';
// From this date a row must name the test, not only the file: a file whose test
// was deleted must turn this guard red. The upstream merge of 2026-10-22 deleted
// the body of tests/context.test.mjs and the file-only check stayed green.
const TEST_TITLE_ADOPTED = '2026-10-23';
// A plan file is named YYYY-MM-DD-<slug>.md. Anything else in that directory
// is not a plan and must not be judged as one.
const PLAN_NAME = /^\d{4}-\d{2}-\d{2}-.*\.md$/;

function section(text, title) {
  const match = new RegExp(`^## ${title}\\s*$`, 'm').exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  // Stop at the next heading of any level: a "## Scenarios & Tests" section
  // that runs into the "### Task" subsections must not absorb their tables.
  const next = /^#{1,3}\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

async function planFiles() {
  let names;
  try {
    names = await readdir(PLANS_DIR);
  } catch {
    return [];
  }
  return names
    .filter(name => PLAN_NAME.test(name))
    .sort()
    .map(name => ({ name, date: name.slice(0, 10) }));
}

function criteriaOf(focus) {
  return focus
    .split(/\r?\n/)
    .filter(line => /^\s*\d+[.)]\s+\S/.test(line))
    .map(line => Number(/^\s*(\d+)[.)]/.exec(line)[1]));
}

function rowsOf(scenarios) {
  return scenarios
    .split(/\r?\n/)
    .filter(line => /^\|\s*\d+\s*\|/.test(line))
    .map(line => ({ number: Number(/^\|\s*(\d+)\s*\|/.exec(line)[1]), text: line }));
}

// A row looks like: | 1 | criterion | tests/x.test.mjs › the test title |
function rowTitle(cell) {
  const parts = cell.split('›');
  if (parts.length !== 2) return null;
  const file = /tests\/[A-Za-z0-9._-]+\.test\.mjs/.exec(parts[0]);
  if (!file) return null;
  const title = parts[1].replace(/\|\s*$/, '').trim();
  return title ? { file: file[0], title } : null;
}

function testTitles(source) {
  return [...source.matchAll(/\btest\(\s*(['"`])([\s\S]*?)\1/g)].map(match => match[2]);
}

test('the traceability guard is not vacuous: plans exist and every plan states its criteria', async () => {
  const plans = await planFiles();
  assert.ok(plans.length > 0, 'no plan files found — the traceability guard would guard nothing');
  for (const plan of plans) {
    const text = await readFile(join(PLANS_DIR, plan.name), 'utf8');
    const focus = section(text, 'Review Focus');
    assert.ok(focus, `${plan.name} has no "## Review Focus" section`);
    const criteria = criteriaOf(focus);
    assert.ok(criteria.length > 0, `${plan.name} lists no numbered Review Focus criterion`);
  }
});

test('every Review Focus criterion has a row in the Scenarios & Tests table', async () => {
  for (const plan of await planFiles()) {
    if (plan.date < RULE_ADOPTED) continue;
    const text = await readFile(join(PLANS_DIR, plan.name), 'utf8');
    const focus = section(text, 'Review Focus');
    const criteria = criteriaOf(focus ?? '');
    const scenarios = section(text, 'Scenarios & Tests');
    assert.ok(scenarios, `${plan.name} has no "## Scenarios & Tests" section`);
    const rows = new Set(rowsOf(scenarios).map(row => row.number));
    for (const criterion of criteria) {
      assert.ok(
        rows.has(criterion),
        `${plan.name}: Review Focus item ${criterion} has no row in "## Scenarios & Tests"`,
      );
    }
  }
});

test('every Scenarios & Tests row names a test file that exists', async () => {
  for (const plan of await planFiles()) {
    if (plan.date < RULE_ADOPTED) continue;
    const text = await readFile(join(PLANS_DIR, plan.name), 'utf8');
    const scenarios = section(text, 'Scenarios & Tests');
    if (!scenarios) continue;
    for (const row of rowsOf(scenarios)) {
      const file = /tests\/[A-Za-z0-9._-]+\.test\.mjs/.exec(row.text);
      assert.ok(file, `${plan.name}: row ${row.number} names no test file`);
      const exists = await stat(join(ROOT, file[0])).then(() => true, () => false);
      assert.ok(exists, `${plan.name}: row ${row.number} names ${file[0]}, which does not exist`);
    }
  }
});

test('from 2026-10-23 every Scenarios & Tests row names a test the file contains', async () => {
  const plans = (await planFiles()).filter(plan => plan.date >= TEST_TITLE_ADOPTED);
  assert.ok(plans.length > 0, `no plan dated ${TEST_TITLE_ADOPTED} or later exists — the title check guards nothing`);
  for (const plan of plans) {
    const text = await readFile(join(PLANS_DIR, plan.name), 'utf8');
    const scenarios = section(text, 'Scenarios & Tests');
    if (!scenarios) continue;
    for (const row of rowsOf(scenarios)) {
      const target = rowTitle(row.text);
      assert.ok(target, `${plan.name}: row ${row.number} must name a test as "tests/<file>.test.mjs › <title>"`);
      const source = await readFile(join(ROOT, target.file), 'utf8');
      assert.ok(
        testTitles(source).includes(target.title),
        `${plan.name}: row ${row.number} names "${target.title}", which ${target.file} does not contain`,
      );
    }
  }
});

test('the two guards protect each other', async () => {
  const hygiene = await readFile(new URL('./repo-hygiene.test.mjs', import.meta.url), 'utf8');
  assert.ok(
    hygiene.includes('plan-traceability:guarded-by-repo-hygiene'),
    'tests/repo-hygiene.test.mjs lost its marker — the tripwire is broken.',
  );
});
