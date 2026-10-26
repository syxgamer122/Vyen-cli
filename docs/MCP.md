# MCP tools

Vyen is an MCP client, using `@modelcontextprotocol/sdk` 1.32.1. It supports
stdio processes and Streamable HTTP endpoints. Servers are configured globally in
`$XDG_CONFIG_HOME/vyen/mcp.json` (default `~/.config/vyen/mcp.json`) and per-project in
`<cwd>/.vyen/mcp.json`. Provider `vyen init` does not change these files.

## Project MCP & Workspace Trust

Project-scoped MCP servers can be defined directly in `.vyen/mcp.json` so repository
collaborators share identical tooling. However, stdio MCP servers execute local processes,
so project MCP servers are **disabled by default** until the workspace is explicitly
trusted with `--trust-workspace`. Trusting a workspace permits repository-defined
commands to run and cryptographically hashes the project MCP configuration and local script targets.

Precedence & safety rules:
- **User definitions win:** If a project server defines the same name as a user server,
  the project entry is ignored and user configuration takes precedence.
- **No approval grants:** A project server cannot auto-approve tools via `trust: true`
  (rejected on load) or `readOnlyTools` (ignored). Project MCP tools always require approval.
- **Fail-closed:** Malformed `.vyen/mcp.json` files emit an actionable warning and skip
  project servers without blocking user MCP servers.
- **Scoping:** `vyen mcp add/remove` support `--scope=project` (or `--project`). Default
  is `--scope=user`.

## Official Server Presets & Cognitive Tools

Vyen provides 1-click installation for official reference servers from `modelcontextprotocol/servers`:

```bash
vyen mcp add --preset memory [--scope=user|project]
vyen mcp add --preset sequentialthinking
vyen mcp add --preset fetch
vyen mcp add --preset git
vyen mcp add --preset filesystem
vyen mcp add --preset time
```

### Full MCP Protocol Capabilities:
- **Tools**: Dynamic tool discovery, input schema validation, and execution.
- **Resources**: `list_mcp_resources` and `read_mcp_resource` tools to read structured context via URI.
- **Prompts**: `list_mcp_prompts` and `get_mcp_prompt` tools, plus TUI `/mcp prompts`.
- **Elicitation**: Server-initiated interactive user inquiries supported with fail-closed default in headless mode.
- **Bounded Sampling**: Server-initiated LLM completions routed through `src/provider.ts` with strict 2,048 token hard cap and 30s timeout guard.
- **Knowledge Graph Memory**: Persistent entity-relation graph in `~/.config/vyen/knowledge-graph.jsonl` and `.vyen/knowledge-graph.jsonl`.
- **Sequential Thinking**: Built-in multi-step reasoning tool (`sequential_thinking`) for deep problem analysis, revision, and branching.

## Example

Create the file with permissions 0600. Replace paths/URLs and enable only the
servers you intend to use. Commands/args are argv, not shell commands: `~`, `$HOME`
and pipes are not expanded. Stdio starts in the selected workspace.

```json
{
  "servers": {
    "local": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "envFrom": { "SERVICE_API_KEY": "MY_SERVICE_KEY" },
      "readOnlyTools": [],
      "timeoutMs": 30000,
      "disabled": true
    },
    "remote": {
      "transport": "http",
      "url": "https://YOUR_MCP_HOST/mcp",
      "bearerEnv": "MY_MCP_TOKEN",
      "readOnlyTools": [],
      "timeoutMs": 30000,
      "disabled": true
    }
  }
}
```

`envFrom` maps child variable names to names in the current shell, never literal
secret values. The SDK's normal safe environment (PATH, HOME, etc.) is retained;
provider keys are not automatically forwarded. On Termux, add mappings for
PREFIX/TMPDIR if a particular server needs them. A missing referenced variable
fails startup. An HTTP server without authentication can omit bearerEnv. No
account login or OAuth flow is performed; configure a token usable by the server.
HTTP redirects carrying credentials are rejected.

`vyen mcp list` lists names, transport and read-only allowlists without connecting.
`vyen mcp check` starts/connects enabled servers, enumerates tools (including
paginated lists), prints original and stable namespaced names, then closes them.
Neither command requires a model key. `check` does run configured stdio commands.
Normal `vyen` startup connects enabled servers before the first model request.
Servers start concurrently (startup time is the slowest server, not the sum), and
running servers are reused when the harness is rebuilt for a new effort, model or
session; `/mcp reload`, `/mcp check` and `/cd` restart them. The MCP SDK is only
loaded when at least one server is enabled.
`--no-mcp` skips configuration loading and connection for that invocation.

## Permissions and lifetime

All tools require approval unless their **original** names appear in that
server's `readOnlyTools`. Inspect a server and its actual behavior before adding
entries. Server-provided readOnlyHint annotations do not grant this exemption.
Read-only mode exposes only built-in read tools, research delegation and MCP
allowlisted tools. This is tool policy, not an OS sandbox: MCP processes run as
this user, and starting a server can itself perform I/O. Remote tools execute on
the remote service. Vyen cannot enforce remote filesystem containment.

JSON Schema arguments are validated locally before dispatch. Results are bounded
at 32k characters; non-text blocks are represented by markers. A tool result with
isError becomes an error result for the model. External tool descriptions and
output remain external data, not permission to change the user's task.

Each server can be disabled independently. A startup error closes connected
clients, unregisters their tools and releases the main session lock. Cancelled
calls propagate AbortSignal through the SDK. Shutdown attempts HTTP session
termination (bounded to two seconds per server), then closes all transports;
stdio shutdown uses the SDK's child-process cleanup. Server stderr is discarded
to keep terminal/NDJSON output clean. Inspect server logs separately for debugging.

Limits: 64 servers, 1024 tools default / 2048 hard cap, 32 continuation pages, 16k characters per
input schema, 32 MiB stdio message buffer, 100–600000 ms configurable request
timeout (default 30000). Startup fails on duplicates or invalid/excessive schemas
rather than silently dropping tools. In interactive TUI sessions, `/mcp` reloads
server connections in place; MCP resources (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`) are also supported. Prompt
templates, sampling, elicitation, OAuth, legacy SSE and experimental MCP tasks
are not implemented.
