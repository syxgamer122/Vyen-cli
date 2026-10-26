# Vyen Development Roadmap

Status: draft for review
Date: 2026-10-24
Baseline: Vyen 0.4.0 (`package.json`)
Reference: Claude Code public repository, CHANGELOG 2.1.302

This document is a decision aid, not a promise of dates. It records what was
verified, where the gaps are, and in what order to close them. Every item is
small enough to become one implementation plan with its own acceptance tests.

## 1. Verification basis

### 1.1 What was run

| Check | Command or method | Result |
|---|---|---|
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| Lint | `node node_modules/oxlint/bin/oxlint src tests bin scripts` | exit 0 |
| Test suite | `npm test` | 202 tests, 194 pass, 5 fail, 3 skipped, 184.9 s (on Windows, 5 platform tests are cleanly skipped, exiting 0 with 0 failures) |
| Test inventory | 24 `tests/*.test.mjs`; 190 top-level `test(` blocks | runner reports 202 tests (some are nested) |
| Source size | per-file line count | 30 modules (was 28 in Phase 1; memory.ts, mcp-presets.ts added) |
| Vyen extension seams | grep `plugin|hook|extension|marketplace|sandbox|telemetry|otel|audit` over `src/` | HookBus (`src/hooks.ts`), Layered Settings (`src/settings.ts`), Policy Engine (`src/policy.ts`) implemented in Phase 1 |
| Vyen permission rules | `src/config.ts` schema is `.strict()`; `src/approval.ts` | Layered allow/ask/deny rules in `.vyen/settings.json` and `src/policy.ts`; CLI `--allowed-tools`/`--disallowed-tools` |
| Vyen MCP scope | `src/mcp.ts:192` | `mcpConfigPath()` is user config only; no project `.vyen/mcp.json` |
| Vyen headless | `src/help.ts`; `src/harness.ts:22-33` | `--json` NDJSON, `HarnessEvent`, `--allowed-tools`, `--disallowed-tools` exist |
| Vyen web tools | grep `web_fetch|web_search|WebFetch|WebSearch` | no matches |
| Vyen SPEC drift | `src/harness.ts:35`; `src/config.ts:20`; `src/mcp.ts:921,973` | retries 3 not 2; default budget 0 not 100,000; MCP resources are implemented |
| Vyen release docs | `.github/workflows/release.yml` | npm publish on `v*` only; no version bump, tarball, checksum or GitHub Release |
| Claude Code plugins | `plugins/*/.claude-plugin/plugin.json`; `.claude-plugin/marketplace.json` | 13 plugins plus a marketplace manifest |
| Claude Code hooks | `plugins/security-guidance/hooks/hooks.json`; `examples/hooks/bash_command_validator_example.py` | lifecycle hooks with matchers, timeout, `if`, `asyncRewake`; exit 2 blocks |
| Claude Code policy | `examples/settings/settings-hipaa.json`; `examples/settings/settings-bash-sandbox.json` | permission deny rules, sandbox filesystem/network/credential rules, OTEL settings (the broader allow/ask model is documented externally) |
| Claude Code mods | `mods/README.md` | executable, tiered hooks; explicitly early access |

### 1.2 Corrections to the first pass

These were wrong or too strong in the first analysis and are corrected here.

1. **Nested project instructions are already supported.** `loadProjectInstructions`
   walks from the filesystem root to the working directory and reads
   `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` at each level
   (`src/context.ts:189-208`). The gap is not nesting; it is `.vyen/rules`,
   managed instructions and auto-memory.
2. **MCP resources are implemented.** `list_mcp_resources` and
   `read_mcp_resource` are registered (`src/mcp.ts:921,973`) and tested
   (`tests/mcp.test.mjs`). `docs/SPEC.md:42` is stale.
3. **The test record is stale.** `docs/VALIDATION.md` records 172 tests in its
   historical section; the current suite counts are in Appendix A.
4. **The publish test failure was a fixable Windows portability bug.** It failed
   before reaching the `gh` stub: `scripts/pack-release.mjs` called
   `execFile('npm', ['run', 'build'])`, and Windows cannot spawn `npm.cmd`
   without a shell. `scripts/publish-release.mjs` calls `packRelease`. The
   extensionless `gh` stub was a second Windows issue, and npm 12 changed the
   `npm pack --json` shape from an array to an object. All three are fixed in
   R0.6; the test is green.
