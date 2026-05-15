# cc-proxy

Mixed-model proxy for Claude Code. Route Opus models to Anthropic and Sonnet/Haiku to DeepSeek within a single session.

## Why

Claude Code subscriptions include Opus access but routing all models through Anthropic is expensive. DeepSeek's Anthropic-compatible API supports Sonnet-level models at lower cost. This proxy lets you split traffic — keep Opus on Anthropic, send everything else to DeepSeek.

## Architecture

```
Claude Code
    │
    ▼
cc-proxy (localhost:3456)
    │
    ├─ model includes "deepseek" ──► api.deepseek.com/anthropic
    │
    └─ model includes "claude"  ──► api.anthropic.com
```

Model routing is determined by the model name in the request body:
- `claude-*` → Anthropic
- `deepseek-*` → DeepSeek

## Prerequisites

- Node.js 18+
- DeepSeek API key (required)
- Anthropic API key (optional — only needed if not using a Claude Code subscription)

## Setup

```bash
git clone <repo-url>
cd cc-proxy
npm install  # only needs node:http — no external deps
```

Set environment variables:

```bash
# Required
export DEEPSEEK_API_KEY=sk-your-deepseek-key

# Optional — only if using an Anthropic API key instead of subscription
export ANTHROPIC_API_KEY=sk-ant-your-key
```

Optional config:

```bash
export PROXY_PORT=3456              # default
export REQUEST_TIMEOUT_MS=120000    # default (2 min)
export MAX_BODY_SIZE_MB=10          # default
```

## Usage

### Start the proxy

```bash
node server.js
```

### Configure Claude Code

Use `switch-provider.ps1` (PowerShell) to set the required environment variables before launching `claude`:

```powershell
# Three modes:

# 1. Anthropic defaults (clears all overrides)
. .\switch-provider.ps1 anthropic

# 2. All models through DeepSeek
. .\switch-provider.ps1 deepseek

# 3. Mixed mode — Opus to Anthropic, Sonnet/Haiku to DeepSeek
. .\switch-provider.ps1 mixed
```

Then launch Claude Code:

```bash
claude
```

### Mixed mode with subscription

If you have a Claude Code subscription (no API key), the proxy auto-detects this and passes through your subscription auth to Anthropic:

```bash
# Only DEEPSEEK_API_KEY set — ANTHROPIC_API_KEY not needed
export DEEPSEEK_API_KEY=sk-your-deepseek-key
node server.js
# Log shows: Anthropic auth: passthrough
```

The proxy forwards your Claude Code subscription token to Anthropic transparently.

### Mixed mode with API key

If you have an Anthropic API key, set it and the proxy uses it directly:

```bash
export DEEPSEEK_API_KEY=sk-your-deepseek-key
export ANTHROPIC_API_KEY=sk-ant-your-key
node server.js
# Log shows: Anthropic auth: api-key
```

## Auth modes

| Mode | `ANTHROPIC_API_KEY` set? | Anthropic auth |
|------|--------------------------|----------------|
| `api-key` | Yes | Uses `ANTHROPIC_API_KEY` env var |
| `passthrough` | No | Forwards incoming `x-api-key` header (subscription token) |

DeepSeek requests always use `DEEPSEEK_API_KEY` regardless of mode.

## Model mapping (mixed mode)

| Claude Code role | Model sent | Routed to |
|-----------------|------------|-----------|
| Opus | `claude-opus-4-7` | Anthropic |
| Sonnet | `deepseek-v4-pro[1m]` | DeepSeek |
| Haiku | `deepseek-v4-flash` | DeepSeek |
| Subagent | `deepseek-v4-flash` | DeepSeek |

## API

The proxy exposes a single endpoint compatible with the Anthropic Messages API:

```
POST http://127.0.0.1:3456/v1/messages
```

Set `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` in Claude Code to route through the proxy.

## License

MIT
