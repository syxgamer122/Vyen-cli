import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../dist/session.js';
import { safeError, redactSecrets } from '../dist/errors.js';
import { AuditLogger } from '../dist/audit.js';

test('configured API keys are redacted from persisted session checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-scrub-key-'));
  try {
    const secretKey = 'vyen-super-secret-key-99999';
    const store = new SessionStore(dir, undefined, { secretKeys: [secretKey] });
    store.session.messages.push({
      role: 'user',
      content: `Here is my key: ${secretKey}`,
    });
    store.session.messages.push({
      role: 'assistant',
      content: `I received key: ${secretKey}`,
    });
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
    const openAiToken = 'sk-proj-12345678901234567890123456789012';
    const anthropicToken = 'sk-ant-api03-1234567890123456789012345678901234567890';
    const githubToken = 'ghp_123456789012345678901234567890123456';
    const bearerToken = 'Bearer mysecretbearertoken12345678901234567890';

    const store = new SessionStore(dir);
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
    const secretKey = 'vyen-secret-token-recovery-test';
    const sessionId = 'session-scrub-resume-1';
    const store = new SessionStore(dir, sessionId, { secretKeys: [secretKey] });
    store.session.messages.push({
      role: 'user',
      content: `Sensitive token: ${secretKey}`,
    });
    await store.save();
    await store.close();

    // Reopen session from disk
    const resumedStore = new SessionStore(dir, sessionId, { secretKeys: [secretKey] });
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
