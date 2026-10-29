// A provider that dies mid-stream must reach the user with its reason and
// without the API key, not as "[object Object]".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, cli } from './helpers.mjs';

const KEY = 'sk-proj-SECRETKEY1234567890abcdef';

test('a mid-stream provider failure reports the upstream reason and never the key', async t => {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    chunk({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Work' }, finish_reason: null }] });
    chunk({ error: { message: `upstream rejected key ${KEY}`, type: 'invalid_request_error' } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t);
  const run = await cli(f, `http://127.0.0.1:${server.address().port}/v1`, ['--json', '-p', 'hi'], { env: { VYEN_API_KEY: KEY } }).done;
  assert.equal(run.code, 1, run.stderr);
  assert.ok(!run.stdout.includes(KEY), 'the key must never reach stdout');
  const errorEvent = run.stdout.trim().split('\n').map(line => JSON.parse(line)).find(e => e.type === 'error');
  assert.ok(errorEvent, 'an error event must be emitted');
  assert.notEqual(errorEvent.message, '[object Object]');
  assert.match(errorEvent.message, /upstream rejected key/);
});