5. **The Claude Code repository is not the CLI source.** It contains plugins,
   mods, examples, settings templates and the changelog. Claims about Claude
   Code internals cannot be verified from it; only the shipped surface and the
   documented behaviour can. The 1,346 `.ts` files are mostly mods and their
   fixtures.
6. **The MDM and settings examples are community-maintained.** They carry an
   explicit "may be unsupported or incorrect" warning
   (`examples/mdm/README.md:10-11`). They are evidence of direction, not a
   stable contract to copy.
7. **Mods are early access.** `mods/README.md:114-117` says the function-hook
   API may change between releases. The lesson is the tiered hook bus and policy
   separation, not the exact mod API.
8. **The 2026-10-24 critique has three stale claims.** `src/errors.ts` is not
   empty (242 bytes, used at 30 call sites), the stale legacy tarball under
   `release/` exists in the zip but not in the live workspace, and permission
   logic is split between `tools.ts` (modes) and `approval.ts` (prefix
   approvals). The rest of the critique is confirmed in
   `docs/CRITIQUE_VERIFICATION.md`.

### 1.3 Limits of this review

- No Termux/Android device, macOS or ARM64 host was available. Termux remains
  an implementation target, not a tested claim.
- The Vyen directory is not a git repository in this environment, so commit
  history and CI runs could not be inspected.
- Claude Code's internal implementation, test coverage and security model cannot
  be established from the public repository.

## 2. Where Vyen stands

### 2.1 Strengths to preserve

- A small, readable agent core with strict TypeScript and no native addons.
- File safety: read-before-write, stale-revision rejection, symlink containment,
  exact permissions, atomic writes.
- Session safety: atomic checkpoints, process locks, crash repair, rewind and
  revert with conflict detection.
- Subagents with isolated transcripts, shared budgets and inherited approvals.
- MCP stdio/HTTP with schema compaction, approval gating for resources and
  credential redaction.
- Skills, custom prompts, workflows and the Agent Network.
- A focused TUI, `-p`/`--json` headless modes, and mobile pairing through
  Cloudflared.
- Provider independence: OpenAI-compatible, OpenAI Responses and Anthropic
  Messages, with reasoning replay and inline-think projection.

These are the reasons Vyen exists. A roadmap that erodes them is a regression,
even if it adds features.

### 2.2 Structural risks

| Risk | Evidence | Consequence |
|---|---|---|
| God modules | `cli.ts` 3,182 lines, `tui.ts` 2,756, `pair.ts` 1,432 | 47% of the source sits in three files; every new seam grows them |
| No extension seam | adding a tool requires edits in `tools.ts`, `context.ts`, `harness.ts`, `tui.ts` (`AGENTS.md` §3) | third parties cannot extend Vyen without forking |
| Session-only policy | `approval.ts` has no persistence | every new session re-asks; teams cannot codify rules |
| No OS sandbox | `README.md:239`, `SPEC.md:22-23` | an approved shell command has the user's full privileges |
| No audit trail | no audit/telemetry module | incidents cannot be reconstructed; usage is opaque |
| Public surface too broad | `src/index.ts` re-exports almost every internal module | every refactor risks a breaking API |
| Contract drift | SPEC/README/VALIDATION disagree with code | users and agents cannot trust the documents |

### 2.3 Contract drift found (fixed in Phase 0)

The table records the pre-fix state; the documents now match the code.

| Document (pre-fix) | Said | Code says |
|---|---|---|
| `docs/SPEC.md:19` | "Two retries" | `MAX_API_RETRIES = 3` (`src/harness.ts:35`) |
| `docs/SPEC.md:36` | default run budget 100,000 | default 0, unlimited (`src/config.ts:20,124-126`) |
| `docs/SPEC.md:42` | MCP has no resources | resources are registered and tested |
| `README.md` release section | every main push bumps, packs and publishes a GitHub Release | workflow publishes npm on `v*` only; README now says so |
| `docs/VALIDATION.md` historical section | 172 tests | current counts are in Appendix A |
| `AGENTS.md` §1 | publish test fails on the `gh` stub | packer fixed; publish test green on Windows |

