# Vyen Brand Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from `goon` to `vyen` everywhere — display strings, package name, binary, config/data directories, environment variables — while keeping every existing installation working by migrating its on-disk data and still honouring the old `GOON_*` variables.

**Architecture:** One new module `src/migrate.ts` owns the legacy-data copy, driven by a marker file so a half-finished migration resumes on the next run. `src/config.ts` owns the new paths and the `VYEN_*` → `GOON_*` environment fallback. Every other source file only changes literal strings — no behaviour moves. `src/index.ts` re-exports the migration entry point so tests can drive it directly.

**Tech Stack:** TypeScript 5.9 (strict, `NodeNext`), Node ≥ 22.16, `node:test` for tests, `zod` for config validation, AI SDK 6 for provider calls.

**Spec:** the approved design in the conversation — sections A1–A6 (rename) and C1–C5 (decisions). This plan is plan 1 of 2; plan 2 (`2026-10-21-vyen-critical-fixes.md`) fixes the eight audit findings and runs **after** this one.

## Global Constraints

- The string `goon` must not survive as a live identifier anywhere in `src/`, `bin/`, `tests/`, `scripts/`, `docs/`, `package.json`, or `npm-shrinkwrap.json`. The only permitted survivors are: the legacy `GOON_*` environment-variable names, the legacy `~/.config/goon` and `~/.local/share/goon` directory names, the migration marker filename, and `NOTICE.md` history entries that describe past releases.
- The npm package name is `vyen-cli` and the binary is `vyen` → `bin/vyen.mjs`.
- Config lives at `<XDG_CONFIG_HOME>/vyen`; data lives at `<XDG_DATA_HOME>/vyen`. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` keep their standard meaning.
- Environment variables: `VYEN_PROVIDER`, `VYEN_BASE_URL`, `VYEN_MODEL`, `VYEN_EFFORT`, `VYEN_KEY_ENV`, `VYEN_CONTEXT_WINDOW`, `VYEN_MAX_OUTPUT_TOKENS`, `VYEN_TIMEOUT_MS`, `VYEN_RUN_TOKEN_BUDGET`, `VYEN_INLINE_REASONING`, `VYEN_BASH`. The matching `GOON_*` names remain honoured as a silent fallback.
- `config.keyEnv` defaults to `VYEN_API_KEY`.
- Migration **copies**; it never moves or deletes the legacy directory.
- Migration is driven by the marker file `~/.config/vyen/.migrated-from-goon`, not by the existence of `~/.config/vyen`. A migration interrupted midway must resume on the next run.
- Migration never overwrites a file that already exists in the new directory.
- Migration never throws. Any failure is reported, not raised, and must not prevent the CLI from starting.
- The OpenAI-compatible provider namespace and its `providerOptions` key must stay identical to each other (`vyen` and `vyen`).
- Every task ends with the full suite green: `npm run typecheck && npm run lint && npm test`.
- This directory is not a git repository. Task 0 creates one.

## Review Focus

These are the inputs most likely to bite a real user and that no task's tests below fully cover. Each line is pinned by a test added in the task that owns the code.

1. **A user whose legacy `~/.config/goon/config.json` names `keyEnv: "GOON_API_KEY"` and whose shell exports `GOON_API_KEY`** — after migration the key must still resolve. Pinned in Task 3.
2. **A user who ran the migration once, then edited `~/.config/vyen/config.json` by hand** — the next launch must not overwrite their edit with the legacy copy. Pinned in Task 2.
3. **A user whose first launch was interrupted between copying `config.json` and writing the marker** — the second launch must finish the copy, not skip it. Pinned in Task 2.
4. **A user with `GOON_BASH` set but no `VYEN_BASH`** — bash resolution must still find Git Bash on Windows. Pinned in Task 4.
5. **Two terminals launching `vyen` for the first time simultaneously** — both may attempt the copy; neither may crash and the resulting directory must be valid. Pinned in Task 2.

---

### Task 0: Create the git repository

**Files:**
- Create: `.git/` (via `git init`)

**Interfaces:**
- Consumes: nothing.
- Produces: a git repository with one baseline commit, so every later task can commit and so a botched rename is revertible.

- [ ] **Step 1: Initialise the repository and commit the current state**

Run: `git init -b main && git add -A && git commit -m "chore: baseline before vyen rename"`

Expected: one commit named "chore: baseline before vyen rename". `.gitignore` already excludes `node_modules/`, `dist/`, `release-out/`, `*.tgz` (except `release/*.tgz`) and `.env`, so `git status` must be clean afterwards.

- [ ] **Step 2: Confirm the working tree is clean**

Run: `git status --porcelain`
Expected: no output.

---

### Task 1: Create the migration module

**Files:**
- Create: `src/migrate.ts`
- Create: `tests/migrate.test.mjs`
- Modify: `src/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const MIGRATION_MARKER = '.migrated-from-goon';
  export interface MigrationReport {
    migrated: boolean;      // true when a migration ran and completed
    skipped: boolean;       // true when the marker already existed
    copied: string[];       // names of the entries copied, e.g. ['config.json', 'sessions']
    error?: string;         // present when the migration failed; never thrown
  }
  export async function migrateLegacyData(options: {
    legacyConfigDir: string;
    legacyDataDir: string;
    configDir: string;
    dataDir: string;
  }): Promise<MigrationReport>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/migrate.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyData, MIGRATION_MARKER } from '../dist/migrate.js';

const dirs = async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-migrate-test-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const legacyConfigDir = join(root, 'goon-config');
  const legacyDataDir = join(root, 'goon-data');
  const configDir = join(root, 'vyen-config');
  const dataDir = join(root, 'vyen-data');
  await mkdir(legacyConfigDir, { recursive: true });
  await mkdir(legacyDataDir, { recursive: true });
  await writeFile(join(legacyConfigDir, 'config.json'), '{"model":"legacy-model"}');
  await writeFile(join(legacyConfigDir, 'credentials.json'), '{"GOON_API_KEY":"legacy-secret"}');
  await mkdir(join(legacyConfigDir, 'skills', 'demo'), { recursive: true });
  await writeFile(join(legacyConfigDir, 'skills', 'demo', 'SKILL.md'), '# demo');
  await mkdir(join(legacyDataDir, 'sessions'), { recursive: true });
  await writeFile(join(legacyDataDir, 'sessions', 'a.json'), '{}');
  return { legacyConfigDir, legacyDataDir, configDir, dataDir };
};

test('migration copies legacy config, skills and sessions into the vyen directories', async t => {
  const d = await dirs(t);
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(report.error, undefined);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"legacy-model"}');
  assert.equal(await readFile(join(d.configDir, 'credentials.json'), 'utf8'), '{"GOON_API_KEY":"legacy-secret"}');
  assert.equal(await readFile(join(d.configDir, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# demo');
  assert.equal(await readFile(join(d.dataDir, 'sessions', 'a.json'), 'utf8'), '{}');
  assert.ok((await readdir(d.configDir)).includes(MIGRATION_MARKER));
});

test('migration never overwrites a file that already exists in the new directory', async t => {
  const d = await dirs(t);
  await mkdir(d.configDir, { recursive: true });
  await writeFile(join(d.configDir, 'config.json'), '{"model":"hand-edited"}');
  await migrateLegacyData(d);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"hand-edited"}');
});

test('an interrupted migration resumes because the marker, not the directory, gates it', async t => {
  const d = await dirs(t);
  await mkdir(d.configDir, { recursive: true });
  await writeFile(join(d.configDir, 'config.json'), '{"model":"partial"}');
  // No marker: the previous run died before writing one.
  const report = await migrateLegacyData(d);
  assert.equal(report.migrated, true);
  assert.equal(await readFile(join(d.configDir, 'credentials.json'), 'utf8'), '{"GOON_API_KEY":"legacy-secret"}');
});

test('a completed migration is skipped on the next launch', async t => {
  const d = await dirs(t);
  await migrateLegacyData(d);
  await writeFile(join(d.legacyConfigDir, 'config.json'), '{"model":"changed-after-migration"}');
  const report = await migrateLegacyData(d);
  assert.equal(report.skipped, true);
  assert.equal(report.migrated, false);
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), '{"model":"legacy-model"}');
});

test('migration reports instead of throwing when the legacy directory is unreadable', async t => {
  const d = await dirs(t);
  await writeFile(join(d.legacyConfigDir, 'config.json'), 'not json');
  const report = await migrateLegacyData(d);
  assert.equal(report.error, undefined); // a bad legacy file is still copied, not parsed
  assert.equal(await readFile(join(d.configDir, 'config.json'), 'utf8'), 'not json');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/migrate.test.mjs`
Expected: FAIL with `Cannot find module '../dist/migrate.js'`.

- [ ] **Step 3: Implement `src/migrate.ts`**

Create `src/migrate.ts`:

```ts
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export const MIGRATION_MARKER = '.migrated-from-goon';

const CONFIG_ENTRIES = ['config.json', 'credentials.json', 'mcp.json', 'memories.json', 'presets.json'];
const CONFIG_DIRECTORIES = ['skills'];
const DATA_DIRECTORIES = ['sessions'];

export interface MigrationReport {
  migrated: boolean;
  skipped: boolean;
  copied: string[];
  error?: string;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function migrateLegacyData(options: {
  legacyConfigDir: string;
  legacyDataDir: string;
  configDir: string;
  dataDir: string;
}): Promise<MigrationReport> {
  const { legacyConfigDir, legacyDataDir, configDir, dataDir } = options;
  const copied: string[] = [];
  try {
    const marker = join(configDir, MIGRATION_MARKER);
    if (await exists(marker)) return { migrated: false, skipped: true, copied: [] };
    if (!await exists(legacyConfigDir) && !await exists(legacyDataDir)) {
      return { migrated: false, skipped: false, copied: [] };
    }
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    for (const name of CONFIG_ENTRIES) {
      const from = join(legacyConfigDir, name);
      const to = join(configDir, name);
      if (await exists(from) && !await exists(to)) {
        await cp(from, to);
        copied.push(name);
      }
    }
    for (const name of CONFIG_DIRECTORIES) {
      const from = join(legacyConfigDir, name);
      const to = join(configDir, name);
      if (await exists(from) && !await exists(to)) {
        await cp(from, to, { recursive: true });
        copied.push(name);
      }
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    for (const name of DATA_DIRECTORIES) {
      const from = join(legacyDataDir, name);
      const to = join(dataDir, name);
      if (await exists(from) && !await exists(to)) {
        await cp(from, to, { recursive: true });
        copied.push(name);
      }
    }
    await writeFile(marker, `${JSON.stringify({ migratedAt: new Date().toISOString(), source: legacyConfigDir }, null, 2)}\n`, 'utf8');
    return { migrated: true, skipped: false, copied };
  } catch (error) {
    return { migrated: false, skipped: false, copied, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: Export it from the package entry point**

In `src/index.ts`, add after the `session.js` export line:

```ts
export { migrateLegacyData, MIGRATION_MARKER } from './migrate.js';
export type { MigrationReport } from './migrate.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && node --test tests/migrate.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green (the same 5 Windows-only failures as the baseline are acceptable; see Task 5 for their names).

- [ ] **Step 7: Commit**

```bash
git add src/migrate.ts src/index.ts tests/migrate.test.mjs
git commit -m "feat: add legacy goon to vyen data migration"
```

---

### Task 2: Move the config and data directories, and honour the legacy environment variables

**Files:**
- Modify: `src/config.ts:15`, `:27-30`, `:79-115`
- Test: `tests/migrate.test.mjs` (append), `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `migrateLegacyData` and `MIGRATION_MARKER` from Task 1.
- Produces:
  ```ts
  // src/config.ts
  export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vyen');
  export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vyen');
  export const legacyConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goon');
  export const legacyDataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'goon');
  ```
  `config.keyEnv` now defaults to `'VYEN_API_KEY'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/migrate.test.mjs`:

```js
import { loadConfig, resolveApiKey } from '../dist/config.js';

test('the vyen config directory is used and the legacy goon directory is migrated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-config-test-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const legacy = join(root, 'goon');
  const fresh = join(root, 'vyen');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'config.json'), '{"model":"legacy-model","keyEnv":"GOON_API_KEY"}');
  const previous = { config: process.env.XDG_CONFIG_HOME, key: process.env.VYEN_API_KEY };
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.VYEN_API_KEY;
  try {
    const config = await loadConfig();
    assert.equal(config.model, 'legacy-model');
    assert.equal(config.keyEnv, 'GOON_API_KEY');
    // The migrated copy lives under the vyen directory.
    assert.equal(JSON.parse(await readFile(join(fresh, 'config.json'), 'utf8')).model, 'legacy-model');
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.key !== undefined) process.env.VYEN_API_KEY = previous.key;
  }
});

test('VYEN_* environment variables win and GOON_* remain honoured as a fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-env-test-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const previous = { config: process.env.XDG_CONFIG_HOME, model: process.env.VYEN_MODEL, legacy: process.env.GOON_MODEL };
  process.env.XDG_CONFIG_HOME = root;
  process.env.VYEN_MODEL = 'new-model';
  process.env.GOON_MODEL = 'legacy-model';
  try {
    assert.equal((await loadConfig()).model, 'new-model');
    delete process.env.VYEN_MODEL;
    assert.equal((await loadConfig()).model, 'legacy-model');
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.model === undefined) delete process.env.VYEN_MODEL; else process.env.VYEN_MODEL = previous.model;
    if (previous.legacy === undefined) delete process.env.GOON_MODEL; else process.env.GOON_MODEL = previous.legacy;
  }
});

test('an API key exported as GOON_API_KEY still resolves after the rename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vyen-key-test-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const previous = { config: process.env.XDG_CONFIG_HOME, legacy: process.env.GOON_API_KEY, new: process.env.VYEN_API_KEY };
  process.env.XDG_CONFIG_HOME = root;
  process.env.GOON_API_KEY = 'legacy-secret';
  delete process.env.VYEN_API_KEY;
  try {
    const config = await loadConfig();
    assert.equal(config.keyEnv, 'VYEN_API_KEY');
    assert.equal(await resolveApiKey(config), 'legacy-secret');
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.legacy === undefined) delete process.env.GOON_API_KEY; else process.env.GOON_API_KEY = previous.legacy;
    if (previous.new === undefined) delete process.env.VYEN_API_KEY; else process.env.VYEN_API_KEY = previous.new;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/migrate.test.mjs`
Expected: FAIL — `config.model` is `undefined` because the config still lives in the `goon` directory.

- [ ] **Step 3: Change the directory names and add the legacy helpers**

In `src/config.ts`, replace the two directory helpers:

```ts
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vyen');
export const configPath = () => join(configDir(), 'config.json');
export const credentialsPath = () => join(configDir(), 'credentials.json');
export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vyen');
export const legacyConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goon');
export const legacyDataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'goon');
```

- [ ] **Step 4: Change the default key environment variable**

In `src/config.ts`, change the `keyEnv` schema default:

```ts
keyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('VYEN_API_KEY'),
```

- [ ] **Step 5: Replace the environment variable map with a VYEN-first, GOON-fallback lookup**

In `src/config.ts`, replace the environment loop inside `loadConfig` with:

```ts
  const ENV_SOURCES: Record<string, string[]> = {
    provider: ['VYEN_PROVIDER', 'GOON_PROVIDER'],
    baseUrl: ['VYEN_BASE_URL', 'GOON_BASE_URL'],
    model: ['VYEN_MODEL', 'GOON_MODEL'],
    effort: ['VYEN_EFFORT', 'GOON_EFFORT'],
    keyEnv: ['VYEN_KEY_ENV', 'GOON_KEY_ENV'],
    contextWindow: ['VYEN_CONTEXT_WINDOW', 'GOON_CONTEXT_WINDOW'],
    maxOutputTokens: ['VYEN_MAX_OUTPUT_TOKENS', 'GOON_MAX_OUTPUT_TOKENS'],
    timeoutMs: ['VYEN_TIMEOUT_MS', 'GOON_TIMEOUT_MS'],
    runTokenBudget: ['VYEN_RUN_TOKEN_BUDGET', 'GOON_RUN_TOKEN_BUDGET'],
    inlineReasoning: ['VYEN_INLINE_REASONING', 'GOON_INLINE_REASONING'],
  };
  const NUMERIC_KEYS = ['contextWindow', 'maxOutputTokens', 'timeoutMs', 'runTokenBudget'];
  const env: Record<string, unknown> = {};
  for (const [key, names] of Object.entries(ENV_SOURCES)) {
    for (const name of names) {
      if (process.env[name] === undefined) continue;
      env[key] = NUMERIC_KEYS.includes(key) ? Number(process.env[name]) : process.env[name];
      break;
    }
  }
```

- [ ] **Step 6: Make `resolveApiKey` fall back to the legacy variable and the legacy credential entry**

In `src/config.ts`, replace `resolveApiKey` with:

```ts
export async function resolveApiKey(config: Config): Promise<string | undefined> {
  const fromEnv = process.env[config.keyEnv]?.trim();
  if (fromEnv) return fromEnv;
  if (config.keyEnv !== 'GOON_API_KEY') {
    const legacy = process.env.GOON_API_KEY?.trim();
    if (legacy) return legacy;
  }
  const stored = await loadCredentials();
  const fromStore = stored[config.keyEnv]?.trim();
  if (fromStore) return fromStore;
  if (config.keyEnv !== 'GOON_API_KEY') return stored['GOON_API_KEY']?.trim() || undefined;
  return undefined;
}
```

- [ ] **Step 7: Run the migration before the config is read**

In `src/config.ts`, add the import at the top:

```ts
import { migrateLegacyData } from './migrate.js';
```

and insert it as the **very first statement** of `loadConfig` — before the `readFile(configPath(), …)` that populates `stored`, otherwise the freshly migrated `config.json` would never be read:

```ts
export async function loadConfig(overrides: Record<string, unknown> = {}): Promise<Config> {
  // Migrate first: the legacy config.json has to exist at the new path before
  // it is read below.
  await migrateLegacyData({
    legacyConfigDir: legacyConfigDir(),
    legacyDataDir: legacyDataDir(),
    configDir: configDir(),
    dataDir: dataDir(),
  });
  let stored: unknown = {};
  try { stored = JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  ...
```

`migrateLegacyData` never throws, so no `try/catch` is needed here.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run build && node --test tests/migrate.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 9: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts tests/migrate.test.mjs
git commit -m "feat: move config and data to vyen with legacy goon fallback"
```

---

### Task 3: Rename every brand string in the source

**Files:**
- Modify: `src/cli.ts`, `src/tui.ts`, `src/setup.ts`, `src/context.ts`, `src/provider.ts`, `src/mcp.ts`, `src/files.ts`, `src/process.ts`, `src/session.ts`
- Test: `tests/tui.test.mjs`, `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: the new `vyen` directory names from Task 2.
- Produces: the literal `vyen` in every user-visible position; the OpenAI-compatible provider namespace `vyen` in `src/provider.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/tui.test.mjs`, the existing test at line 100 asserts the composer label. Change its expectation from `'goon> '` to `'vyen> '`:

```js
  const q = tty.ui.question('vyen> ', undefined, true);
```

In `tests/runtime.test.mjs`, add a new test asserting the CLI's own strings:

```js
test('the CLI identifies itself as vyen in help, version and error output', async t => {
  const f = await fixture(t);
  const { cli } = await import('./helpers.mjs');
  const version = await cli(f, 'http://127.0.0.1:1', ['--version']);
  const result = await version.done;
  assert.match(result.stdout, /^vyen cli /);
  const help = await cli(f, 'http://127.0.0.1:1', ['--help']);
  const helpResult = await help.done;
  assert.match(helpResult.stdout, /vyen cli /);
  assert.match(helpResult.stdout, /VYEN_API_KEY/);
  assert.doesNotMatch(helpResult.stdout, /goon/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/runtime.test.mjs tests/tui.test.mjs`
Expected: FAIL — the CLI still prints `goon cli`.

- [ ] **Step 3: Rename the strings in `src/cli.ts`**

Replace, verbatim:

| Line | Old | New |
|---|---|---|
| 28 | `goon cli ${VERSION} — independent coding harness` | `vyen cli ${VERSION} — independent coding harness` |
| 30-35 | `goon [options] [prompt]`, `goon resume [ID\|latest\|number]`, `goon setup`, `goon init …`, `goon doctor \| sessions`, `goon mcp list \| check …` | the same with `vyen` |
| 44 | `Credential variable (default GOON_API_KEY)` | `Credential variable (default VYEN_API_KEY)` |
| 67 | `~/.config/goon/credentials.json` | `~/.config/vyen/credentials.json` |
| 87 | `◆ goon  v${VERSION}` | `◆ vyen  v${VERSION}` |
| 238, 334 | `goon mcp add <name> …` | `vyen mcp add <name> …` |
| 295 | `goon cli ${VERSION}` | `vyen cli ${VERSION}` |
| 363 | `run goon in your project` | `run vyen in your project` |
| 467 | `'goon:signal'` | `'vyen:signal'` |
| 755 | `goon · ${runtime.model} · session` | `vyen · ${runtime.model} · session` |
| 838 | `Exit goon (or press Ctrl+D on empty input)` | `Exit vyen (or press Ctrl+D on empty input)` |
| 949 | `~/.config/goon/skills` | `~/.config/vyen/skills` |
| 1254 | `goon mcp add <name> -- <cmd> [args...]` | `vyen mcp add <name> -- <cmd> [args...]` |
| 1365, 1842 | `goon-session-${…}.md` | `vyen-session-${…}.md` |
| 1385, 1727 | `goon --resume ${…}` | `vyen --resume ${…}` |
| 1438 | `'goon> '` | `'vyen> '` |
| 2181 | `goon: ${message}` | `vyen: ${message}` |

- [ ] **Step 4: Rename the strings in `src/tui.ts`**

| Line | Old | New |
|---|---|---|
| 15 | `goon palette` | `vyen palette` |
| 153 | `'quit goon cli'` | `'quit vyen cli'` |
| 311 | `/^(\s*)(◆ goon)(\s+)(v\S+)(\s+)(.*?)(\s*)$/` | `/^(\s*)(◆ vyen)(\s+)(v\S+)(\s+)(.*?)(\s*)$/` |
| 423 | `private label = 'goon> '` | `private label = 'vyen> '` |
| 990 | `label = 'goon> '` | `label = 'vyen> '` |
| 1281 | `'goon-clip-'` | `'vyen-clip-'` |
| 1326 | `this.label !== 'goon> '` | `this.label !== 'vyen> '` |
| 2311 | `this.label !== 'goon> '` | `this.label !== 'vyen> '` |
| 2326 | `[' goon', T.strong]` | `[' vyen', T.strong]` |
| 2361 | `clip(\`goon · ${sessionLabel}\`)` | `clip(\`vyen · ${sessionLabel}\`)` |

- [ ] **Step 5: Rename the strings in the remaining source files**

- `src/setup.ts:117` — `✻ goon cli v${VERSION} · Interactive Setup` → `✻ vyen cli v${VERSION} · Interactive Setup`.
- `src/context.ts:377` — `You are Goon, an independent terminal coding agent.` → `You are Vyen, an independent terminal coding agent.`
- `src/files.ts:354` — `` `.goon-${randomUUID()}.tmp` `` → `` `.vyen-${randomUUID()}.tmp` ``
- `src/mcp.ts:720` — `new Client({ name: 'goon-cli', version: VERSION }` → `new Client({ name: 'vyen-cli', version: VERSION }`
- `src/session.ts:112` — the comment `goon resume 3` → `vyen resume 3`
- `src/process.ts:12` — `process.env.GOON_BASH,` → `process.env.VYEN_BASH ?? process.env.GOON_BASH,`

  Note: `resolveExecutable` iterates the candidate list and returns the first existing path. `process.env.VYEN_BASH ?? process.env.GOON_BASH` yields `undefined` when neither is set, which the existing `if (candidate && existsSync(candidate))` guard already skips.
- `src/provider.ts:29` — `goon: { reasoningEffort: effort },` → `vyen: { reasoningEffort: effort },`
- `src/provider.ts:105` — `createOpenAICompatible({ ...options, name: 'goon', includeUsage: true })` → `createOpenAICompatible({ ...options, name: 'vyen', includeUsage: true })`

  These two must change together: the AI SDK uses the provider `name` as the `providerOptions` namespace, so `providerOptions.vyen` is the only key the `vyen` provider reads.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build && node --test tests/runtime.test.mjs tests/tui.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 8: Commit**

```bash
git add src tests/runtime.test.mjs tests/tui.test.mjs
git commit -m "feat: rename brand strings from goon to vyen"
```

---

### Task 4: Rename the binary, the npm package and the test harness identifiers

**Files:**
- Move: `bin/goon.mjs` → `bin/vyen.mjs`
- Modify: `package.json`, `npm-shrinkwrap.json`, `.gitignore`
- Modify: `tests/helpers.mjs`, `tests/tui.test.mjs`, `tests/fixtures/mcp-server.mjs`, `tests/fixtures/terminal.py`
- Test: every file under `tests/`

**Interfaces:**
- Consumes: the `vyen` strings from Task 3.
- Produces: `vyen` on `PATH` after install; the npm package `vyen-cli`; the test helper resolves the binary through `VYEN_TEST_BIN`.

- [ ] **Step 1: Rename the binary**

Run: `Move-Item bin/goon.mjs bin/vyen.mjs`
Expected: `bin/vyen.mjs` exists and still contains the three-line launcher importing `../dist/cli.js`.

- [ ] **Step 2: Update `package.json`**

In `package.json`, change:

```json
  "name": "vyen-cli",
  "bin": {
    "vyen": "bin/vyen.mjs"
  },
```

Leave `version`, `files`, `scripts` and the dependency blocks untouched. Note that `files` already lists `README.md` and `LICENSE`; Task 5 creates them.

- [ ] **Step 3: Update `npm-shrinkwrap.json`**

In `npm-shrinkwrap.json`, change the top-level `"name"` and `packages[""].name` from `goon-cli` to `vyen-cli`. Change nothing else — the locked dependency versions must not move.

- [ ] **Step 4: Update `.gitignore`**

Change `.goon/` to `.vyen/`.

- [ ] **Step 5: Update the test harness**

In `tests/helpers.mjs`:
- `join(tmpdir(), 'goon-test-')` → `join(tmpdir(), 'vyen-test-')`
- `resolve(process.env.GOON_TEST_BIN ?? 'bin/goon.mjs')` → `resolve(process.env.VYEN_TEST_BIN ?? process.env.GOON_TEST_BIN ?? 'bin/vyen.mjs')`
- `GOON_API_KEY: 'test-secret-never-echo'` → `VYEN_API_KEY: 'test-secret-never-echo'`
- `child.send({ type: 'goon:signal', signal: sig })` → `child.send({ type: 'vyen:signal', signal: sig })`

In `tests/tui.test.mjs`:
- `resolve(process.env.GOON_TEST_BIN ?? 'bin/goon.mjs')` → `resolve(process.env.VYEN_TEST_BIN ?? process.env.GOON_TEST_BIN ?? 'bin/vyen.mjs')`
- `GOON_API_KEY: 'tui-test-key'` → `VYEN_API_KEY: 'tui-test-key'`
- `join(f.data, 'goon/sessions')` → `join(f.data, 'vyen/sessions')`
- line 106: `tty.ui.question('goon> ', undefined, true)` → `tty.ui.question('vyen> ', undefined, true)`

In `tests/fixtures/mcp-server.mjs`:
- `{ name: 'goon-test-server', version: '1.0.0' }` → `{ name: 'vyen-test-server', version: '1.0.0' }`
- `apiKey: process.env.GOON_API_KEY ?? null` → `apiKey: process.env.VYEN_API_KEY ?? null`

  This assertion checks that the CLI does **not** forward the provider key to an MCP server. The variable name must follow the rename or the assertion silently stops testing anything.

In `tests/subagents.test.mjs`:
- `join(f.data, 'goon/subagents', parent)` → `join(f.data, 'vyen/subagents', parent)`

In `tests/fixtures/terminal.py`: change any `goon` occurrence to `vyen`.

- [ ] **Step 6: Find every remaining occurrence**

Run: `grep -rn "goon\|Goon\|GOON" src tests bin scripts package.json npm-shrinkwrap.json .gitignore`
Expected: only the permitted survivors from the Global Constraints — the `GOON_*` environment names in `src/config.ts`, `src/process.ts` and `tests/helpers.mjs`, the legacy directory names in `src/config.ts`, and `MIGRATION_MARKER` in `src/migrate.ts`. Fix anything else you find before continuing.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: rename binary and npm package to vyen"
```

---

### Task 5: Create README.md and LICENSE

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Modify: `package.json` (no change needed — `files` already lists both)

**Interfaces:**
- Consumes: the `vyen` naming from Task 4.
- Produces: a published archive that actually contains a README and a licence.

- [ ] **Step 1: Write the README**

Create `README.md` with these sections, using only facts the code already guarantees:

```markdown
# vyen-cli

An independent terminal coding agent. It talks to OpenAI-compatible, OpenAI
Responses and Anthropic endpoints, reads and edits files in your workspace,
runs shell commands with your approval, speaks MCP, and can delegate work to
subagents.

## Install

```bash
npm install -g vyen-cli
```

Requires Node.js >= 22.16.0. Verified on Linux; the primary target is Termux on
Android.

## Configure

```bash
vyen setup
```

`vyen setup` writes `~/.config/vyen/config.json`. The API key is never written
to the config file — it is read from the environment variable named by
`keyEnv` (default `VYEN_API_KEY`) or from `~/.config/vyen/credentials.json`.

## Run

```bash
vyen                      # interactive
vyen "fix the failing test"   # one shot
vyen --read-only          # no writes, no shell
vyen --plan               # plan first, then implement
```

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `VYEN_API_KEY` | API key | — |
| `VYEN_BASE_URL` | Gateway base URL | `https://api.yuristore.xyz/v1` |
| `VYEN_MODEL` | Model id | — |
| `VYEN_PROVIDER` | `openai-compatible`, `openai-responses`, `anthropic` | `openai-compatible` |
| `VYEN_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` | provider default |
| `VYEN_CONTEXT_WINDOW` | Context window in tokens | `128000` |
| `VYEN_MAX_OUTPUT_TOKENS` | Output cap per response | `16384` |
| `VYEN_TIMEOUT_MS` | Per-request timeout | `300000` |
| `VYEN_RUN_TOKEN_BUDGET` | Token cap for one run, `0` disables | `0` |
| `VYEN_INLINE_REASONING` | `leading-think` or `off` | `leading-think` |
| `VYEN_BASH` | Path to bash on Windows | auto-detected |

The older `GOON_*` names still work, so existing shell profiles keep running.

## Permissions

Mutating tools and shell commands need approval. `--yes` approves everything
for that run; `--read-only` removes them entirely; `--plan` allows exploration
first. A denied tool ends the run.

## MCP

Servers live in `~/.config/vyen/mcp.json`, separate from the main config. See
[docs/MCP.md](docs/MCP.md).

## Sessions

Sessions are stored as JSON under `~/.local/share/vyen/sessions/`. `vyen
sessions` lists them and `vyen resume` reopens one.

## License

MIT
```

- [ ] **Step 2: Write the licence**

Create `LICENSE` containing the standard MIT text, with the copyright line
`Copyright (c) 2026 vyen contributors`.

- [ ] **Step 3: Verify the packaged archive contains both files**

Run: `npm run build && npm pack --dry-run --json`
Expected: the file list includes `README.md`, `LICENSE`, `bin/vyen.mjs` and `dist/cli.js`, and does **not** include `bin/goon.mjs`.

- [ ] **Step 4: Commit**

```bash
git add README.md LICENSE
git commit -m "docs: add vyen README and MIT licence"
```

---

### Task 6: Update the documentation

**Files:**
- Modify: `docs/SPEC.md`, `docs/MCP.md`, `docs/REFERENCE_REVIEW.md`, `NOTICE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation that matches the renamed code.

- [ ] **Step 1: Update `docs/SPEC.md`**

- Line 1: `# Goon CLI 0.2` → `# Vyen CLI 0.2`
- Line 10: `flags > GOON_* environment > user config > defaults` → `flags > VYEN_* environment > user config > defaults`

- [ ] **Step 2: Update `docs/MCP.md`**

- Line 3: `Goon is an MCP client` → `Vyen is an MCP client`
- Line 5: `$XDG_CONFIG_HOME/goon/mcp.json` (default `~/.config/goon/mcp.json`) → `$XDG_CONFIG_HOME/vyen/mcp.json` (default `~/.config/vyen/mcp.json`)
- Line 6: `goon init` → `vyen init`
- Line 46: `goon mcp list` → `vyen mcp list`
- Line 47: `goon mcp check` → `vyen mcp check`
- Line 50: `Normal goon startup` → `Normal vyen startup`
- Line 61: `Goon cannot enforce remote filesystem containment.` → `Vyen cannot enforce remote filesystem containment.`

- [ ] **Step 3: Update `docs/REFERENCE_REVIEW.md`**

Replace every `Goon` / `Goon's` with `Vyen` / `Vyen's`, and line 41's
`GOON_INLINE_REASONING=off` with `VYEN_INLINE_REASONING=off`. The pinned
upstream commits and the adopted-contract table stay exactly as they are.

- [ ] **Step 4: Update `NOTICE.md`**

- Line 3: `Goon CLI is an independent implementation.` → `Vyen CLI is an independent implementation.`
- Line 18: `Goon uses the Vercel AI SDK` → `Vyen uses the Vercel AI SDK`

Leave the "Design references inspected for version 0.1.0" section alone — it
describes a past release and is historically accurate.

- [ ] **Step 5: Verify no stale name remains**

Run: `grep -rn "goon\|Goon" docs NOTICE.md README.md`
Expected: no output.

- [ ] **Step 6: Run the full suite once more**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green apart from the 5 known Windows-only failures.

- [ ] **Step 7: Commit**

```bash
git add docs NOTICE.md README.md
git commit -m "docs: rename goon to vyen across documentation"
```

---

### Task 7: Final verification

**Files:** none modified.

**Interfaces:**
- Consumes: the whole rename.
- Produces: a verified, self-consistent tree.

- [ ] **Step 1: Confirm no live `goon` identifier survives**

Run: `grep -rn "goon\|Goon\|GOON" src bin tests scripts docs package.json npm-shrinkwrap.json .gitignore README.md NOTICE.md`
Expected: only `GOON_*` environment-variable names (the documented fallback), the legacy `goon` directory names in `src/config.ts` and `src/migrate.ts`, and `MIGRATION_MARKER`.

- [ ] **Step 2: Run the whole verification chain**

Run: `npm run typecheck && npm run lint && npm test`
Expected: `typecheck` and `lint` clean; `test` green apart from the 5 Windows-only failures listed in Task 5 Step 6.

- [ ] **Step 3: Smoke-test the installed binary**

Run: `npm run build && node bin/vyen.mjs --version && node bin/vyen.mjs --help`
Expected: `vyen cli <version>` and a help text that mentions `VYEN_API_KEY` and `~/.config/vyen/`.

- [ ] **Step 4: Confirm the tree is clean**

Run: `git status --porcelain && git log --oneline`
Expected: an empty status and one commit per task.

---

## Not in this plan

- **A CI workflow.** `.github/` was deleted, so the release pipeline
  (`scripts/publish-release.mjs`) has no workflow to invoke it and the repo has
  no CI. Both need to be recreated for the new repository once its name is
  known — the old workflow hard-coded `binxgtl/goon-cli`.
- **The eight audit findings.** They live in plan 2,
  `docs/superpowers/plans/2026-10-21-vyen-critical-fixes.md`.
