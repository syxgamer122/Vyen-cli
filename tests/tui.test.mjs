import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TerminalUI, THEME, terminalText, wrapTerminal } from '../dist/tui.js';

function terminal(t) {
  const input = new PassThrough(), output = new PassThrough();
  input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  output.columns = 40; output.rows = 12;
  let written = '', cancelled = 0;
  output.on('data', chunk => { written += chunk; });
  const ui = new TerminalUI('test-model', () => { cancelled++; }, input, output);
  t.after(() => ui.close());
  const key = (text, name, extra = {}) => input.emit('keypress', text, { name, ...extra });
  return { ui, input, output, key, get written() { return written; }, get cancelled() { return cancelled; } };
}

test('TUI edits Unicode input, recalls history and restores terminal state on close', async t => {
  const tty = terminal(t);
  assert.equal(tty.input.isRaw, true);
  const first = tty.ui.question('vyen> ', undefined, true);
  tty.key('xin chào', undefined); tty.key('', 'left'); tty.key('', 'backspace'); tty.key('a', 'a'); tty.key('', 'return');
  assert.equal(await first, 'xin chao');
  const second = tty.ui.question('vyen> ', undefined, true);
  tty.key('', 'up'); tty.key('', 'return'); assert.equal(await second, 'xin chao');
  tty.ui.close(); tty.ui.close();
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount('keypress'), 0);
  assert.equal(tty.output.listenerCount('resize'), 0);
  assert(tty.written.includes('\x1b[?1049h'));
  assert(tty.written.endsWith('\x1b[?25h\x1b[?1049l'));
});

