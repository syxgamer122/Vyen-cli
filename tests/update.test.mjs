import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchLatestVersion,
  checkForUpdates,
  detectInstallMethod,
  methodFromPath,
  readUpdateCache,
  updateNotice,
  upgradeCommand,
  writeUpdateCache,
} from '../dist/update.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('upgrade maps every package manager to its install command', async () => {
  assert.deepEqual(upgradeCommand('npm', '1.2.3'), {
    command: 'npm',
    args: ['install', '--global', '@nguyenhuumanh/vyen@1.2.3', '--no-audit', '--no-fund'],
  });
  assert.deepEqual(upgradeCommand('pnpm', '1.2.3'), {
    command: 'pnpm',
    args: ['add', '--global', '@nguyenhuumanh/vyen@1.2.3'],
  });
  assert.deepEqual(upgradeCommand('yarn', '1.2.3'), {
    command: 'yarn',
    args: ['global', 'add', '@nguyenhuumanh/vyen@1.2.3'],
  });
  assert.deepEqual(upgradeCommand('bun', '1.2.3'), {
    command: 'bun',
    args: ['install', '--global', '@nguyenhuumanh/vyen@1.2.3'],
  });

  const npmGlobal = '/usr/local/lib/node_modules/@nguyenhuumanh/vyen/dist/update.js';
  const bunGlobal = '/home/u/.bun/install/global/node_modules/@nguyenhuumanh/vyen/dist/update.js';
  const pnpmGlobal = '/home/u/.local/share/pnpm/global/5/node_modules/@nguyenhuumanh/vyen/dist/update.js';
  const yarnGlobal = '/home/u/.config/yarn/global/node_modules/@nguyenhuumanh/vyen/dist/update.js';
  assert.equal(methodFromPath(npmGlobal), 'npm');
  assert.equal(methodFromPath(bunGlobal), 'bun');
  assert.equal(methodFromPath(pnpmGlobal), 'pnpm');
  assert.equal(methodFromPath(yarnGlobal), 'yarn');
  assert.equal(methodFromPath('/home/u/src/vyen/src/update.ts'), undefined);

  const seen = [];
  assert.equal(await detectInstallMethod({
    packageRoot: bunGlobal,
    run: async (command, args) => {
      seen.push(`${command} ${args.join(' ')}`);
      return { code: 0, output: '@nguyenhuumanh/vyen@0.3.0' };
    },
  }), 'bun');
  assert.deepEqual(seen, ['bun pm ls --global']);

  assert.equal(await detectInstallMethod({
    packageRoot: npmGlobal,
    run: async command => command === 'npm'
      ? { code: 0, output: '@nguyenhuumanh/vyen@0.3.0' }
      : { code: 1, output: 'not found' },
  }), 'npm');

  assert.equal(await detectInstallMethod({
    packageRoot: '/home/u/src/vyen/src/update.ts',
    run: async () => ({ code: 1, output: 'not found' }),
  }), undefined);
});

test('upgrade installs nothing when the running version is current', async (t) => {
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  const result = await runUpgradeCli(t, ['upgrade', '--method', 'npm'], version);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`vyen ${version.replaceAll('.', '\\.')} is already installed`));
  assert.doesNotMatch(result.stdout, /npm install/);
});

test('upgrade rejects an invalid target before any package manager runs', async (t) => {
  const result = await runUpgradeCli(t, ['upgrade', '1.2', '--method', 'npm'], '9.9.9');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid version "1\.2"/);
  assert.doesNotMatch(result.stdout, /Installing/);
});

test('upgrade --dry-run prints the command and installs nothing', async (t) => {
  const result = await runUpgradeCli(t, ['upgrade', '--method', 'npm', '--dry-run'], '9.9.9');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /npm install --global @nguyenhuumanh\/vyen@9\.9\.9 --no-audit --no-fund/);
  assert.doesNotMatch(result.stdout, /Restart vyen/);
});

test('config accepts the update policy and VYEN_UPDATE overrides it', async (t) => {
  const { configSchema, loadConfig } = await import('../dist/config.js');
  assert.equal(configSchema.parse({}).update, 'notify');
  assert.equal(configSchema.parse({ update: 'disable' }).update, 'disable');
  assert.equal(configSchema.parse({ update: 'auto' }).update, 'auto');
  assert.throws(() => configSchema.parse({ update: 'sometimes' }));

  const root = await mkdtemp(join(tmpdir(), 'vyen-config-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousUpdate = process.env.VYEN_UPDATE;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousUpdate === undefined) delete process.env.VYEN_UPDATE;
    else process.env.VYEN_UPDATE = previousUpdate;
    return rm(root, { recursive: true, force: true });
  });
  process.env.XDG_CONFIG_HOME = root;
  process.env.VYEN_UPDATE = 'auto';
  assert.equal((await loadConfig()).update, 'auto');
});

