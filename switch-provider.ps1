<#
.SYNOPSIS
    Switches Claude Code between Anthropic (default), DeepSeek, and Mixed (proxy) providers.

.DESCRIPTION
    Three modes:
      - anthropic: Clears overrides, uses built-in subscription auth.
      - deepseek:  All models route to DeepSeek's Anthropic-compatible endpoint.
      - mixed:     Routes through a local proxy (cc-proxy) that sends Opus to Anthropic
                   and Sonnet/Haiku to DeepSeek within a single session.

    Run BEFORE launching `claude`. Changes apply to the current PowerShell session.

.PARAMETER Provider
    Which provider to activate: 'anthropic', 'deepseek', or 'mixed'.

.EXAMPLE
    . .\switch-provider.ps1 mixed
    claude

.NOTES
    Prerequisites:
      - For deepseek and mixed: DEEPSEEK_API_KEY user env var must be set.
      - For mixed: optionally set ANTHROPIC_API_KEY user env var for API-key mode.
        If omitted, proxy passes through subscription auth for Anthropic-bound requests.
      - For mixed only: cc-proxy server must be running (node server.js).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('anthropic', 'deepseek', 'mixed')]
    [string]$Provider
)

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
        $env:ANTHROPIC_MODEL                = 'deepseek-v4-pro[1m]'
        $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = 'deepseek-v4-pro[1m]'
        $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
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
        $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
        $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = 'deepseek-v4-flash'
        $env:CLAUDE_CODE_SUBAGENT_MODEL     = 'deepseek-v4-flash'
        $env:CLAUDE_CODE_EFFORT_LEVEL       = 'max'

        Write-Host "Claude Code configured for MIXED mode (proxy at 127.0.0.1:3456)." -ForegroundColor Magenta
        Write-Host "  Opus    → Anthropic (claude-opus-4-7)"
        Write-Host "  Sonnet  → DeepSeek (deepseek-v4-pro[1m])"
        Write-Host "  Haiku   → DeepSeek (deepseek-v4-flash)"
        Write-Host "  Subagent → DeepSeek (deepseek-v4-flash)"
        if ($usingApiKey) {
            Write-Host "  Anthropic auth → API key (ANTHROPIC_API_KEY)"
        } else {
            Write-Host "  Anthropic auth → passthrough (subscription token)"
        }
        Write-Host ""
        Write-Host "Make sure the proxy is running: node server.js" -ForegroundColor DarkGray
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
    Write-Host "  (none — using Claude Code defaults)"
}
