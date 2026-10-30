import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionStore, repairInterrupted, retargetSessionWorkspace } from '../dist/session.js';
import { fixture } from './helpers.mjs';

test('an all-digit 8-char session ID prefix resumes by prefix instead of being treated as a list index', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const seed = await SessionStore.open(root, input);
  seed.session.messages.push({ role: 'user', content: 'digit-prefixed session' });
  await seed.save();
  const digitId = '12345678-aaaa-4bbb-8ccc-dddddddddddd';
  const raw = JSON.parse(await readFile(join(root, `${seed.session.id}.json`), 'utf8'));
  await writeFile(join(root, `${digitId}.json`), JSON.stringify({ ...raw, id: digitId }));
  await seed.close();

  const byDigits = await SessionStore.open(root, input, '12345678');
  assert.equal(byDigits.session.id, digitId);
  await byDigits.close();
  // Small numbers keep their list-index meaning (vyen resume 1).
  const byIndex = await SessionStore.open(root, input, '1');
  assert.ok([digitId, seed.session.id].includes(byIndex.session.id));
  await byIndex.close();
});

test('a recovery lock left by a crashed process is reclaimed, a live one is respected', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const seed = await SessionStore.open(root, input);
  await seed.close();
  const id = seed.session.id;
  const lock = join(root, `${id}.lock`);
  // A lock owned by a PID that certainly does not exist, plus a recovery lock
  // that a killed process left behind. Both must not block the session forever.
  await writeFile(lock, '2147483646');
  await writeFile(`${lock}.recovery`, '2147483646');
  const reopened = await SessionStore.open(root, input, id);
  assert.equal(reopened.session.id, id);
  await reopened.close();

  // A recovery lock held by a LIVE process still fails closed.
  await writeFile(lock, '2147483646');
  await writeFile(`${lock}.recovery`, String(process.pid));
  await assert.rejects(SessionStore.open(root, input, id), /locked or undergoing recovery/);
});

test('deleting a session also removes a leftover recovery lock', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const seed = await SessionStore.open(root, input);
  const id = seed.session.id;
  await seed.close();
  await writeFile(join(root, `${id}.lock.recovery`), '2147483646');
  assert.equal(await SessionStore.deleteSession(root, id.slice(0, 8)), id);
  await assert.rejects(readFile(join(root, `${id}.lock.recovery`), 'utf8'), { code: 'ENOENT' });
});

test('session lock prevents two owners and resume retains message history', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const store = await SessionStore.open(root, input);
  await assert.rejects(SessionStore.open(root, input, store.session.id), /already open/);
  store.session.messages.push({ role: 'user', content: 'remember' });
  await store.save();
  await store.close();
  const resumed = await SessionStore.open(root, input, 'latest');
  assert.equal(resumed.session.messages[0].content, 'remember');
  assert.equal(resumed.session.id, store.session.id);
  await resumed.close();
});

test('crash repair preserves completed results and adds unknown outcomes once', () => {
  const messages = [{ role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 'one', toolName: 'write_file', input: {} },
    { type: 'tool-call', toolCallId: 'two', toolName: 'bash', input: {} },
  ] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'write_file', output: { type: 'text', value: 'saved' } }] }];
  assert.equal(repairInterrupted(messages), true);
  assert.equal(messages.at(-1).content[0].toolCallId, 'two');
  assert.equal(messages.at(-1).content[0].output.type, 'error-text');
  assert.equal(repairInterrupted(messages), false);
});

test('resume rejects another workspace and releases the acquired lock', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const store = await SessionStore.open(root, input);
  const id = store.session.id;
  await store.close();
  await assert.rejects(SessionStore.open(root, { ...input, cwd: f.root }, id), /different workspace/);
  const resumed = await SessionStore.open(root, input, id);
  await resumed.close();
});