test('paired-device input answers a pending question but never executes slash commands', async t => {
  const tty = terminal(t);
  const executed = [];
  tty.ui.onImmediateCommand = cmd => { executed.push(cmd); };

  // A pending question accepts a path-like answer that starts with `/`, even from a remote device.
  const answer = tty.ui.question('[path] ', undefined, true);
  tty.ui.submitExternalPrompt('/etc/hosts', { allowCommands: false });
  assert.equal(await answer, '/etc/hosts');
  assert.deepEqual(executed, []);

  // Command-looking remote input is queued as prompt text, never dispatched locally.
  tty.ui.submitExternalPrompt('/cd C:\\Windows', { allowCommands: false });
  tty.ui.submitExternalPrompt('/revert --force', { allowCommands: false });
  tty.ui.submitExternalPrompt('/delete current', { allowCommands: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(executed, []);
  assert.equal(tty.ui.hasQueuedPrompts(), true);

  // Local input still runs commands; the option is what separates the two paths.
  tty.ui.submitExternalPrompt('/help');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(executed, ['/help']);
});

test('TUI cancels approvals, handles Ctrl+C and redraws at narrow terminal sizes', async t => {
  const tty = terminal(t), controller = new AbortController();
  const approval = tty.ui.question('[y/N] ', controller.signal);
  controller.abort(); await assert.rejects(approval, /cancelled/);
  tty.key('', 'c', { ctrl: true }); assert.equal(tty.cancelled, 1);
  tty.ui.event({ type: 'text', text: 'hello\nworld\x1b[2J' });
  tty.ui.event({ type: 'tool', name: 'read_file', id: 'one', state: 'start' });
  tty.ui.event({ type: 'subagent', id: 'child', task: 'Inspect', state: 'start' });
  tty.ui.event({ type: 'subagent', id: 'child', state: 'progress', event: { type: 'usage', total: 15 } });
  tty.output.columns = 4; tty.output.rows = 8; tty.output.emit('resize');
  const prompt = tty.ui.question(); tty.key('abc', undefined);
  await new Promise(resolve => setTimeout(resolve, 40));
  tty.key('', 'return'); assert.equal(await prompt, 'abc');
  tty.ui.close();
});

test('terminal rendering strips complete escape sequences and wraps wide characters', () => {
  assert.equal(terminalText('safe\x1b[2Jtext\x1b]52;c;c2VjcmV0\x07end'), 'safetextend');
  assert.deepEqual(wrapTerminal('ab界c', 4), ['ab界', 'c']);
});

test('real TUI pseudo-terminal handles status, resize, approval and clean exit', async t => {
  if (process.platform === 'win32') { t.skip('POSIX pseudo-terminal test'); return; }
  const { spawn } = await import('node:child_process');
  const { resolve, join } = await import('node:path');
  const { readFile, readdir } = await import('node:fs/promises');
  const { fixture, provider, sse } = await import('./helpers.mjs');
  const f = await fixture(t);
  const p = await provider(t, (_, response, n) => n === 1 ? sse(response, {
    calls: [{ id: 'ui-write', name: 'write_file', input: { path: 'ui.txt', content: 'approved from TUI' } }],
  }) : sse(response, { text: 'Created by TUI.' }));
  const child = spawn('python3', [resolve('tests/fixtures/terminal.py'), process.execPath, resolve(process.env.VYEN_TEST_BIN ?? 'bin/vyen.mjs'),
    '--cwd', f.cwd, '--model', 'test-model', '--base-url', p.url], {
    env: { ...process.env, VYEN_API_KEY: 'tui-test-key', XDG_CONFIG_HOME: f.config, XDG_DATA_HOME: f.data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  assert.equal(result, 0, stderr + stdout);
  assert.deepEqual(JSON.parse(stdout), { code: 0, entered: true, restored: true, canonical: true });
  assert.equal(await readFile(join(f.cwd, 'ui.txt'), 'utf8'), 'approved from TUI');
  assert(!(await readdir(join(f.data, 'vyen/sessions'))).some(n => n.endsWith('.lock')));
});

test('real TUI pseudo-terminal: rebuilding the harness mid-run keeps the run cancellable', async t => {
  if (process.platform === 'win32') { t.skip('POSIX pseudo-terminal test'); return; }
  const { spawn } = await import('node:child_process');
  const { resolve, join } = await import('node:path');
  const { readdir } = await import('node:fs/promises');
  const { fixture, provider } = await import('./helpers.mjs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const f = await fixture(t);
  // The provider never answers, so the run stays in flight while the harness
  // is rebuilt. If Ctrl+C could not cancel it, the CLI would hang here.
  const p = await provider(t, async () => { await delay(60000); });
  const child = spawn('python3', [resolve('tests/fixtures/terminal.py'), '--cancel', process.execPath, resolve(process.env.VYEN_TEST_BIN ?? 'bin/vyen.mjs'),
    '--cwd', f.cwd, '--model', 'test-model', '--base-url', p.url], {
    env: { ...process.env, VYEN_API_KEY: 'tui-test-key', XDG_CONFIG_HOME: f.config, XDG_DATA_HOME: f.data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  assert.equal(result, 0, stderr + stdout);
  assert.deepEqual(JSON.parse(stdout), { code: 0, cancelled: true });
  assert(!(await readdir(join(f.data, 'vyen/sessions'))).some(n => n.endsWith('.lock')));
});

test('TUI separates opt-in reasoning from answers and consumes compact child progress', async t => {
  const tty = terminal(t); tty.output.columns = 100; tty.output.rows = 24;
  tty.ui.event({ type: 'reasoning', source: 'provider', text: 'native detail' });
  tty.ui.event({ type: 'reasoning', source: 'inline', text: 'thinking ' });
  tty.ui.event({ type: 'reasoning', source: 'inline', text: 'detail' });
  tty.ui.event({ type: 'text', text: 'Visible answer.' });
  tty.ui.event({ type: 'subagent', id: 'child123', state: 'start', task: 'Inspect one file' });
  tty.ui.event({ type: 'subagent', id: 'child123', state: 'progress', event: { type: 'usage', input: 10, output: 5, total: 15 } });
  tty.ui.event({ type: 'subagent', id: 'child123', state: 'progress', event: { type: 'tool', name: 'read_file', id: 'r1', state: 'done' } });
  tty.ui.event({ type: 'subagent', id: 'child123', state: 'done' });
  await new Promise(resolve => setTimeout(resolve, 40));
  const frame = tty.ui.renderedFrame();
  assert.equal(frame.split('∴ Thinking').length - 1, 2);
  assert(!frame.includes('[reasoning'), 'Must not render raw [reasoning] tags');
  assert(!frame.includes('[answer]'), 'Must not render raw [answer] header');
  assert.match(frame, /Visible answer\./);
  assert.match(frame, /agent child123: done/); assert.match(frame, /15 tokens/);
  assert.equal(frame.split('Inspect one file').length - 1, 1);
});

test('TUI supports slash-command Tab completion, Shift+Tab mode toggle, Alt+. effort cycling, and dynamic setup wizard with zero hardcoded models', async t => {
  const tty = terminal(t);
  let modeToggles = 0;
  const efforts = [];
  tty.ui.onToggleMode = () => { modeToggles++; tty.ui.setMode('auto'); };
  tty.ui.onCycleEffort = dir => { efforts.push(dir); tty.ui.setEffort('xhigh'); };
  const q = tty.ui.question('vyen> ', undefined, true);
  tty.key('', 'tab', { shift: true });
  assert.equal(modeToggles, 1);
  tty.key('.', '.', { meta: true });
  assert.deepEqual(efforts, [1]);
  tty.key('/eff', undefined);
  tty.key('', 'tab');
  tty.key('', 'return');
  assert.equal((await q).trim(), '/effort');

  const { fixture } = await import('./helpers.mjs');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { runSetupWizard, resolveRuntime, PROVIDER_PRESETS, EFFORT_LEVELS } = await import('../dist/index.js');
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const preset of PROVIDER_PRESETS) {
    assert(!('models' in preset), `Preset ${preset.id} must not hardcode models`);
  }

  const f = await fixture(t);
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  const oldKey = process.env.VYEN_API_KEY;
  process.env.XDG_CONFIG_HOME = f.config;
  delete process.env.VYEN_API_KEY;
  t.after(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldKey !== undefined) process.env.VYEN_API_KEY = oldKey;
  });

  // Step 1: provider=4 (OpenRouter), Step 2: URL, Step 3: API Key, Step 4: pick discovered model #1, Step 5: effort=xhigh
  const answers = ['4', 'https://openrouter.ai/api/v1', 'sk-or-wizard-secret-key', '1', 'xhigh'];
  let outputLog = '';
  const updated = await runSetupWizard(undefined, {
    write: text => { outputLog += text; },
    ask: async () => answers.shift() ?? '',
    discover: async (url, key) => {
      assert.equal(url, 'https://openrouter.ai/api/v1');
      assert.equal(key, 'sk-or-wizard-secret-key');
      return [{ id: 'dynamic/discovered-model-v1', contextWindow: 200_000 }];
    },
  });
  assert.equal(updated.provider, 'openai-compatible');
  assert.equal(updated.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(updated.model, 'dynamic/discovered-model-v1');
  assert.equal(updated.effort, 'xhigh');
  assert.match(outputLog, /Setup saved/);

  const rawConfig = await readFile(join(f.config, 'vyen', 'config.json'), 'utf8');
  assert(!rawConfig.includes('sk-or-wizard-secret-key'));
  const runtime = await resolveRuntime(updated, f.cwd);
  assert.equal(runtime.apiKey, 'sk-or-wizard-secret-key');
  assert.equal(runtime.effort, 'xhigh');
});

test('Codex TUI renders Markdown bullets without false-positive red diff coloring, coalesces Explored cells, and suppresses noisy tool_stream status', async t => {
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 30;
  tty.ui.setStatus('Running');

  // 1. Live tool_stream event is suppressed from status bar (only clean Working status shown)
  tty.ui.event({ type: 'tool_stream', id: 'tc1', name: 'write_file', state: 'delta', preview: 'src/app.ts' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(tty.written.includes('\x1b[?2026h'), 'Should wrap frames in DEC Mode 2026 synchronized output');
  assert(!tty.written.includes('Streaming write_file:'), 'Must NOT display noisy Streaming write_file status');
  assert(tty.written.includes('Working'), 'Should display clean Working status indicator');

  // 2. Coalesced Explored cell for consecutive read/list/search tools
  tty.ui.event({
    type: 'tool',
    id: 'r1',
    name: 'read_file',
    state: 'done',
    meta: { kind: 'read', summary: 'src/index.ts' },
  });
  tty.ui.event({
    type: 'tool',
    id: 's1',
    name: 'search',
    state: 'done',
    meta: { kind: 'search', summary: 'createModel in src' },
  });

  // 3. Ran cell and Edited cell with (+A -R) diff
  tty.ui.event({
    type: 'tool',
    id: 'b1',
    name: 'bash',
    state: 'done',
    meta: { kind: 'exec', summary: 'npm test', durationMs: 1200, outputPreview: ['PASS all tests'], omittedLines: 0 },
  });
  tty.ui.event({
    type: 'tool',
    id: 'e1',
    name: 'edit_file',
    state: 'done',
    meta: {
      kind: 'edit',
      verb: 'Edited',
      summary: 'src/app.ts',
      added: 1,
      removed: 1,
      diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-const oldVal = 1;\n+const newVal = 2;',
    },
  });

  // 4. Markdown answer with bullet lists (- item) must NOT be colored red (\x1b[31m)
  tty.ui.event({
    type: 'text',
    text: '# Summary\n- **Todo list:** completed\n- `inline_code` works\n',
  });
  await new Promise(resolve => setTimeout(resolve, 30));

  const lastFrame = tty.ui.renderedFrame();
  assert.match(lastFrame, /Explored/);
  assert.match(lastFrame, /Read.*src\/index\.ts/);
  assert.match(lastFrame, /Search.*createModel in src/);
  assert.match(lastFrame, /Ran/);
  assert.match(lastFrame, /Edited/);
  assert.match(lastFrame, /• .*Todo list:.* completed/);

  // Verify the bullet list line is NOT colored red (\x1b[31m), while the real diff deletion line IS colored red
  const lines = lastFrame.split('\r\n');
  const todoBulletLine = lines.find(l => l.includes('Todo list:'));
  assert(todoBulletLine, 'Should find rendered Todo list bullet line');
  assert(!todoBulletLine.includes(THEME.delFg), 'Markdown bullet list item must NOT be colored as a diff deletion');

  const diffRemovedLine = lines.find(l => l.includes('const oldVal = 1;'));
  assert(diffRemovedLine, 'Should find rendered diff deletion line');
  assert(diffRemovedLine.includes(THEME.delFg) && diffRemovedLine.includes(THEME.delBg), 'Real diff deletion line must use the deletion colors');
});

test('Codex TUI collapses pasted ScreenClip image paths into [Image #1], prevents line-wrap cursor drift, and scrolls with mouse wheel and Up/Down', async t => {
  const { fixture } = await import('./helpers.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { stripVTControlCharacters } = await import('node:util');
  const { WorkspaceFiles, expandFileMentions } = await import('../dist/index.js');

  const f = await fixture(t);
  await mkdir(f.data, { recursive: true });
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  // Create an image file with a Windows ScreenClip-style GUID filename in f.data (outside workspace f.cwd!)
  const externalImgPath = join(f.data, '{25D1BD96-7B57-4392-BBF0-17E774BEEFF2}.png');
  await writeFile(externalImgPath, pngBytes);

  const tty = terminal(t);
  tty.output.columns = 80;
  tty.output.rows = 16;

  // 1. Emit 25 lines of long reasoning & answer text to overflow the 16-row viewport
  tty.ui.event({
    type: 'reasoning',
    source: 'provider',
    text: ('Long reasoning line that previously wrapped after adding the 4-char prefix. ').repeat(6) + '\n',
  });
  for (let i = 1; i <= 15; i++) {
    tty.ui.event({ type: 'text', text: `Line ${i} of assistant answer in transcript.\n` });
  }
  await new Promise(resolve => setTimeout(resolve, 25));

  // Verify NO rendered line in the frame exceeds columns - 1 (79 visible chars)
  for (const rawLine of tty.ui.renderedFrame().split('\r\n')) {
    const cleanLine = stripVTControlCharacters(rawLine.split('\r')[0]);
    assert(
      cleanLine.length <= 79,
      `Rendered line exceeded 79 visible columns (${cleanLine.length}): ${JSON.stringify(cleanLine)}`,
    );
  }

  // 2. Start prompt question and test Up/Down & SGR Mouse Wheel scrollback when transcript overflows
  const q = tty.ui.question('vyen> ', undefined, true);
  await new Promise(resolve => setTimeout(resolve, 25));

  // Press Up arrow on empty input -> scrolls up in transcript and the status row says how far
  tty.key('', 'up');
  await new Promise(resolve => setTimeout(resolve, 25));
  let latestFrame = tty.ui.renderedFrame();
  assert.match(latestFrame, /lines above the latest output/);

  // SGR mouse wheel up (\x1b[<64;10;10M) scrolls further up without leaking "64;10;10M" into input
  tty.key(undefined, 'undefined', { sequence: '\x1b[<' });
  for (const ch of '64;10;10M') tty.key(ch, ch);
  await new Promise(resolve => setTimeout(resolve, 25));

  // Press Escape while scrolled up -> returns to bottom (scroll = 0)
  tty.key('', 'escape');
  await new Promise(resolve => setTimeout(resolve, 25));
  latestFrame = tty.ui.renderedFrame();
  assert(!latestFrame.includes('lines above the latest output'), 'Escape should return scroll position to bottom');

  // 3. Simulate pasting the external ScreenClip image path via bracketed paste
  tty.key(undefined, 'paste-start', { sequence: '\x1b[200~' });
  tty.key(externalImgPath, undefined);
  tty.key(undefined, 'paste-end', { sequence: '\x1b[201~' });
  await new Promise(resolve => setTimeout(resolve, 25));

  latestFrame = tty.ui.renderedFrame();
  // Composer shows [Image #1] pill and Attached status bar instead of raw 100+ char path
  assert.match(latestFrame, /\[Image #1\]/);
  assert.match(latestFrame, /attached  \[Image #1\]/);
  assert(tty.written.includes('H\x1b[?25h'), 'Cursor should be positioned on boxMid row');

  // Submit the pasted image
  tty.key('', 'return');
  const submitted = await q;
  assert.equal(submitted.trim(), `@"${externalImgPath}"`);

  // 4. Verify expandFileMentions loads both @"<externalImgPath>" AND bare pasted externalImgPath (without @)
  const wsFiles = new WorkspaceFiles(f.cwd);
  const fromMention = await expandFileMentions(submitted, wsFiles, { model: 'space-bunny' });
  assert.equal(fromMention.imageParts.length, 1);
  assert.equal(fromMention.imageParts[0].mediaType, 'image/png');

  const fromBarePaste = await expandFileMentions(`Please inspect ${externalImgPath}`, wsFiles, { model: 'space-bunny' });
  assert.equal(fromBarePaste.imageParts.length, 1);
  assert.equal(fromBarePaste.imageParts[0].mediaType, 'image/png');
  assert.match(fromBarePaste.text, /\[Image #1: \{25D1BD96-7B57-4392-BBF0-17E774BEEFF2\}\.png\]/);
});

test('Codex TUI renders rounded composer text box with spacer gap, pipe-free thinking cells, differential row rendering, and cleans up askTransient prompts', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 90;
  tty.output.rows = 20;

  tty.ui.write('Type /help for commands, @file to attach files, !<cmd> for shell, or enter a task.\n');
  tty.ui.event({ type: 'reasoning', source: 'provider', text: 'Checking files without vertical bars\n' });
  tty.ui.event({ type: 'text', text: 'Direct bullet answer without [answer] tag.\n' });
  await new Promise(resolve => setTimeout(resolve, 25));

  // Verify 'Type /help for commands...' is dimmed with \x1b[2m
  assert(tty.ui.renderedFrame().includes(`${THEME.faint}Type /help for commands`), 'Type /help line must be styled faint');

  // Verify transient approval prompt appears while waiting and is removed once answered
  const approvalPromise = tty.ui.askTransient('\n▲ Allow bash?\n  $ npm test\n', '[y/N/a(lways)] ');
  await new Promise(resolve => setTimeout(resolve, 25));
  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /▲ Allow bash\?/);
  assert.match(frame, /\$ npm test/);

  tty.key('y', 'y');
  tty.key('', 'return');
  assert.equal(await approvalPromise, 'y');
  await new Promise(resolve => setTimeout(resolve, 25));

  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert(!frame.includes('Allow bash?'), 'Transient approval prompt should be removed from transcript after answer');
  assert.match(frame, /∴ Thinking/);
  assert.match(frame, /  Checking files without vertical bars/);
  assert.match(frame, /◆ Direct bullet answer without \[answer\] tag\./);

  // Minimal chrome: no header band and no boxes. A single rule, the prompt line, then one footer
  // line with mode, model and effort on the left and the token count on the right.
  const lines = frame.split('\r\n');
  assert(!lines[0].includes('test-model'), 'No header band repeating the model');
  assert(!/[╭╮╰╯]/.test(frame), 'No box borders');
  assert.match(lines.at(-3), /^─+$/);
  assert.match(lines.at(-2), /^› Ask anything   \/ commands/);
  assert.match(lines.at(-1), /^ask   test-model   effort default\s+0 tokens$/);
  assert(!frame.includes('Ready ·'), 'Footer should not contain Ready text');
  assert(!frame.includes('Queue'), 'Must not render Queue label when empty');

  // Verify differential rendering while busy: spinner ticks must NOT emit \x1b[2J or rewrite transcript lines
  const writtenLenBeforeSpin = tty.written.length;
  tty.ui.setStatus('Running');
  await new Promise(resolve => setTimeout(resolve, 180));
  const spinOutput = tty.written.slice(writtenLenBeforeSpin);
  assert(!spinOutput.includes('\x1b[2J'), 'Spinner ticks while working must NEVER emit \\x1b[2J (which resets mouse selection)');
  assert(!spinOutput.includes('Direct bullet answer'), 'Spinner ticks must not rewrite unchanged transcript rows');

  // Queue prompt while busy (no pending question active) — shown without the word 'Queue'
  tty.key('queued follow-up task', undefined);
  tty.key('', 'return');
  await new Promise(resolve => setTimeout(resolve, 25));

  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /queued  queued follow-up task   alt\+↑ edit/);
  assert(!frame.includes('Queue'), 'Queued row must not include the word Queue');

  // Next question(remember=true) automatically dequeues and resolves the queued prompt
  tty.ui.setStatus('Ready');
  const dequeued = await tty.ui.question('vyen> ', undefined, true);
  assert.equal(dequeued, 'queued follow-up task');
});

test('Codex TUI backtrack/revert removes reverted turns from screen, restores prompt into composer box, and supports Esc Esc rewind', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 90;
  tty.output.rows = 20;

  tty.ui.write('Welcome banner line\n');

  // Turn 1
  tty.ui.markTurnStart();
  tty.ui.write('\n> first prompt\n');
  tty.ui.event({ type: 'text', text: 'First answer.\n' });

  // Turn 2 (failed turn like HTTP 500 in screenshot)
  tty.ui.markTurnStart();
  tty.ui.write('\n> can u play valorant\n');
  tty.ui.write('\nUpstream provider returned HTTP 500:\n');
  await new Promise(resolve => setTimeout(resolve, 25));

  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /› can u play valorant/);
  assert.match(frame, /Upstream provider returned HTTP 500:/);

  // Start idle composer question and press Esc twice (Esc Esc) to trigger /revert
  const q1 = tty.ui.question('vyen> ', undefined, true);
  await new Promise(resolve => setTimeout(resolve, 20));

  tty.key('', 'escape');
  await new Promise(resolve => setTimeout(resolve, 20));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /Press Esc again to rewind and edit the previous prompt/);

  tty.key('', 'escape');
  assert.equal(await q1, '/revert');

  // Simulate CLI executing /revert for Turn 2: rewind 1 turn and restore prompt to composer
  assert.equal(tty.ui.rewindTurns(1), true);
  tty.ui.setInput('can u play valorant', true);
  tty.ui.setNotice('↺ Rewound 1 turn — edit prompt below, Enter to resend, or Esc Esc to rewind further');

  const q2 = tty.ui.question('vyen> ', undefined, true);
  await new Promise(resolve => setTimeout(resolve, 25));

  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  // Reverted Turn 2 is completely removed from the transcript body!
  assert(!frame.includes('Upstream provider returned HTTP 500:'), 'Failed turn error must be removed from screen');
  // Turn 1 is still intact on screen
  assert.match(frame, /› first prompt/);
  assert.match(frame, /◆ First answer\./);
  // And the reverted prompt 'can u play valorant' is restored into the prompt line
  assert.match(frame.split('\r\n').at(-2), /^› can u play valorant\s*$/);

  // Pressing Esc Esc again while restored prompt is untouched in composer triggers another /revert!
  tty.key('', 'escape');
  tty.key('', 'escape');
  assert.equal(await q2, '/revert');
});

test('welcomeBanner is a short unboxed block that wraps cleanly with NFD Vietnamese paths and /view toggles normal vs verbose thinking', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const { welcomeBanner, visibleLength } = await import('../dist/index.js');

  // NFD decomposed path: "D:\Thư mục mới (2)" ("u" + \u0323, "ơ" + \u0301)
  const nfdWorkspace = 'D:\\Th\u01B0 mu\u0323c m\u01A1\u0301i (2)';
  const banner = welcomeBanner('gpt-5.4', 'openai', 'https://api.ezaiapi.com/v1', 'max', nfdWorkspace, '0f40f011-0000-4000-8000-000000000000', 'ask');
  const lines = banner.trim().split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^◆ vyen v\d+\.\d+\.\d+$/);
  assert.match(banner, /model gpt-5\.4 {3}effort max {3}mode ask/);
  assert.match(banner, /gateway api\.ezaiapi\.com\/v1 \(openai\)/);
  assert.match(banner, /session 0f40f011/);
  assert(!/[╭╮╰╯│]/.test(banner), 'banner has no box');

  // Test /view mode: normal hides thinking blocks, verbose shows all thinking blocks
  const tty = terminal(t);
  tty.output.columns = 40;
  tty.output.rows = 20;

  // In a narrow terminal the banner wraps instead of breaking an outline; no row exceeds the width.
  tty.ui.write(banner);
  await new Promise(resolve => setTimeout(resolve, 25));
  for (const row of stripVTControlCharacters(tty.ui.renderedFrame()).split('\r\n')) {
    assert(visibleLength(row) <= 40, `row too wide: ${row}`);
  }
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /◆ vyen v/);
  tty.ui.clear();
  tty.output.columns = 90;

  tty.ui.setViewMode('normal');
  assert.equal(tty.ui.getViewMode(), 'normal');
  tty.ui.event({ type: 'reasoning', source: 'provider', text: 'Internal chain of thought step 1.\n' });
  tty.ui.event({ type: 'text', text: 'Final visible answer.\n' });
  await new Promise(resolve => setTimeout(resolve, 25));

  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert(!frame.includes('∴ Thinking'), 'In normal view mode, thinking blocks must be hidden');
  assert(!frame.includes('Internal chain of thought step 1.'), 'In normal view mode, reasoning text must be hidden');
  assert.match(frame, /◆ Final visible answer\./);

  // Switch to verbose view mode -> thinking block immediately appears
  tty.ui.setViewMode('verbose');
  assert.equal(tty.ui.getViewMode(), 'verbose');
  await new Promise(resolve => setTimeout(resolve, 25));

  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /∴ Thinking/);
  assert.match(frame, /Internal chain of thought step 1\./);
  assert.match(frame, /◆ Final visible answer\./);

  // Verify computeUnifiedDiff and TUI do NOT cap >60 line writes at +60
  const { computeUnifiedDiff } = await import('../dist/index.js');
  const longContent = Array.from({ length: 250 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join('\n') + '\n';
  const diff250 = computeUnifiedDiff('src/big.ts', '', longContent);
  assert.match(diff250, /--- a\/src\/big\.ts \(new \+250 -0\)/);
  const plusLines = diff250.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  assert.equal(plusLines.length, 250, 'computeUnifiedDiff must include all 250 added lines, not cap at 60');
});

test('Windows nul device bug prevention: sanitizeBashCommand, WorkspaceFiles rejection, and unlinkSafe', async () => {
  const { sanitizeBashCommand, WorkspaceFiles, WINDOWS_RESERVED_DEVICE_RE, toWinExtendedPath } =
    await import('../dist/index.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  assert.equal(WINDOWS_RESERVED_DEVICE_RE.test('nul'), true);
  assert.equal(WINDOWS_RESERVED_DEVICE_RE.test('NUL.txt'), true);
  assert.equal(WINDOWS_RESERVED_DEVICE_RE.test('CON'), true);
  assert.equal(WINDOWS_RESERVED_DEVICE_RE.test('normal.ts'), false);

  if (process.platform === 'win32') {
    assert.equal(sanitizeBashCommand('dir /a /b 2>nul'), 'dir /a /b 2>/dev/null');
    assert.equal(sanitizeBashCommand('git status >nul 2>&1'), 'git status >/dev/null 2>&1');
    assert.equal(sanitizeBashCommand('cmd >> NUL'), 'cmd >> /dev/null');
    assert.equal(sanitizeBashCommand('cat foo >/dev/nul'), 'cat foo >/dev/null');
    assert.match(toWinExtendedPath('D:\\testcli\\nul'), /^\\\\\?\\D:\\testcli\\nul$/i);
  }

  const dir = await mkdtemp(join(tmpdir(), 'vyen-nul-test-'));
  try {
    const files = new WorkspaceFiles(dir);
    await assert.rejects(() => files.write('nul', 'bad'), /Windows reserved device name/);
    await assert.rejects(() => files.write('src/CON.txt', 'bad'), /Windows reserved device name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TerminalUI Ctrl+T toggles Codex Transcript Mode, auto-approve mode, and immediate slash commands while working', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 95;
  tty.output.rows = 22;

  tty.ui.setViewMode('normal');
  tty.ui.event({ type: 'reasoning', source: 'provider', text: 'Hidden reasoning visible in Ctrl+T.\n' });
  tty.ui.event({ type: 'text', text: 'Visible answer text.\n' });
  await new Promise(resolve => setTimeout(resolve, 25));

  // Press Ctrl+T (\x14) -> enters full-screen T R A N S C R I P T mode even when viewMode is 'normal'
  tty.input.write('\x14');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(tty.ui.isTranscriptOverlay(), true);
  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /◆ transcript/);
  assert.match(frame, /∴ Thinking/);
  assert.match(frame, /Hidden reasoning visible in Ctrl\+T\./);

  // Press q (or Ctrl+T / Esc) -> exits Transcript Mode back to normal Composer view immediately
  tty.input.write('q');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(tty.ui.isTranscriptOverlay(), false);

  // Simulate agent working (status === 'Running', no pending question)
  tty.ui.setStatus('Running');
  const immediateExecuted = [];
  tty.ui.onImmediateCommand = cmd => {
    immediateExecuted.push(cmd);
    if (cmd === '/auto') tty.ui.setMode('auto');
  };

  // Typing a slash command (/auto) while Running executes IMMEDIATELY instead of queueing!
  tty.input.write('/auto\r');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(immediateExecuted, ['/auto']);

  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /auto-approve/);

  // Typing a normal non-slash message while Running still queues into queuedPrompts
  tty.input.write('do next task after this\r');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(immediateExecuted, ['/auto']);
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /do next task after this/);
});

test('redesign: Markdown blockquotes in answers never render as user turns, and cells after an unterminated answer are not answer text', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 90;
  tty.output.rows = 24;

  tty.ui.markTurnStart();
  tty.ui.write('\n> real user prompt\n');
  tty.ui.event({ type: 'text', text: 'Answer intro\n> quoted model text\nAnswer without trailing newline' });
  tty.ui.event({ type: 'tool', id: 'b1', name: 'bash', state: 'done', meta: { kind: 'exec', summary: 'npm test', durationMs: 1000, outputPreview: ['ok'] } });
  await new Promise(resolve => setTimeout(resolve, 30));

  const raw = tty.ui.renderedFrame();
  const plain = stripVTControlCharacters(raw);
  // Exactly one user turn row (accent marker): the real prompt. The blockquote renders as a quote bar.
  const bodyRows = raw.split('\r\n').slice(0, -3); // minus rule, prompt and footer
  const userRows = bodyRows.filter(l => l.startsWith(`${THEME.brandBold}›`));
  assert.equal(userRows.length, 1, `expected one user row, got ${userRows.length}`);
  assert.match(stripVTControlCharacters(userRows[0]), /› real user prompt/);
  assert.match(plain, /▎ quoted model text/);
  assert(!/› quoted model text/.test(plain), 'blockquote must not be rendered as a user turn');
  // The tool cell after an unterminated answer is a real cell (status-colored glyph), not answer prose.
  const ranRow = raw.split('\r\n').find(l => stripVTControlCharacters(l).startsWith('● Ran npm test'));
  assert(ranRow, 'Ran cell row must start at column 0 with its glyph');
  assert(ranRow.startsWith(`${THEME.ok}\x1b[1m●`), 'Ran glyph must use the success tone');
  assert.match(plain, /Answer without trailing newline/);
});

test('redesign: the footer shows workspace, branch and a provider-reported context percentage', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 20;
  tty.ui.setWorkspace('D:\\work\\testcli', 'feature/redesign');
  tty.ui.setContextWindow(200_000);
  await new Promise(resolve => setTimeout(resolve, 25));
  const footerOf = () => tty.ui.renderedFrame().split('\r\n').at(-1);
  let header = stripVTControlCharacters(footerOf());
  assert.match(header, /testcli \(feature\/redesign\)/);
  assert(!header.includes('ctx'), 'context stays hidden until occupancy is known');
  assert.equal(header.split('test-model').length, 2, 'the model appears once');

  // 60k prompt + 8k completion of the latest request = 68k / 200k = 34%
  tty.ui.event({ type: 'usage', input: 60_000, output: 8_000, total: 68_000 });
  // Subagent usage must not move the parent's context meter.
  tty.ui.event({ type: 'subagent', id: 'kid', state: 'progress', event: { type: 'usage', input: 150_000, output: 1, total: 150_001 } });
  await new Promise(resolve => setTimeout(resolve, 25));
  header = stripVTControlCharacters(footerOf());
  assert.match(header, /ctx 34%/);
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /218k tokens/);

  // Compaction invalidates the measurement until the next provider report.
  tty.ui.event({ type: 'compaction', count: 1 });
  await new Promise(resolve => setTimeout(resolve, 25));
  header = stripVTControlCharacters(footerOf());
  assert(!header.includes('ctx'), 'context must hide after compaction');
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /◌ Context compacted #1/);

  // >= 90% switches the meter to the error tone.
  tty.ui.event({ type: 'usage', input: 185_000, output: 0, total: 185_000 });
  await new Promise(resolve => setTimeout(resolve, 25));
  const rawFooter = footerOf();
  assert.match(stripVTControlCharacters(rawFooter), /93%/);
  assert(rawFooter.includes(`${THEME.err}ctx 93%`), 'critical occupancy must use the error tone');
});

test('pro status bar: context meter renders visual block gauge and token fraction at wide columns', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;
  tty.ui.setContextWindow(200_000);

  // 68k / 200k = 34% -> 2 of 5 blocks filled: [██░░░]
  tty.ui.event({ type: 'usage', input: 60_000, output: 8_000, total: 68_000 });
  await new Promise(resolve => setTimeout(resolve, 25));
  const footerOf = () => tty.ui.renderedFrame().split('\r\n').at(-1);
  let footer = stripVTControlCharacters(footerOf());

  assert.match(footer, /\[██░░░\]\s+ctx 34%/, 'Wide columns must show visual block gauge');
  assert.match(footer, /\(68k\/200k\)/, 'Wide columns must show detailed context fraction');

  // >= 90% (185k / 200k = 93%) -> 5 of 5 blocks filled: [█████]
  tty.ui.event({ type: 'usage', input: 185_000, output: 0, total: 185_000 });
  await new Promise(resolve => setTimeout(resolve, 25));
  footer = stripVTControlCharacters(footerOf());
  assert.match(footer, /\[█████\]\s+ctx 93%/, 'Critical occupancy must fill all gauge blocks');

  // Medium columns show gauge but hide detailed fraction
  tty.output.columns = 76;
  tty.output.emit('resize');
  await new Promise(resolve => setTimeout(resolve, 25));
  const medFooter = stripVTControlCharacters(footerOf());
  assert.match(medFooter, /\[█████\]\s+ctx 93%/, 'Medium columns retain visual block gauge');
  assert(!medFooter.includes('185k/200k'), 'Medium columns hide detailed fraction');

  // Narrow columns hide both gauge and detailed fraction to prevent wrap/truncation
  tty.output.columns = 60;
  tty.output.emit('resize');
  await new Promise(resolve => setTimeout(resolve, 25));
  const narrowFooter = stripVTControlCharacters(footerOf());
  assert.match(narrowFooter, /ctx 93%/, 'Narrow columns still keep percentage');
  assert(!narrowFooter.includes('['), 'Narrow columns hide visual block gauge');
  assert(!narrowFooter.includes('185k/200k'), 'Narrow columns hide detailed fraction to save space');
});

test('redesign: slash popup lists matching commands with descriptions and Tab still completes the first match', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;
  const q = tty.ui.question('vyen> ', undefined, true);
  tty.key('/rev', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /› \/revert\s+rewind turn\(s\)/);
  assert.match(frame, /\/review\s+run code review/);
  assert(!/\/resume/.test(frame), 'non-matching commands must be filtered out');
  tty.key('', 'tab');
  tty.key('', 'return');
  assert.equal((await q).trim(), '/revert');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(!/rewind turn\(s\)/.test(stripVTControlCharacters(tty.ui.renderedFrame())), 'popup closes after submit');

  // ↓ / ↑ move the popup selection and must never clear the composer (history recall used to wipe it).
  const q2 = tty.ui.question('vyen> ', undefined, true);
  tty.key('/rev', undefined);
  tty.key('', 'down');
  await new Promise(resolve => setTimeout(resolve, 25));
  let after = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(after.split('\r\n').at(-2), /^› \/rev\s*$/, 'Down arrow must keep the typed input');
  assert.match(after, /› \/review\s+run code review/, 'Down arrow must move the selection to the next match');
  tty.key('', 'down'); // wraps back to the first match
  tty.key('', 'up'); // and up wraps to the last
  await new Promise(resolve => setTimeout(resolve, 25));
  after = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(after, /› \/review\s+run code review/);
  tty.key('', 'return');
  assert.equal(await q2, '/review', 'Enter submits the highlighted command');
});

test('redesign: at-mention popup lists matching workspace files, supports arrow navigation, and Tab/Enter completes path', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;
  tty.ui.setWorkspaceFiles(['src/tui.ts', 'src/cli.ts', 'tests/tui.test.mjs', 'docs/SPEC.md', 'path with space/file.txt']);

  const q = tty.ui.question('vyen> ', undefined, true);
  tty.key('@tu', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));

  const frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /›\s+src\/tui\.ts/, 'Exact basename match should be highlighted with selection marker');
  assert.match(frame, /tests\/tui\.test\.mjs/, 'Matching test file should be listed');
  assert(!/src\/cli\.ts/.test(frame), 'Non-matching files should be filtered out');
  assert(!/docs\/SPEC\.md/.test(frame), 'Non-matching files should be filtered out');

  // Down arrow moves selection to next match
  tty.key('', 'down');
  await new Promise(resolve => setTimeout(resolve, 25));
  const frame2 = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame2, /›\s+tests\/tui\.test\.mjs/, 'Down arrow moves selection to next match');

  // Tab completes selected file with trailing space
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameAfterTab = stripVTControlCharacters(tty.ui.renderedFrame());
  assert(!/tests\/tui\.test\.mjs/.test(frameAfterTab.split('\r\n').slice(0, -3).join('\n')), 'Popup must close after Tab completion');
  assert.match(frameAfterTab.split('\r\n').at(-2), /^› @tests\/tui\.test\.mjs\s*$/, 'Tab must replace @tu with completed mention and trailing space');

  // Space-containing file quotes path
  tty.key('@space', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameSpace = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameSpace, /path with space\/file\.txt/);
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameAfterSpaceTab = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameAfterSpaceTab.split('\r\n').at(-2), /@"path with space\/file\.txt"\s*$/);

  // Esc dismisses popup
  tty.key('@src', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /src\/cli\.ts/);
  tty.key('', 'escape');
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameEsc = stripVTControlCharacters(tty.ui.renderedFrame());
  assert(!/src\/cli\.ts/.test(frameEsc.split('\r\n').slice(0, -3).join('\n')), 'Esc must dismiss popup without clearing input');
  assert.match(frameEsc.split('\r\n').at(-2), /@src/);

  tty.key('', 'return');
  const result = await q;
  assert.match(result, /@tests\/tui\.test\.mjs\s+@"path with space\/file\.txt"\s+@src/);
});