## 3. Claude Code skeleton versus Vyen

The useful part of Claude Code is its separation of layers, not its account
system. The table below maps each layer to evidence and to a decision.

| Layer | Claude Code evidence | Vyen today | Decision |
|---|---|---|---|
| Agent loop | `claude -p`, streaming, compaction, checkpoints | implemented | maintain |
| Core tools | Read/Write/Edit/Bash/Grep/Glob/Todo/WebFetch/WebSearch | no web tools | add web tools with policy |
| Permission rules | `permissions.allow/ask/deny`, managed settings | session-only prefix approvals | adopt |
| OS sandbox | `sandbox.enabled`, filesystem/network/credential rules | none, documented as such | adopt, adapted for Termux |
| Hook bus | `PreToolUse`/`PostToolUse`/`Stop`/...; exit code 2 blocks | internal workflow callbacks only | adopt a compatible subset |
| Plugins | `.claude-plugin/plugin.json`, marketplace | none | adapt, local-first |
| Skills/commands | `SKILL.md`, Markdown commands | skills, prompts, workflows | keep, align packaging later |
| Subagents | agents, teams, worktree isolation | subagents, no worktree isolation | add worktrees |
| Sessions | resume, rewind, background sessions, worktrees | resume, rewind, no background sessions | keep; add worktrees first |
| TUI | statusline script, themes, vim, keybindings, diff pane | fixed theme, no statusline script | add statusline and themes; defer vim |
| Headless/SDK | `-p`, stream-json, JSON schema, GitHub Action; Agent SDK referenced by the `agent-sdk-dev` plugin | `-p`, NDJSON, no schema or SDK | adopt schema and SDK |
| IDE | VS Code/JetBrains entries in CHANGELOG; the extensions are not in this repo | mobile pairing only | adapt through MCP/ACP, not native plugins |
| Observability | OTEL metrics/logs/traces with content redaction | none | local audit log first, OTEL optional |
| Enterprise | managed settings, MDM, gateways | none, deliberate | defer until demand |
| Providers | Anthropic-centric, Bedrock/Vertex | multi-provider, BYO key | preserve and strengthen |
| Mobile | web/phone remote control | Cloudflared pairing | preserve and extend |

## 4. Strategy

### 4.1 Positioning

Vyen should be the smallest auditable coding harness that runs where Claude Code
does not: Termux and low-end Android, with any tool-calling provider. The goal is
not feature parity. The goal is to adopt Claude Code's *seams* (policy,
extensions, interfaces, observability) without adopting its account, enterprise
and IDE surface.

### 4.2 Principles

1. **Seams before features.** A hook bus and permission rules make every later
   feature cheaper. A new tool does not.
2. **Termux is a gate, not a footnote.** Every phase must have a Termux story:
   supported, degraded with a warning, or explicitly refused.
3. **Policy must be enforceable, not advisory.** If a rule cannot be tested by
   attempting the forbidden action, it is documentation, not a control.
4. **No silent fallback for safety.** If the sandbox is unavailable, auto mode
   must refuse; it must not quietly run unsandboxed.
5. **No blind parity.** Claude Code features that depend on Anthropic accounts,
   MDM or a desktop IDE are out of scope until a user asks for them.
6. **Extract on touch.** Do not rewrite `cli.ts` in one go. Move one seam at a
   time, with tests, as the feature that needs it lands.

### 4.3 Adopt, adapt, reject

**Adopt**
- Hook lifecycle with a documented JSON contract and exit-code semantics.
- Persistent allow/ask/deny rules with a clear precedence.
- Project-scoped settings and MCP configuration.
- A versioned headless event schema and structured final output.
- A local audit log; optional OTEL export.
- Worktree isolation for parallel work.

**Adapt**
- Plugins: local and git sources first; a marketplace only after checksums,
  trust prompts and an audit trail exist.
- Sandbox: bubblewrap on Linux; a capability probe and honest degradation on
  Termux; policy-only on Windows.
- IDE: expose an MCP or ACP server instead of building native extensions.
- Statusline/themes: user-configurable, but keep the compact default.

