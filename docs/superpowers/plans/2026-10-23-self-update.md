# OpenCode-style self-update for vyen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give vyen the updater OpenCode ships: a `vyen upgrade [version]` command that detects how vyen was installed (npm, pnpm, yarn, bun), a `update` config policy (`disable | notify | auto`, default `notify`), and a cached, non-blocking startup notice inside the TUI.

**Architecture:** One new runtime module `src/update.ts` owns version comparison, install-method detection, registry lookup, the 24-hour cache and the upgrade command. `src/cli.ts` dispatches `vyen upgrade` before config/migration work (so it also works with a broken config) and, only in interactive TTY runs, reads the cache and prints one notice through the existing `display()` path. `src/config.ts` gains one enum field; no new dependency.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node >= 22.16 (`fetch`, `AbortSignal.timeout`, `node:child_process`), node:test. Distribution stays npm-only, so the OpenCode binary-installer branch is intentionally out of scope.

**Spec:** `docs/SPEC.md`

## Global Constraints

- Node floor stays `>=22.16.0`; no new npm dependency.
- Code, comments and test names are English; README additions stay in Vietnamese like the rest of the file.
- The package name is `@nguyenhuumanh/vyen`; the binary is `vyen`.
- Tests must never install a real package or reach the public registry: a local HTTP server answers `GET /<package>/latest`, selected with `VYEN_REGISTRY`.
- `vyen upgrade` must work on Windows (spawn `.cmd` shims), Linux, macOS and Termux.
- Never block an interactive start on the network: the cache read is local, a stale cache is refreshed in the background.
- The gate is `npm run typecheck`, `npm run lint`, `npm test`. The six known Windows-only failures (`tests/files.test.mjs`, `tests/audit.test.mjs:106`, `tests/publish.test.mjs:11`) are not regressions.

## Review Focus

1. `vyen upgrade` detects npm, pnpm, yarn and bun installs and runs that manager's global-install command; `--method` overrides detection.
2. A target equal to the running version prints "already installed" and runs no package manager.
3. An invalid target exits non-zero before any package manager runs.
4. `--dry-run` prints the exact package-manager command and installs nothing.
5. The `update` policy accepts `disable`, `notify` and `auto` (default `notify`), and `VYEN_UPDATE` overrides the stored value.
6. An interactive start shows one notice only when a newer cached release exists and the policy is `notify`.
7. A stale or missing update cache is refreshed in the background; the caller never waits for the network.

## Scenarios & Tests

**What the user sees:** after a release, a user who starts `vyen` sees one line such as `vyen 0.3.1 is available (installed 0.3.0). Run: vyen upgrade`; typing `vyen upgrade` prints the detected manager, installs the newest release and asks for a restart. Prompt mode and `--json` print nothing about updates.

| # | Criterion | Test |
|---|---|---|
| 1 | upgrade detects npm, pnpm, yarn and bun | `tests/update.test.mjs` › upgrade maps every package manager to its install command |
| 2 | a target equal to the running version | `tests/update.test.mjs` › upgrade installs nothing when the running version is current |
| 3 | an invalid target exits non-zero | `tests/update.test.mjs` › upgrade rejects an invalid target before any package manager runs |
| 4 | dry-run prints the exact command | `tests/update.test.mjs` › upgrade --dry-run prints the command and installs nothing |
| 5 | the update policy accepts disable | `tests/update.test.mjs` › config accepts the update policy and VYEN_UPDATE overrides it |
| 6 | an interactive start shows one notice | `tests/update.test.mjs` › the startup notice appears only for a newer release in notify mode |
| 7 | a stale or missing update cache | `tests/update.test.mjs` › a stale update cache is refreshed without blocking the caller |

## Task 1: Version, command and install-method core

**Files:**
- Create: `src/update.ts`
- Test: `tests/update.test.mjs`

