# Critique verification - 2026-10-24

Scope: the critique supplied against `Vyen-cli-main.zip` and the live
workspace. Each claim was checked against the live workspace first, then
against the zip where the two differ. Commands and file references are the
evidence; a claim is not accepted because it sounds plausible.

The verdicts below describe the **pre-fix baseline**. The status after the
Phase 0 changes is recorded at the end of this file.

## Verdicts

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `src/errors.ts` is empty (0 bytes), a "phantom security module" | **FALSE** | Live workspace: 242 bytes, `safeError()` redacts an exact API key and caps the message at 2,000 chars. Imported by `cli.ts`, `harness.ts`, `network.ts` and `subagents.ts` (30 call sites). The zip entry is also 242 bytes, not 0. |
| 2 | `AGENTS.md` says 18 source files; the Quick map lists 15; 10 modules are missing | **TRUE** | 25 `src/*.ts` files. Quick map omits `approval.ts`, `network.ts`, `workflow.ts`, `pair.ts`, `setup.ts`, `prompts.ts`, `help.ts`, `update.ts`, `version.ts`, `index.ts`. |
| 3 | Permission logic is in `src/approval.ts`, not `src/tools.ts` | **PARTIAL** | Permission modes and `applyPermissionMode` live in `tools.ts`; session prefix approval and its bypass rules live in `approval.ts`. The Quick map should name both. |
| 4 | The publish test failed because `scripts/publish-release.mjs` spawned `npm` without a Windows shell; this was a fixable code bug, not an OS limitation | **TRUE (fixed)** | `scripts/pack-release.mjs` called `execFile('npm', ['run','build'])`; on Windows `npm` is `npm.cmd` and `execFile` without a shell raised `ENOENT`. `publish-release.mjs` calls `packRelease`. The test also wrote an extensionless `gh` stub, and npm 12 changed `npm pack --json` to an object; both are fixed and covered by the publish test. |
| 5 | The stale legacy CLI tarball under `release/` still exists | **TRUE for the zip, FALSE for the live workspace** | The zip contains a `release/` tarball from the old brand (56,500 bytes). The live workspace has no `release/` directory and no `.tgz`; `docs/VALIDATION.md` records the deletion. |
| 6 | The stale archive bypasses hygiene/brand guards | **TRUE for the zip** | `tests/brand.test.mjs` scans `ts|mjs|md|json|yml|py`, not `.tgz`; a `.tgz` in `release/` is invisible to it. The live workspace no longer has the archive. |
| 7 | Termux cannot use bubblewrap, so "auto refuses when sandbox is unavailable" would disable auto on Termux | **TRUE as a design risk** | Android without root commonly blocks unprivileged user namespaces and mount syscalls. No Termux device was available to measure this, so it is a risk, not a measured failure. The roadmap needs a proot/allowlist fallback or an explicit `--unsafe` decision. |
| 8 | The roadmap omits `/pair` security | **TRUE** | `pair.ts` has a 128-bit token, constant-time comparison and localhost binding, but no failed-auth rate limit, session TTL, Origin/Host validation or pair-specific audit. The roadmap had no pair item. |
| 9 | `web_fetch` needs post-DNS and per-redirect private-address checks, not only URL-string checks | **TRUE as a requirement gap** | The roadmap said "block loopback/private addresses" without specifying DNS resolution, socket pinning or re-validation on redirects. A DNS-rebinding/redirect SSRF bypass would satisfy the words while defeating the intent. |
| 10 | Project trust hashed only the config, so a changed hook script is trusted silently | **TRUE as a requirement gap** | The roadmap's trust proposal hashed `.vyen/settings.json`/`.vyen/mcp.json`. A referenced `scripts/hook.sh` can change without changing the config hash. |
| 11 | Worktrees conflict with checkpoints and lack `node_modules` | **TRUE as an integration risk** | `subagents.ts` merges child checkpoints into the parent; `session.ts` stores file paths, not workspace identity. A new worktree has no ignored `node_modules`. The roadmap did not state how merge, cleanup and `/revert` interact. |
| 12 | The `<100 ms` Termux startup budget is unrealistic | **UNVERIFIED, likely too aggressive** | No Termux measurement exists. Node process startup alone can exceed 100 ms on low-end Android. The budget should be baseline-relative or measured, not asserted. |
| 13 | An unset `baseUrl` sends the user's key and source to `api.yuristore.xyz` | **TRUE** | `DEFAULT_GATEWAY_URL = 'https://api.yuristore.xyz/v1'` (`config.ts`); `resolveRuntime` uses it when `config.baseUrl` is absent. A user who sets only `VYEN_API_KEY` and no base URL sends traffic there. `README.md` documents it and now carries an explicit security warning; the CLI prints a one-time warning naming the destination before the first model request, the setup wizard warns before its `/models` probe on a first setup, and an explicit `baseUrl` suppresses the runtime warning (R0.9 resolved). |
| 14 | A `python -m pytest` prefix approval can be bypassed with `-p`/`--plugins` | **TRUE** | `bashApprovalPrefix` returns `python -m pytest`; `isApprovedBashPrefix` accepts `python -m pytest -p evil_plugin` and `--plugins evil_plugin` because `RISKY_OPTION_RE` does not cover them. Confirmed by running `dist/approval.js`. |
| 15 | `/rewind`/`/revert` do not restore or warn about files changed by `bash` | **TRUE** | `README.md:217` says only direct edit tools are backed up; no workspace scan is done for shell commands. No warning was found for a turn that ran `bash` and changed files. |
| 16 | `AGENTS.md` has a checklist for a new tool but not for a slash command, config flag or event | **TRUE** | Section 3 only covers tools. `cli.ts`, `help.ts`, `config.ts` and the `HarnessEvent` union have no equivalent checklist, which is one source of SPEC drift. |
| 17 | The "no `as any` / no lint disable" rule could be enforced instead of self-declared | **PARTIAL** | There is no `as any` in `src/`, `tests/`, `scripts/` or `bin/`. There are two necessary `oxlint-disable-next-line no-control-regex` comments in `tui.ts:201,277`; a naive regex would fail them. A guard would need a reason/allowlist, not a blanket ban. |