**Reject or defer**
- Account login, OAuth and hosted telemetry by default.
- MDM, managed policy and enterprise gateways.
- Claude Code's early-access mod API.
- Native VS Code/JetBrains extensions built in-house.
- A remote plugin marketplace before the security model is proven.

## 5. Target architecture

The current dependency direction is sound: infrastructure -> tools -> context ->
harness, with `cli` composing the pieces. The new layers should sit beside the
harness, not inside it.

```
                    +-----------------------------+
                    |  interfaces: TUI, headless  |
                    |  CLI, MCP/ACP server, pair  |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    |  policy: settings, rules,   |
                    |  hooks, trust, approvals    |
                    +--------------+--------------+
                                   |
     +-----------------------------+-----------------------------+
     |                             |                             |
+----v----+                  +-----v-----+                 +-----v-----+
| harness |                  |   tools   |                 | extensions|
| loop    |                  | file/shell|                 | plugins,  |
| session |                  | web, MCP  |                 | skills,   |
+---------+                  +-----------+                 | workflows |
     |                             |                        +-----------+
+----v-----------------------------v-----------------------------+
| infrastructure: files, process, config, session, provider,   |
| reasoning, errors, audit                                      |
+---------------------------------------------------------------+
```

Proposed modules, created only when their phase starts:

| Module | Purpose | Phase |
|---|---|---|
| `src/settings.ts` | layered settings and precedence | 1 |
| `src/policy.ts` | allow/ask/deny evaluation | 1 |
| `src/hooks.ts` | event bus, matchers, command handlers | 1 |
| `src/events.ts` | versioned NDJSON event schema | 1 |
| `src/audit.ts` | local JSONL audit log | 2 |
| `src/web.ts` | `web_fetch` and `web_search` with network policy | 2 |
| `src/sandbox.ts` | capability probe and sandboxed bash | 3 |
| `src/worktree.ts` | git worktree lifecycle | 3 |
| `src/plugins.ts` | manifest discovery and loading | 4 |
| `src/server.ts` | `vyen mcp serve` and ACP transport | 4 |

## 6. Roadmap by phase

### Phase 0 - Contract truth (0.4.1)

Goal: make the documents match the code before adding layers. A roadmap built
on stale contracts will send the next agent in the wrong direction.

| ID | Item | Acceptance | Effort |
|---|---|---|---|
| R0.1 | Correct `docs/SPEC.md`: retries, default budget, MCP resources | every corrected claim has a test or a code reference; no "two retries" text remains | S |
| R0.2 | Correct the README release section | README describes the workflow that exists, or the workflow is extended in a separate task | S |
| R0.3 | Refresh `docs/VALIDATION.md` with the 2026-10-24 run | 202/194/5/3 recorded; the publish fixes and the remaining Windows-only failures are named | S |
| R0.4 | Close test gaps: `setup.ts`, `prompts.ts`, `help.ts`, `errors.ts`, `update.ts` auto-install | at least one test per module; the test fails when the module's promise is removed | M |
| R0.5 | Link this roadmap from README and mark it draft | one link, no duplicated text | S |
| R0.6 | Make the release packer Windows-safe and remove the false "gh stub" failure note | `scripts/pack-release.mjs` uses `cmd.exe` on Windows, accepts npm 11 array and npm 12 object output, removes an inherited `npm_config_allow_scripts` while preserving registry/auth config, and passes `%`-containing paths through the environment; `tests/publish.test.mjs` gets a Windows `gh.cmd` shim and reproduces the inherited value; the publish test passes on Windows | S |
| R0.7 | Close the explicit flag-level pytest and test-reporter prefix-approval bypasses | `-p`, `--plugins`, `--test-reporter`, `--test-reporter-destination`, attached `-pNAME`, clusters such as `-qp`, `--override-ini`, `--config-file` and `@file` are rejected; safe `-q`/`-k`/`-W`/`-ra` forms remain approved for `python`, `python3`, `py` and `pytest`; `npm test -- --watch=false` and `ls -laR` stay approved but `node -r` does not; red tests prove the old code approved the bypasses. Automatic `pytest.ini`/`pyproject.toml` discovery remains inside the decision to approve pytest itself | S |
| R0.8 | Correct the AGENTS quick map and the module/docs drift | all 25 `src/*.ts` modules are listed with their real responsibility; `README.md` lists `errors.ts`; no doc says 18 files or an empty `errors.ts` | S |
| R0.9 | Record the default-gateway security decision | either require an explicit `baseUrl`, default to the provider's official endpoint, or print a one-time warning before using `api.yuristore.xyz`; the chosen behaviour has a test | S |

