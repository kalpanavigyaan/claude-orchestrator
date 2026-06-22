<#
.SYNOPSIS
    Start the Telegram Fleet mini-app server and bot.
    Requires .env to be configured first (copy .env.example).
#>
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "No .env file found. Create one from .env.example:" -ForegroundColor Red
    Write-Host "  1. Copy-Item .env.example .env"
    Write-Host "  2. Set BOT_TOKEN (from @BotFather)"
    Write-Host "  3. Run ngrok http 3001, copy the https URL into MINI_APP_URL"
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "┌─ Telegram Fleet App ─────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "│  Before starting, make sure:                                      │" -ForegroundColor Cyan
Write-Host "│    1. Fleet Console is running  (.\scripts\start-fleet-console.ps1)│" -ForegroundColor Cyan
Write-Host "│    2. ngrok is running          (ngrok http 3001)                 │" -ForegroundColor Cyan
Write-Host "│    3. MINI_APP_URL in .env matches the ngrok HTTPS URL            │" -ForegroundColor Cyan
Write-Host "│    4. Send /fleet in Telegram to open the mini app                │" -ForegroundColor Cyan
Write-Host "└──────────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""

node src/bot.mjs
