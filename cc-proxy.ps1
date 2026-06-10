<#
.SYNOPSIS
    Configure Claude Code to use Anthropic, DeepSeek, or mixed models via cc-proxy.

.DESCRIPTION
    Actions:
      start  -- Start the cc-proxy process (if not already running).
      stop   -- Stop the proxy process and reset env to Anthropic defaults.

    Modes (-Mode):
      anthropic -- Clear overrides, use built-in Claude Code defaults.
      deepseek  -- Route ALL models to DeepSeek (Anthropic-compatible endpoint).
      mixed     -- Route Opus to Anthropic, Sonnet/Haiku/subagents to DeepSeek.
                  Requires the proxy to be running.

    Action and Mode can be combined:  . .\cc-proxy.ps1 start -Mode mixed

    Dot-source to apply to current PowerShell session. Run BEFORE launching `claude`.

.PARAMETER Action
    'start' to start the proxy, 'stop' to stop it.

.PARAMETER Mode
    Model routing mode: 'anthropic', 'deepseek', or 'mixed'.

.PARAMETER Force
    Skip stop confirmation prompt.

.PARAMETER Help
    Show detailed help and exit.

.EXAMPLE
    . .\cc-proxy.ps1 start -Mode mixed
    claude

.EXAMPLE
    . .\cc-proxy.ps1 -Mode deepseek

.EXAMPLE
    . .\cc-proxy.ps1 stop

.EXAMPLE
    . .\cc-proxy.ps1                    # show help
    . .\cc-proxy.ps1 -Help             # show help

.NOTES
    Requires DEEPSEEK_API_KEY user env var for deepseek and mixed modes.
    Optionally set ANTHROPIC_API_KEY for API-key mode; omit for passthrough auth.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop')]
    [string]$Action,

    [Parameter()]
    [ValidateSet('anthropic', 'deepseek', 'mixed')]
    [string]$Mode,

    [Parameter()]
    [switch]$Force,

    [Parameter()]
    [switch]$Help
)

$proxyPort = 3456

$managedVars = @(
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'ANTHROPIC_SMALL_FAST_MODEL'
)

function Test-ProxyRunning {
    try {
        $conn = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $proxyPort)
        $conn.Close()
        $conn.Dispose()
        return $true
    } catch {
        return $false
    }
}

function Show-Help {
    Write-Host "cc-proxy -- Claude Code multi-provider launcher" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor White
    Write-Host '  . .\cc-proxy.ps1 start|stop -Mode anthropic|deepseek|mixed -Force'
    Write-Host ""
    Write-Host "Actions:" -ForegroundColor White
    Write-Host "  start       Start the proxy on 127.0.0.1:${proxyPort}. No-op if already running."
    Write-Host "  stop        Stop the proxy + reset env to Anthropic defaults."
    Write-Host "              Prompts for confirmation unless -Force is used."
    Write-Host ""
    Write-Host "Modes -Mode:" -ForegroundColor White
    Write-Host "  anthropic   Use Claude Code defaults - Anthropic subscription."
    Write-Host "              Clears all overrides. No proxy needed."
    Write-Host ""
    Write-Host "  deepseek    Route ALL models to DeepSeek."
    Write-Host "              Opus, Sonnet, Haiku, subagents -> deepseek-v4-pro / v4-flash"
    Write-Host "              Requires: DEEPSEEK_API_KEY"
    Write-Host ""
    Write-Host "  mixed       Mix providers within one session."
    Write-Host "              Opus    -> Anthropic latest default"
    Write-Host "              Sonnet  -> DeepSeek deepseek-v4-pro"
    Write-Host "              Haiku   -> DeepSeek deepseek-v4-flash"
    Write-Host "              Subagent-> DeepSeek deepseek-v4-flash"
    Write-Host "              Requires: DEEPSEEK_API_KEY"
    Write-Host "              Optional: ANTHROPIC_API_KEY, passthrough auth if omitted"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor White
    Write-Host "  . .\cc-proxy.ps1 start -Mode mixed    # Start proxy + mixed routing"
    Write-Host "  . .\cc-proxy.ps1 -Mode deepseek       # DeepSeek-only, no proxy"
    Write-Host "  . .\cc-proxy.ps1 -Mode anthropic      # Reset to defaults"
    Write-Host "  . .\cc-proxy.ps1 stop                 # Stop proxy + reset"
    Write-Host "  . .\cc-proxy.ps1 stop -Force          # Stop without confirmation"
    Write-Host ""
    Write-Host "Parallel use: env vars are per-shell. Proxy is a single shared process"
    Write-Host "on port $proxyPort. Multiple shells can route through the same proxy with"
    Write-Host "different model mappings. 'stop' affects ALL shells using the proxy."
    Write-Host ""
    Write-Host "Docs: https://github.com/dagonet/cc-proxy"
}

