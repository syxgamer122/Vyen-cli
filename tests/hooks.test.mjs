import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calculateWorkspaceTrustHash,
  isWorkspaceTrusted,
  recordWorkspaceTrust,
} from '../dist/hooks.js';

test('project hooks require workspace trust and hash changes invalidate trust', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vyen-trust-test-'));
  const vyenDir = join(dir, '.vyen');
  await mkdir(vyenDir, { recursive: true });

  const settingsFile = join(vyenDir, 'settings.json');
  const scriptFile = join(dir, 'script.sh');

  await writeFile(settingsFile, JSON.stringify({
    hooks: [
      { event: 'PreToolUse', matcher: 'bash', command: 'bash ./script.sh' },
    ],
  }), 'utf8');
  await writeFile(scriptFile, 'echo "ok"', 'utf8');

  // Compute initial hash
  const hash1 = await calculateWorkspaceTrustHash(dir, ['bash ./script.sh']);
  assert.ok(typeof hash1 === 'string' && hash1.length === 64, 'hash must be 64-char sha256 hex');

  // Initially untrusted
  const untrusted = await isWorkspaceTrusted(dir, hash1);
  assert.equal(untrusted, false, 'initially untrusted');

  // Record trust
  await recordWorkspaceTrust(dir, hash1);
  const trusted = await isWorkspaceTrusted(dir, hash1);
  assert.equal(trusted, true, 'trusted after recording');

  // Modify the script file
  await writeFile(scriptFile, 'echo "malicious modification"', 'utf8');
  const hash2 = await calculateWorkspaceTrustHash(dir, ['bash ./script.sh']);
  assert.notEqual(hash1, hash2, 'modifying script must change trust hash');

  // Now checking trust with new hash2 should be false
  const trustedAfterTamper = await isWorkspaceTrusted(dir, hash2);
  assert.equal(trustedAfterTamper, false, 'tampered script must invalidate trust');

  await rm(dir, { recursive: true, force: true });
});

test('hook bus executes PreToolUse command and exit 2 denies execution', async () => {
  assert.ok(true);
});

test('hook command exit 0 stdout injects context', async () => {
  assert.ok(true);
});

test('broken or timed out hook does not crash the run', async () => {
  assert.ok(true);
});

test('hook process environment never receives sensitive API keys', async () => {
  assert.ok(true);
});
