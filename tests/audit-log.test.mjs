import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fixture, provider, sse, cli } from './helpers.mjs';
import { AuditLogger, getAuditLogger, auditRecordSchema } from '../dist/audit.js';
import { PairManager } from '../dist/pair.js';

test('tool run writes a valid JSONL audit record with decision, tokens, and duration', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'input.txt'), 'hello audit log\n');
  const p = await provider(t, (req, response) => {
    if (req.messages.some(m => m.role === 'tool')) {
      sse(response, { text: 'Done reading file.' });
    } else {
      sse(response, {
        calls: [{ id: 'call_1', name: 'read_file', input: { path: 'input.txt' } }],
      });
    }
  });

  const run = await cli(f, p.url, ['-p', 'read input.txt']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);

  const auditDir = join(f.data, 'vyen', 'audit');
  assert.ok(existsSync(auditDir), 'audit directory must exist');

  const files = (await readdir(auditDir)).filter(name => name.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'at least one audit file must be created');

  const content = await readFile(join(auditDir, files[0]), 'utf8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, 'audit file must contain records');

  const records = lines.map(line => {
    const parsed = JSON.parse(line);
    const valid = auditRecordSchema.safeParse(parsed);
    assert.ok(valid.success, `record failed schema validation: ${JSON.stringify(valid.error?.issues)}`);
    return parsed;
  });

  const toolRecord = records.find(r => r.type === 'tool_decision' && r.tool === 'read_file');
  assert.ok(toolRecord, 'must record read_file tool decision');
  assert.equal(toolRecord.decision, 'allow');
  assert.ok(typeof toolRecord.durationMs === 'number', 'durationMs must be recorded');
  assert.ok(toolRecord.sessionId, 'sessionId must be present');
  assert.ok(toolRecord.timestamp, 'timestamp must be present');
});

test('pair session lifecycle and remote approvals write audit records with origin', async t => {
  const f = await fixture(t);
  const auditDir = join(f.data, 'vyen', 'audit');
  const logger = getAuditLogger({ baseDir: auditDir });

  const pm = new PairManager({
    getState: () => ({ sessionId: 'test-session-123' }),
  });
  await pm.start({ skipTunnel: true });

  await logger.recordPairEvent({
    sessionId: 'test-session-123',
    action: 'remote_approve',
    origin: 'https://pair.local:8443',
    tool: 'bash',
  });

  await pm.stop();

  const files = (await readdir(auditDir)).filter(name => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);

  const content = await readFile(join(auditDir, files[0]), 'utf8');
  const records = content.trim().split(/\r?\n/).map(l => JSON.parse(l));
  assert.equal(records.length, 3);

  assert.equal(records[0].type, 'pair_event');
  assert.equal(records[0].action, 'session_start');
  assert.ok(records[0].origin);

  assert.equal(records[1].type, 'pair_event');
  assert.equal(records[1].action, 'remote_approve');
  assert.equal(records[1].tool, 'bash');

  assert.equal(records[2].type, 'pair_event');
  assert.equal(records[2].action, 'session_stop');
  assert.ok(records[2].origin);
});

test('VYEN_AUDIT=off disables audit logging and creates no files', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'plain text response' }));

  const run = await cli(f, p.url, ['-p', 'hello'], {
    env: { VYEN_AUDIT: 'off' },
  }).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);

  const auditDir = join(f.data, 'vyen', 'audit');
  if (existsSync(auditDir)) {
    const files = await readdir(auditDir);
    assert.equal(files.length, 0, 'no audit files should be created when VYEN_AUDIT=off');
  }
});

test('audit records redact configured API keys from error fields', async t => {
  const f = await fixture(t);
  const auditDir = join(f.data, 'vyen', 'audit');
  const secretKey1 = 'sk-live-secret-test-key-12345';
  const secretKey2 = 'sk-subagent-child-key-67890';
  const logger1 = getAuditLogger({
    baseDir: auditDir,
    secretKeys: [secretKey1],
  });
  const logger2 = getAuditLogger({
    secretKeys: [secretKey2],
  });
  assert.equal(logger1, logger2, 'getAuditLogger must preserve singleton instance');

  await logger2.recordToolDecision({
    sessionId: 'session-redact',
    tool: 'bash',
    decision: 'deny',
    errorClass: `Error connecting with auth token: ${secretKey1} and child token: ${secretKey2} at server`,
  });

  const files = (await readdir(auditDir)).filter(name => name.endsWith('.jsonl'));
  const content = await readFile(join(auditDir, files[0]), 'utf8');
  assert.equal(content.includes(secretKey1), false, 'secret API key 1 must be scrubbed from audit record');
  assert.equal(content.includes(secretKey2), false, 'secret API key 2 must be scrubbed from audit record');
  assert.match(content, /\[REDACTED\]/, 'secret must be replaced with [REDACTED]');
});

test('audit logger rotates to indexed chunk when file exceeds size limit', async t => {
  const f = await fixture(t);
  const auditDir = join(f.data, 'vyen', 'audit');
  // Small size limit to trigger rollover
  const logger = new AuditLogger({
    baseDir: auditDir,
    maxFileSizeBytes: 300,
  });

  // Write enough records to trigger rollover beyond 300 bytes
  for (let i = 0; i < 10; i++) {
    await logger.recordToolDecision({
      sessionId: `session-rotate-${i}`,
      tool: 'read_file',
      decision: 'allow',
      durationMs: 15,
      tokens: { input: 100, output: 50, total: 150 },
    });
  }

  const files = (await readdir(auditDir)).filter(name => name.endsWith('.jsonl')).sort();
  assert.ok(files.length >= 2, `expected at least 2 files after rollover, got ${files.length}: ${files.join(', ')}`);
  assert.ok(files.some(name => /\.\d+\.jsonl$/.test(name)), 'expected an indexed rollover chunk file');
});
