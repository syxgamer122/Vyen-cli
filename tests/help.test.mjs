import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../dist/help.js';
import { VERSION } from '../dist/version.js';

test('help lists the documented flags and subcommands', () => {
  assert.match(HELP, new RegExp(`vyen cli ${VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const token of [
    '--provider', '--base-url', '--model', '--effort', '--key-env', '--resume',
    '--pair', '--yes', '--read-only', '--json', '--output-format', '--json-schema', '--no-tui', '--no-mcp',
    '--no-subagents', '--run-token-budget', '--output-last-message',
    '--allowed-tools', '--disallowed-tools', '--trust-workspace',
    'vyen setup', 'vyen mcp list', 'vyen upgrade',
    '/yolo',
  ]) assert.ok(HELP.includes(token), token);
  assert.match(HELP, /--no-subagents\s+.*Agent Network/, '--no-subagents description must mention Agent Network');
});

test('--help answers even when the rest of the line is invalid or incomplete', async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  for (const args of [['--help', '-p'], ['-h', '--bad-flag'], ['--help', 'doctor']]) {
    const child = spawn(process.execPath, [resolve('bin/vyen.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(r => child.once('close', r));
    assert.equal(code, 0, `vyen ${args.join(' ')} exited ${code}: ${err}`);
    assert.ok(out.startsWith(`vyen cli ${VERSION}`), `vyen ${args.join(' ')} did not print help: ${out.slice(0, 60)}`);
  }
});