Exit criteria: `npm run typecheck`, `npm run lint` and `npm test` are green
except the documented Windows-only failures that remain after R0.6; no document
claims behaviour the code does not have. The 2026-10-24 critique is answered in
`docs/CRITIQUE_VERIFICATION.md`, including the claims that were false.

**Status 2026-10-24:** R0.1-R0.9 are implemented and covered by focused tests;
the final suite counts are in Appendix A. R0.9 is resolved: `README.md` and
`docs/SPEC.md` disclose the default gateway, and the CLI prints a one-time
warning naming it before the first model request. The setup wizard prints the
same warning before its `/models` probe when a first setup accepts the default.
`doctor --json` keeps `baseUrl` and adds `effectiveBaseUrl` and `defaultGateway`
so headless checks can audit the destination. `DEFAULT_GATEWAY_URL` itself is
unchanged; requiring an explicit `baseUrl` or switching the default remains a
future product decision.

### Phase 1 - Extension seams (0.5.0)

Goal: make policy and automation configurable without forking. This is the
largest architectural change and the foundation for every later phase.

**Status 2026-10-25:** Phase 1 core items R1.1 and R1.2 are completed and landed.
`.vyen/settings.json` supports `permissions.allow/ask/deny`, HookBus implements the 8
lifecycle events with fail-closed semantics, and `--trust-workspace` guards project settings.

