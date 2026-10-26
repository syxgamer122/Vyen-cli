import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  McpManager,
  formatMcpList,
  loadMergedMcpConfig,
  loadProjectMcpConfig,
  mcpConfigSchema,
  mcpConfigPath,
  mcpToolName,
  projectMcpCommandCandidates,
  projectMcpConfigPath,
  saveProjectMcpConfig,
} from '../dist/mcp.js';
import { ToolRegistry } from '../dist/tools.js';
import { mockMcpServer } from './fixtures/mcp-server.mjs';
import { fixture, cli, provider, sse } from './helpers.mjs';

const stdio = extra => mcpConfigSchema.parse({ servers: { local: { transport: 'stdio', command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'], ...extra } } });
const call = (toolName, input = {}) => ({ toolName, input, toolCallId: 'fixture' });
const signal = () => new AbortController().signal;

test('MCP stdio discovers pages, validates arguments, preserves approvals and unregisters on close', async t => {
  const f = await fixture(t);
  let approvals = 0;
  const registry = new ToolRegistry(f.cwd, async () => { approvals++; return false; });
  const manager = new McpManager(stdio({ readOnlyTools: ['echo', 'wait', 'fail'] }), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);
  assert.equal(manager.tools.length, 5);
  const echo = mcpToolName('local', 'echo'), danger = mcpToolName('local', 'danger-tool');
  assert.equal((await registry.execute(call(echo, { text: 'hello' }), signal())).text, 'hello');
  await assert.rejects(registry.execute(call(echo, { text: 4 }), signal()), /Invalid arguments/);
  assert.equal((await registry.execute(call(danger), signal())).denied, true);
  assert.equal(approvals, 1, 'server readOnlyHint cannot bypass approvals');
  await assert.rejects(registry.execute(call(mcpToolName('local', 'fail')), signal()), /Tool failed/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  await assert.rejects(registry.execute(call(mcpToolName('local', 'wait')), controller.signal));
  clearTimeout(timer);
  await manager.close();
  assert(!Object.keys(registry.schemas()).includes(echo));
  await manager.close();
});

test('MCP read-only mode uses the user allowlist and stdio forwards only configured secrets', async t => {
  const f = await fixture(t);
  const oldKey = process.env.VYEN_API_KEY, oldForwarded = process.env.VYEN_TEST_FORWARD;
  process.env.VYEN_API_KEY = 'must-not-inherit'; process.env.VYEN_TEST_FORWARD = 'explicit-value';
  t.after(() => {
    if (oldKey === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = oldKey;
    if (oldForwarded === undefined) delete process.env.VYEN_TEST_FORWARD; else process.env.VYEN_TEST_FORWARD = oldForwarded;
  });
  const registry = new ToolRegistry(f.cwd, async () => true, true);
  const manager = new McpManager(stdio({ readOnlyTools: ['echo'], envFrom: { FORWARDED: 'VYEN_TEST_FORWARD' } }), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);
  assert(!Object.keys(registry.schemas()).includes(mcpToolName('local', 'danger-tool')));
  const result = await registry.execute(call(mcpToolName('local', 'echo'), { text: 'env' }), signal());
  assert.deepEqual(JSON.parse(result.text), { forwarded: 'explicit-value', apiKey: null });
  await manager.close();
});

test('MCP Streamable HTTP uses bearer env credentials and executes real protocol calls', async t => {
  const f = await fixture(t), clients = [];
  const http = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer vyen-mcp-test-token');
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const server = mockMcpServer(); clients.push(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(request, response);
    response.on('close', () => server.close());
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all(clients.map(c => c.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  process.env.VYEN_MCP_TEST_TOKEN = 'vyen-mcp-test-token';
  t.after(() => { delete process.env.VYEN_MCP_TEST_TOKEN; });
  const config = mcpConfigSchema.parse({ servers: { remote: { transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`,
    bearerEnv: 'VYEN_MCP_TEST_TOKEN', readOnlyTools: ['echo'] } } });
  const registry = new ToolRegistry(f.cwd, async () => false);
  const manager = new McpManager(config, f.cwd); t.after(() => manager.close());
  await manager.connect(registry);
  assert.equal((await registry.execute(call(mcpToolName('remote', 'echo'), { text: 'remote works' }), signal())).text, 'remote works');
  await manager.close();
});

test('real CLI dispatches MCP tools and startup failure releases session locks', async t => {
  const f = await fixture(t);
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  const path = join(f.config, 'vyen/mcp.json');
  await writeFile(path, JSON.stringify(stdio({ readOnlyTools: ['echo'] })));
  const echo = mcpToolName('local', 'echo');
  const p = await provider(t, (body, response, n) => {
    if (body.messages.some(m => m.content === 'bypass broken config')) return sse(response, { text: 'Bypassed.' });
    if (n === 1) { assert(body.tools.some(t => t.function.name === echo)); return sse(response, { calls: [{ id: 'echo1', name: echo, input: { text: 'CLI MCP' } }] }); }
    assert.equal(body.messages.at(-1).content, 'CLI MCP'); return sse(response, { text: 'MCP done.' });
  });
  const result = await cli(f, p.url, ['--read-only', '-p', 'use MCP']).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /MCP done/);
  await writeFile(path, JSON.stringify({ servers: { broken: { transport: 'stdio', command: 'vyen-nonexistent-binary-123' } } }));
  const broken = await cli(f, p.url, ['-p', 'do nothing']).done;
  assert.equal(broken.code, 1);
  assert.deepEqual((await readdir(join(f.data, 'vyen/sessions'))).filter(n => n.endsWith('.lock')), []);
  const bypass = await cli(f, p.url, ['--no-mcp', '-p', 'bypass broken config']).done;
  assert.equal(bypass.code, 0, bypass.stderr);
});

test('MCP request timeout leaves no registered tools and redacts configured credentials', async t => {
  const f = await fixture(t);
  process.env.VYEN_MCP_ERROR_TOKEN = 'mcp-error-secret';
  t.after(() => { delete process.env.VYEN_MCP_ERROR_TOKEN; });
  const http = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the request */ }
    response.writeHead(401, { 'content-type': 'text/plain' }); response.end('Rejected mcp-error-secret');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  const registry = new ToolRegistry(f.cwd, async () => true);
  const config = mcpConfigSchema.parse({ servers: { broken: { transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`,
    bearerEnv: 'VYEN_MCP_ERROR_TOKEN', timeoutMs: 200 } } });
  const manager = new McpManager(config, f.cwd);
  await assert.rejects(manager.connect(registry), error => !error.message.includes('mcp-error-secret'));
  assert.deepEqual(manager.tools, []);
  const timeout = new McpManager(stdio({ timeoutMs: 100 }), f.cwd);
  // A real child that starts but never responds to initialize.
  timeout.config.servers.local.args = ['-e', 'process.stdin.resume()'];
  const start = Date.now();
  await assert.rejects(timeout.connect(registry), /timed out|timeout/i);
  assert(Date.now() - start < 5000);
  assert(!Object.keys(registry.schemas()).some(n => n.startsWith('mcp_')));
});

test('SIGTERM during MCP initialization preserves exit status, kills the server and unlocks the session', async t => {
  const f = await fixture(t);
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  await writeFile(join(f.config, 'vyen/mcp.json'), JSON.stringify({ servers: { waiting: {
    transport: 'stdio', command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('mcp-ready', String(process.pid)); process.stdin.resume()"],
  } } }));
  const running = cli(f, 'http://127.0.0.1:1/v1', ['-p', 'never contact model']);
  let pid;
  for (let i = 0; i < 200; i++) {
    try { pid = Number(await readFile(join(f.cwd, 'mcp-ready'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert(pid, 'MCP child did not start');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  running.child.kill('SIGTERM');
  const result = await running.done;
  if (process.platform === 'win32' && result.code === null) {
    assert.equal(result.signal, 'SIGTERM');
    try { process.kill(pid, 'SIGKILL'); } catch {}
  } else {
    assert.equal(result.code, 143, result.stderr);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert(!(await readdir(join(f.data, 'vyen/sessions'))).some(n => n.endsWith('.lock')));
  }
});

test('MCP stdio handles REA-scale server (207 tools, >2.7MB tools/list payload, >20KB Draft 2020-12 schema, mcpServers config)', async t => {
  const f = await fixture(t);
  let approvals = 0;
  const registry = new ToolRegistry(f.cwd, async () => { approvals++; return false; });
  const config = mcpConfigSchema.parse({
    mcpServers: {
      rea: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--rea-scale'],
        trust: true,
      },
    },
  });
  const manager = new McpManager(config, f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);
  assert.equal(manager.tools.length, 207);
  assert.equal(manager.statuses.length, 1);
  assert.equal(manager.statuses[0].status, 'ok');
  assert.equal(manager.statuses[0].toolCount, 207);
  const firstTool = mcpToolName('rea', 'rea_tool_1');
  const lastTool = mcpToolName('rea', 'rea_tool_207');
  assert(Object.keys(registry.schemas()).includes(firstTool));
  assert(Object.keys(registry.schemas()).includes(lastTool));
  const res = await registry.execute(call(lastTool, { query: 'hello-rea', mode: 'fast' }), signal());
  assert.equal(res.text, 'called:rea_tool_207:hello-rea');
  assert.equal(approvals, 0, 'trust: true auto-approves server tools');
  await manager.close();
});

test('MCP supports Codex config.toml import and enabledTools/disabledTools filtering', async t => {
  const { parseCodexMcpServers } = await import('../dist/mcp.js');
  const toml = `
model = "gpt-5.4"

[mcp_servers.rea]
command = "rea"
args = ["mcp", "serve"]
startup_timeout_sec = 45
tool_timeout_sec = 120
enabled_tools = ["rea_tool_1", "rea_tool_2"]
disabled_tools = ["rea_tool_2"]
default_tools_approval_mode = "approve"

[mcp_servers.rea.env]
REA_MODE = "production"
`;
  const parsed = parseCodexMcpServers(toml);
  assert(parsed.rea);
  assert.equal(parsed.rea.transport, 'stdio');
  assert.equal(parsed.rea.command, 'rea');
  assert.deepEqual(parsed.rea.args, ['mcp', 'serve']);
  assert.equal(parsed.rea.timeoutMs, 45_000);
  assert.equal(parsed.rea.toolTimeoutMs, 120_000);
  assert.equal(parsed.rea.trust, true);
  assert.deepEqual(parsed.rea.env, { REA_MODE: 'production' });

  const f = await fixture(t);
  const registry = new ToolRegistry(f.cwd, async () => true);
  const filteredConfig = mcpConfigSchema.parse({
    mcpServers: {
      rea: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--rea-scale'],
        enabledTools: ['rea_tool_1', 'rea_tool_2', 'rea_tool_3'],
        disabledTools: ['rea_tool_2'],
      },
    },
  });
  const manager = new McpManager(filteredConfig, f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);
  assert.deepEqual(manager.tools.map(tl => tl.name).sort(), [
    mcpToolName('rea', 'rea_tool_1'),
    mcpToolName('rea', 'rea_tool_3'),
  ].sort());
  await manager.close();
});

test('read_mcp_resource requires approval and is absent in read-only mode', async t => {
  const f = await fixture(t);
  const approvals = [];
  const registry = new ToolRegistry(f.cwd, async request => { approvals.push(request.tool); return true; });
  const manager = new McpManager(stdio({}), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  const names = Object.keys(registry.schemas());
  assert.ok(names.includes('read_mcp_resource'));

  const result = await registry.execute(
    call('read_mcp_resource', { server: 'local', uri: 'file:///etc/shadow' }),
    signal(),
  );
  assert.deepEqual(approvals, ['read_mcp_resource']);
  assert.match(result.text, /root:x:0:0/);
  await manager.close();

  // A read-only registry must not offer the tool at all.
  const readOnlyRegistry = new ToolRegistry(f.cwd, async () => true, true);
  const readOnlyManager = new McpManager(stdio({}), f.cwd);
  t.after(() => readOnlyManager.close());
  await readOnlyManager.connect(readOnlyRegistry);
  assert.ok(!Object.keys(readOnlyRegistry.schemas()).includes('read_mcp_resource'));
  await readOnlyManager.close();
});

test('an MCP server error never leaks a resolved credential', async t => {
  const f = await fixture(t);
  const secret = 'sk-live-mcp-secret-value';
  process.env.VYEN_MCP_SHORT_SECRET = 'abc';
  t.after(() => { delete process.env.VYEN_MCP_SHORT_SECRET; });
  const registry = new ToolRegistry(f.cwd, async () => true);
  const manager = new McpManager(stdio({
    env: {
      LEAKED_TOKEN: secret,
      SHORT_TOKEN: '${VYEN_MCP_SHORT_SECRET}',
      FALLBACK_TOKEN: '${VYEN_MCP_MISSING_VAR:-fallback-secret}',
    },
  }), f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);

  for (const [name, value] of [['literal', secret], ['short-env', 'abc'], ['fallback', 'fallback-secret']]) {
    await assert.rejects(
      registry.execute(call(mcpToolName('local', 'leak')), signal()),
      err => {
        assert.ok(!String(err.message).includes(value), `the ${name} secret must not appear in the error`);
        return true;
      },
    );
  }
  await manager.close();
});

const projectServer = extra => ({
  transport: 'stdio',
  command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'],
  ...extra,
});

test('loadProjectMcpConfig strips BOM, rejects corrupt JSON and project trust', async t => {
  const f = await fixture(t);
  const projectPath = projectMcpConfigPath(f.cwd);
  assert.equal(projectPath, join(f.cwd, '.vyen', 'mcp.json'));
  await mkdir(join(f.cwd, '.vyen'), { recursive: true });

  assert.deepEqual(await loadProjectMcpConfig(f.cwd), { servers: {} });

  await saveProjectMcpConfig(f.cwd, mcpConfigSchema.parse({ servers: { proj: projectServer() } }));
  assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).servers.proj.command, process.execPath);

  await writeFile(projectPath, '\uFEFF' + JSON.stringify({ servers: { proj: projectServer() } }));
  assert.equal((await loadProjectMcpConfig(f.cwd)).servers.proj.transport, 'stdio');

  await writeFile(projectPath, '{broken');
  await assert.rejects(loadProjectMcpConfig(f.cwd), /Failed to parse project MCP config/);

  await writeFile(projectPath, JSON.stringify({ servers: { proj: { command: 'node', args: [], source: 'user' } } }));
  await assert.rejects(loadProjectMcpConfig(f.cwd), /Invalid project MCP config/);

  await writeFile(projectPath, JSON.stringify({ servers: { proj: { command: 'node', args: [], trust: true } } }));
  await assert.rejects(loadProjectMcpConfig(f.cwd), /may not set trust/);
  await assert.rejects(
    saveProjectMcpConfig(f.cwd, mcpConfigSchema.parse({ servers: { proj: { command: 'node', args: [], trust: true } } })),
    /may not set trust/,
  );

  await rm(projectPath);
  assert.deepEqual(await loadProjectMcpConfig(f.cwd), { servers: {} });
});

test('loadMergedMcpConfig keeps the user server when a project entry has the same name', async t => {
  const f = await fixture(t);
  const userConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['user.mjs'], readOnlyTools: ['echo'], trust: true },
  } });
  const projectConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['project.mjs'] },
    projectOnly: { command: process.execPath, args: ['project.mjs'], trust: true, readOnlyTools: ['echo'] },
  } });

  const merged = await loadMergedMcpConfig(f.cwd, { isTrusted: true, userConfig, projectConfig });

  assert.equal(merged.servers.shared.command, process.execPath);
  assert.deepEqual(merged.servers.shared.args, ['user.mjs']);
  assert.equal(merged.servers.shared.trust, true);
  assert.deepEqual(merged.servers.shared.readOnlyTools, ['echo']);
  assert.equal(merged.sources.shared, 'user');
  assert.deepEqual(merged.ignoredProject, ['shared']);
  assert.equal(merged.servers.projectOnly.disabled, false);
  assert.equal(merged.servers.projectOnly.trust, false);
  assert.deepEqual(merged.servers.projectOnly.readOnlyTools, []);
  assert.equal(merged.sources.projectOnly, 'project');
  assert.equal(merged.projectPresent, true);
  assert.equal(merged.userPath, mcpConfigPath());
  assert.equal(merged.projectPath, projectMcpConfigPath(f.cwd));
  assert.deepEqual(projectMcpCommandCandidates(projectConfig.servers), [
    process.execPath, 'project.mjs',
    process.execPath, 'project.mjs',
  ]);
});

test('project MCP servers cannot grant trust or read-only approvals', async t => {
  const f = await fixture(t);
  const projectConfig = mcpConfigSchema.parse({ servers: {
    projectOnly: projectServer({ trust: true, readOnlyTools: ['echo'] }),
  } });
  const merged = await loadMergedMcpConfig(f.cwd, {
    isTrusted: true,
    userConfig: mcpConfigSchema.parse({ servers: {} }),
    projectConfig,
  });
  assert.equal(merged.servers.projectOnly.trust, false);
  assert.deepEqual(merged.servers.projectOnly.readOnlyTools, []);

  let approvals = 0;
  const registry = new ToolRegistry(f.cwd, async () => { approvals++; return false; });
  const manager = new McpManager(merged, f.cwd);
  t.after(() => manager.close());
  await manager.connect(registry);
  const result = await registry.execute(call(mcpToolName('projectOnly', 'echo'), { text: 'x' }), signal());
  assert.equal(result.denied, true);
  assert.equal(approvals, 1, 'project config cannot exempt its tools from approval');
  await manager.close();
});

test('untrusted project MCP servers are listed as disabled with project source', async t => {
  const f = await fixture(t);
  const userConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['user.mjs'] },
  } });
  const projectConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['project.mjs'] },
    projectOnly: projectServer({ readOnlyTools: ['echo'] }),
    optedOut: projectServer({ disabled: true }),
  } });

  const merged = await loadMergedMcpConfig(f.cwd, { isTrusted: false, userConfig, projectConfig });

  assert.equal(merged.servers.shared.disabled, false);
  assert.equal(merged.servers.shared.trust, false);
  assert.equal(merged.servers.projectOnly.disabled, true);
  assert.equal(merged.servers.projectOnly.trust, false);
  assert.deepEqual(merged.servers.projectOnly.readOnlyTools, []);
  assert.equal(merged.sources.projectOnly, 'project');
  assert.deepEqual(merged.untrusted, ['projectOnly']);
  assert.deepEqual(merged.ignoredProject, ['shared']);
  assert.equal(merged.servers.optedOut.disabled, true);
  assert.ok(!merged.untrusted.includes('optedOut'), 'an already-disabled server is not reported as trust-blocked');
});