test('redesign: at-mention Enter completion, Ctrl+P/N navigation, and mid-prompt mention', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;
  tty.ui.setWorkspaceFiles(['src/tui.ts', 'src/cli.ts', 'tests/tui.test.mjs', 'docs/SPEC.md']);

  const q = tty.ui.question('vyen> ', undefined, true);
  tty.key('check @cl', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));

  const frame1 = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame1, /›\s+src\/cli\.ts/);

  // Enter accepts completion and does NOT submit the prompt prematurely
  tty.key('', 'return');
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameAfterEnter = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameAfterEnter.split('\r\n').at(-2), /^› check @src\/cli\.ts\s*$/);

  // Continue typing prompt after completed mention
  tty.key('and fix', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameAfterTyping = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameAfterTyping.split('\r\n').at(-2), /^› check @src\/cli\.ts and fix\s*$/);

  // Submit prompt with Enter
  tty.key('', 'return');
  const result = await q;
  assert.equal(result, 'check @src/cli.ts and fix');

  // Test Ctrl+N and Ctrl+P navigation on bare @
  const q2 = tty.ui.question('vyen> ', undefined, true);
  tty.key('@', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameAt = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameAt, /›\s+src\/tui\.ts/);

  // Ctrl+N moves down
  tty.key('', 'n', { ctrl: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameN = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameN, /›\s+src\/cli\.ts/);

  // Ctrl+P moves back up
  tty.key('', 'p', { ctrl: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameP = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameP, /›\s+src\/tui\.ts/);

  // Tab completes
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  tty.key('', 'return');
  assert.equal((await q2).trim(), '@src/tui.ts');
});