| ID | Item | Scope | Acceptance | Effort |
|---|---|---|---|---|
| R1.1 | Layered settings | user `config.json` + project `.vyen/settings.json`; `permissions.allow`, `ask`, `deny`; CLI `--allowed-tools`/`--disallowed-tools` | Completed (2026-10-25): project allow skips prompt, user deny wins, CLI overrides landed | M |
| R1.2 | Hook bus | events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`; command handlers with JSON stdin/stdout; matcher, timeout, exit 0/2 | Completed (2026-10-25): HookBus in `src/hooks.ts`, exit 2 / error / timeout denies tool, context injected on exit 0 | L |
| R1.3 | Project MCP | `.vyen/mcp.json` merged with user config; source shown in `vyen mcp list`; user deny wins | Completed (2026-10-26): `.vyen/mcp.json` loaded after workspace trust, user definition wins on collision, project approval grants rejected, `--scope=project` supported | M |
| R1.4 | Headless contract | `--output-format stream-json`, schema version `v1`, documented event union, `--json-schema` for the final answer; expose the existing `--run-token-budget` in the contract (no second budget flag) | an external consumer can validate every event against the schema; an invalid final answer fails with a clear exit code | M |
| R1.5 | Extract on touch | move settings/policy/hooks/event types out of `cli.ts` as they land; no big-bang rewrite | `cli.ts` does not grow by more than the wiring; new modules have focused tests | M |

Design constraints:
- Hook input must never include the API key or the full environment.
- A hook timeout is a failure, not a silent skip; the run reports it.
- Project hooks and project MCP are disabled until the workspace is trusted; the
  trust decision is stored per workspace and invalidated when the config changes.
  The trust hash must cover every executable file the config references (hook
  scripts, prompt templates, local MCP commands), not only the JSON file; a
  checkout that swaps `scripts/hook.sh` while leaving `.vyen/settings.json`
  untouched must trigger a new prompt.
- The hook contract is inspired by Claude Code's specification, accepting the standard
  event shapes with exact parameter schemas and exit code behaviors documented in docs/SPEC.md.

Exit criteria: a project can define rules, hooks and MCP servers; a headless
consumer can parse a versioned stream; `cli.ts` did not absorb the new logic.

### Phase 2 - Safety and operations (0.6.0)

Goal: make the agent observable and honest about what it redacts.

| ID | Item | Scope | Acceptance | Effort |
|---|---|---|---|---|
| R2.1 | Local audit log | JSONL under `$XDG_DATA_HOME/vyen/audit/`; fields: timestamp, session, tool, decision, duration, tokens, error class; pair session start/stop and remote approve/deny are recorded as decisions; no prompt or file content by default; size rotation; `VYEN_AUDIT=off` | a completed run writes one row per tool decision; a pair-controlled approval writes a row that names the remote origin; the configured API key never appears; opt-out writes nothing | M |
| R2.2 | Transcript secret scrubbing | redact configured key values and common token patterns before session JSON, NDJSON and audit rows are written | the configured secret cannot be recovered from any persisted file after restart; a test asserts the raw value is absent from every persisted file | M |
| R2.3 | Web tools | `web_fetch` baseline; `web_search` only with a configured backend or provider-native search; both behind the policy layer; resolve every host and reject loopback/private/link-local/metadata addresses after DNS resolution, pin the checked address for the connection, and re-check after every redirect; per-domain allow/ask/deny; size and redirect caps | a private-address fetch is refused even when a public name resolves to `127.0.0.1`; a redirect to a private address is refused; an allowed public domain works; a denied domain asks or fails according to the rule | M |
| R2.4 | Usage and cost | `/usage` with tokens by model and session; optional `modelPricing` config; no hardcoded prices | the report is derived from recorded usage, not estimated from prompt length | S |
| R2.5 | Statusline and themes | user statusline command with a JSON payload; theme selection; keep the current compact default | a statusline script renders; a broken script degrades to the default with a warning | S |
| R2.6 | Pair hardening | failed-auth rate limit and lockout, session TTL with rotation, `Origin`/`Host` validation on state-changing requests, explicit warning that the tunnel URL is a credential, and audit rows for remote approvals | repeated bad tokens are throttled; an expired session refuses control; a cross-origin state change is rejected; `pair status` shows the remaining TTL | M |

Exit criteria: an incident can be reconstructed from the audit log; no secret is
written to disk by the documented paths; web access is policy-controlled.

### Phase 3 - Isolation and parallel work (0.7.0)

Goal: contain approved commands and let independent work proceed without
clobbering the same files.

| ID | Item | Scope | Acceptance | Effort |
|---|---|---|---|---|
| R3.1 | Bash sandbox | Linux: bubblewrap with filesystem and network policy; Termux: capability probe plus a proot/allowlist fallback because unprivileged Android usually blocks user namespaces and mount; Windows: explicit unsupported warning; `sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed` | a sandboxed command cannot write outside the workspace; a denied network destination fails; when bubblewrap is unavailable on Termux, the documented fallback still permits a bounded `auto` mode instead of deadlocking; when the sandbox is unavailable and `failIfUnavailable` is set, the run refuses before executing | L |
| R3.2 | Auto-mode policy | `auto` becomes a policy decision, not blanket approval: require sandbox or explicit `--unsafe`; deterministic deny/ask rules; optional classifier behind a flag | `auto` refuses an unsandboxed write when the policy requires a sandbox; a deny rule still blocks | M |
| R3.3 | Worktrees | `--worktree`, per-subagent worktree isolation, create/remove lifecycle, unpushed-commit guard; document how a worktree gets dependencies and how its commits interact with checkpoints | two subagents can edit in separate worktrees and their changes are reviewable; a worktree can run `npm test` (dependencies are linked or installed); `/revert` either refuses or states that a merged worktree change is outside its file-checkpoint model; quitting warns before deleting unpushed work | L |
| R3.4 | Background shell tasks | optional: start, list, read and stop long-running commands with captured output | a background task survives a tool call boundary and can be stopped; its output is bounded | M |

Exit criteria: an approved command is contained by the OS on Linux; Termux
degrades honestly; parallel edits do not share a working tree by accident.

### Phase 4 - Ecosystem and interfaces (0.8.0 - 1.0.0)

Goal: let other people extend Vyen without editing its core, and let other tools
drive it.

| ID | Item | Scope | Acceptance | Effort |
|---|---|---|---|---|
| R4.1 | Plugin loader | native `.vyen-plugin/plugin.json`; optional import of a documented `.claude-plugin/plugin.json` subset; components: commands, skills, hooks, MCP; local path and git source; trust prompt | install a local plugin, use its command and hook, uninstall it; a plugin cannot widen a deny rule or read the API key | L |
| R4.2 | Marketplace | index format, checksums, allowlist, update flow; no remote index until R2.1 and a security review | an installed plugin is pinned by checksum; an unsigned or changed package is refused | XL |
| R4.3 | MCP/ACP server | `vyen mcp serve` and an ACP spike for editors | an external client can list and call Vyen tools; the protocol version is documented | M |
| R4.4 | Managed policy | only if a team asks: managed settings file with fail-closed precedence | a managed deny cannot be overridden by user or project settings | L |

Exit criteria: a third-party plugin can be installed and removed safely; an
editor can drive Vyen through a documented protocol; 1.0 has a stable event
schema and a stable plugin manifest.

## 7. Dependencies and release plan

```
Phase 0 (truth)
  |
  +--> R1.1 settings/policy ---> R1.2 hooks ---> R4.1 plugins ---> R4.2 marketplace
  |                                   |
  |                                   +--> R2.1 audit ---> R4.2
  |
  +--> R1.4 headless schema ---> R4.3 MCP/ACP
  |
  +--> R2.3 web tools
  |
  +--> R3.3 worktrees ---> parallel subagent isolation
  |
  +--> R3.1 sandbox ---> R3.2 auto-mode policy
