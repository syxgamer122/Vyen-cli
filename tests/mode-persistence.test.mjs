// A transient mode switch (Shift+Tab, or a paired device) must not rewrite the
// saved default; /mode and /auto must. Otherwise leaving vyen in auto starts
// every later session auto-approving writes and shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('only explicit mode commands persist approvalMode', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const persistSites = [...source.matchAll(/setPermissionMode\(([^)]*)\)/g)].map(m => m[1].trim());
  // /mode and /auto pass persist=true; the keyboard toggle and remote device do not.
  assert.deepEqual(
    persistSites.sort(),
    ['next, true', 'next, true', 'next', 'nextMode'].sort(),
    `unexpected setPermissionMode call sites: ${persistSites.join(' | ')}`,
  );
  // The saved value is only written inside the persist branch.
  const persistBlock = source.slice(source.indexOf('if (persist) {'), source.indexOf('const label = mode ==='));
  assert.match(persistBlock, /config\.approvalMode = mode/);
  assert.match(persistBlock, /saveConfig\(config\)/);
});