function Stop-Proxy {
    $pidFile = Join-Path $PSScriptRoot '.proxy-pid'
    if (Test-Path $pidFile) {
        $raw = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
        $proxyPid = if ($raw) { $raw.Trim() } else { '' }
        if ($proxyPid -and $proxyPid -ne $PID) {
            try { Stop-Process -Id $proxyPid -Force -ErrorAction Stop; Write-Host "Proxy stopped, pid $proxyPid." -ForegroundColor Yellow }
            catch { Write-Host "Proxy process $proxyPid not found, already stopped." -ForegroundColor DarkGray }
        } else {
            Write-Host "Proxy PID is invalid or matches current process -- skipping." -ForegroundColor Yellow
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    } elseif (Test-ProxyRunning) {
        Write-Host "Proxy is running on port $proxyPort but no PID file found." -ForegroundColor Yellow
        $listener = Get-NetTCPConnection -LocalPort $proxyPort -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener -and $listener.OwningProcess) {
            $foundPid = $listener.OwningProcess
            try { Stop-Process -Id $foundPid -Force -ErrorAction Stop; Write-Host "Proxy stopped, pid $foundPid, found via port $proxyPort." -ForegroundColor Yellow }
            catch { Write-Host "Failed to stop pid $foundPid - check manually." -ForegroundColor Red }
        } else {
            Write-Host "  Could not identify process on port $proxyPort." -ForegroundColor Red
        }
    } else {
        Write-Host "Proxy is not running." -ForegroundColor DarkGray
    }

    foreach ($var in $managedVars) {
        Remove-Item "env:$var" -ErrorAction SilentlyContinue
    }
    Write-Host "Session reset to Anthropic defaults." -ForegroundColor Cyan
}

