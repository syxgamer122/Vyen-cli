# vyen

An independent terminal coding agent. It talks to OpenAI-compatible, OpenAI
Responses and Anthropic endpoints, reads and edits files in your workspace,
runs shell commands with your approval, speaks MCP, and can delegate work to
subagents.

## Install

```bash
npm install -g vyen
```

Requires Node.js >= 22.16.0. Verified on Linux; the primary target is Termux on
Android.

A release tarball with the same contents is also attached to every GitHub
release, for machines that cannot reach the npm registry.

## Configure

```bash
vyen setup
```

`vyen setup` writes `~/.config/vyen/config.json`. The API key is never written
to the config file — it is read from the environment variable named by
`keyEnv` (default `VYEN_API_KEY`) or from `~/.config/vyen/credentials.json`.

## Run

```bash
vyen                          # interactive
vyen "fix the failing test"   # one shot
vyen --read-only              # no writes, no shell
vyen --plan                   # plan first, then implement
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
A `goon` installation's `~/.config/goon` and `~/.local/share/goon` are copied
into their `vyen` counterparts on the first launch; the old directories are left
in place.

## Permissions

Mutating tools and shell commands need approval. `--yes` approves everything
for that run; `--read-only` removes them entirely; `--plan` allows exploration
first. A denied tool ends the run with exit code 2.

## MCP

Servers live in `~/.config/vyen/mcp.json`, separate from the main config. See
[docs/MCP.md](docs/MCP.md).

## Sessions

Sessions are stored as JSON under `~/.local/share/vyen/sessions/`. `vyen
sessions` lists them and `vyen resume` reopens one.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — boundaries and contracts
- [docs/MCP.md](docs/MCP.md) — MCP configuration and limits
- [docs/VALIDATION.md](docs/VALIDATION.md) — what the test suite covers
- [docs/REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md) — design references and
  the reasoning behind the stream and subagent contracts

## License

MIT
