# cc-proxy

Mixed-model proxy for Claude Code. Route Opus to Anthropic, Sonnet/Haiku to DeepSeek — within a single session.

## Why

Claude Code subscriptions include Opus. Running all models through Anthropic is expensive. DeepSeek's Anthropic-compatible API serves Sonnet-level models at lower cost. This proxy splits traffic — Opus stays on Anthropic, everything else goes to DeepSeek.

## Prerequisites

- Node.js 18+
- DeepSeek API key (required)
- Anthropic API key (optional — subscription token is forwarded if omitted)
- Windows + PowerShell 5.1 (for `switch-provider.ps1`)

## Setup

Set environment variables persistently (Windows):

```powershell
[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-your-key', 'User')
# Optional — only for API-key mode:
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'sk-ant-your-key', 'User')
```

Restart PowerShell after setting.

Optional config:

```powershell
$env:PROXY_PORT = '3456'            # default
$env:REQUEST_TIMEOUT_MS = '120000'  # default (2 min)
$env:MAX_BODY_SIZE_MB = '10'        # default
```

## Quick start

```powershell
cd cc-proxy
. .\switch-provider.ps1 mixed    # auto-starts proxy + configures env
claude                            # launch Claude Code
. .\switch-provider.ps1 stop-proxy  # stop proxy + reset env
```

The proxy auto-starts with `mixed` mode. No separate terminal needed. Logs go to `.proxy-stdout.log` and `.proxy-stderr.log`.

## Modes

| Command | Behavior |
|---------|----------|
| `.\switch-provider.ps1 anthropic` | Clear all overrides, use built-in subscription auth |
| `.\switch-provider.ps1 deepseek` | All models via DeepSeek's Anthropic-compatible API |
| `.\switch-provider.ps1 mixed` | Opus → Anthropic, Sonnet/Haiku → DeepSeek (auto-starts proxy) |
| `.\switch-provider.ps1 stop-proxy` | Kill proxy + reset env to Anthropic defaults |

## Architecture

```
Claude Code
    │
    ▼
cc-proxy (localhost:3456)
    │
    ├─ model includes "deepseek" ──► api.deepseek.com/anthropic/v1/messages
    │
    └─ model includes "claude"  ──► api.anthropic.com/v1/messages
```

All other `/v1/*` endpoints (models, token counting, etc.) are proxied to Anthropic. `GET /v1/models` response is modified to include DeepSeek models so Claude Code recognizes them.

## Auth modes

| Mode | `ANTHROPIC_API_KEY` set? | Anthropic auth |
|------|--------------------------|----------------|
| `api-key` | Yes | Uses `ANTHROPIC_API_KEY` |
| `passthrough` | No | Forwards `x-api-key` header (subscription token) |

DeepSeek requests always use `DEEPSEEK_API_KEY`. In `passthrough` mode, client headers are NOT forwarded to DeepSeek (prevents credential leak).

## Model mapping (mixed mode)

| Claude Code role | Model sent | Routed to |
|-----------------|------------|-----------|
| Opus | `claude-opus-4-7` | Anthropic |
| Sonnet | `deepseek-v4-pro` | DeepSeek |
| Haiku | `deepseek-v4-flash` | DeepSeek |
| Subagent | `deepseek-v4-flash` | DeepSeek |

## Manual proxy start

If you prefer to run the proxy separately:

```bash
node server.js
```

Startup output includes a health check that validates the DeepSeek API key against the real API.

## Tests

```bash
node --test server.test.js
```

23 tests covering model routing, auth header correctness, model injection, passthrough mode, and error handling. Mock upstreams simulate Anthropic and DeepSeek.

## License

MIT