test('redesign: at-mention handles non-BMP emoji prefixes, Windows backslashes, and long paths', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 120;
  tty.output.rows = 24;
  const longPath = 'deeply/nested/directory/structure/that/exceeds/one/hundred/characters/in/total/relative/path/length/component.ts';
  tty.ui.setWorkspaceFiles(['src/tui.ts', 'src/cli.ts', longPath]);

  // 1. Emoji prefix does not desynchronize atStart index
  const q1 = tty.ui.question('vyen> ', undefined, true);
  tty.key('🚀 @tu', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  tty.key('', 'return');
  const res1 = await q1;
  assert.equal(res1.trim(), '🚀 @src/tui.ts');

  // 2. Windows backslash in query matches normalized workspace path
  const q2 = tty.ui.question('vyen> ', undefined, true);
  tty.key('@src\\cl', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameBackslash = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameBackslash, /›\s+src\/cli\.ts/);
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  tty.key('', 'return');
  const res2 = await q2;
  assert.equal(res2.trim(), '@src/cli.ts');

  // 3. Path exceeding 100 characters is not dropped by score subtraction
  const q3 = tty.ui.question('vyen> ', undefined, true);
  tty.key('@comp', undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  const frameLong = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frameLong, /component\.ts/);
  tty.key('', 'tab');
  await new Promise(resolve => setTimeout(resolve, 25));
  tty.key('', 'return');
  const res3 = await q3;
  assert.equal(res3.trim(), `@${longPath}`);
});

