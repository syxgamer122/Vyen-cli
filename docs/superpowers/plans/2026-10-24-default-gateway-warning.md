# Default gateway warning - 2026-10-24

Spec: `docs/ROADMAP.md` R0.9; `docs/SPEC.md`; `README.md`.

## Goal

Keep `DEFAULT_GATEWAY_URL` unchanged and make its use explicit: when `baseUrl`
is absent, print a one-time warning naming the third-party destination before
the first request. An explicit `baseUrl` stays silent. Record the decision in
the contract documents.

## Review Focus

1. With no `baseUrl`, the CLI prints the default gateway URL once before the
   first model request.
2. With an explicit `baseUrl`, the CLI prints no default-gateway warning.
3. The setup wizard warns before probing the default gateway on a first setup,
   and stays silent when another preset is selected.
4. Interactive runs route the warning to the visible display; noninteractive
   runs route it to stderr.
5. `vyen doctor --json` reports the effective destination and whether it is the
   default, while keeping the existing `baseUrl` field compatible.
6. `docs/SPEC.md`, `README.md`, `docs/CRITIQUE_VERIFICATION.md` and
   `docs/VALIDATION.md` state the warning behaviour, and `R0.9` is marked
   resolved with `DEFAULT_GATEWAY_URL` unchanged.

## Scenarios & Tests

**What the user sees:** a first run without `baseUrl` prints one warning naming
`https://api.yuristore.xyz/v1` before any prompt or API key leaves the machine;
setting `--base-url` or config `baseUrl` prints no such warning.

| # | Criterion | Test |
|---|---|---|
| 1 | With no baseUrl, the CLI warns before the first request | tests/runtime.test.mjs › the default gateway warns once before the first request and an explicit gateway stays silent |
| 2 | With an explicit baseUrl, the CLI is silent | tests/runtime.test.mjs › the default gateway warns once before the first request and an explicit gateway stays silent |
| 3 | The setup wizard warns before probing the default gateway | tests/setup.test.mjs › setup warns before probing the default gateway and stays silent for another preset |
| 4 | Interactive runs route the warning to the display | tests/runtime.test.mjs › gateway warning routes interactive runs to the display and noninteractive runs to stderr |
| 5 | Doctor JSON exposes the default destination | tests/runtime.test.mjs › the default gateway warns once before the first request and an explicit gateway stays silent |
| 6 | Doctor JSON marks an explicit destination | tests/runtime.test.mjs › init saves only configuration, doctor probes /models without calling completions |
| 7 | SPEC, README and R0.9 state the warning | tests/docs-contract.test.mjs › SPEC matches the implemented retry, budget and MCP-resource contract, and README states the real release and gateway facts |

## Tasks

### T1 - Add the failing warning test

Add `tests/fixtures/default-gateway-fetch.cjs` to answer model discovery and
chat requests without network access, and extend `tests/helpers.mjs` so a child
can omit `--base-url` and take Node preload arguments. Add the test named in
row 1 to `tests/runtime.test.mjs`; it checks the warning text, the absence of a
warning with an explicit `baseUrl`, the warning appearing once, and the warning
preceding the preload's request marker. Add the doctor path to the same test.
Also add the routing test named in row 4, covering interactive display and
noninteractive stderr sinks.

Run `npm run build && node --test tests/runtime.test.mjs`. Expect RED because no
default-gateway warning exists yet.

### T2 - Implement the warning

Add `defaultGatewayWarning(config)` to `src/config.ts` so the setup wizard can
share it without a cycle. Add `emitDefaultGatewayWarning` in `src/cli.ts`; in
`main`, emit it once before the normal runtime's first request, routing
interactive runs through the existing display and noninteractive runs to stderr.
Emit it in the `doctor` branch before `discoverModels`, and in `runSetupWizard`
before the first `/models` probe when a first setup accepts the default gateway.
Keep `doctor --json`'s existing `baseUrl` field and add `effectiveBaseUrl` and
`defaultGateway` so a headless consumer can audit the destination.
Do not change `DEFAULT_GATEWAY_URL`.

Add the setup test named in row 3 to `tests/setup.test.mjs` before the wizard
change; expect RED, then implement and re-run. Re-run T1; expect GREEN.

### T3 - Update the contract documents and their guard

Update `docs/SPEC.md`, `README.md`, `docs/ROADMAP.md` (R0.9 status and the open
decision), `docs/CRITIQUE_VERIFICATION.md` and `docs/VALIDATION.md`. Extend
`tests/docs-contract.test.mjs` to assert the warning text, the resolved R0.9
status and the unchanged constant. Run
`npm run build && node --test tests/docs-contract.test.mjs`; expect RED before
the documentation edits and GREEN after them.

### T4 - Re-measure the gates

Run `npm run typecheck`, `npm run lint` and `npm test`. Record the exact counts
and the known Windows failures in `docs/VALIDATION.md`; update the counts in
`docs/ROADMAP.md` and the docs-contract expectation only if the real run differs.

## Out of scope

- Changing `DEFAULT_GATEWAY_URL` or requiring an explicit `baseUrl`: both remain
  product decisions, not mechanical fixes.
- Persisting an acknowledgement across runs: this warning is once per run.
- Pair, SSRF, trust-hash, worktree and Termux roadmap items.