test('dead process lock can be recovered and archives do not duplicate session listings', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const store = await SessionStore.open(root, input), id = store.session.id;
  await store.close();
  await writeFile(join(root, `${id}.lock`), '2147483647');
  await writeFile(join(root, `${id}.compact-1.json`), await readFile(join(root, `${id}.json`)));
  const resumed = await SessionStore.open(root, input, id);
  assert.equal((await SessionStore.list(root)).length, 1);
  await resumed.close();
});

test('SessionStore supports short 8-char ID prefix resume, excludeId on latest, and forkToNewFile', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const s1 = await SessionStore.open(root, input);
  s1.session.messages.push({ role: 'user', content: 'First task in session 1' });
  await s1.save();
  const forkedId = await s1.forkToNewFile('Forked branch');
  await s1.close();

  // Resume by 8-char prefix
  const byPrefix = await SessionStore.open(root, input, forkedId.slice(0, 8));
  assert.equal(byPrefix.session.id, forkedId);
  assert.equal(byPrefix.session.title, 'Forked branch');
  assert.equal(byPrefix.session.messages.length, 1);

  // Resume latest excluding currently active session
  const latestOther = await SessionStore.open(root, input, 'latest', forkedId);
  assert.equal(latestOther.session.id, s1.session.id);
  await byPrefix.close();
  await latestOther.close();
});

test('changing the workspace drops checkpoints whose backup paths belong to the old workspace', async t => {
  const f = await fixture(t);
  const store = await SessionStore.open(join(f.root, 'sessions'), {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1',
  });
  t.after(() => store.close());
  store.session.checkpoints = [{
    id: 1, createdAt: new Date().toISOString(), prompt: 'p', messageIndex: 0, tokensBefore: 0,
    files: [{ path: 'notes.md', existed: false }],
  }];
  const changed = retargetSessionWorkspace(store, join(f.root, 'other-project'));
  assert.equal(changed, true);
  assert.deepEqual(store.session.checkpoints, []);
  assert.equal(store.session.cwd, join(f.root, 'other-project'));
});

test('staying in the same workspace keeps the checkpoints', async t => {
  const f = await fixture(t);
  const store = await SessionStore.open(join(f.root, 'sessions'), {
    cwd: f.cwd, provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1',
  });
  t.after(() => store.close());
  store.session.checkpoints = [{
    id: 1, createdAt: new Date().toISOString(), prompt: 'p', messageIndex: 0, tokensBefore: 0,
    files: [{ path: 'notes.md', existed: false }],
  }];
  const changed = retargetSessionWorkspace(store, f.cwd);
  assert.equal(changed, false);
  assert.equal(store.session.checkpoints.length, 1);
});

test('the /cd handler drops the checkpoints via the shared helper', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(source, /retargetSessionWorkspace\(store,/);
});

test('the /delete current handler tolerates a session file that is already gone', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const start = source.indexOf("if (input === '/delete' || input.startsWith('/delete '))");
  assert.ok(start > -1, 'the /delete handler must exist');
  const block = source.slice(start, source.indexOf("if (input.startsWith('/presets ')", start));
  assert.match(block, /deleteSession\(sessionsRoot, oldId\)\.catch\(\(\) => \{\}\)/);
});

test('the /export handler reports a refused overwrite instead of ending the session', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const start = source.indexOf("if (cmdInput === '/export' || cmdInput.startsWith('/export '))");
  assert.ok(start > -1, 'the /export handler must exist');
  const block = source.slice(start, source.indexOf("if (cmdInput === '/fork'", start));
  assert.match(block, /try \{[\s\S]*writeExport\(outName, lines\.join\('\\n'\)\)[\s\S]*catch \(error\)[\s\S]*Failed to export session/);
});

