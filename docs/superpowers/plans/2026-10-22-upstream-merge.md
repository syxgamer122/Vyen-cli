# Upstream merge — vyen fork onto goon-cli 0.3.0+

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fork's source with upstream `binxgtl/goon-cli` (0.3.0 + 2 commits, +4452/−3016 lines, 9 security + 15 correctness + 5 performance fixes) and re-apply on top of it the vyen identity, the goon→vyen data migration, and the eight fixes upstream still lacks.

**Architecture:** The fork is upstream 0.2.23 plus a brand rename plus eight fixes. Upstream rewrote the same files, so a textual merge would conflict in 22 files. Instead the new tree is **upstream's tree, renamed** — a scripted, verifiable string transformation — and the fork's own work is re-applied on top as small, test-first patches. The rename is a case-only substitution (`goon`→`vyen`, `Goon`→`Vyen`, `GOON`→`VYEN`) with two exceptions: the npm package name and the GitHub repository URL.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node ≥ 22.16, AI SDK 6, `@modelcontextprotocol/sdk` 1.32.1, `node:test`.

**Spec:** `docs/AUDIT.md` (upstream's own audit — the source of the fixes this merge brings) and `docs/SPEC.md` (the contract). `AGENTS.md` holds the working agreements; §2.5 Law 1 requires the traceability table below.

## Global Constraints

- The npm package stays `@nguyenhuumanh/vyen`; the installed command stays `vyen`. npm's name policy rejects every unscoped `vyen*` name, so the scope is not optional.
- No `goon` identifier may survive in shipped source, except the legacy `GOON_*` environment names, the legacy `~/.config/goon` and `~/.local/share/goon` directories, the migration marker, and the historical plan documents.
- Upstream's `docs/AUDIT.md` findings S1–S9 and B1–B15 are the acceptance list. A finding is closed only when a test goes red without the fix.
- The three fixes upstream still lacks must survive the merge: `read_mcp_resource` requires approval, `wait_agent` reports a real `timed_out`, and a workspace change drops the turn checkpoints.
- `src/migrate.ts` and its wiring survive: a goon installation's config, credentials and sessions move to the vyen directories on first run.
- Every task ends with `npm run typecheck` (exit 0), `npm run lint` (no new errors) and `npm test` green except the five known platform failures listed in `AGENTS.md` §1.
- Source files carry no BOM (`AGENTS.md` §8). Bulk edits go through a Node script, never PowerShell `Set-Content`.
- Commit messages are English, `type(scope): description` (`AGENTS.md` §5).
- Upstream's `.github/workflows/release.yml` is replaced by the fork's trusted-publishing (OIDC) workflow for `@nguyenhuumanh/vyen`.

## Review Focus

1. **The published package is `@nguyenhuumanh/vyen` and the command it installs is `vyen`.** After the merge, `npm run release:pack` must produce `nguyenhuumanh-vyen-<version>.tgz`, install it into an isolated prefix, and the installed binary must answer `vyen cli <version>`.
2. **No `goon` identifier survives the rename in shipped source.** A guard test scans `src/`, `tests/`, `scripts/`, `bin/`, `docs/`, `package.json` and `npm-shrinkwrap.json` and fails on any live occurrence outside the permitted legacy names.
3. **Upstream's security findings are closed in the fork.** S1 (a stale captured mode auto-approves writes), S2 (Shift+Tab answers "always" on a pending approval), S3 (the API key reaches the `bash` child environment), S4 (`view_image` reads outside the workspace), S5 (a tool hidden from the model still executes) and S9 (npm audit advisories in the AI SDK, ajv and zod).
4. **Upstream's correctness findings are closed.** B1 (`edit_file` interprets `$&` and `$$` in the new text), B2 (images stored as a Buffer blow up the token estimate and break resume), B7 (`apply_patch` ignores `*** Move to:`, lets a second `Update` block overwrite the first and drops the trailing newline), B8 (`/revert` overwrites the user's later edits), B9 (slash commands typed while busy report "Queued" but are dropped).
5. **The fixes upstream still lacks stay in the fork.** Upstream's tree still has six of them: `read_mcp_resource` is registered read-only, so an MCP server can return any content it holds without a prompt; `wait_agent` derives `timed_out` from whether *any* target finished, so a parent can read "not timed out" while a child still runs; a `/cd` to another project keeps the turn checkpoints, so `/revert` can restore the first project's files; leaving plan mode restores the label but not the registry's enforcement; the MCP phase and the model run share one abort controller, so a harness rebuild during a run detaches the run's cancellation; and a subagent spawned while its parent is being cancelled outlives the parent. The other two fixes of the fork — the redaction of resolved credential placeholders, and resuming a session from another project — upstream implemented in its own shape and they are **not** re-applied: a second mechanism for the same job is a patch.
6. **A goon installation's data migrates into the vyen directories on first run**, and the migration is resumable, never overwrites an existing file, and never throws.

