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
. .\cc-proxy.ps1 start -Mode mixed  # start proxy + configure mixed mode
claude                               # launch Claude Code
. .\cc-proxy.ps1 stop                # stop proxy + reset env
```

The proxy runs as a hidden background process. Logs go to `.logs/proxy-stdout.log` (rolling, last 10 kept).

### Linux / Mac

The proxy itself (`server.js`) is plain Node.js — runs anywhere. The `cc-proxy.ps1` script is Windows-only; on Linux/Mac, set the env vars and start the proxy manually:

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

A `cc-proxy.sh` for Linux/Mac is a welcome contribution.

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

## CLI

```
. .\cc-proxy.ps1 [start|stop] [-Mode anthropic|deepseek|mixed] [-Force]
```

Dot-source to apply env vars to the current PowerShell session. Run BEFORE `claude`.

| Command | Behavior |
|---------|----------|
| `. .\cc-proxy.ps1` | Show help |
| `. .\cc-proxy.ps1 start` | Start the proxy (no-op if already running) |
| `. .\cc-proxy.ps1 start -Mode mixed` | Start proxy + configure mixed routing |
| `. .\cc-proxy.ps1 -Mode mixed` | Configure mixed mode (warns if proxy not running) |
| `. .\cc-proxy.ps1 -Mode deepseek` | All models via DeepSeek (no proxy needed) |
| `. .\cc-proxy.ps1 -Mode anthropic` | Clear overrides, use built-in defaults |
| `. .\cc-proxy.ps1 stop` | Stop proxy + reset env (prompts for confirmation) |
| `. .\cc-proxy.ps1 stop -Force` | Stop without confirmation prompt |

`start` and `-Mode` can be combined or used separately. `-Mode mixed` warns if the proxy isn't running since requests would fail.

## Verifying routing

Every proxied request logs one line to `.logs/proxy-stdout.log`:

```
2026-05-17T09:20:43Z #1 [deepseek] model=deepseek-v4-pro status=200
2026-05-17T09:20:43Z #2 [anthropic] model=claude-opus-4-7 status=200
2026-05-17T09:20:44Z #3 [deepseek] model=deepseek-v4-flash status=200
```

Format: `{ISO timestamp} #{request counter} [{route}] model={model} status={http status}`

The `[deepseek]` or `[anthropic]` tag is the actual backend that handled the request. This is the ground truth — if a coder agent sends `deepseek-v4-pro` and the log shows `[deepseek]`, it went to DeepSeek.

**Verification workflow:**
```powershell
# Tail the log in one terminal
Get-Content .logs/proxy-stdout.log -Wait

# Trigger a coder agent in Claude Code, then check for:
# [deepseek] model=deepseek-v4-pro status=200
```

Errors include the response body (truncated to 500 chars). Timeouts and connection failures are logged separately.

### max_tokens injection

Anthropic's API requires `max_tokens`; DeepSeek's does not. When Claude Code targets a DeepSeek model it may omit `max_tokens`. The proxy auto-injects `max_tokens: 4096` when routing to Anthropic if the field is missing.

## Parallel sessions

Env vars set by `cc-proxy.ps1` are **per-shell** (process scope). The proxy process (`server.js`) is **shared** — a single instance on `127.0.0.1:3456`.

This means:
- Multiple shells can use different model mappings through the same proxy
- `start` is a no-op if the proxy is already running
- `stop` affects **all** shells — the confirmation prompt warns about this
- `start` from one shell, `-Mode` from another: both work

## Extending

This is a first approach. Ideas for extension:

- **Linux/Mac launcher**: `cc-proxy.sh` with equivalent functionality
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
