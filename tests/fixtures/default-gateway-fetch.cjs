// Test-only network shim: the CLI must reach the default gateway warning path
// without sending a real request to api.yuristore.xyz. It answers the two
// endpoints used by `doctor` and a normal prompt, and logs each request so the
// test can assert that the warning came first.
const CHAT_SSE = [
  'data: {"id":"chatcmpl-default","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-default","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Default gateway works."},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-default","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}',
  'data: [DONE]',
  '',
].join('\n\n');

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  process.stderr.write(`[default-gateway-fetch] ${url}\n`);
  if (url.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/chat/completions')) {
    return new Response(CHAT_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response('not found', { status: 404 });
};
