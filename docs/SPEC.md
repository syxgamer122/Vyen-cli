# Vyen CLI 0.2

Independent implementation informed by ZCode's separation of runtime, provider,
tools and persistence. No ZCode runtime source is copied or loaded.

## Owners and boundaries

- CLI owns terminal input, flags and lifetime. Provider configuration comes
  only from user config, environment and flags. MCP has a separate user-only
  mcp.json. Priority: flags > VYEN_* environment > user config > defaults.
  Credentials are resolved at runtime through keyEnv and are never saved by init.
  If baseUrl is absent, Provider uses the built-in default
  `https://api.yuristore.xyz/v1`; this is a third-party destination and README
  discloses it. The CLI prints a one-time warning naming that destination before
  the first model request; an explicit baseUrl suppresses it. The setup wizard
  prints the same warning before its first `/models` probe when a first setup
  still accepts the default gateway.
- Harness owns ModelMessage history, token accounting, tool result pairing and
  compaction. A streamed response must complete before any tool executes. Reads
  can run in consecutive batches of up to six; mutations execute in declaration order.
- SessionStore owns atomic JSON checkpoints and a process lock. A session is
  bound to its real workspace. Loading repairs interrupted tool calls with error
  results; it never replays a side effect. A live lock is never stolen.
- Provider owns HTTP/model protocol handling through AI SDK: OpenAI chat,
  OpenAI Responses, Anthropic Messages. Three retries; configurable request timeout.
- Tools own file/shell I/O. File paths resolve within the real workspace;
  symlink escapes fail. Existing files must be read before overwrite/edit;
  changed revisions are rejected. Shell commands require approval and execute
  as the current user, without an OS sandbox. Read-only mode omits all mutations
  and shell. --yes explicitly authorizes them without prompts. Project settings
  in `.vyen/settings.json` define permissions (`allow`, `ask`, `deny`) and lifecycle
  `hooks` (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `PreCompact`, `Stop`). Hooks receive a JSON payload on stdin with
  `event`, `sessionId`, `timestamp`, `cwd` and event-specific fields in a sanitized
  environment; exit 2 denies tool execution, exit 0 injects stdout context,
  and project hooks require workspace trust hash verification (opt in via --trust-workspace).
  Nested ephemeral runners (Agent Network rounds, workflow steps) inherit tool hooks but do
  not emit global `SessionStart`/`SessionEnd`. CLI flags
  `--allowed-tools` and `--disallowed-tools` override layered settings. User deny
  cannot be widened by project rules; deny rules take effect even in auto mode.
- Help/init/doctor/sessions/upgrade perform no model request. No account login,
  plugin marketplace, telemetry, browser, native addons or bundled runtime.
  `vyen doctor --json` keeps `baseUrl` as the configured value or
  `"provider default"` and adds `effectiveBaseUrl` and `defaultGateway` so a
  headless consumer can audit the destination without parsing stderr.
  Updates are opt-in: `vyen upgrade` detects npm/pnpm/yarn/bun and runs that
  manager's global install. The interactive start reads a 24-hour registry cache
  and only notifies by default; `update: auto` installs before the TUI starts,
  and prompt/JSON runs never check. No prebuilt binary is downloaded.
- Cancellation aborts HTTP, approvals and process groups, records terminal tool
  results, and checkpoints before shutdown. Permission denial ends the current
  run rather than inviting repeated requests.
- Context is compacted before the next request when a conservative character
  estimate or measured input exceeds 70% of the declared window. Only complete
  tool-result groups enter a compact summary. Default run token budget: 0 (unlimited);
  a positive value caps the run. Output/tool budgets and command deadlines are bounded.
- MCP owns clients and transport cleanup. SDK stdio and Streamable HTTP tools
  are namespaced, schema-validated and bounded. Only user readOnlyTools entries
  bypass approvals; remote annotations do not grant privileges. Stdio inherits
  the SDK default environment plus explicit envFrom mappings. HTTP bearer keys
  come from env variables. No sampling, OAuth, prompts or legacy SSE; tools and
  resources are supported.
- Subagents own separate transcripts under subagents/PARENT_UUID. Research uses
  at most two concurrent children globally per manager; editing tasks are serial
  mutation barriers. Children share the parent's approval callback and run budget,
  have a 30k local budget, no MCP and no child delegation. Parent cancellation
  drains children; child permission denial stops the parent. Budgets are checked
  between requests and concurrent in-flight requests can exceed the threshold.
- Pairing is opt-in (`vyen pair`, `--pair` or `/pair`). The HTTP server binds
  127.0.0.1 unless LAN mode is requested explicitly. Every request needs the
  per-session 128-bit token from the URL or a Bearer header. A remote device may
  prompt, read the stream, switch to ask/plan/readonly and answer approvals; it
  cannot enable auto-approval or run `!` shell commands, and `always` grants a
  tool only for that session. The tunnel link is a credential: anyone holding it
  can control the session. Cloudflared comes from PATH or is downloaded from
  Cloudflare's GitHub release on first use; an ordinary install or start fetches
  nothing, and only the explicit pair command can trigger the download, then
  only after the user confirms it.
