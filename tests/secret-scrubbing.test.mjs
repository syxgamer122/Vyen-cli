import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../dist/session.js';
import { safeError, redactSecrets, redactObject } from '../dist/errors.js';
import { AuditLogger } from '../dist/audit.js';

test('configured API keys are redacted from persisted session checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-key-'));
  try {
    const input = { cwd: dir, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
    const secretKey = 'vyen-super-secret-key-99999';
    const store = await SessionStore.open(dir, input);
    store.addSecretKey(secretKey);
    store.session.messages.push({
      role: 'user',
      content: `Here is my key: ${secretKey}`,
    });
    store.session.messages.push({
      role: 'assistant',
      content: `I received key: ${secretKey}`,
    });
    store.session.checkpoints = [{
      turn: 1,
      prompt: `Save key ${secretKey}`,
      files: [{ path: 'test.txt', content: `SECRET=${secretKey}` }],
    }];
    await store.save();

    const filePath = join(dir, `${store.session.id}.json`);
    const content = await readFile(filePath, 'utf8');

    assert.equal(content.includes(secretKey), false, 'persisted file must not contain raw secret key');
    assert.equal(content.includes('[REDACTED]'), true, 'persisted file must contain [REDACTED]');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('common token patterns are scrubbed from persisted sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-patterns-'));
  try {
    const input = { cwd: dir, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
    const openAiToken = 'sk-proj-12345678901234567890123456789012';
    const anthropicToken = 'sk-ant-api03-1234567890123456789012345678901234567890';
    const githubToken = 'ghp_123456789012345678901234567890123456';
    const bearerToken = 'Bearer mysecretbearertoken12345678901234567890';

    const store = await SessionStore.open(dir, input);
    store.session.messages.push({
      role: 'user',
      content: `Tokens: ${openAiToken} and ${anthropicToken} and ${githubToken} and ${bearerToken}`,
    });
    await store.save();

    const filePath = join(dir, `${store.session.id}.json`);
    const content = await readFile(filePath, 'utf8');

    assert.equal(content.includes(openAiToken), false, 'persisted file must not contain OpenAI token pattern');
    assert.equal(content.includes(anthropicToken), false, 'persisted file must not contain Anthropic token pattern');
    assert.equal(content.includes(githubToken), false, 'persisted file must not contain GitHub token pattern');
    assert.equal(content.includes(bearerToken), false, 'persisted file must not contain Bearer token pattern');
    assert.equal(content.includes('[REDACTED]'), true, 'persisted file must contain [REDACTED]');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resuming a session cannot recover the raw secret from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-resume-'));
  try {
    const input = { cwd: dir, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
    const secretKey = 'vyen-secret-token-recovery-test';
    const store = await SessionStore.open(dir, input);
    const sessionId = store.session.id;
    store.addSecretKey(secretKey);
    store.session.messages.push({
      role: 'user',
      content: `Sensitive token: ${secretKey}`,
    });
    await store.save();
    await store.close();

    // Reopen session from disk
    const resumedStore = await SessionStore.open(dir, input, sessionId, true);
    const userMsg = resumedStore.session.messages[0];
    const textContent = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);

    assert.equal(textContent.includes(secretKey), false, 'resumed session must not contain raw secret');
    assert.equal(textContent.includes('[REDACTED]'), true, 'resumed session must contain [REDACTED]');
    await resumedStore.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('headless stream-json output redacts secrets from event payloads', async () => {
  const secretKey = 'vyen-stream-secret-999';
  const openAiToken = 'sk-proj-streamtest12345678901234567890';
  const input = `Error: call failed with ${secretKey} using ${openAiToken}`;

  const redacted = redactSecrets(input, { secretKeys: [secretKey] });
  assert.equal(redacted.includes(secretKey), false, 'redacted text must not contain secretKey');
  assert.equal(redacted.includes(openAiToken), false, 'redacted text must not contain OpenAI token');
  assert.equal(redacted.includes('[REDACTED]'), true, 'redacted text must contain [REDACTED]');

  const event = {
    type: 'tool',
    id: 't_1',
    meta: {
      summary: `Running tool with ${secretKey}`,
      nested: { token: openAiToken },
    },
  };
  const scrubbedEvent = redactObject(event, { secretKeys: [secretKey] });
  assert.equal(scrubbedEvent.meta.summary.includes(secretKey), false);
  assert.equal(scrubbedEvent.meta.summary.includes('[REDACTED]'), true);
  assert.equal(scrubbedEvent.meta.nested.token.includes(openAiToken), false);
  assert.equal(scrubbedEvent.meta.nested.token, '[REDACTED]');
});

test('audit log and error traces sanitize configured keys across all fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-audit-'));
  try {
    const secretKey = 'vyen-audit-secret-456';
    const githubToken = 'ghp_auditsecrettoken123456789012345678';
    const logger = new AuditLogger({ baseDir: dir, secretKeys: [secretKey] });

    await logger.recordToolDecision({
      sessionId: 'sess_audit_scrub',
      tool: `bash_${secretKey}`,
      decision: 'deny',
      errorClass: `Failed with token ${githubToken}`,
    });

    const today = new Date().toISOString().slice(0, 10);
    const auditFile = join(dir, `audit-${today}.jsonl`);
    const content = await readFile(auditFile, 'utf8');

    assert.equal(content.includes(secretKey), false, 'audit log must not contain secretKey in any field');
    assert.equal(content.includes(githubToken), false, 'audit log must not contain token pattern in any field');
    assert.equal(content.includes('[REDACTED]'), true, 'audit log must contain [REDACTED]');

    const errMessage = safeError(new Error(`Failed with ${secretKey} and ${githubToken}`), secretKey);
    assert.equal(errMessage.includes(secretKey), false, 'safeError must redact secretKey');
    assert.equal(errMessage.includes(githubToken), false, 'safeError must redact token pattern');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('compaction archives (.compact-N.json) redact secret keys and token patterns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-compact-'));
  try {
    const input = { cwd: dir, provider: 'test', model: 'model', baseUrl: 'http://localhost/v1' };
    const secretKey = 'vyen-compact-secret-key-12345';
    const anthropicToken = 'sk-ant-api03-compacttesttoken12345678901234567890';
    const store = await SessionStore.open(dir, input);
    store.addSecretKey(secretKey);
    store.session.messages.push({
      role: 'user',
      content: `Pre-compaction secret: ${secretKey} and ${anthropicToken}`,
    });
    await store.archiveCompaction(1);

    const compactPath = join(dir, `${store.session.id}.compact-1.json`);
    const content = await readFile(compactPath, 'utf8');

    assert.equal(content.includes(secretKey), false, 'compaction archive must not contain raw secretKey');
    assert.equal(content.includes(anthropicToken), false, 'compaction archive must not contain raw token');
    assert.equal(content.includes('[REDACTED]'), true, 'compaction archive must contain [REDACTED]');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redactObject preserves Date and Buffer instances without converting to plain object', () => {
  const d = new Date('2026-10-29T12:00:00Z');
  const buf = Buffer.from('binary-payload');
  const obj = {
    date: d,
    buffer: buf,
    text: 'my sk-proj-12345678901234567890123456789012 key',
  };

  const scrubbed = redactObject(obj);
  assert.equal(scrubbed.date instanceof Date, true, 'Date instance must be preserved');
  const err = new Error('test error');
  const rx = /test-regex/i;
  assert.equal(redactObject(err) instanceof Error, true, 'Error instance must be preserved');
  assert.equal(redactObject(rx) instanceof RegExp, true, 'RegExp instance must be preserved');
  const circular = { key: 'val' };
  circular.self = circular;
  const scrubbedCircular = redactObject(circular);
  assert.equal(scrubbedCircular.key, 'val', 'Circular reference should be handled safely');
  assert.equal(scrubbed.date.toISOString(), d.toISOString());
  assert.equal(Buffer.isBuffer(scrubbed.buffer), true, 'Buffer instance must be preserved');
  assert.equal(scrubbed.buffer.toString(), 'binary-payload');
  assert.equal(scrubbed.text.includes('sk-proj'), false);
  assert.equal(scrubbed.text.includes('[REDACTED]'), true);
});

test('redactSecrets redacts fine-grained GitHub PATs and AWS access keys', () => {
  const githubPat = 'github_pat_11ABCDE1234567890abcdef1234567890ABCDEF';
  const awsKey = 'AKIAIOSFODNN7EXAMPLE';
  const awsStsKey = 'ASIAIOSFODNN7EXAMPLE';
  const text = `Keys: ${githubPat} and ${awsKey} and ${awsStsKey}`;

  const redacted = redactSecrets(text);
  assert.equal(redacted.includes(githubPat), false, 'fine-grained GitHub PAT must be redacted');
  assert.equal(redacted.includes(awsKey), false, 'AWS access key must be redacted');
  assert.equal(redacted.includes(awsStsKey), false, 'AWS STS temporary key must be redacted');
  assert.equal(redacted.includes('[REDACTED]'), true);

  const normalWord = 'EURASIA1234567890ABCDEF';
  const textWithWord = `Prefix ${normalWord} suffix`;
  assert.equal(redactSecrets(textWithWord), textWithWord, 'longer identifiers containing ASIA must not be corrupted');
});
