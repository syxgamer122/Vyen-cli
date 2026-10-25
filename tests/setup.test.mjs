import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, DEFAULT_GATEWAY_URL, configSchema } from '../dist/config.js';
import { parseEffortInput, runSetupWizard } from '../dist/setup.js';
import { fixture } from './helpers.mjs';

test('parseEffortInput accepts names and numbers and rejects unknown values', () => {
  assert.equal(parseEffortInput('', 'low'), 'low');
  assert.equal(parseEffortInput('  ', 'high'), 'high');
  assert.equal(parseEffortInput('high'), 'high');
  assert.equal(parseEffortInput('HIGH'), 'high');
  assert.equal(parseEffortInput('2'), EFFORT_LEVELS[0]);
  assert.equal(parseEffortInput(String(EFFORT_LEVELS.length + 1)), EFFORT_LEVELS.at(-1));
  assert.equal(parseEffortInput('default', 'high'), undefined);
  assert.equal(parseEffortInput('off', 'high'), undefined);
  assert.equal(parseEffortInput('bogus', 'medium'), 'medium');
  assert.equal(parseEffortInput('bogus'), undefined);
  assert.equal(parseEffortInput(String(EFFORT_LEVELS.length + 2), 'medium'), 'medium');
});

test('setup warns before probing the default gateway and stays silent for another preset', async t => {
  const f = await fixture(t);
  const savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    VYEN_TEST_SETUP_KEY: process.env.VYEN_TEST_SETUP_KEY,
    GOON_API_KEY: process.env.GOON_API_KEY,
  };
  process.env.XDG_CONFIG_HOME = f.config;
  process.env.XDG_DATA_HOME = f.data;
  process.env.VYEN_TEST_SETUP_KEY = 'test-secret-for-setup';
  delete process.env.GOON_API_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const run = async (overrides, providerAnswer = '') => {
    const written = [];
    let discoverCalled = false;
    const config = configSchema.parse({
      provider: 'openai-compatible',
      model: 'test-model',
      keyEnv: 'VYEN_TEST_SETUP_KEY',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      ...overrides,
    });
    await assert.rejects(runSetupWizard(config, {
      write: text => { written.push(text); },
      ask: async prompt => {
        if (prompt.includes('Select provider')) return providerAnswer;
        if (prompt.includes('Base URL')) return '';
        return '';
      },
      askSecret: async () => 'test-key',
      discover: async () => {
        discoverCalled = true;
        throw new Error('stop after discovery');
      },
    }), /stop after discovery/);
    return { text: written.join(''), discoverCalled };
  };

  const fallback = await run({});
  assert(fallback.discoverCalled === true);
  assert.match(fallback.text, /default third-party gateway https:\/\/api\.yuristore\.xyz\/v1/);
  assert.ok(fallback.text.indexOf('default third-party gateway') < fallback.text.indexOf('Step 4/5'));

  const otherPreset = await run({}, '4');
  assert(otherPreset.discoverCalled === true);
  assert.doesNotMatch(otherPreset.text, /default third-party gateway/);

  const savedDefault = await run({ baseUrl: DEFAULT_GATEWAY_URL });
  assert(savedDefault.discoverCalled === true);
  assert.doesNotMatch(savedDefault.text, /default third-party gateway/);
});