- Workflows are data, not code: built-ins plus `.vyen/workflows/*.json|*.md` and
  the user config directory. Steps run prompts, subagents, network sessions,
  shell commands or approval gates. Shell steps use the same approval callback as
  `bash`, are refused in read-only/plan modes, and have a 120-second deadline.
  A prompt step's `readOnly`/`mode` narrows the tool registry for that step and
  `effort` selects its reasoning level. The slash command and the `run_workflow`
  tool each share one run budget across every step. Workflow child sessions
  share the parent's budget and approval callback.
- Agent Network convenes read-only persona subagents for at most four rounds and
  exposes a P2P message bus to child agents. It shares the parent run budget;
  when the parent is unbounded it caps a session at 120,000 tokens. Peer tools
  cannot widen a child's permission mode.
- TerminalUI owns the alternate screen, raw input, resize, scrollback and keyboard
  cleanup. It is enabled only for interactive TTYs; --no-tui, TERM=dumb, prompt
  mode and JSON retain plain output. Terminal controls in model/tool data are
  stripped. No native UI dependency is required.
- AnswerProjection owns display compatibility for leading think blocks. It never
  mutates SDK response messages or signed provider replay metadata. Extraction
  is incremental across chunk boundaries, ends once visible answer text starts,
  and can be disabled. Reasoning is opt-in on a separate event/display channel.
  Compaction uses the visible summary and refuses reasoning-only output.
- Every terminal model step without tool calls requires non-whitespace projected
  answer text, independent of observed reasoning events. Earlier tool narration
  and successful child reports cannot stand in for the parent's final answer.
  Missing answers checkpoint usage/history and fail without automatic retries or
  replaying completed tools. Tool-only intermediate steps remain valid; explicit
  permission denial retains its stopped/denied outcome and exit code 2.
- Child start/progress/terminal events form a discriminated union. Only start
  includes task; progress excludes text/reasoning. Child reports select the last
  non-empty visible assistant answer. Terminal publication follows session close,
  and capacity is released on cleanup failures as well as successful runs.
  See REFERENCE_REVIEW.md for exact source references and NDJSON migration.

## Hook Events & Lifecycle

The Hook system is inspired by Claude Code's lifecycle and hook architecture, adapted for Vyen's POSIX and Windows terminal environment. Hooks execute via stdin/stdout JSON streaming in a sanitized environment that preserves SSH and Git authentication while stripping credentials.

Project hooks are defined strictly in `.vyen/settings.json` (user configuration `config.json` holds only global permissions). Project hooks and allow rules require explicit workspace trust via `--trust-workspace` (which computes and re-records the SHA-256 trust hash over settings and allow script targets).

| Event | Trigger | Payload Fields | Exit 0 Behavior | Non-Zero / Timeout |
|---|---|---|---|---|
| `SessionStart` | Session startup or first turn of resumed session | `event`, `sessionId`, `timestamp`, `cwd` | Injects stdout as system context | Ignored (logged as warning) |
| `SessionEnd` | Process shutdown, `/new`, `/resume`, `/delete`, or subagent cleanup | `event`, `sessionId`, `timestamp`, `cwd` | Ignored | Ignored (logged as warning) |
| `UserPromptSubmit` | User submits prompt | `event`, `sessionId`, `timestamp`, `cwd`, `prompt` | Injects stdout as prompt context | Ignored (logged as warning) |
| `PreToolUse` | Before tool batch execution | `event`, `sessionId`, `timestamp`, `cwd`, `tool`, `input` | Ignored | Exit 2 or error/timeout: Denies tool execution (fail-closed) |
| `PostToolUse` | After tool execution completes | `event`, `sessionId`, `timestamp`, `cwd`, `tool`, `input`, `output` | Injects stdout as context | Ignored (logged as warning) |
| `PostToolUseFailure` | After tool failure or permission denial | `event`, `sessionId`, `timestamp`, `cwd`, `tool`, `input`, `error` | Ignored | Ignored (logged as warning) |
| `PreCompact` | Before context compaction occurs | `event`, `sessionId`, `timestamp`, `cwd`, `tokens`, `trigger` (`'manual'` \| `'token_limit'`) | Ignored | Ignored (logged as warning) |
| `Stop` | User requests stop / abort | `event`, `sessionId`, `timestamp`, `cwd`, `reason` (`'complete'` \| `'permission_denied'` \| `'aborted'` \| `'error'`) | Ignored | Ignored (logged as warning) |

## Acceptance

Run against a local mock HTTP provider through the actual CLI: streaming tool
calls, read/write/edit, denied approval, cancellation, authentication failure,
resume and crash repair. Unit tests cover config validation, locks, symlink
escapes, stale revisions, output limits and subprocess cleanup. Exact existing
file permissions survive restrictive umasks; new files obey umask. CI runs the
full suite at default, 027 and 007 umasks. MCP tests use real SDK stdio/HTTP
servers; subagent tests use the provider loop and cancellation. A POSIX PTY
test exercises TUI input, resize, approval, terminal restoration and clean exit.
Linux tests do not establish Android device compatibility.

## Automated npm releases

Pushing main and manual workflow dispatch run checks on Node 22.16 and 24.
Pull requests run read-only checks without publish permissions. A `v*` tag push
runs the publish job after those checks: the tag must equal package.json's
version, and npm publishes through OIDC trusted publishing (no stored token,
provenance enabled). Tags are never moved and the workflow never bumps a version
or edits the repository. A rerun publishes the same version or fails when that
version already exists. CLI version output reads its installed manifest.
