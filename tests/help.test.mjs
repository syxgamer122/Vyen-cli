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
  ]) assert.ok(HELP.includes(token), token);
});
