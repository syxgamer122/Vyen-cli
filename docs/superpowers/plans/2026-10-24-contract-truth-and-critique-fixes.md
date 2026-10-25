# Contract truth and critique fixes - 2026-10-24

Spec: `docs/ROADMAP.md` Phase 0; `docs/CRITIQUE_VERIFICATION.md`;
`docs/SPEC.md`; `README.md`.

## Goal

Make the documents match the code and close the two verified defects that can be
fixed without changing the product's security model: the Windows release-packer
spawn bug and the `python -m pytest -p` prefix-approval bypass. Add focused
tests for modules that currently have none, then re-measure the suite.

## Review Focus

1. A prefix approval for `python -m pytest` cannot be widened by `-p` or
   `--plugins`; the old code approved both and the new code rejects both.
2. A Windows checkout can run the release packer and the publish test without
   `spawn npm ENOENT`; the `gh` stub is executable on Windows too.
3. `docs/SPEC.md` states three retries, an unlimited default run budget and
   supported MCP resources, and no longer contains the stale claims.
4. `safeError` removes the configured API key from an error message and caps
   the result at 2,000 characters.
5. Prompt templates substitute `$ARGUMENTS`, `$1`..`$9` and `$$`; a template
   without placeholders appends the user's arguments.

## Scenarios & Tests

**What the user sees:** after this change, a Windows maintainer can run the
publish test, a pytest plugin cannot ride on an approved prefix, and the docs
describe the retry, budget and MCP behaviour the code actually has.

| # | Criterion | Test |
|---|---|---|
| 1 | Prefix approval cannot be widened by `-p` | tests/audit.test.mjs › bash prefix approvals only cover simple commands |
| 2 | Release packer works on Windows | tests/publish.test.mjs › publishing creates the first tag, bumps on update and repairs a rerun without another bump |
| 3 | SPEC matches retries, budget and MCP resources | tests/docs-contract.test.mjs › SPEC matches the implemented retry, budget and MCP-resource contract, and README states the real release and gateway facts |
| 4 | safeError redacts and truncates | tests/errors.test.mjs › safeError redacts the configured key and truncates the message |
| 5 | Prompt templates expand and append | tests/prompts.test.mjs › prompt templates expand arguments and append them when there is no placeholder |
| 6 | Help text stays complete | tests/help.test.mjs › help lists the documented flags and subcommands |
| 7 | Effort input parser is stable | tests/setup.test.mjs › parseEffortInput accepts names and numbers and rejects unknown values |

## Tasks

### T1 - Add the red approval test

Edit `tests/audit.test.mjs`, in the existing prefix test, to assert:

- `python -m pytest -q tests` is approved;
- `python -m pytest -p evil_plugin tests` is not approved;
- `python -m pytest --plugins evil_plugin tests` is not approved.

Run `npm run build && node --test tests/audit.test.mjs`. Expect the new
assertions to fail because `RISKY_OPTION_RE` does not cover `-p`/`--plugins`.

### T2 - Fix the prefix rules

Add `p|plugins?` to the risky-option alternatives in `src/approval.ts` and a
comment naming the pytest plugin case. Re-run T1; expect green. Run the rest of
the approval assertions to ensure `npm test`, `python -m pytest -q` and
`git status` still work.

### T3 - Fix the Windows release packer

In `scripts/pack-release.mjs`, route `npm` through the Windows command shell
(`cmd.exe /d /s /c`) or an equivalent robust shim when `process.platform` is
`win32`; keep `execFile` on POSIX. In `tests/publish.test.mjs`, keep the
extensionless `gh` on POSIX and add a `gh.cmd` shim on Windows that invokes the
same Node script. Run `npm run build && node --test tests/publish.test.mjs`.
Expect the old code to fail at `spawn npm ENOENT`; expect the fixed code to
reach and pass the `gh` assertions.

### T4 - Add focused module tests

Create `tests/errors.test.mjs`, `tests/prompts.test.mjs`, `tests/help.test.mjs`,
`tests/setup.test.mjs` with the scenarios listed above. Import from `dist/` and
build before running. For each test, break the promised behaviour once, confirm
red, restore, and confirm green.

### T5 - Add the docs contract test

Create `tests/docs-contract.test.mjs` that reads `docs/SPEC.md` and `README.md`
and asserts the corrected claims: three retries, default run budget `0`, MCP
resources supported, and no text that says resources are unsupported. The
expectation comes from `src/harness.ts`, `src/config.ts` and `src/mcp.ts`, not
from the prose being tested.

### T6 - Correct the documents

- `docs/SPEC.md`: retries 2 -> 3; default budget 100,000 -> 0/unlimited; MCP
  resources supported; keep prompts/sampling/OAuth/SSE unsupported.
- `README.md`: add `src/errors.ts` and the missing modules to the table; correct
  the release section; add a link to `docs/ROADMAP.md`.
- `AGENTS.md`: replace `18 files` with `25 files`; add the missing modules to
  the Quick map; correct the publish-failure note; add the config/slash-command
  checklist; keep the character budget under 24,000 with 1,000 to spare.
- `docs/VALIDATION.md`: append the new dated run and the corrected failure cause.
- `docs/ROADMAP.md`: the Phase 0 rows above are already added; update counts
  after the new suite run.

### T7 - Re-measure and update the known-failure list

Run `npm run typecheck`, `npm run lint`, `npm test`. Record the exact counts in
`docs/VALIDATION.md`. If the publish test is green, remove it from the
known-failure list in `AGENTS.md` and update `docs/ROADMAP.md` from six to the
remaining count. Do not claim a green run if only a subset was run.

## Out of scope

- Changing `DEFAULT_GATEWAY_URL`: this is a product/security decision (R0.9 and
  roadmap open decision 7), not a mechanical doc fix.
- Pair rate limiting/TTL (R2.6) and the Termux sandbox fallback (R3.1): these
  need design work and a device to verify.
- A full `cli.ts`/`tui.ts` split.