test('formatMcpList marks user and project servers and untrusted state', async t => {
  const f = await fixture(t);
  const userConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['user.mjs'] },
  } });
  const projectConfig = mcpConfigSchema.parse({ servers: {
    shared: { command: process.execPath, args: ['project.mjs'] },
    projectOnly: projectServer(),
    optedOut: projectServer({ disabled: true }),
  } });
  const merged = await loadMergedMcpConfig(f.cwd, { isTrusted: false, userConfig, projectConfig });

  const text = formatMcpList(merged, [{ name: 'shared', status: 'ok', toolCount: 3 }]);
  assert.match(text, /MCP Servers \(3\)/);
  assert.match(text, /shared\s+\[stdio\] \[user\] \(connected, 3 tools\)/);
  assert.match(text, /projectOnly\s+\[stdio\] \[project\] \(disabled, untrusted\)/);
  assert.match(text, /optedOut\s+\[stdio\] \[project\] \(disabled\)/);
  assert.match(text, /Ignored project overrides.*shared/);
});

test('project MCP server does not start without workspace trust and user servers still start', async t => {
  const f = await fixture(t);
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  await writeFile(join(f.config, 'vyen', 'mcp.json'), JSON.stringify({ servers: { user: projectServer() } }));
  await mkdir(join(f.cwd, '.vyen'), { recursive: true });
  await writeFile(join(f.cwd, '.vyen', 'mcp.json'), JSON.stringify({ servers: { project: projectServer() } }));

  let requests = 0;
  const p = await provider(t, (body, response) => {
    requests++;
    assert(body.tools.some(tool => tool.function.name === mcpToolName('user', 'echo')), 'user MCP tools must be available');
    assert(
      !body.tools.some(tool => tool.function.name === mcpToolName('project', 'echo')),
      'project MCP tools must stay disabled until the workspace is trusted',
    );
    sse(response, { text: 'Done.' });
  });
  const result = await cli(f, p.url, ['-p', 'hello']).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, 1);
  assert.match(result.stderr, /project MCP server.*not trusted|project MCP server.*disabled/);
});

