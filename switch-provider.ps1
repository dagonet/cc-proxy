<#
.SYNOPSIS
    Switches Claude Code between Anthropic (default), DeepSeek, and Mixed (proxy) providers.

.DESCRIPTION
    Three modes plus a control command:
      - anthropic: Clears overrides, uses built-in subscription auth.
      - deepseek:  All models route to DeepSeek's Anthropic-compatible endpoint.
      - mixed:     Routes through a local proxy (cc-proxy) that sends Opus to Anthropic
                   and Sonnet/Haiku to DeepSeek within a single session.
                   Proxy auto-starts if not already running.
      - stop-proxy: Stops the auto-started proxy process.

    Run BEFORE launching `claude`. Changes apply to the current PowerShell session.

.PARAMETER Provider
    Which provider to activate: 'anthropic', 'deepseek', or 'mixed'.

.EXAMPLE
    . .\switch-provider.ps1 mixed
    claude

.EXAMPLE
    . .\switch-provider.ps1 stop-proxy

.NOTES
    Prerequisites:
      - For deepseek and mixed: DEEPSEEK_API_KEY user env var must be set.
      - For mixed: optionally set ANTHROPIC_API_KEY user env var for API-key mode.
        If omitted, proxy passes through subscription auth for Anthropic-bound requests.
      - For mixed: proxy auto-starts if not already running. Stop with .\switch-provider.ps1 stop-proxy
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('anthropic', 'deepseek', 'mixed', 'stop-proxy')]
    [string]$Provider
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

if ($Provider -eq 'stop-proxy') {
    $pidFile = Join-Path $PSScriptRoot '.proxy-pid'
    if (Test-Path $pidFile) {
        $raw = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
        $proxyPid = if ($raw) { $raw.Trim() } else { '' }
        if ($proxyPid -and $proxyPid -ne $PID) {
            try { Stop-Process -Id $proxyPid -Force -ErrorAction Stop; Write-Host "Proxy stopped (pid $proxyPid)." -ForegroundColor Yellow }
            catch { Write-Host "Proxy process $proxyPid not found (already stopped)." -ForegroundColor DarkGray }
        } else {
            Write-Host "Proxy PID is invalid or matches current process -- skipping." -ForegroundColor Yellow
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    } elseif (Test-ProxyRunning) {
        Write-Host "Proxy is running on port $proxyPort but no PID file found." -ForegroundColor Yellow
        $listener = Get-NetTCPConnection -LocalPort $proxyPort -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener -and $listener.OwningProcess) {
            $foundPid = $listener.OwningProcess
            try { Stop-Process -Id $foundPid -Force -ErrorAction Stop; Write-Host "Proxy stopped (pid $foundPid, found via port $proxyPort)." -ForegroundColor Yellow }
            catch { Write-Host "Failed to stop pid $foundPid — check manually." -ForegroundColor Red }
        } else {
            Write-Host "  Could not identify process on port $proxyPort." -ForegroundColor Red
        }
    } else {
        Write-Host "Proxy is not running." -ForegroundColor DarkGray
    }

    # Also reset env to Anthropic defaults
    foreach ($var in $managedVars) {
        Remove-Item "env:$var" -ErrorAction SilentlyContinue
    }
    Write-Host "Session reset to Anthropic defaults." -ForegroundColor Cyan
    return
}

if ($Provider -eq 'mixed' -and -not (Test-ProxyRunning)) {
    $serverScript = Join-Path $PSScriptRoot 'server.js'
    if (-not (Test-Path $serverScript)) {
        Write-Error "server.js not found at $serverScript"
        return
    }
    Write-Host "Starting proxy server..." -ForegroundColor DarkGray -NoNewline
    $outLog = Join-Path $PSScriptRoot '.proxy-stdout.log'
    $errLog = Join-Path $PSScriptRoot '.proxy-stderr.log'
    $proc = Start-Process -FilePath 'node' -ArgumentList $serverScript `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $proc.Pid | Out-File -FilePath (Join-Path $PSScriptRoot '.proxy-pid') -NoNewline

    # Wait for proxy to be ready (health check)
    $timeout = 15
    while ($timeout -gt 0 -and -not (Test-ProxyRunning)) {
        Start-Sleep -Seconds 1
        $timeout--
    }
    if (Test-ProxyRunning) {
        Write-Host " ready (pid $($proc.Id))" -ForegroundColor Green
    } else {
        Write-Warning "Proxy did not respond within 15s -- check the proxy terminal."
    }
}

# Always clear ALL managed vars first, then set only what the mode needs.
foreach ($var in $managedVars) {
    Remove-Item "env:$var" -ErrorAction SilentlyContinue
}

switch ($Provider) {
    'anthropic' {
        Write-Host "Claude Code session reset to Anthropic defaults (overrides cleared)." -ForegroundColor Cyan
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

        Write-Host "Claude Code configured for DeepSeek (all models)." -ForegroundColor Green
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
        $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = 'claude-opus-4-7'
        $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
        $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = 'deepseek-v4-flash'
        $env:CLAUDE_CODE_SUBAGENT_MODEL     = 'deepseek-v4-flash'
        $env:CLAUDE_CODE_EFFORT_LEVEL       = 'max'

        Write-Host "Claude Code configured for MIXED mode (proxy at 127.0.0.1:3456)." -ForegroundColor Magenta
        Write-Host "  Opus    -> Anthropic (claude-opus-4-7)"
        Write-Host "  Sonnet  -> DeepSeek (deepseek-v4-pro)"
        Write-Host "  Haiku   -> DeepSeek (deepseek-v4-flash)"
        Write-Host "  Subagent -> DeepSeek (deepseek-v4-flash)"
        if ($usingApiKey) {
            Write-Host "  Anthropic auth -> API key (ANTHROPIC_API_KEY)"
        } else {
            Write-Host "  Anthropic auth -> passthrough (subscription token)"
        }
        if (Test-ProxyRunning) {
            Write-Host ""
            Write-Host "Proxy is running at 127.0.0.1:$proxyPort (logs: .proxy-stdout.log .proxy-stderr.log)" -ForegroundColor DarkGray
        }
    }
}

# Verification
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
    Write-Host "  (none -- using Claude Code defaults)"
}