test('the startup notice appears only for a newer release in notify mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-update-'));
  const file = join(root, 'update-check.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeUpdateCache(file, { checkedAt: new Date().toISOString(), latest: '9.9.9' });
  let fetches = 0;
  const fetchLatest = async () => { fetches += 1; return '9.9.9'; };
  assert.equal((await checkForUpdates({ policy: 'notify', current: '0.3.0', cacheFile: file, fetchLatest })).action, 'notify');
  assert.equal((await checkForUpdates({ policy: 'notify', current: '9.9.9', cacheFile: file, fetchLatest })).action, 'none');
  assert.equal((await checkForUpdates({ policy: 'auto', current: '0.3.0', cacheFile: file, fetchLatest })).action, 'auto');
  assert.equal((await checkForUpdates({ policy: 'notify', current: '10.0.0', cacheFile: file, fetchLatest })).action, 'none');
  assert.equal(fetches, 0, 'a fresh cache must not refresh');
  assert.equal(
    updateNotice('0.3.0', '9.9.9'),
    'vyen 9.9.9 is available (installed 0.3.0). Run: vyen upgrade',
  );

  const missing = join(root, 'missing.json');
  assert.equal((await checkForUpdates({ policy: 'disable', current: '0.3.0', cacheFile: missing, fetchLatest })).action, 'none');
  assert.equal(fetches, 0, 'disable must not touch the network');
  assert.equal(await readUpdateCache(missing), undefined, 'disable must not write the cache');
});

test('a stale update cache is refreshed without blocking the caller', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-update-'));
  const file = join(root, 'update-check.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const result = await checkForUpdates({
    policy: 'notify',
    current: '0.3.0',
    cacheFile: file,
    fetchLatest: () => gate.then(() => '9.9.9'),
  });
  assert.equal(result.action, 'none');
  assert.ok(result.refresh, 'a missing cache must start a background refresh');
  assert.equal(await readUpdateCache(file), undefined);
  release();
  await result.refresh;
  assert.equal((await readUpdateCache(file)).latest, '9.9.9');
});

test('upgrade runs the matching package manager', async (t) => {
  const shims = await mkdtemp(join(tmpdir(), 'vyen-shim-'));
  const marker = join(shims, 'args.txt');
  const windows = process.platform === 'win32';
  const shim = join(shims, windows ? 'npm.cmd' : 'npm');
  await writeFile(shim, windows
    ? '@echo off\r\necho %* > "%VYEN_TEST_NPM_MARKER%"\r\n'
    : '#!/bin/sh\nprintf \'%s\' "$*" > "$VYEN_TEST_NPM_MARKER"\n');
  if (!windows) await chmod(shim, 0o755);
  t.after(() => rm(shims, { recursive: true, force: true }));

  const result = await runUpgradeCli(t, ['upgrade', '9.9.9', '--method', 'npm'], '9.9.9', {
    shimDir: shims,
    env: { VYEN_TEST_NPM_MARKER: marker },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Installed @nguyenhuumanh\/vyen@9\.9\.9\. Restart vyen to use it\./);
  const recorded = await readFile(marker, 'utf8');
  assert.match(recorded, /install --global @nguyenhuumanh\/vyen@9\.9\.9 --no-audit --no-fund/);
});

async function runUpgradeCli(t, args, latestVersion, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vyen-upgrade-'));
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: latestVersion }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolveClose => server.close(resolveClose));
  });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    VYEN_REGISTRY: `http://127.0.0.1:${server.address().port}`,
    ...options.env,
  };
  if (options.shimDir) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${options.shimDir}${delimiter}${env[pathKey] ?? ''}`;
  }
  delete env.VYEN_API_KEY;
  delete env.GOON_API_KEY;

  const child = spawn(process.execPath, [resolve(ROOT, 'bin', 'vyen.mjs'), ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const result = await new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveClose({ code, stdout, stderr }));
  });
  clearTimeout(timer);
  return result;
}

test('fetchLatestVersion fetches and parses latest semver from npm registry with timeout and error fallback', async t => {
  let responseStatus = 200;
  let responseBody = JSON.stringify({ version: '0.6.1' });
  const server = createServer((req, res) => {
    assert.equal(req.headers.accept, 'application/json');
    assert.ok(req.url.includes('%2F') || req.url.includes('vyen'));
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(responseBody);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const registry = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(r => server.close(r)));

  // Valid version
  const v1 = await fetchLatestVersion({ registry });
  assert.equal(v1, '0.6.1');

  // Trailing slashes are stripped
  const v2 = await fetchLatestVersion({ registry: `${registry}///` });
  assert.equal(v2, '0.6.1');

  // Invalid semver string in body -> undefined
  responseBody = JSON.stringify({ version: 'not-a-semver' });
  const vInvalid = await fetchLatestVersion({ registry });
  assert.equal(vInvalid, undefined);

  // 404 response -> undefined
  responseStatus = 404;
  responseBody = JSON.stringify({ error: 'Not found' });
  const v404 = await fetchLatestVersion({ registry });
  assert.equal(v404, undefined);

  // Network failure / unreachable port -> undefined
  const vDead = await fetchLatestVersion({ registry: 'http://127.0.0.1:1' });
  assert.equal(vDead, undefined);
});
