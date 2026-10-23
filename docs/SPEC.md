# Vyen CLI 0.2

Independent implementation informed by ZCode's separation of runtime, provider,
tools and persistence. No ZCode runtime source is copied or loaded.

## Owners and boundaries

- CLI owns terminal input, flags and lifetime. Provider configuration comes
  only from user config, environment and flags. MCP has a separate user-only
  mcp.json. Priority: flags > VYEN_* environment > user config > defaults.
  Credentials are resolved at runtime through keyEnv and are never saved by init.
- Harness owns ModelMessage history, token accounting, tool result pairing and
  compaction. A streamed response must complete before any tool executes. Reads
  can run in consecutive batches of up to six; mutations execute in declaration order.
- SessionStore owns atomic JSON checkpoints and a process lock. A session is
  bound to its real workspace. Loading repairs interrupted tool calls with error
  results; it never replays a side effect. A live lock is never stolen.
- Provider owns HTTP/model protocol handling through AI SDK: OpenAI chat,
  OpenAI Responses, Anthropic Messages. Two retries; configurable request timeout.
- Tools own file/shell I/O. File paths resolve within the real workspace;
  symlink escapes fail. Existing files must be read before overwrite/edit;
  changed revisions are rejected. Shell commands require approval and execute
  as the current user, without an OS sandbox. Read-only mode omits all mutations
  and shell. --yes explicitly authorizes them without prompts.
- Help/init/doctor/sessions/upgrade perform no model request. No account login,
  plugin marketplace, telemetry, browser, native addons or bundled runtime.
  Updates are opt-in: `vyen upgrade` detects npm/pnpm/yarn/bun and runs that
  manager's global install. The interactive start reads a 24-hour registry cache
  and only notifies by default; `update: auto` installs before the TUI starts,
  and prompt/JSON runs never check. No prebuilt binary is downloaded.
- Cancellation aborts HTTP, approvals and process groups, records terminal tool
  results, and checkpoints before shutdown. Permission denial ends the current
  run rather than inviting repeated requests.
- Context is compacted before the next request when a conservative character
  estimate or measured input exceeds 70% of the declared window. Only complete
  tool-result groups enter a compact summary. Default run token budget: 100,000;
  zero disables it. Output/tool budgets and command deadlines are bounded.
- MCP owns clients and transport cleanup. SDK stdio and Streamable HTTP tools
  are namespaced, schema-validated and bounded. Only user readOnlyTools entries
  bypass approvals; remote annotations do not grant privileges. Stdio inherits
  the SDK default environment plus explicit envFrom mappings. HTTP bearer keys
  come from env variables. No sampling, OAuth, resources, prompts or legacy SSE.
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
  nothing, and only the explicit pair command can trigger the download.
- Workflows are data, not code: built-ins plus `.vyen/workflows/*.json|*.md` and
  the user config directory. Steps run prompts, subagents, network sessions,
  shell commands or approval gates. Shell steps use the same approval callback as
  `bash`, are refused in read-only/plan modes, and have a 120-second deadline.
  Workflow child sessions share the parent's budget and approval callback.
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

## Automated GitHub releases

Pushing main and manual workflow dispatch run checks on Node 22.16 and 24.
Pull requests run read-only checks without publish permissions. A `v*` tag push
runs the publish job after those checks: the tag must equal package.json's
version, and npm publishes through OIDC trusted publishing (no stored token,
provenance enabled). Tags are never moved and the workflow never bumps a version
or edits the repository. A rerun publishes the same version or fails when that
version already exists. CLI version output reads its installed manifest.