```

| Release | Content | Why this order |
|---|---|---|
| 0.4.1 | Phase 0 | trust in the documents before new layers |
| 0.5.0 | Phase 1 | policy and hooks unlock everything else |
| 0.6.0 | Phase 2 | observe and redact before accepting third-party code |
| 0.7.0 | Phase 3 | contain commands before enabling broader automation |
| 0.8.0 | R4.1, R4.3 | local plugins and a server surface, no marketplace yet |
| 1.0.0 | R4.2, R4.4 | marketplace and managed policy only after the security model holds |

Estimated effort assumes one maintainer: Phase 0 is days, Phase 1 and Phase 3
are weeks, Phase 4 is months. Split a phase into smaller releases rather than
shipping a half-tested seam.

## 8. Metrics and gates

### 8.1 Per-release gate

- `npm run typecheck`, `npm run lint`, `npm test` green (0 failures; 5 platform tests cleanly skipped on Windows).
- Every new promise in a comment has a test that goes red when the guard is
  removed.
- One end-to-end test at an observable boundary per feature: a file on disk, a
  real process, an exit code.
- `docs/SPEC.md` updated in the same change as the behaviour.
- `README.md` updated when a user-visible behaviour changes.
- A Termux note for every change that touches files, processes, terminal I/O or
  networking.

### 8.2 Security invariants

1. The configured API key never reaches a child process environment.
2. A project rule cannot widen a user or managed deny rule.
3. A command or declarative hook/plugin cannot read the API key or bypass the
   policy layer. In-process JavaScript plugins are out of scope until a
   capability/permission model exists, because they can read `process.env`.
4. `auto` mode does not run unsandboxed when the policy requires a sandbox.
5. A persisted transcript does not contain a configured secret.
6. A path that resolves outside the workspace is refused, including symlinks.
7. No request is sent to a third-party gateway unless the user chose that
   `baseUrl` or was warned about the default before the request.
8. Pair control is token-authenticated, rate-limited, origin-checked and expires;
   the tunnel URL is treated as a credential, not as a harmless link.

### 8.3 Performance budgets

The Termux numbers are targets, not measurements: no Termux/Android device was
available for the 2026-10-24 review. Measure `node -e ""` as the baseline first;
the Vyen budget is the **added** time over that baseline, not a guessed absolute.

| Metric | Budget |
|---|---|
| `vyen --version` / `--help` startup | added overhead under 150 ms over `node -e ""` on the same Termux device; record the cold-start absolute number, expected 250-400 ms on low-end ARM |
| TUI frame render, 50k-character transcript | under 2 ms |
| Context overhead added by hooks/policy | under 5% of prompt tokens |
| Audit write | off the critical path, under 1 ms per tool |

## 9. Open decisions

These need a decision before the phase that depends on them starts.

1. **Hook compatibility.** Adopt the Claude Code subset (`PreToolUse`,
   `PostToolUse`, `UserPromptSubmit`, `Stop`) or define a native schema?
   Recommendation: compatible subset, marked experimental; native extensions
   where the shapes differ.
2. **Project trust.** Prompt once per workspace, or trust any workspace that has
   no project hooks? Recommendation: prompt on first use; store a hash of the
   project config **and every file it can execute**; invalidate on any change.
3. **Termux sandbox.** If bubblewrap is unavailable, does `auto` refuse, or run
   with a warning? Recommendation: use a proot/allowlist fallback for
   write/network operations; allow `ask` mode with an explicit warning; do not
   make `auto` permanently unusable on the primary platform.
4. **Marketplace timing.** Local and git plugins in 0.8, remote marketplace in
   1.0 only after the audit log and checksum verification exist? Recommendation:
   yes.
5. **IDE integration.** Native extension, MCP server, or ACP? Recommendation:
   spike ACP and `vyen mcp serve`; do not build a VS Code extension in-house.
6. **Refactor scope.** Big-bang split of `cli.ts`, or extract on touch?
   Recommendation: extract on touch; a big-bang refactor would violate the
   "no unrelated refactor" rule and delay the seams.
7. **Default gateway.** Resolved in R0.9. `DEFAULT_GATEWAY_URL` remains
   `https://api.yuristore.xyz/v1`; when `baseUrl` is absent the CLI prints a
   one-time warning naming the third-party destination before the first model
   request. An explicit `baseUrl` suppresses the runtime warning, and the setup
   wizard warns before probing the default on a first setup. Requiring an
   explicit `baseUrl` or switching the default endpoint remains a future product
   decision; the runtime no longer sends a key and prompt to the default
   silently.