test('redesign: Markdown tables align columns across rows', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;
  tty.ui.event({ type: 'text', text: 'Summary:\n| file | change |\n|---|---|\n| src/tui.ts | **meter** |\n| a | b |\n' });
  await new Promise(resolve => setTimeout(resolve, 25));
  const rows = stripVTControlCharacters(tty.ui.renderedFrame()).split('\r\n').filter(l => /[│├]/.test(l) && !/[╭╰]/.test(l) && !l.includes('›'));
  assert.equal(rows.length, 4, rows.join('\n'));
  const barColumns = row => [...row].map((c, i) => (c === '│' || c === '┼' || c === '├' || c === '┤' ? i : -1)).filter(i => i >= 0);
  const expected = barColumns(rows[0]);
  for (const row of rows) assert.deepEqual(barColumns(row), expected, `misaligned row: ${row}`);
});

test('redesign: no rendered row exceeds the terminal width at any size, across every cell kind', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const { visibleLength, welcomeBanner } = await import('../dist/index.js');
  for (const columns of [48, 57, 64, 80, 101, 132]) {
    const tty = terminal(t);
    tty.output.columns = columns;
    tty.output.rows = 60;
    tty.ui.setWorkspace('/home/user/a-very-long-workspace-directory-name-for-testing', 'feature/an-extremely-long-branch-name');
    tty.ui.setContextWindow(100_000);
    tty.ui.setContextUsage(42_000);
    tty.ui.setTokens(123_456);
    tty.ui.write(welcomeBanner('model-with-a-really-long-identifier-v1', 'openai-compatible', 'https://gateway.example.com/v1', 'max', '/home/user/project', '0f40f011-0000-4000-8000-000000000000', 'auto'));
    tty.ui.write('\n> ' + 'long user prompt words '.repeat(12) + '\n');
    tty.ui.event({ type: 'reasoning', source: 'provider', text: 'reasoning words '.repeat(30) + '\n' });
    tty.ui.event({ type: 'tool', id: 'r', name: 'read_file', state: 'done', meta: { kind: 'read', summary: 'src/' + 'deep/'.repeat(20) + 'file.ts' } });
    tty.ui.event({ type: 'tool', id: 'b', name: 'bash', state: 'done', meta: { kind: 'exec', summary: 'echo ' + 'x'.repeat(200), durationMs: 65_000, outputPreview: ['y'.repeat(300)] } });
    tty.ui.event({ type: 'tool', id: 'e', name: 'edit_file', state: 'done', meta: { kind: 'edit', verb: 'Edited', summary: 'src/app.ts', added: 1, removed: 1, diff: `@@ -1,1 +1,1 @@\n-${'old '.repeat(60)}\n+${'new '.repeat(60)}` } });
    tty.ui.event({ type: 'todo', todos: [{ content: 'todo item '.repeat(20), status: 'in_progress' }] });
    tty.ui.event({ type: 'subagent', id: 'abcdef123456', state: 'start', task: 'task words '.repeat(30) });
    tty.ui.event({ type: 'text', text: '# ' + 'Heading '.repeat(20) + '\n- ' + 'bullet '.repeat(40) + '\n> ' + 'quote '.repeat(40) + '\n```js\n' + 'const z = 1; '.repeat(30) + '\n```\n| ' + 'c '.repeat(80) + '| d |\n|---|---|\n| e | f |\n' });
    tty.ui.setStatus('Running');
    tty.ui.question('vyen> ', undefined, true).catch(() => {});
    tty.key('/re', undefined);
    await new Promise(resolve => setTimeout(resolve, 40));
    for (const line of tty.ui.renderedFrame().split('\r\n')) {
      const width = visibleLength(line);
      assert(width <= columns - 1, `cols=${columns}: row is ${width} wide: ${JSON.stringify(stripVTControlCharacters(line))}`);
    }
    tty.ui.close();
  }
});