test('project MCP config errors are reported and do not prevent user MCP servers from starting', async t => {
  const f = await fixture(t);
  await mkdir(join(f.config, 'vyen'), { recursive: true });
  await writeFile(join(f.config, 'vyen', 'mcp.json'), JSON.stringify({ servers: { user: projectServer() } }));
  await mkdir(join(f.cwd, '.vyen'), { recursive: true });
  await writeFile(join(f.cwd, '.vyen', 'mcp.json'), '{broken');

  const p = await provider(t, (body, response) => {
    assert(body.tools.some(tool => tool.function.name === mcpToolName('user', 'echo')), 'user MCP tools must survive a project config error');
    assert(
      !body.tools.some(tool => tool.function.name === mcpToolName('project', 'echo')),
      'no project server may load from a corrupt file',
    );
    sse(response, { text: 'Done.' });
  });
  const result = await cli(f, p.url, ['-p', 'hello']).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /MCP warning: could not load project MCP config/);
});

test('project MCP server starts when the workspace is explicitly trusted', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.vyen'), { recursive: true });
  await writeFile(join(f.cwd, '.vyen', 'mcp.json'), JSON.stringify({ servers: { project: projectServer() } }));

  const p = await provider(t, (body, response) => {
    assert(
      body.tools.some(tool => tool.function.name === mcpToolName('project', 'echo')),
      'explicit workspace trust must allow the project server to start',
    );
    sse(response, { text: 'Done.' });
  });
  const result = await cli(f, p.url, ['--trust-workspace', '-p', 'hello']).done;
  assert.equal(result.code, 0, result.stderr);
});


