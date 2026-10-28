import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, provider, sse, cli } from './helpers.mjs';
import { streamJsonEventSchema } from '../dist/events.js';

const eventsOf = result => {
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      assert.fail(`stdout line ${index + 1} is not JSON: ${line.slice(0, 200)}`);
    }
  });
};

// The contract only holds if a consumer can validate every line the CLI emits.
const assertValidStream = result => {
  const events = eventsOf(result);
  for (const [index, event] of events.entries()) {
    const parsed = streamJsonEventSchema.safeParse(event);
    assert.ok(
      parsed.success,
      `event ${index + 1} (${event?.type}) failed v1 schema validation: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
    );
  }
  return events;
};

test('stream-json output emits v1 session header and valid event union', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'Hello, this is headless stream-json.' }));
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '-p', 'say hello']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  assert.ok(events.length >= 2, 'expected at least session and done events');
  const sessionEvent = events[0];
  assert.equal(sessionEvent.type, 'session');
  assert.equal(sessionEvent.version, 'v1');
  assert.ok(sessionEvent.id);
  assert.ok(sessionEvent.cwd);

  const doneEvent = events.find(e => e.type === 'done');
  assert.ok(doneEvent);
  assert.equal(doneEvent.denied, false);
  assert.match(doneEvent.text, /Hello, this is headless/);
});

test('every emitted event validates against the v1 schema during tool use', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'note.txt'), 'hello from the workspace', 'utf8');
  const p = await provider(t, (_, response, requestNumber) => {
    if (requestNumber === 1) {
      return sse(response, { calls: [{ id: 'call-1', name: 'read_file', input: { path: 'note.txt' } }] });
    }
    return sse(response, { text: 'The note says hello.' });
  });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '-p', 'read note.txt']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  assert.ok(events.some(e => e.type === 'tool'), 'expected a tool event');
  assert.ok(events.some(e => e.type === 'done'), 'expected a done event');
});

test('json-schema with invalid syntax or missing file fails closed with exit code 1', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'unused' }));

  // Case A: invalid inline JSON syntax (braces present, so this must be parsed inline)
  const invalidSyntax = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', '{"type": }', '-p', 'test']).done;
  assert.equal(invalidSyntax.code, 1, 'invalid schema syntax must exit code 1');
  const eventsA = assertValidStream(invalidSyntax);
  const errorA = eventsA.find(e => e.type === 'error');
  assert.ok(errorA, 'must emit error event');
  assert.match(errorA.message, /Failed to parse inline JSON Schema/);
  assert.equal(invalidSyntax.stdout.includes('test-secret-never-echo'), false);
  assert.equal(p.requests.length, 0, 'invalid schema syntax must fail before the model call');

  // Case B: missing schema file
  const missingFile = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', 'nonexistent_schema.json', '-p', 'test']).done;
  assert.equal(missingFile.code, 1, 'missing schema file must exit code 1');
  const eventsB = assertValidStream(missingFile);
  const errorB = eventsB.find(e => e.type === 'error');
  assert.ok(errorB, 'must emit error event');
  assert.match(errorB.message, /Failed to read JSON Schema file/);
  assert.equal(p.requests.length, 0, 'missing schema file must fail before the model call');

  // Case C: empty argument must not silently disable validation
  const emptySchema = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', '', '-p', 'test']).done;
  assert.equal(emptySchema.code, 1, 'empty schema must exit code 1');
  const eventsC = assertValidStream(emptySchema);
  assert.ok(eventsC.some(e => e.type === 'error'), 'must emit error event');
  assert.equal(eventsC.some(e => e.type === 'done'), false, 'must not emit done');
  assert.equal(p.requests.length, 0, 'schema failures must happen before the model call');
});

test('an Ajv-invalid schema fails before spending a model request', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'unused' }));
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', '{"type":"bogus"}', '-p', 'test']).done;
  assert.equal(run.code, 1);
  const events = eventsOf(run);
  const errorEvent = events.find(e => e.type === 'error');
  assert.ok(errorEvent);
  assert.match(errorEvent.message, /Invalid JSON Schema/);
  assert.equal(p.requests.length, 0, 'invalid schema must be rejected before the model call');
});

test('json-schema with non-conforming model output emits error event and exits code 1', async t => {
  const f = await fixture(t);
  // Model returns text that is not valid according to schema
  const p = await provider(t, (_, response) => sse(response, { text: '{"score": "not-a-number"}' }));
  const schema = JSON.stringify({
    type: 'object',
    required: ['score'],
    properties: {
      score: { type: 'number' },
    },
  });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', schema, '-p', 'rate this']).done;
  assert.equal(run.code, 1, 'non-conforming schema output must exit code 1');
  const events = assertValidStream(run);
  const doneEvent = events.find(e => e.type === 'done');
  assert.equal(doneEvent, undefined, 'must not emit successful done event on schema violation');
  const errorEvent = events.find(e => e.type === 'error');
  assert.ok(errorEvent, 'must emit error event');
  assert.match(errorEvent.message, /json-schema/i);
  assert.ok(Array.isArray(errorEvent.schemaErrors), 'must attach validation errors');
  assert.equal(errorEvent.schemaErrors[0].path, '/score');
  assert.match(errorEvent.schemaErrors[0].message, /number/);
});

test('json-schema with non-JSON model output fails closed', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'I could not produce JSON.' }));
  const schema = JSON.stringify({ type: 'object', required: ['score'], properties: { score: { type: 'number' } } });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', schema, '-p', 'rate this']).done;
  assert.equal(run.code, 1);
  const events = assertValidStream(run);
  assert.equal(events.some(e => e.type === 'done'), false);
  const errorEvent = events.find(e => e.type === 'error');
  assert.ok(errorEvent);
  assert.match(errorEvent.schemaErrors[0].message, /parsed as JSON/);
});

test('json-schema with valid conforming model output emits done event with structuredOutput', async t => {
  const f = await fixture(t);
  const conformingJson = '```json\n{"score": 95, "verdict": "pass"}\n```';
  const p = await provider(t, (_, response) => sse(response, { text: conformingJson }));
  const schemaPath = join(f.cwd, 'schema.json');
  await writeFile(schemaPath, JSON.stringify({
    type: 'object',
    required: ['score', 'verdict'],
    properties: {
      score: { type: 'number' },
      verdict: { type: 'string' },
    },
  }), 'utf8');

  const run = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', schemaPath, '-p', 'evaluate']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  const doneEvent = events.find(e => e.type === 'done');
  assert.ok(doneEvent);
  assert.deepEqual(doneEvent.structuredOutput, { score: 95, verdict: 'pass' });

  const outboundPrompt = JSON.stringify(p.requests[0]);
  const injections = outboundPrompt.match(/IMPORTANT: Your final response must strictly adhere/g) ?? [];
  assert.equal(injections.length, 1, 'schema instruction must be injected exactly once');
});

test('json flag remains a backward-compatible alias for stream-json', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'testing alias' }));
  const run = await cli(f, p.url, ['--json', '-p', 'alias test']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  assert.equal(events[0].type, 'session');
  assert.equal(events[0].version, 'v1');
});

test('a missing required property reports its path', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: '{"other":1}' }));
  const schema = JSON.stringify({
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '--json-schema', schema, '-p', 'name it']).done;
  assert.equal(run.code, 1);
  const events = assertValidStream(run);
  const errorEvent = events.find(e => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.schemaErrors[0].path, '/name');
});

test('todo events validate and carry no undeclared fields', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response, requestNumber) => {
    if (requestNumber === 1) {
      return sse(response, {
        calls: [{
          id: 'plan-1',
          name: 'update_plan',
          input: { plan: [{ step: 'first step', status: 'in_progress' }, { step: 'second step', status: 'pending' }] },
        }],
      });
    }
    return sse(response, { text: 'plan recorded' });
  });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '-p', 'plan the work']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  const todoEvent = events.find(e => e.type === 'todo');
  assert.ok(todoEvent, 'expected a todo event');
  assert.deepEqual(
    todoEvent.todos.map(todo => [todo.content, todo.status]),
    [['first step', 'in_progress'], ['second step', 'pending']],
  );
  assert.equal('id' in todoEvent.todos[0], false, 'todo events must not carry an undeclared id');
});

test('subagent event family validates against the v1 schema', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response, requestNumber) => {
    if (requestNumber === 1) {
      return sse(response, { calls: [{ id: 'sub-1', name: 'delegate_task', input: { tasks: ['inspect the workspace and report'] } }] });
    }
    return sse(response, { text: 'child report: workspace is empty' });
  });
  const run = await cli(f, p.url, ['--output-format', 'stream-json', '-p', 'delegate the inspection']).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = assertValidStream(run);
  const states = events.filter(e => e.type === 'subagent').map(e => e.state);
  assert.ok(states.includes('start'), `expected subagent start, got ${states.join(',')}`);
  assert.ok(states.includes('done'), `expected subagent done, got ${states.join(',')}`);
});

test('event schemas cover goal, workflow, network and reject the old drift', () => {
  const goal = status => ({
    type: 'goal',
    goal: {
      goalId: 'g1',
      objective: 'ship',
      status,
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
      tokensAtStart: 0,
      tokensUsed: 0,
      timeUsedSeconds: 0,
    },
  });
  for (const status of ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete']) {
    const parsed = streamJsonEventSchema.safeParse(goal(status));
    assert.ok(parsed.success, `goal status ${status} must validate: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
  }
  assert.ok(streamJsonEventSchema.safeParse({ type: 'workflow_done', result: { steps: [] }, sessionId: 's1' }).success);
  assert.ok(streamJsonEventSchema.safeParse({ type: 'network_done', synthesis: 'done', rounds: 2 }).success);
  assert.ok(streamJsonEventSchema.safeParse({
    type: 'subagent',
    id: 'a1',
    state: 'progress',
    event: { type: 'usage', input: 1, output: 2, total: 3 },
  }).success);
  assert.equal(
    streamJsonEventSchema.safeParse({ type: 'tool', name: 'edit_file', id: 't1', state: 'done', meta: { kind: 'file_write', summary: 'x' } }).success,
    false,
    'legacy tool kind must be rejected',
  );
  assert.equal(
    streamJsonEventSchema.safeParse({ type: 'subagent', phase: 'start', agentId: 'a1' }).success,
    false,
    'legacy subagent envelope must be rejected',
  );
});