test('redesign: formatTokenCount and readGitBranch agree with independent oracles', async t => {
  const { formatTokenCount, readGitBranch } = await import('../dist/index.js');
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(1250), '1.3k');
  assert.equal(formatTokenCount(48_210), '48k');
  assert.equal(formatTokenCount(2_500_000), '2.5M');

  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'vyen-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Normal repo, nested cwd.
  await mkdir(join(root, 'repo', '.git'), { recursive: true });
  await mkdir(join(root, 'repo', 'src', 'deep'), { recursive: true });
  await writeFile(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  assert.equal(readGitBranch(join(root, 'repo', 'src', 'deep')), 'feature/x');
  // Detached HEAD.
  await writeFile(join(root, 'repo', '.git', 'HEAD'), '7869954a1b2c3d4e5f60718293a4b5c6d7e8f901\n');
  assert.equal(readGitBranch(join(root, 'repo')), '7869954');
  // Worktree: .git is a file pointing at the real gitdir.
  await mkdir(join(root, 'wt-gitdir'), { recursive: true });
  await writeFile(join(root, 'wt-gitdir', 'HEAD'), 'ref: refs/heads/wt-branch\n');
  await mkdir(join(root, 'wt'), { recursive: true });
  await writeFile(join(root, 'wt', '.git'), `gitdir: ${join(root, 'wt-gitdir')}\n`);
  assert.equal(readGitBranch(join(root, 'wt')), 'wt-branch');
  // Garbage HEAD is not reported as a branch.
  await writeFile(join(root, 'repo', '.git', 'HEAD'), 'not a ref\n');
  assert.equal(readGitBranch(join(root, 'repo')), undefined);

  // Real git is the oracle for this repository when available.
  const { spawnSync } = await import('node:child_process');
  const git = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim() && git.stdout.trim() !== 'HEAD') {
    assert.equal(readGitBranch(process.cwd()), git.stdout.trim());
  }
});
test('setup: Esc truly cancels a cancellable question; default questions keep Esc = empty answer; hints match behavior', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 20;

  const cancellable = tty.ui.question('Base URL: ', undefined, false, { escCancels: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /enter submit {3}esc cancel/);
  tty.key('https://typed-but-cancelled', undefined);
  tty.key('', 'escape');
  await assert.rejects(cancellable, err => err.name === 'InputCancelledError');

  const approval = tty.ui.question('[y/N/a(lways)] ');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(stripVTControlCharacters(tty.ui.renderedFrame()), /esc deny/);
  tty.key('', 'escape');
  assert.equal(await approval, '', 'non-cancellable questions still resolve empty on Esc');
});