test('deleteSession reports an unknown session instead of returning undefined', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const store = await SessionStore.open(root, input);
  const id = store.session.id;
  await store.close();

  await assert.rejects(SessionStore.deleteSession(root, 'deadbeef'), /No saved session matches/);
  assert.equal(await SessionStore.deleteSession(root, id), id);
});
test('/sessions command: supports /sessions list, /sessions delete, and drops through to picker in TUI mode', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("if (cmdInput === '/sessions list' || cmdInput.startsWith('/sessions list ') || (cmdInput === '/sessions' && !tui))"), '/sessions list must exist in immediate commands');
  assert.ok(source.includes("if (cmdInput === '/sessions delete' || cmdInput.startsWith('/sessions delete ')"), '/sessions delete must exist in immediate commands');
  assert.ok(source.includes("if (input === '/resume' || input.startsWith('/resume ') || input === '/sessions' || input.startsWith('/sessions '))"), '/sessions must drop through to interactive picker in mainLoop');
  assert.ok(source.includes("onDelete: async (item) =>"), 'session picker must wire up onDelete handler');
  assert.ok(source.includes("!/^\\d{1,3}$/.test(target) && target.toLowerCase() !== 'latest' && store.session.id.toLowerCase().startsWith(target.toLowerCase())"), 'numeric index deletion must not be blocked by active session prefix');
});

test('deleteSession supports numeric index matching /resume selection rule', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const input = { cwd: f.cwd, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };

  // Create session 1
  const s1 = await SessionStore.open(root, input);
  s1.session.messages.push({ role: 'user', content: 'hello from s1' });
  await s1.save();
  const id1 = s1.session.id;
  await s1.close();

  // Create session 2 (more recent)
  const s2 = await SessionStore.open(root, input);
  s2.session.messages.push({ role: 'user', content: 'hello from s2' });
  await s2.save();
  const id2 = s2.session.id;
  await s2.close();

  // Resume 1 opens s2 (most recent)
  const resumed = await SessionStore.open(root, input, '1');
  assert.equal(resumed.session.id, id2);
  await resumed.close();

  // deleteSession '1' must delete s2, not fail or search prefix '1'
  const deletedId = await SessionStore.deleteSession(root, '1', { cwd: f.cwd });
  assert.equal(deletedId, id2);

  // Now s1 becomes index 1, and deleting it with excludeId starting with '1' must still delete s1
  const fakeActiveId = '10000000-0000-0000-0000-000000000000';
  const deletedRemaining = await SessionStore.deleteSession(root, '1', { cwd: f.cwd, excludeId: fakeActiveId });
  assert.equal(deletedRemaining, id1);
});

test('positional session lookups (latest, numeric index) never cross workspaces when cwd is specified', async t => {
  const f = await fixture(t), root = join(f.root, 'sessions');
  const ws1 = join(f.cwd, 'ws1');
  const ws2 = join(f.cwd, 'ws2');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(ws1, { recursive: true });
  await mkdir(ws2, { recursive: true });
  const input1 = { cwd: ws1, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
  const input2 = { cwd: ws2, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };

  // Create a session in ws1
  const s1 = await SessionStore.open(root, input1);
  s1.session.messages.push({ role: 'user', content: 'ws1 turn' });
  await s1.save();
  const id1 = s1.session.id;
  await s1.close();

  // In ws2 (empty workspace), resolveSessionId for '1' or 'latest' must NOT return s1
  const list = await SessionStore.list(root);
  assert.equal(SessionStore.resolveSessionId(list, '1', { cwd: ws2 }), undefined);
  assert.equal(SessionStore.resolveSessionId(list, 'latest', { cwd: ws2 }), undefined);

  // deleteSession '1' in ws2 must NOT delete s1 from ws1
  await assert.rejects(SessionStore.deleteSession(root, '1', { cwd: ws2 }), /No saved session matches "1"/);

  // open latest in ws2 must reject with workspace mismatch / no matching session
  await assert.rejects(SessionStore.open(root, input2, 'latest'), /No matching session to resume in this workspace/);

  // s1 in ws1 must still exist
  const remaining = await SessionStore.open(root, input1, '1');
  assert.equal(remaining.session.id, id1);
  await remaining.close();
});