test('the stream validator rejects non-JSON lines and unknown events', () => {
  assert.throws(() => eventsOf({ stdout: '{"type":"text","text":"ok"}\nnot-json\n' }), /is not JSON/);
  assert.throws(() => assertValidStream({ stdout: '{"type":"bogus"}\n' }), /failed v1 schema validation/);
  assert.doesNotThrow(() => assertValidStream({ stdout: '{"type":"text","text":"ok"}\n' }));
});

test('help and version short-circuit before flag validation', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'unused' }));
  const help = await cli(f, p.url, ['--help', '--output-format', 'bogus']).done;
  assert.equal(help.code, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /--json-schema/);
  const version = await cli(f, p.url, ['--version', '--json-schema', '']).done;
  assert.equal(version.code, 0, version.stdout + version.stderr);
  const emptyFormat = await cli(f, p.url, ['--output-format', '', '-p', 'x']).done;
  assert.equal(emptyFormat.code, 1, 'explicit empty output format must fail closed');
});

test('text output stays the default and emits no NDJSON envelope', async t => {
  const f = await fixture(t);
  const p = await provider(t, (_, response) => sse(response, { text: 'plain text answer' }));

  const defaultRun = await cli(f, p.url, ['-p', 'say hello']).done;
  assert.equal(defaultRun.code, 0, defaultRun.stdout + defaultRun.stderr);
  assert.equal(defaultRun.stdout.trim(), 'plain text answer');
  assert.equal(defaultRun.stdout.includes('"type":"session"'), false);

  const explicitText = await cli(f, p.url, ['--output-format', 'text', '-p', 'say hello']).done;
  assert.equal(explicitText.code, 0, explicitText.stdout + explicitText.stderr);
  assert.equal(explicitText.stdout.trim(), 'plain text answer');
});