test('setup: transient status (MCP reconnect) is always restored, including on failure, so the UI never sticks on Working', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 20;
  tty.ui.setStatus('Ready');

  const value = await tty.ui.withStatus('Connecting MCP', async () => {
    assert.equal(tty.ui.getStatus(), 'Connecting MCP');
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(tty.ui.getStatus(), 'Ready');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(!stripVTControlCharacters(tty.ui.renderedFrame()).includes('Working'), 'no Working indicator after reconnect');

  await assert.rejects(tty.ui.withStatus('Connecting MCP', async () => { throw new Error('mcp boom'); }), /mcp boom/);
  assert.equal(tty.ui.getStatus(), 'Ready', 'status restored after a failed reconnect');

  tty.ui.setStatus('Running');
  await tty.ui.withStatus('Connecting MCP', async () => {});
  assert.equal(tty.ui.getStatus(), 'Running', 'an active run keeps its Running status');
  tty.ui.setStatus('Ready');
});

test('setup: cancelling the wizard mid-way persists neither the API key nor the config', async t => {
  const { fixture } = await import('./helpers.mjs');
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { runSetupWizard } = await import('../dist/index.js');
  const f = await fixture(t);
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  const oldKey = process.env.VYEN_API_KEY;
  process.env.XDG_CONFIG_HOME = f.config;
  delete process.env.VYEN_API_KEY;
  t.after(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldKey !== undefined) process.env.VYEN_API_KEY = oldKey;
  });

  const answers = ['4', 'https://openrouter.ai/api/v1', 'sk-cancelled-secret-key'];
  await assert.rejects(
    runSetupWizard(undefined, {
      write: () => {},
      ask: async () => {
        if (answers.length) return answers.shift();
        throw Object.assign(new Error('Cancelled by user.'), { name: 'InputCancelledError' }); // Esc at the model step
      },
      discover: async () => [],
    }),
    err => err.name === 'InputCancelledError',
  );

  const walk = async dir => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };
  for (const file of await walk(f.config)) {
    assert(!(await readFile(file, 'utf8')).includes('sk-cancelled-secret-key'), `secret leaked into ${file}`);
  }
  assert(!(await walk(f.config)).some(p => p.endsWith('config.json')), 'config must not be written on cancel');
});

