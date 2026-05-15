# cc-proxy

A configurable mixed-model proxy for Claude Code. Route different models to different providers within a single session — mix Anthropic, DeepSeek, local LLMs, or any OpenAI-compatible endpoint.

## Why

Claude Code normally talks to one provider. This proxy sits between Claude Code and the world, inspecting each request's model name and routing it to the right upstream. You pick which model goes where.

Example: a Claude Code subscription grants Opus access. Run Opus on Anthropic, send Sonnet-class requests to DeepSeek — faster and cheaper. Or route coding tasks to a local GPU model while keeping reasoning on a cloud provider.

## How it works

```
Claude Code
    │  ANTHROPIC_BASE_URL=http://127.0.0.1:3456
    ▼
cc-proxy (localhost:3456)
    │
    ├─ model matches "deepseek" ──► api.deepseek.com/anthropic
    │
    ├─ model matches "claude"   ──► api.anthropic.com
    │
    └─ model matches "local-*"  ──► http://localhost:8080/v1  (future)
```

Routing is determined by the model name in each request body. The proxy also handles other `/v1/*` endpoints (model listing, token counting) and injects custom model entries so Claude Code recognizes all providers.

## Quick start (Windows + PowerShell)

```powershell
# Set API keys (once, persistent)
[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-your-key', 'User')

# Clone and run
git clone https://github.com/dagonet/cc-proxy.git
cd cc-proxy
. .\switch-provider.ps1 mixed   # auto-starts proxy + configures env
claude                           # launch Claude Code
. .\switch-provider.ps1 stop-proxy  # stop + reset
```

The proxy auto-starts in a hidden window. Logs go to `.proxy-stdout.log` and `.proxy-stderr.log`.

### Linux / Mac

The proxy itself (`server.js`) is plain Node.js — runs anywhere. The `switch-provider.ps1` script is Windows-only; on Linux/Mac, set the env vars and start the proxy manually:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
# Start proxy (separate terminal or background)
node server.js &
# Launch Claude Code
claude
```

A `switch-provider.sh` for Linux/Mac is a welcome contribution.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (required) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (optional — subscription token forwarded if omitted) |
| `PROXY_PORT` | `3456` | Proxy listen port |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout (2 min) |
| `MAX_BODY_SIZE_MB` | `10` | Max request body size |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com/v1/messages` | Anthropic endpoint |
| `DEEPSEEK_UPSTREAM_URL` | `https://api.deepseek.com/anthropic/v1/messages` | DeepSeek endpoint |
| `ANTHROPIC_BASE_URL_OVERRIDE` | `https://api.anthropic.com` | Base URL for non-messages endpoints |

### Custom routing rules

The routing function is in `server.js`:

```js
function routeRequest(model) {
  if (model && model.includes('deepseek')) return 'deepseek';
  if (model && model.includes('claude'))   return 'anthropic';
  return null;
}
```

Modify this to add new providers — local LLMs, OpenAI-compatible endpoints, anything. Define the upstream URL and API key mapping in `getUpstreamConfig()`, and add the model name to the injected list in `proxyModels()`.

## Auth modes

| Mode | `ANTHROPIC_API_KEY` set? | Anthropic auth |
|------|--------------------------|----------------|
| `api-key` | Yes | Uses `ANTHROPIC_API_KEY` |
| `passthrough` | No | Forwards `x-api-key` header (subscription token) |

DeepSeek requests always use `DEEPSEEK_API_KEY`. In passthrough mode, client headers are not forwarded to DeepSeek to prevent credential leaks.

## Current example: Anthropic + DeepSeek (mixed mode)

| Claude Code role | Model sent | Routed to |
|-----------------|------------|-----------|
| Opus | `claude-opus-4-7` | Anthropic |
| Sonnet | `deepseek-v4-pro` | DeepSeek |
| Haiku | `deepseek-v4-flash` | DeepSeek |
| Subagent | `deepseek-v4-flash` | DeepSeek |

Switch modes on the fly:

| Command | Behavior |
|---------|----------|
| `switch-provider anthropic` | Clear overrides, use built-in subscription auth |
| `switch-provider deepseek` | All models via DeepSeek |
| `switch-provider mixed` | Opus → Anthropic, rest → DeepSeek |
| `switch-provider stop-proxy` | Kill proxy + reset env |

## Extending

This is a first approach. Ideas for extension:

- **Linux/Mac launcher**: `switch-provider.sh` with equivalent functionality
- **More providers**: OpenAI, Groq, local Ollama, vLLM endpoints
- **Model name rewriting**: rename models on the fly (e.g. `claude-sonnet-4-6` → `deepseek-v4-pro`)
- **Load balancing**: distribute requests across multiple keys or endpoints
- **Caching / replay**: store and replay responses for testing
- **Auth plugins**: OAuth, AWS SigV4, custom headers per provider

Pull requests welcome.

## Tests

```bash
node --test server.test.js
```

23 tests covering model routing, auth header correctness, model injection, passthrough mode, and error handling. Mock upstreams simulate Anthropic and DeepSeek.

## License

MIT