## Scenarios & Tests

**What the user sees:** after the merge, `npm install -g @nguyenhuamanh/vyen` still gives a working `vyen`; the same permissions, secret handling and bug fixes upstream shipped are present; and an existing goon user's `~/.config/goon` and `~/.local/share/goon` are copied into the vyen locations on first launch, with a line naming what moved.

| # | Criterion | Test |
|---|---|---|
| 1 | published package and installed command | `tests/release.test.mjs` |
| 2 | no goon identifier survives the rename | `tests/brand.test.mjs` |
| 3 | upstream security findings closed | `tests/audit.test.mjs` |
| 4 | upstream correctness findings closed | `tests/audit.test.mjs` |
| 5 | the three fixes upstream lacks survive | `tests/mcp.test.mjs` |
| 6 | goon data migrates into the vyen directories | `tests/migrate.test.mjs` |

---

### Task 1: Take upstream's tree and re-apply the vyen identity

**Files:**
- Modify: every file upstream changed since 0.2.23
- Keep (not overwritten): `src/migrate.ts`, `tests/migrate.test.mjs`, `tests/plan-traceability.test.mjs`, `tests/repo-hygiene.test.mjs`, `AGENTS.md`, `docs/superpowers/plans/*.md`, `.github/workflows/release.yml`
- Create: `tests/brand.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a tree whose `src/` matches upstream `a202d46` except for the vyen rename; the package named `@nguyenhuumanh/vyen` with the binary `vyen` → `bin/vyen.mjs`.

- [ ] **Step 1: Create the branch**

Run: `git checkout -b feat/upstream-merge`
Expected: switched to `feat/upstream-merge`.

- [ ] **Step 2: Record what the fork must keep**

Run: `git ls-files src/migrate.ts tests/migrate.test.mjs tests/plan-traceability.test.mjs tests/repo-hygiene.test.mjs AGENTS.md .github/workflows/release.yml docs/superpowers/plans/`
Expected: the list Step 3 must not overwrite.

- [ ] **Step 3: Take upstream's version of the files it owns**

Run: `git checkout upstream/main -- src tests bin scripts docs README.md CHANGELOG.md package.json npm-shrinkwrap.json`

`src/migrate.ts` and the three test files are not in upstream's tree, so they stay.

- [ ] **Step 4: Restore the fork's own workflow**

Run: `git checkout HEAD -- .github/workflows/release.yml`

- [ ] **Step 5: Write the brand guard test**

Create `tests/brand.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = new Set(['node_modules', '.git', '.next', 'dist', 'release-out', 'superpowers']);