test('Codex paste handling collapses multi-line and long pastes into [Pasted text #1 +N lines], supports atomic Backspace, and expands on submit', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const tty = terminal(t);
  tty.output.columns = 100;
  tty.output.rows = 24;

  // 1. Bracketed paste of 25 lines via real stream write (emits per-char + return/enter events)
  const q1 = tty.ui.question('vyen> ', undefined, true);
  const lines25 = Array.from({ length: 25 }, (_, i) => `line ${i + 1}: const value_${i + 1} = ${i + 1};`).join('\r\n');
  tty.input.write(`\x1b[200~${lines25}\x1b[201~`);
  await new Promise(resolve => setTimeout(resolve, 25));

  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /\[Pasted text #1 \+25 lines\]/);
  assert.match(frame, /attached  \[Pasted text #1 \+25 lines\]/);
  assert(!frame.includes('const value_15'), 'Composer must NOT show raw pasted lines');

  // Type follow-up comment after the pill and submit
  tty.key('sửa vyen thành paste nội dung dài', undefined);
  tty.key('', 'return');
  const submitted1 = await q1;
  const expectedLines25 = lines25.replace(/\r\n/g, '\n');
  assert.equal(submitted1, `${expectedLines25}\nsửa vyen thành paste nội dung dài`);

  // Echoing the submitted prompt to transcript keeps the compact [Pasted text #1 +25 lines] pill
  tty.ui.write(`\n> ${submitted1}\n`);
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /› \[Pasted text #1 \+25 lines\]/);
  assert(!frame.includes('const value_15'), 'Transcript echo must collapse expanded paste back to pill');

  // 2. Long single-line paste (> 150 chars), atomic Backspace, and multiple pastes (#1, #2)
  const q2 = tty.ui.question('vyen> ', undefined, true);
  const longSingleLine = 'x'.repeat(200);
  tty.input.write(`\x1b[200~${longSingleLine}\x1b[201~`);
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /\[Pasted text #1 \(200 chars\)\]/);

  // Single Backspace deletes the entire [Pasted text #1 (200 chars)] pill and resets counter to #1
  tty.key('', 'backspace');
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert(!frame.includes('[Pasted text #1 (200 chars)]'), 'Atomic Backspace should remove entire paste pill');
  assert(!frame.includes("attached  ["), 'Status bar attachment notice should disappear after Backspace');

  // Non-bracketed multi-line paste burst on raw stream does NOT prematurely submit on \r\n
  tty.input.write('alpha line\r\nbeta line\r\ngamma line');
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /\[Pasted text #1 \+3 lines\]/);

  tty.key('', 'return');
  const submitted2 = await q2;
  assert.equal(submitted2, 'alpha line\nbeta line\ngamma line');

  // 3. Up-arrow history recall and setInput (from /revert) rehydrate paste placeholders and expand on submit
  const q3 = tty.ui.question('vyen> ', undefined, true);
  tty.key('', 'up');
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /\[Pasted text #1 \+3 lines\]/);
  tty.key('', 'return');
  assert.equal(await q3, 'alpha line\nbeta line\ngamma line');
});

test('Codex /goal system: formatting, draft parsing, get_goal/create_goal/update_goal tools, token budget steering, and TUI goal indicators', async t => {
  const { stripVTControlCharacters } = await import('node:util');
  const { join } = await import('node:path');
  const {
    SessionStore,
    formatGoalElapsedSeconds,
    formatGoalTokensCompact,
    formatGoalStatusIndicator,
    formatGoalSummaryLines,
    parseGoalDraftArgs,
  } = await import('../dist/session.js');
  const {
    buildGoalContinuationPrompt,
    buildGoalBudgetLimitPrompt,
    buildGoalObjectiveUpdatedPrompt,
    buildUserGoalContextMessage,
  } = await import('../dist/context.js');
  const { ToolRegistry } = await import('../dist/tools.js');
  const { Harness } = await import('../dist/harness.js');
  const { fixture, provider, sse } = await import('./helpers.mjs');

  // 1. Formatting & draft argument parsing
  assert.equal(formatGoalElapsedSeconds(45), '45s');
  assert.equal(formatGoalElapsedSeconds(125), '2m');
  assert.equal(formatGoalElapsedSeconds(3720), '1h 2m');
  assert.equal(formatGoalTokensCompact(950), '950');
  assert.equal(formatGoalTokensCompact(12_500), '12.5K');
  assert.equal(formatGoalTokensCompact(1_500_000), '1.5M');

  assert.deepEqual(parseGoalDraftArgs('--budget 50k Fix all failing tests'), {
    objective: 'Fix all failing tests',
    tokenBudget: 50_000,
  });
  assert.deepEqual(parseGoalDraftArgs('--token-budget=1.5m Ship v1'), {
    objective: 'Ship v1',
    tokenBudget: 1_500_000,
  });
  assert('error' in parseGoalDraftArgs('--budget invalid Fix tests'));

  const now = new Date().toISOString();
  const sampleGoal = {
    goalId: 'goal_test1',
    objective: 'Refactor parser and pass tests',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    tokensAtStart: 0,
    tokensUsed: 12_500,
    timeUsedSeconds: 180,
    tokenBudget: 50_000,
  };
  assert.equal(formatGoalStatusIndicator(sampleGoal), 'Pursuing goal (12.5K / 50K)');
  assert.equal(formatGoalStatusIndicator({ ...sampleGoal, status: 'paused' }), 'Goal paused (/goal resume)');
  assert.equal(formatGoalStatusIndicator({ ...sampleGoal, status: 'blocked' }), 'Goal stalled (/goal resume)');
  assert.equal(formatGoalStatusIndicator({ ...sampleGoal, status: 'complete' }), 'Goal achieved (12.5K tokens)');
  assert.match(formatGoalSummaryLines(sampleGoal), /Status: active/);
  assert.match(formatGoalSummaryLines(sampleGoal), /Token budget: 50K/);

  // 2. Codex goal steering XML templates
  const contXml = buildGoalContinuationPrompt(sampleGoal, true);
  assert.match(contXml, /<codex_internal_context source="goal">/);
  assert.match(contXml, /Completion audit:/);
  assert.match(contXml, /update_goal/);
  assert.match(buildGoalBudgetLimitPrompt(sampleGoal), /The active thread goal has reached its token budget/);
  assert.match(buildGoalObjectiveUpdatedPrompt(sampleGoal), /The active thread goal objective was edited by the user/);
  assert.match(buildUserGoalContextMessage({ objective: 'New obj', status: 'active' }), /<codex_internal_context source="user_goal">/);

  // 3. TUI renders goal indicator in header and status bar
  const tty = terminal(t);
  tty.output.columns = 110;
  tty.output.rows = 24;
  tty.ui.setGoal(sampleGoal);
  await new Promise(resolve => setTimeout(resolve, 25));
  let frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /Pursuing goal \(12\.5K \/ 50K\)/);

  tty.ui.event({ type: 'goal', goal: { ...sampleGoal, status: 'complete' } });
  await new Promise(resolve => setTimeout(resolve, 25));
  frame = stripVTControlCharacters(tty.ui.renderedFrame());
  assert.match(frame, /Goal achieved \(12\.5K tokens\)/);

  // 4. Harness + ToolRegistry execute create_goal, get_goal, and update_goal({ status: "complete" })
  const f = await fixture(t);
  let turnStep = 0;
  const p = await provider(t, (_, response) => {
    turnStep++;
    if (turnStep === 1) {
      return sse(response, {
        calls: [{ id: 'cg1', name: 'create_goal', input: { objective: 'Verify goal tools end-to-end' } }],
      });
    }
    if (turnStep === 2) {
      return sse(response, {
        calls: [
          { id: 'gg1', name: 'get_goal', input: {} },
          { id: 'ug1', name: 'update_goal', input: { status: 'complete' } },
        ],
      });
    }
    return sse(response, { text: 'Goal completed and verified.' });
  });

  const config = {
    cwd: f.cwd,
    provider: 'openai-compatible',
    model: 'test-model',
    baseUrl: p.url,
    apiKey: 'fake',
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    runTokenBudget: 0,
    timeoutMs: 5000,
    inlineReasoning: 'leading-think',
    showReasoning: false,
  };
  const store = await SessionStore.open(join(f.root, 'sessions'), config);
  t.after(() => store.close());
  const reg = new ToolRegistry(f.cwd, async () => true, false);
  const events = [];
  const harness = new Harness(config, store, reg, ev => events.push(ev));
  const out = await harness.run('Create and complete a session goal.', new AbortController().signal);
  assert.equal(out, 'Goal completed and verified.');
  assert.equal(store.session.goal?.objective, 'Verify goal tools end-to-end');
  assert.equal(store.session.goal?.status, 'complete');
  assert(events.some(e => e.type === 'goal' && e.goal?.status === 'complete'));

  // 5. CLI autonomous continuation loop pursues active goal across turns until update_goal(complete)
  const { main } = await import('../dist/cli.js');
  let cliStep = 0;
  let sawContinuationXml = false;
  const p2 = await provider(t, (body, response) => {
    cliStep++;
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
    const lastText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    if (lastText.includes('<codex_internal_context source="goal">')) {
      sawContinuationXml = true;
    }
    if (cliStep === 1) {
      return sse(response, {
        calls: [{ id: 'cg_cli', name: 'create_goal', input: { objective: 'Autonomous multi-turn goal' } }],
      });
    }
    if (cliStep === 2) {
      // Finish Turn 1 while goal is still active -> CLI must auto-trigger continuation Turn 2!
      return sse(response, { text: 'Step 1 progress done; continuing next turn.' });
    }
    if (cliStep === 3) {
      // Turn 2 (automatic continuation): mark goal complete
      return sse(response, {
        calls: [{ id: 'ug_cli', name: 'update_goal', input: { status: 'complete' } }],
      });
    }
    return sse(response, { text: 'All requirements verified and goal completed.' });
  });

  const oldKey = process.env.VYEN_API_KEY;
  const oldCfg = process.env.XDG_CONFIG_HOME;
  const oldData = process.env.XDG_DATA_HOME;
  process.env.VYEN_API_KEY = 'fake-goal-key';
  process.env.XDG_CONFIG_HOME = f.config;
  process.env.XDG_DATA_HOME = f.data;
  try {
    await main([
      '--cwd', f.cwd,
      '--provider', 'openai-compatible',
      '--base-url', p2.url,
      '--model', 'test-model',
      '--yes',
      '--no-mcp',
      '--no-subagents',
      '--json',
      '-p', 'Start autonomous goal',
    ]);
  } finally {
    if (oldKey === undefined) delete process.env.VYEN_API_KEY;
    else process.env.VYEN_API_KEY = oldKey;
    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
    if (oldData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldData;
  }
  assert.equal(cliStep, 4, 'CLI should run Turn 1 (2 model calls) + automatic Continuation Turn 2 (2 model calls)');
  assert.equal(sawContinuationXml, true, 'Continuation turn must include Codex goal continuation XML');
});

test('syntax highlighting: Markdown fenced code blocks highlight keywords, strings, comments, numbers, and JSON keys in TUI', async t => {
  const { highlightCode } = await import('../dist/tui.js');
  assert.equal(typeof highlightCode, 'function', 'highlightCode must be an exported function');

  // 1. TypeScript / JavaScript
  const tsOut = highlightCode('const count: number = 42; // item count', 'ts');
  assert.match(tsOut, new RegExp(THEME.brand.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'const'));
  assert.match(tsOut, new RegExp(THEME.info.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'number'));
  assert.match(tsOut, new RegExp(THEME.warn.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '42'));
  assert.match(tsOut, new RegExp(THEME.faint.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '\\/\\/ item count'));

  // 2. Python
  const pyOut = highlightCode('def calculate(x: int) -> bool:\n    return x > 0 and True # comment', 'py');
  assert.match(pyOut, new RegExp(THEME.brand.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'def'));
  assert.match(pyOut, new RegExp(THEME.warn.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'True'));
  assert.match(pyOut, new RegExp(THEME.faint.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '# comment'));

  // 3. Shell
  const shOut = highlightCode('if [ -f "$FILE" ]; then echo "done"; fi', 'bash');
  assert.match(shOut, new RegExp(THEME.brand.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'if'));
  assert.match(shOut, new RegExp(THEME.brand.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'then'));
  assert.match(shOut, new RegExp(THEME.ok.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '"done"'));

  // 4. JSON: keys vs values
  const jsonKeyOut = highlightCode('  "status": "active",', 'json');
  assert.match(jsonKeyOut, new RegExp(THEME.info.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '"status"'));
  assert.match(jsonKeyOut, new RegExp(THEME.ok.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '"active"'));

  // 5. Strings must not false-match keywords inside them
  const strOut = highlightCode('const msg = "function return true // not comment";', 'js');
  assert.match(strOut, new RegExp(THEME.ok.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '"function return true // not comment"'));

  // 6. TerminalUI end-to-end integration: renderedFrame includes highlighted code block in rich mode
  const tty = terminal(t);
  tty.output.columns = 80;
  tty.output.rows = 24;
  tty.ui.markTurnStart();
  tty.ui.event({ type: 'text', text: '```ts\nconst total = 99;\n```\n' });
  await new Promise(resolve => setTimeout(resolve, 30));

  const frame = tty.ui.renderedFrame();
  assert.match(frame, /│/);
  assert.match(frame, new RegExp(THEME.brand.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + 'const'));
  assert.match(frame, new RegExp(THEME.warn.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '99'));
});