## What the critique gets right

The structural findings are sound: the docs under-describe the source, the
publish test hides a fixable portability bug, the default gateway is a silent
third-party egress, prefix approval has a real interpreter bypass, pair and
checkpoint surfaces are under-specified, and the roadmap needs explicit
post-DNS SSRF, trust-hash scope, worktree integration, Termux fallback and
measured performance budgets.

## What the critique gets wrong or stale

- `src/errors.ts` is not empty. It is a real, used redaction helper. The real
  documentation gap is that `README.md`'s module table omits it, not that the
  module is phantom.
- The stale legacy tarball under `release/` exists in the zip, not in the live
  workspace. The zip is a stale artifact; the workspace already removed it.
- The permission split is not "tools vs approval"; both files have distinct
  responsibilities.

## Actions taken from this verification

Immediate (Phase 0):

1. Fix the Windows `npm` spawn in `scripts/pack-release.mjs` and the
   extensionless `gh` stub in `tests/publish.test.mjs`; prove the publish test
   green on Windows.
2. Close the `-p`/`--plugins` prefix-approval bypass in `src/approval.ts` with
   a red test first.
3. Correct `docs/SPEC.md`, `README.md`, `AGENTS.md` and `docs/VALIDATION.md`.
4. Add tests for `src/errors.ts`, `src/prompts.ts`, `src/help.ts` and
   `setup.ts:parseEffortInput`.

Deferred to the roadmap with explicit acceptance criteria:

- Pair rate limiting, TTL and Origin/Host validation.
- Post-DNS and per-redirect SSRF checks for `web_fetch`.
- Trust hashing of referenced hook scripts.
- Worktree/checkpoint/`node_modules` integration.
- Termux sandbox fallback and a measured startup budget.

## Status after the Phase 0 changes

1. **Publish portability fixed.** `scripts/pack-release.mjs` uses `cmd.exe` on
   Windows, accepts both the npm 11 array and npm 12 object shapes from
   `npm pack --json`, removes an inherited `npm_config_allow_scripts` before a
   project-scoped install while preserving registry/auth config, and passes
   `%`-containing paths through the environment. `tests/publish.test.mjs` writes
   a `gh.cmd` shim on Windows and runs a literal `%TEMP%` probe. The test passes
   on this Windows host, including when `npm_config_allow_scripts` is exported.
2. **Explicit flag-level prefix bypasses closed; project config remains a trust boundary.**
   `tests/audit.test.mjs` proves that `--test-reporter=./evil.js`, `--test-reporter ./evil.js`
   and `--test-reporter-destination=./out.txt` are refused while `npm test -- --watch=false`
   remains approved. It also proves that `python -m pytest -p evil_plugin`, `--plugins evil_plugin`,
   attached forms such as `-pevil_plugin`, clusters such as `-qp`/`-qpevil_plugin`,
   `--override-ini`, `--config-file` and `@file` expansion are refused, while
   `-q`, `-k smoke`, `-W error` and pytest's `-ra` report flag remain approved
   for the `python`, `python3`, `py` and direct `pytest` prefixes. `ls -laR`
   stays approved but `node -r` is rejected, so the `r` exception is
   command-aware. The reporter assertions were red before the regex change. Automatic
   discovery of `pytest.ini`/`pyproject.toml` is part of approving pytest itself
   and remains inside that project-config trust boundary; `--config-file` is not accepted as a
   way to widen an already-approved prefix.
3. **Documents corrected.** `docs/SPEC.md` says three retries, a default budget
   of `0` (unlimited), and supports MCP resources. `README.md` lists the missing
   modules, describes the actual release workflow, links the roadmap, and warns
   that the default `baseUrl` is a third-party gateway. `AGENTS.md` lists all 25
   modules and has the slash-command/config/event seams; `docs/VALIDATION.md`
   records the run below.
4. **Focused tests added.** `tests/errors.test.mjs`, `tests/prompts.test.mjs`,
   `tests/help.test.mjs`, `tests/setup.test.mjs` and
   `tests/docs-contract.test.mjs` cover the modules that had no direct test.

The default-gateway **runtime** policy is resolved (roadmap R0.9): README and
SPEC disclose the destination, and the CLI prints a one-time warning naming it
before the first model request. The setup wizard warns before its `/models`
probe on a first setup; an explicit `baseUrl` suppresses the runtime warning,
`doctor --json` exposes `effectiveBaseUrl` and `defaultGateway` for headless
auditing, and `DEFAULT_GATEWAY_URL` is unchanged. The pair, SSRF, trust-hash, worktree and
Termux items remain roadmap work with acceptance criteria, not claims of
completion.