**Interfaces:**
- Produces: `PACKAGE_NAME: string`, `INSTALL_METHODS: readonly ['npm','pnpm','yarn','bun']`, `type InstallMethod`, `type UpdatePolicy = 'disable'|'notify'|'auto'`, `parseVersion(input: string): ParsedVersion | undefined`, `compareVersions(a: string, b: string): number`, `upgradeCommand(method: InstallMethod, version: string): { command: string; args: string[] }`, `methodFromPath(path: string): InstallMethod | undefined`, `detectInstallMethod(options?: { packageRoot?: string; run?: RunCapture }): Promise<InstallMethod | undefined>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/update.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInstallMethod, methodFromPath, upgradeCommand } from '../dist/update.js';

test('upgrade maps every package manager to its install command', async () => {
  assert.deepEqual(upgradeCommand('npm', '1.2.3'), {
    command: 'npm',
    args: ['install', '--global', '@nguyenhuumanh/vyen@1.2.3', '--no-audit', '--no-fund'],
  });
  assert.deepEqual(upgradeCommand('pnpm', '1.2.3'), {
    command: 'pnpm', args: ['add', '--global', '@nguyenhuumanh/vyen@1.2.3'],
  });
  assert.deepEqual(upgradeCommand('yarn', '1.2.3'), {
    command: 'yarn', args: ['global', 'add', '@nguyenhuumanh/vyen@1.2.3'],
  });
  assert.deepEqual(upgradeCommand('bun', '1.2.3'), {
    command: 'bun', args: ['install', '--global', '@nguyenhuumanh/vyen@1.2.3'],
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

  const bunListing = {
    command: 'bun', args: ['pm', 'ls', '--global'],
    result: { code: 0, output: '@nguyenhuumanh/vyen@0.3.0' },
  };
  assert.equal(await detectInstallMethod({
    packageRoot: bunGlobal,
    run: async (command, args) => {
      assert.deepEqual([command, args], [bunListing.command, bunListing.args]);
      return bunListing.result;
    },
  }), 'bun');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: FAIL — `Cannot find module .../dist/update.js`.

- [ ] **Step 3: Implement the core in `src/update.ts`**

Rules the test pins:
- `upgradeCommand` returns the four argument vectors above, with `version` stripped of a leading `v`.
- `methodFromPath` normalises `\` to `/`, lowercases, and checks markers in this order: `.bun/` or `/bun/install/global/` → `bun`; `/.pnpm/` or `/pnpm/global/` or `/pnpm-global/` → `pnpm`; `/yarn/global/` or `/.config/yarn/` → `yarn`; a `/node_modules/@nguyenhuumanh/vyen/` path → `npm`; otherwise `undefined`.
- `detectInstallMethod` tries the hinted method first, then the remaining managers concurrently. A manager counts as the installer when its listing exits `0` **and** the output contains `@nguyenhuumanh/vyen`. Default `packageRoot` is the real path of `..` from `import.meta.url`; default `run` is `captureCommand` (spawn, `shell` only on Windows, 8 s timeout, `childEnv()`).
- `parseVersion` accepts `v?MAJOR.MINOR.PATCH` with optional prerelease/build, rejects leading zeros and inputs over 256 characters; `compareVersions` follows semver (prerelease below release, numeric identifiers compared with `BigInt`, build metadata ignored).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: PASS.

## Task 2: Registry, cache, policy and the background check

**Files:**
- Modify: `src/update.ts`
- Modify: `src/config.ts:11-25`, `src/config.ts:101-112`
- Test: `tests/update.test.mjs`

**Interfaces:**
- Produces: `fetchLatestVersion(options?: { registry?: string }): Promise<string | undefined>`, `updateCachePath(): string`, `readUpdateCache(file?: string): Promise<{ checkedAt: string; latest: string } | undefined>`, `writeUpdateCache(file: string, value: { checkedAt: string; latest: string }): Promise<void>`, `updateAction(current: string, latest: string, policy: UpdatePolicy): 'none' | 'notify' | 'auto'`, `checkForUpdates(options: { policy: UpdatePolicy; current: string; cacheFile?: string; now?: number; fetchLatest?: () => Promise<string | undefined> }): Promise<{ action: 'none' | 'notify' | 'auto'; latest?: string; refresh?: Promise<void> }>`, `UPDATE_CHECK_TTL_MS = 86_400_000`.
- Config produces: `configSchema` field `update: 'disable' | 'notify' | 'auto'` defaulting to `'notify'`; `VYEN_UPDATE` / `GOON_UPDATE` map into it in `loadConfig`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/update.test.mjs`:

```js
test('config accepts the update policy and VYEN_UPDATE overrides it', async () => {
  const { configSchema, loadConfig } = await import('../dist/config.js');
  assert.equal(configSchema.parse({}).update, 'notify');
  assert.equal(configSchema.parse({ update: 'disable' }).update, 'disable');
  assert.equal(configSchema.parse({ update: 'auto' }).update, 'auto');
  assert.throws(() => configSchema.parse({ update: 'sometimes' }));
});
```

For the environment half, use a temp `XDG_CONFIG_HOME`, set `VYEN_UPDATE=auto`, call `loadConfig()`, assert `update === 'auto'`, then restore the variable in `t.after`.