// The legacy names that must survive: the GOON_* environment variables, the
// legacy directories, the migration marker and the historical package name.
const allowed = [/GOON_[A-Z_]+/, /['"`]goon['"`]/, /\.migrated-from-goon/];

function scan(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { scan(full, out); continue; }
    if (!/\.(ts|mjs|md|json|yml|py)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

test('no live goon identifier survives the rename in shipped source', () => {
  const offenders = [];
  for (const file of [
    ...scan(join(ROOT, 'src')), ...scan(join(ROOT, 'tests')), ...scan(join(ROOT, 'scripts')),
    ...scan(join(ROOT, 'bin')), ...scan(join(ROOT, 'docs')),
    join(ROOT, 'package.json'), join(ROOT, 'npm-shrinkwrap.json'),
  ]) {
    const text = readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (!/goon/i.test(line)) return;
      if (allowed.some(pattern => pattern.test(line))) return;
      offenders.push(`${relative(ROOT, file)}:${index + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], 'live goon identifiers remain');
});

test('the package is the scoped name npm allows and the command is vyen', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@nguyenhuumanh/vyen');
  assert.equal(manifest.bin.vyen, 'bin/vyen.mjs');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run build && node --test tests/brand.test.mjs`
Expected: FAIL — the upstream tree still says `goon` everywhere.

- [ ] **Step 7: Apply the rename**

Write a Node script that, for every file the guard scans, replaces `goon-cli` → `vyen` first, then `Goon` → `Vyen`, `GOON` → `VYEN`, `goon` → `vyen`, and finally fixes the two special cases: the package name becomes `@nguyenhuumanh/vyen` and `binxgtl/goon-cli` becomes `syxgamer122/Vyen-cli`. Rename `bin/goon.mjs` to `bin/vyen.mjs`.

- [ ] **Step 8: Verify the rename landed**

Run: `node --test tests/brand.test.mjs`
Expected: PASS.

- [ ] **Step 9: Verify the build and the suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green except the five known platform failures. The fork's own tests that referenced the old API come back in Task 2.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: take the upstream goon-cli tree and re-apply the vyen identity"
```

---

### Task 2: Re-apply the eight fixes upstream still lacks

**Files:**
- Modify: `src/tools.ts`, `src/cli.ts`, `src/mcp.ts`, `src/session.ts`, `src/subagents.ts`
- Test: `tests/runtime.test.mjs`, `tests/mcp.test.mjs`, `tests/session.test.mjs`, `tests/subagents.test.mjs`, `tests/files.test.mjs`

**Interfaces:**
- Consumes: the renamed upstream tree.
- Produces: `applyPermissionMode(registry, mode)` in `src/tools.ts`; `retargetSessionWorkspace(store, nextCwd)` in `src/session.ts`; `read_mcp_resource` registered `readOnly: false`; `wait_agent` computing `timed_out` from every target.

- [ ] **Step 1: Re-apply each fix test-first, one fix at a time**

For each fix, write the test from `docs/superpowers/plans/2026-10-21-vyen-critical-fixes.md` (it holds the exact test bodies and the exact fix for each), run it to see it fail, apply the fix, run it to see it pass. Upstream's tree still lacks six of the eight: the workspace-change checkpoint guard, the permission-mode helper and the plan-exit restore, `read_mcp_resource` approval, the separate abort scope, the subagent abort race, and the `wait_agent` timeout flag. The redaction of resolved credential placeholders and the resume workspace selection are **not** re-applied — upstream implemented both in its own shape.

- [ ] **Step 2: Verify with a mutation check**

Break each of the eight fixes in turn, rebuild, and confirm the matching test fails. Every mutation must be caught.

- [ ] **Step 3: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green except the five known platform failures.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: re-apply the eight fixes upstream still lacks"
```

---

### Task 3: Re-apply the fork's own additions

**Files:**
- Modify: `src/config.ts`, `src/cli.ts`, `src/index.ts`, `scripts/pack-release.mjs`, `scripts/publish-release.mjs`
- Test: `tests/migrate.test.mjs`, `tests/release.test.mjs`

**Interfaces:**
- Consumes: the renamed tree with the eight fixes.
- Produces: `migrateLegacyData(options)` in `src/migrate.ts`, exported from `src/index.ts` and called from the CLI entry point; a `release:pack` that packs the scoped name and smoke-tests the installed binary.

- [ ] **Step 1: Re-apply the migration wiring**

`src/config.ts` must expose `legacyConfigDir()` and `legacyDataDir()` next to `configDir()` and `dataDir()`. `src/cli.ts` must call `migrateLegacyData` once at startup, before `loadConfig`, and report the result on stderr: one line naming what moved on success, one line naming the failure and the manual fix on error.

- [ ] **Step 2: Re-apply the release scripts for the scoped name**

`scripts/pack-release.mjs` must expect `nguyenhuumanh-vyen-<version>.tgz` and install to `node_modules/@nguyenhuumanh/vyen/bin/vyen.mjs`. `scripts/publish-release.mjs` must name the scoped package in the release notes.

- [ ] **Step 3: Verify the release flow end to end**

Run: `npm run release:pack`
Expected: the tarball, the stable `vyen.tgz` alias, the checksum file, and the isolated install answering `vyen cli <version>`.

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green except the five known platform failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: re-apply the goon data migration and the scoped release flow"
```

---

### Task 4: Final review and push

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: a reviewed, pushed branch.

- [ ] **Step 1: Run the whole verification chain**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green except the five known platform failures.

- [ ] **Step 2: Run the independent review**

Dispatch the `requesting-code-review` skill over the whole branch range, with the plan's Review Focus section and the ledger's rulings. Fix every Critical and Important finding in one pass, each with a test that goes red without the fix.

- [ ] **Step 3: Push**

Run: `git push -u origin feat/upstream-merge`
Expected: the branch is on the remote.

## Not in this plan

- Merging the fork's `main` into the new branch — that is the human's call after the review.
- Publishing a new version to npm — `0.2.23` is already on the registry and immutable; the next release is `0.3.1` or higher.
- The upstream `goon-cli` name on the registry — upstream keeps it.
