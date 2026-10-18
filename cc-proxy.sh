# cc-proxy launcher for Linux/Mac (bash). Mirrors cc-proxy.ps1.
#
# Source it, so the model settings land in the shell that then runs `claude`:
#   . ./cc-proxy.sh start mixed     # start the proxy + mixed routing
#   . ./cc-proxy.sh deepseek        # all models via DeepSeek (no proxy)
#   . ./cc-proxy.sh anthropic       # back to Claude Code defaults
#   . ./cc-proxy.sh stop            # stop the proxy (all shells) + reset
#   . ./cc-proxy.sh status
#
# Keys live in ~/.config/cc-proxy/env (chmod 600), lines like:
#   DEEPSEEK_API_KEY=sk-...
#   ANTHROPIC_API_KEY=sk-ant-...   # optional; without it the subscription token is passed through

_ccp_main() {
    local repo port keyfile
    repo="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
    port="${CC_PROXY_PORT:-3456}"
    keyfile="${CC_PROXY_ENV_FILE:-$HOME/.config/cc-proxy/env}"
    local action="" mode="" arg
    for arg in "$@"; do
        case "$arg" in
            start|stop|status) action="$arg" ;;
            anthropic|deepseek|mixed) mode="$arg" ;;
            *) echo "cc-proxy: unknown argument '$arg'" >&2; return 2 ;;
        esac
    done
    if [ -z "$action" ] && [ -z "$mode" ]; then
        sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        return 0
    fi

    _ccp_running() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
    _ccp_key() { [ -r "$keyfile" ] && (set -a; . "$keyfile"; printenv "$1"); }
    _ccp_clear() {
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
              ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL \
              CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ANTHROPIC_SMALL_FAST_MODEL
    }

    case "$action" in
        stop)
            if [ -f "$repo/.proxy-pid" ] && kill "$(cat "$repo/.proxy-pid")" 2>/dev/null; then
                local i
                for i in 1 2 3 4 5 6 7 8 9 10; do _ccp_running || break; sleep 0.3; done
                echo "Proxy stopped (affects every shell using 127.0.0.1:$port)."
            else
                echo "Proxy was not running."
            fi
            rm -f "$repo/.proxy-pid"
            _ccp_clear
            echo "Model overrides cleared: Claude Code defaults."
            return 0
            ;;
        status)
            if _ccp_running; then echo "Proxy running on 127.0.0.1:$port. Log: $repo/.logs/proxy-stdout.log"
            else echo "Proxy not running."; fi
            env | grep -E '^(ANTHROPIC_(BASE_URL|MODEL|DEFAULT_[A-Z]+_MODEL|SMALL_FAST_MODEL)|CLAUDE_CODE_(SUBAGENT_MODEL|EFFORT_LEVEL|DISABLE_EXPERIMENTAL_BETAS))=' \
                || echo "No model overrides in this shell."
            return 0
            ;;
        start)
            if _ccp_running; then
                echo "Proxy already running on 127.0.0.1:$port."
            else
                if [ -z "$(_ccp_key DEEPSEEK_API_KEY)" ]; then
                    echo "cc-proxy: DEEPSEEK_API_KEY missing in $keyfile" >&2; return 1
                fi
                mkdir -p "$repo/.logs"
                local base i
                for base in proxy-stdout proxy-stderr; do
                    for i in 8 7 6 5 4 3 2 1 0; do
                        [ -f "$repo/.logs/$base.$i.log" ] && mv -f "$repo/.logs/$base.$i.log" "$repo/.logs/$base.$((i + 1)).log"
                    done
                    [ -f "$repo/.logs/$base.log" ] && mv -f "$repo/.logs/$base.log" "$repo/.logs/$base.0.log"
                done
                (
                    cd "$repo" || exit 1
                    # The keys reach only the proxy's process, not this shell.
                    set -a; . "$keyfile"; set +a
                    PROXY_PORT="$port" setsid nohup node server.js >"$repo/.logs/proxy-stdout.log" 2>"$repo/.logs/proxy-stderr.log" </dev/null &
                    echo $! >"$repo/.proxy-pid"
                )
                for i in 1 2 3 4 5 6 7 8 9 10; do _ccp_running && break; sleep 0.3; done
                if _ccp_running; then echo "Proxy started on 127.0.0.1:$port. Log: $repo/.logs/proxy-stdout.log"
                else echo "cc-proxy: proxy did not come up; see $repo/.logs/proxy-stderr.log" >&2; return 1; fi
            fi
            ;;
    esac

    case "$mode" in
        anthropic)
            _ccp_clear
            echo "Claude Code defaults (Anthropic subscription), no proxy needed."
            ;;
        deepseek)
            local key; key="$(_ccp_key DEEPSEEK_API_KEY)"
            if [ -z "$key" ]; then echo "cc-proxy: DEEPSEEK_API_KEY missing in $keyfile" >&2; return 1; fi
            _ccp_clear
            export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
            export ANTHROPIC_AUTH_TOKEN="$key"
            export ANTHROPIC_MODEL=deepseek-v4-pro
            # [1m] declares the real 1M window; Claude Code strips it before sending.
            export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-v4-pro[1m]'
            export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro[1m]'
            export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
            export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
            export CLAUDE_CODE_EFFORT_LEVEL=max
            # No proxy in the path: stop the tool_addition blocks DeepSeek rejects (422).
            export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
            echo "DeepSeek for all models (direct, no proxy)."
            ;;
        mixed)
            if [ -z "$(_ccp_key DEEPSEEK_API_KEY)" ]; then
                echo "cc-proxy: DEEPSEEK_API_KEY missing in $keyfile" >&2; return 1
            fi
            _ccp_clear
            export ANTHROPIC_BASE_URL="http://127.0.0.1:$port"
            [ -n "$(_ccp_key ANTHROPIC_API_KEY)" ] && export ANTHROPIC_AUTH_TOKEN=proxy-placeholder
            # Opus stays unset: Claude Code's latest default Opus routes to Anthropic.
            export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro[1m]'
            export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
            export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
            export CLAUDE_CODE_EFFORT_LEVEL=max
            echo "Mixed: Opus -> Anthropic; Sonnet, Haiku, sub-agents -> DeepSeek (via proxy 127.0.0.1:$port)."
            _ccp_running || echo "Warning: the proxy is not running; add 'start'." >&2
            ;;
    esac
}
_ccp_main "$@"
_ccp_rc=$?
unset -f _ccp_main _ccp_running _ccp_key _ccp_clear
eval "unset _ccp_rc; return $_ccp_rc 2>/dev/null || exit $_ccp_rc"