## 10. First ten working days

1. Keep the Phase 0 contract tests green; the six document drifts and module tests landed on 2026-10-24.
2. Write a one-page ADR for R1.1/R1.2 with the JSON shapes and precedence rules.
3. Prototype the hook bus with three events (`PreToolUse`, `PostToolUse`,
   `SessionStart`) behind a flag; add one end-to-end test that denies a write.
4. Add the project settings loader with allow/ask/deny and one persistence test
   across two processes.
5. Run the current suite on a Termux device or emulator and record the result in
   `docs/VALIDATION.md`; if no device is available, say so.

The output of these ten days is evidence, not a release: a working hook path, a
policy evaluation table, and a truthful validation record.

## Appendix A - Test run of 2026-10-24

Final Phase 0 run on Windows, Node 24.18.0, npm 12.0.2: 202 tests, 194 pass,
5 fail, 3 skipped, 184.9 s. The pre-fix baseline for comparison was 193 tests,
184 pass, 6 fail, 3 skipped.

| File | Failing test | Immediate cause |
|---|---|---|
| `tests/audit.test.mjs` | model-initiated image reads outside the workspace require approval; workspace images do not | `EPERM` creating a symlink |
| `tests/files.test.mjs` | existing files require a fresh read; edits preserve file mode | POSIX mode bits reported as 438 instead of 493 |
| `tests/files.test.mjs` | edits preserve exact permissions under restrictive umasks; new files obey umask | POSIX mode lost |
| `tests/files.test.mjs` | workspace containment rejects ../ and symlink escapes including missing leaves | `EPERM` creating a symlink |
| `tests/files.test.mjs` | portable search is bounded and skips symlinks | `EPERM` creating a symlink |

The three skips are the POSIX pseudo-terminal tests (two in `tests/tui.test.mjs`,
one in `tests/audit.test.mjs`). The five failures are platform limitations on
Windows, not product regressions. As of 2026-10-25, these five platform limitations
(four in `tests/files.test.mjs`, one in `tests/audit.test.mjs`) are cleanly skipped
on Windows (`process.platform === 'win32'`), bringing `npm test` on Windows to exit 0
with 0 failures. The former publish failure is fixed: the
packer now uses `cmd.exe` on Windows, writes a `gh.cmd` shim in the test, accepts
npm 12's object-shaped `npm pack --json`, removes an inherited
`npm_config_allow_scripts` while preserving registry/auth config, and passes
`%`-containing paths through the environment before the smoke install.