function Start-Proxy {
    if (Test-ProxyRunning) {
        Write-Host "Proxy already running on 127.0.0.1:$proxyPort." -ForegroundColor DarkGray
        return
    }

    $serverScript = Join-Path $PSScriptRoot 'server.js'
    if (-not (Test-Path $serverScript)) {
        Write-Error "server.js not found at $serverScript"
        return
    }

    Write-Host "Starting proxy server..." -ForegroundColor DarkGray -NoNewline

    $logsDir = Join-Path $PSScriptRoot '.logs'
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force > $null }

    $outLog = Join-Path $logsDir 'proxy-stdout.log'
    $errLog = Join-Path $logsDir 'proxy-stderr.log'

    # Rotate logs: keep last 10 of each
    foreach ($base in @('proxy-stdout', 'proxy-stderr')) {
        $last = Join-Path $logsDir "${base}.9.log"
        if (Test-Path $last) { Remove-Item $last -Force }
        for ($i = 8; $i -ge 0; $i--) {
            $old = Join-Path $logsDir "${base}.${i}.log"
            $new = Join-Path $logsDir "${base}.$($i + 1).log"
            if (Test-Path $old) { Move-Item $old $new -Force }
        }
        $current = Join-Path $logsDir "${base}.log"
        if (Test-Path $current) { Move-Item $current (Join-Path $logsDir "${base}.0.log") -Force }
    }

    $proc = Start-Process -FilePath 'node' -ArgumentList $serverScript `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $proc.Id | Out-File -FilePath (Join-Path $PSScriptRoot '.proxy-pid') -NoNewline

    $timeout = 15
    while ($timeout -gt 0 -and -not (Test-ProxyRunning)) {
        Start-Sleep -Seconds 1
        $timeout--
    }
    if (Test-ProxyRunning) {
        Write-Host " ready, pid $($proc.Id)" -ForegroundColor Green
    } else {
        Write-Warning "Proxy did not respond within 15s -- check .logs/proxy-stderr.log"
    }
}

function Set-Mode {
    param([string]$Mode)

    foreach ($var in $managedVars) {
        Remove-Item "env:$var" -ErrorAction SilentlyContinue
    }

    switch ($Mode) {
        'anthropic' {
            Write-Host "Claude Code session reset to Anthropic defaults, overrides cleared." -ForegroundColor Cyan
        }

        'deepseek' {
            $apiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
            if ([string]::IsNullOrWhiteSpace($apiKey)) {
                Write-Error "DEEPSEEK_API_KEY is not set as a user environment variable."
                Write-Error "Set it with: [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-...', 'User'), then restart PowerShell."
                return
            }

            $env:ANTHROPIC_BASE_URL             = 'https://api.deepseek.com/anthropic'
            $env:ANTHROPIC_AUTH_TOKEN           = $apiKey
            $env:ANTHROPIC_MODEL                = 'deepseek-v4-pro'
            $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = 'deepseek-v4-pro'
            $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
            $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = 'deepseek-v4-flash'
            $env:CLAUDE_CODE_SUBAGENT_MODEL     = 'deepseek-v4-flash'
            $env:CLAUDE_CODE_EFFORT_LEVEL       = 'max'

            Write-Host "Claude Code configured for DeepSeek, all models." -ForegroundColor Green
        }

        'mixed' {
            $deepseekKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
            if ([string]::IsNullOrWhiteSpace($deepseekKey)) {
                Write-Error "DEEPSEEK_API_KEY is not set as a user environment variable."
                return
            }

            $anthropicKey = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
            $usingApiKey = -not [string]::IsNullOrWhiteSpace($anthropicKey)

            $env:ANTHROPIC_BASE_URL             = 'http://127.0.0.1:3456'
            if ($usingApiKey) {
                $env:ANTHROPIC_AUTH_TOKEN       = 'proxy-placeholder'
            }
            # Opus: leave ANTHROPIC_DEFAULT_OPUS_MODEL unset so Claude Code
            # uses its built-in latest Opus default (routes to Anthropic via
            # the 'claude' name match). Cleared at top of Set-Mode already.
            $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
            $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = 'deepseek-v4-flash'
            $env:CLAUDE_CODE_SUBAGENT_MODEL     = 'deepseek-v4-flash'
            $env:CLAUDE_CODE_EFFORT_LEVEL       = 'max'

            Write-Host "Claude Code configured for MIXED mode, proxy at 127.0.0.1:3456." -ForegroundColor Magenta
            Write-Host '  Opus    -> Anthropic latest default'
            Write-Host "  Sonnet  -> DeepSeek deepseek-v4-pro"
            Write-Host "  Haiku   -> DeepSeek deepseek-v4-flash"
            Write-Host "  Subagent -> DeepSeek deepseek-v4-flash"
            if ($usingApiKey) {
                Write-Host "  Anthropic auth -> API key, ANTHROPIC_API_KEY"
            } else {
                Write-Host "  Anthropic auth -> passthrough, subscription token"
            }

            if (-not (Test-ProxyRunning)) {
                Write-Warning "Proxy is not running on 127.0.0.1:${proxyPort}. Use 'start' to start it."
                Write-Warning "Requests to proxy will fail until the proxy is started."
            } else {
                Write-Host ""
                Write-Host "Proxy is running at 127.0.0.1:${proxyPort}. Logs: .logs/" -ForegroundColor DarkGray
            }
        }
    }
}

function Show-Verification {
    Write-Host ""
    Write-Host "Active overrides:" -ForegroundColor DarkGray
    $any = $false
    foreach ($var in $managedVars) {
        $value = [Environment]::GetEnvironmentVariable($var, 'Process')
        if ($value) {
            $any = $true
            if ($var -eq 'ANTHROPIC_AUTH_TOKEN') {
                $masked = if ($value.Length -gt 8) { $value.Substring(0, 6) + '...' } else { '***' }
                Write-Host "  $var = $masked"
            } else {
                Write-Host "  $var = $value"
            }
        }
    }
    if (-not $any) {
        Write-Host "  none -- using Claude Code defaults"
    }
}

# ---- Main ----

if ($Help) {
    Show-Help
    return
}

if (-not $Action -and -not $Mode) {
    Show-Help
    return
}

# Stop action
if ($Action -eq 'stop') {
    if (Test-ProxyRunning) {
        if (-not $Force) {
            Write-Warning "Stopping the proxy affects ALL shells using 127.0.0.1:${proxyPort}."
            $confirm = Read-Host "Stop proxy? (y/N)"
            if ($confirm -notmatch '^[yY]') {
                Write-Host "Aborted." -ForegroundColor DarkGray
                return
            }
        }
    }
    Stop-Proxy
    Show-Verification
    return
}

# Start action
if ($Action -eq 'start') {
    Start-Proxy
}

# Mode
if ($Mode) {
    Set-Mode -Mode $Mode
    Show-Verification
}