```js
test('the startup notice appears only for a newer release in notify mode', async (t) => {
  const file = join(await mkdtemp(join(tmpdir(), 'vyen-update-')), 'update-check.json');
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
  await writeUpdateCache(file, { checkedAt: new Date().toISOString(), latest: '9.9.9' });
  const fetchLatest = async () => { throw new Error('the cache is fresh'); };
  assert.equal((await checkForUpdates({ policy: 'notify', current: '0.3.0', cacheFile: file, fetchLatest })).action, 'notify');
  assert.equal((await checkForUpdates({ policy: 'disable', current: '0.3.0', cacheFile: file, fetchLatest })).action, 'none');
  assert.equal((await checkForUpdates({ policy: 'notify', current: '9.9.9', cacheFile: file, fetchLatest })).action, 'none');
  assert.equal((await checkForUpdates({ policy: 'auto', current: '0.3.0', cacheFile: file, fetchLatest })).action, 'auto');
  assert.equal((await checkForUpdates({ policy: 'notify', current: '10.0.0', cacheFile: file, fetchLatest })).action, 'none');
});
```

```js
test('a stale update cache is refreshed without blocking the caller', async (t) => {
  const file = join(await mkdtemp(join(tmpdir(), 'vyen-update-')), 'update-check.json');
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await checkForUpdates({
    policy: 'notify', current: '0.3.0', cacheFile: file,
    fetchLatest: () => gate.then(() => '9.9.9'),
  });
  assert.equal(result.action, 'none');
  assert.ok(result.refresh, 'a missing cache must start a background refresh');
  assert.equal(await readUpdateCache(file), undefined);
  release();
  await result.refresh;
  assert.equal((await readUpdateCache(file)).latest, '9.9.9');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: FAIL — `configSchema.parse({}).update` is `undefined`, and `checkForUpdates` is not exported.

- [ ] **Step 3: Implement**

- `updateAction`: `disable` → `none`; unparseable versions → `none`; `compareVersions(latest, current) > 0` → policy; otherwise `none`.
- `fetchLatestVersion`: `GET {registry}/@nguyenhuumanh%2Fvyen/latest`, registry from `VYEN_REGISTRY`, then `npm_config_registry`, then `https://registry.npmjs.org`; 5 s `AbortSignal.timeout`; non-2xx, bad JSON or an invalid `version` → `undefined` (never throw).
- `checkForUpdates`: `disable` → `{ action: 'none' }` (no cache read, no network). A fresh cache (`now - Date.parse(checkedAt) <= UPDATE_CHECK_TTL_MS`) is used directly, `refresh` absent. Missing/stale cache returns immediately and exposes `refresh`, which fetches, writes `{ checkedAt, latest }` through `atomicJson` (after `mkdir(dirname, { recursive: true })`) and never rejects. The cache path is `join(dataDir(), 'update-check.json')`. The notice text is not built here.
- `src/config.ts`: add `update: z.enum(['disable','notify','auto']).default('notify')` and `update: ['VYEN_UPDATE', 'GOON_UPDATE']` in `ENV_SOURCES` (string key, not numeric).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: PASS.

## Task 3: `vyen upgrade`, the startup notice and docs

**Files:**
- Modify: `src/update.ts`, `src/cli.ts:320-358`, `src/cli.ts:491-500`, `src/cli.ts:609-615`, `src/help.ts:4-39`, `README.md:64-86`, `README.md:273-285`, `docs/SPEC.md:20-22`
- Test: `tests/update.test.mjs`

**Interfaces:**
- Produces: `runUpgrade(options: { target?: string; method?: string; dryRun?: boolean; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; current?: string; detect?: () => Promise<InstallMethod | undefined>; fetchLatest?: () => Promise<string | undefined> }): Promise<number>`, `updateNotice(current: string, latest: string): string`.
- CLI consumes `runUpgrade`, `checkForUpdates`, `updateNotice`; the `upgrade` positional exits before legacy migration and `loadConfig`.

- [ ] **Step 1: Write the failing end-to-end tests**

Add a helper that starts a local registry and spawns `bin/vyen.mjs` with isolated XDG dirs, then:

```js
test('upgrade installs nothing when the running version is current', async (t) => {
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const res = await runUpgradeCli(t, ['upgrade', '--method', 'npm'], version);
  assert.equal(res.code, 0);
  assert.match(res.stdout, new RegExp(`vyen ${version.replaceAll('.', '\\.')} is already installed`));
  assert.doesNotMatch(res.stdout, /npm install/);
});

test('upgrade rejects an invalid target before any package manager runs', async (t) => {
  const res = await runUpgradeCli(t, ['upgrade', '1.2', '--method', 'npm'], '9.9.9');
  assert.equal(res.code, 1);
  assert.match(res.stderr, /invalid version "1\.2"/);
});

test('upgrade --dry-run prints the command and installs nothing', async (t) => {
  const res = await runUpgradeCli(t, ['upgrade', '--method', 'npm', '--dry-run'], '9.9.9');
  assert.equal(res.code, 0);
  assert.match(res.stdout, /npm install --global @nguyenhuumanh\/vyen@9\.9\.9 --no-audit --no-fund/);
});
```

`runUpgradeCli(t, args, latestVersion)` must:
- create a temp dir and start an HTTP server answering every request with `{"version": latestVersion}`;
- set `VYEN_REGISTRY` to `http://127.0.0.1:<port>`, `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under the temp dir, and remove `VYEN_API_KEY`/`GOON_API_KEY`;
- spawn `process.execPath bin/vyen.mjs ...args` with `stdio: pipe`, 20 s timeout, capture `stdout`/`stderr`;
- register cleanup for the server, child and temp dir with `t.after`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: FAIL — `upgrade` is parsed as prompt text, no "already installed" output, exit code 0/1 mismatch.

- [ ] **Step 3: Implement**

- `runUpgrade`: normalise `--method` (case-insensitive; reject names outside the four with exit 1); validate the explicit target before any network call (`invalid version "X". Pass a version like 0.3.1.`); otherwise fetch latest and fail with exit 1 when the registry is unreachable; equal to `current` → `vyen <current> is already installed.` and exit 0; no method → `could not detect how vyen was installed. Re-run with --method npm|pnpm|yarn|bun.`; `--dry-run` → print `command args.join(' ')` and exit 0; otherwise print `Installing @nguyenhuumanh/vyen@X with <method>...`, spawn with `stdio: 'inherit'` (`shell` on Windows), and on a non-zero exit print the manual command and return that code; on success print `Installed ... Restart vyen to use it.`.
- `updateNotice(current, latest)` returns `vyen ${latest} is available (installed ${current}). Run: vyen upgrade`.
- CLI parseArgs: add `method: { type: 'string' }` and `'dry-run': { type: 'boolean' }`. Dispatch `positionals[0] === 'upgrade'` right after help/version, before `migrateLegacyData`/`loadConfig`, setting `process.exitCode = await runUpgrade(...)`.
- Startup check: after `const interactive = !prompt;`, only when `!prompt && stdin.isTTY && stdout.isTTY && !jsonOutput`, call `checkForUpdates({ policy: config.update, current: VERSION })`; keep `refresh` unawaited; `notify` stores `updateNotice(...)`; `auto` calls `runUpgrade` with a buffered `stdout` sink and stores the buffer (success) or `vyen X is available; run: vyen upgrade` (failure). Wrap in `try/catch` so an update never blocks startup. After `display` is defined, `if (updateNotice) display(`${updateNotice}\n`)` (the TUI owns the alternate screen, so pre-TUI writes would be hidden).
- `help.ts`: add `vyen upgrade [VERSION] [--method npm|pnpm|yarn|bun] [--dry-run]` to Usage and the two flags to Options.
- `README.md`: add `vyen upgrade` to the CLI block and a short "Cập nhật phiên bản" paragraph (auto-detect, `--method`, `--dry-run`, policy env `VYEN_UPDATE`, notice only in TUI, cache path).
- `docs/SPEC.md`: replace the "auto-updater" prohibition with the opt-in update contract (explicit command, `notify|auto|disable`, cache, prompt/JSON never check) and correct the release paragraph that says no npm publishing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build; node --test tests/update.test.mjs`
Expected: PASS (three E2E + five other tests).

- [ ] **Step 5: Full gate**

Run: `npm run typecheck; npm run lint; npm test`
Expected: typecheck 0, lint 0 errors, suite green except the six known Windows-only failures and three skipped POSIX pty tests.

## Self-review notes

- Every Review Focus row names a test title that the test file contains verbatim.
- The network is only ever `http://127.0.0.1` in tests; no test executes a real package manager (`--dry-run` and the already-current path return before spawning).
- The startup notice is tested at the `checkForUpdates` boundary; the CLI wiring is covered by the E2E tests only for the explicit command, which is the observable contract.
- Out of scope by design: OpenCode's prebuilt-binary downloader and `brew`/`winget` methods, because vyen ships only through npm.
