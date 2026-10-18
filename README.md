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

`cc-proxy.sh` mirrors `cc-proxy.ps1` for bash. Put the keys in `~/.config/cc-proxy/env`:

```bash
mkdir -p ~/.config/cc-proxy
printf 'DEEPSEEK_API_KEY=sk-your-key\n' > ~/.config/cc-proxy/env   # optional: ANTHROPIC_API_KEY=...
chmod 600 ~/.config/cc-proxy/env
```

Then **source** it (so the env vars land in your shell) and run `claude`:

```bash
. ./cc-proxy.sh start mixed     # start the proxy + mixed routing
. ./cc-proxy.sh deepseek        # all models via DeepSeek (starts the proxy)
. ./cc-proxy.sh anthropic       # back to Claude Code defaults
. ./cc-proxy.sh status          # proxy state + overrides in this shell
. ./cc-proxy.sh stop            # stop the proxy (all shells) + reset
```

To call it from anywhere, symlink it: `ln -s "$PWD/cc-proxy.sh" ~/.local/bin/cc-proxy.sh`, then `. ~/.local/bin/cc-proxy.sh start mixed`. The script finds the repo through the link. The keys are loaded only into the proxy's process. Your shell gets none of them, in any mode. `CC_PROXY_PORT` and `CC_PROXY_ENV_FILE` override the port (3456) and the key file.

Manual equivalent of mixed mode, without the script:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
# Opus: leave ANTHROPIC_DEFAULT_OPUS_MODEL unset so Claude Code uses its
# latest built-in Opus default (routed to Anthropic via the "claude" match).
# [1m] declares the real 1M window so auto-compact doesn't fire at 200K.
# Claude Code strips the suffix before sending the model ID upstream.
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
# Start proxy (separate terminal or background)
node server.js &
# Launch Claude Code
claude
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (required) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (optional — subscription token forwarded if omitted) |
| `PROXY_PORT` | `3456` | Proxy listen port |
| `REQUEST_TIMEOUT_MS` | `300000` | Upstream request timeout (5 min) |
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
| Opus | latest default (e.g. `claude-opus-4-8`) | Anthropic |
| Sonnet | `deepseek-v4-pro` | DeepSeek |
| Haiku | `deepseek-v4-flash` | DeepSeek |
| Subagent | `deepseek-v4-flash` | DeepSeek |

**1M-context Sonnet handling.** Claude Code's `sonnet[1m]` alias bypasses `ANTHROPIC_DEFAULT_SONNET_MODEL` and sends the raw `claude-sonnet-4-6[1m]` name. The proxy is only in the request path in mixed and DeepSeek-only mode, so it rewrites **every** `claude-sonnet-*` and `claude-haiku-*` name (200k and `[1m]` variants alike) to its DeepSeek target before routing — the `[1m]` suffix is stripped so DeepSeek's API accepts the name. In mixed mode Opus passes through to Anthropic. Targets default to `deepseek-v4-pro` / `deepseek-v4-flash`; override with `PROXY_SONNET_MODEL` / `PROXY_HAIKU_MODEL`.

**Getting the full 1M window.** The Sonnet alias is pinned as `deepseek-v4-pro[1m]`, and so is the main model in DeepSeek-only mode. Behind a gateway, Claude Code can't verify an unrecognized model's capabilities and would budget it at 200K, making auto-compact fire long before the model is actually full. The `[1m]` suffix declares the real window (DeepSeek V4 Pro is 1M), and Claude Code strips the suffix before sending the model ID upstream. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can't substitute for this — it is capped at the window Claude Code already believes the model has.

## DeepSeek-only mode

`deepseek` mode also goes through the proxy, and the launchers start the proxy if it isn't running. A direct connection can't be fixed: DeepSeek rejects request shapes that newer Claude Code versions send (see below), and nothing can rewrite them on the way.

The shell's `ANTHROPIC_AUTH_TOKEN` is the marker `cc-proxy-deepseek-only`, not a key. The DeepSeek key lives only in the proxy. For a client that sends the marker, the proxy:
- sends every model to DeepSeek; a stray Claude model (e.g. Opus) becomes `deepseek-v4-pro`
- sends token counts to DeepSeek's `/v1/messages/count_tokens`
- answers `/v1/models` itself with the DeepSeek models, since DeepSeek has no model list
- answers any other `/v1` call with 404

It never calls Anthropic for that client. Mixed-mode shells are unaffected and can share the same proxy.

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
| `. .\cc-proxy.ps1 -Mode deepseek` | All models via DeepSeek (starts the proxy if needed) |
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

### Mid-conversation tool additions

When a tool connects partway through a session (an MCP server, the notifications tool), Claude Code's `inline-tools` beta announces it with a `tool_addition` block carrying the full `tool_definition`. DeepSeek's Anthropic endpoint only accepts `tool_addition` → `tool_reference` to a tool listed in `tools`, and rejects the whole request otherwise:

```
422 ... messages[3].content: unknown variant `tool_definition`, expected `tool_reference`
```

For DeepSeek-bound requests the proxy moves each definition into `tools`, rewrites the block to a `tool_reference`, and drops references to tools DeepSeek was not given (the log shows `[normalize]`). Anthropic-bound bodies are forwarded unchanged.

This covers DeepSeek-only mode as well, which goes through the proxy. Earlier versions set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` in that mode instead. That's no longer needed, so Claude Code's newer features stay on. The launchers still clear it in every mode.

### Tool schema patterns

DeepSeek validates the regex in every tool's JSON-schema `pattern`, and rejects the `\0` escape that Claude Code's Artifact tool uses (`"^[^\\0]*$"`):

```
400 Invalid schema for function 'Artifact': "^[^\\0]*$" is not a "regex"
```

For DeepSeek-bound requests the proxy rewrites real `\0` escapes to the equivalent `\x00`, in `pattern` values and `patternProperties` keys. An escaped backslash before `0` (`\\0`) and `\0` followed by a digit are left as they are. Every other pattern Claude Code 2.1.302 sends was accepted by DeepSeek as is.

### Token counts

`/v1/messages/count_tokens` goes to the counter of whichever upstream the model routes to (DeepSeek has one). It gets the same DeepSeek fixes as messages, and no injected `max_tokens`.

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

- **More providers**: OpenAI, Groq, local Ollama, vLLM endpoints
- **Model name rewriting**: rename models on the fly (e.g. `claude-sonnet-4-6` → `deepseek-v4-pro`)
- **Load balancing**: distribute requests across multiple keys or endpoints
- **Caching / replay**: store and replay responses for testing
- **Auth plugins**: OAuth, AWS SigV4, custom headers per provider

Pull requests welcome.

## Tests

```bash
npm test    # from the repo folder; elsewhere use: npm --prefix <repo> test
```

Tests cover model routing, auth header correctness, model injection, passthrough mode, DeepSeek tool-addition rewriting, and error handling. Mock upstreams simulate Anthropic and DeepSeek. Run them from the repo folder: the proxy is spawned as `node server.js` relative to the working directory.

## License

MIT
