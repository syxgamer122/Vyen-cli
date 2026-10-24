import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPrompts, expandPromptTemplate } from '../dist/prompts.js';

test('prompt templates expand arguments and append them when there is no placeholder', () => {
  assert.equal(expandPromptTemplate('Review $ARGUMENTS', 'a b'), 'Review a b');
  assert.equal(expandPromptTemplate('$1/$2/$9', 'a b'), 'a/b/');
  assert.equal(expandPromptTemplate('Price $$5', ''), 'Price $5');
  assert.equal(expandPromptTemplate('Do it', 'a b'), 'Do it\n\na b');
  assert.equal(expandPromptTemplate('Do it', ''), 'Do it');
});

test('prompt discovery prefers workspace files, reads front matter and skips oversized files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.HOME = join(root, 'home');
  t.after(() => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.vyen', 'prompts'), { recursive: true });
  await mkdir(join(workspace, '.agents', 'prompts'), { recursive: true });
  await writeFile(join(workspace, '.vyen', 'prompts', 'review.md'), '---\ndescription: Review a change\n---\nReview $ARGUMENTS\n');
  await writeFile(join(workspace, '.agents', 'prompts', 'review.md'), 'shadowed\n');
  await writeFile(join(workspace, '.vyen', 'prompts', 'large.md'), 'x'.repeat(64 * 1024 + 1));
  await writeFile(join(workspace, '.vyen', 'prompts', 'notes.txt'), 'not a prompt');

  const prompts = await discoverPrompts(workspace);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].name, 'review');
  assert.equal(prompts[0].description, 'Review a change');
  assert.equal(prompts[0].scope, 'workspace');
  assert.equal(prompts[0].body, 'Review $ARGUMENTS');
});
