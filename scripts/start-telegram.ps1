<#
.SYNOPSIS
    Start the Telegram Fleet mini-app: Express server + Telegraf bot.
    Assumes the Fleet Console orchestrator is already running on port 4318.

.NOTES
    One-time setup:
      1. cd telegram-fleet-app
      2. npm install
      3. Copy-Item .env.example .env
      4. Set BOT_TOKEN in .env (from @BotFather)
      5. Install ngrok: https://ngrok.com/download
#>

$root   = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root "telegram-fleet-app"

if (-not (Test-Path $appDir)) {
    Write-Host "ERROR: telegram-fleet-app/ not found at $appDir" -ForegroundColor Red
    exit 1
}

$envFile = Join-Path $appDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Host ""
    Write-Host "No .env file found in telegram-fleet-app/." -ForegroundColor Red
    Write-Host "Run these commands first:" -ForegroundColor Yellow
    Write-Host "  cd telegram-fleet-app"
    Write-Host "  Copy-Item .env.example .env"
    Write-Host "  # Edit .env: set BOT_TOKEN (from @BotFather)"
    Write-Host ""
    exit 1
}

# Check if npm deps are installed
if (-not (Test-Path (Join-Path $appDir "node_modules"))) {
    Write-Host "Installing telegram-fleet-app dependencies..." -ForegroundColor Cyan
    Push-Location $appDir
    npm install
    Pop-Location
}

# Check if ngrok is available
$ngrokAvailable = $null -ne (Get-Command ngrok -ErrorAction SilentlyContinue)

Write-Host ""
Write-Host "┌─ Telegram Fleet App ─────────────────────────────────────────────┐" -ForegroundColor Cyan
if (-not $ngrokAvailable) {
    Write-Host "│  ⚠  ngrok not found in PATH. Install from https://ngrok.com       │" -ForegroundColor Yellow
    Write-Host "│     then run: ngrok http 3001                                      │" -ForegroundColor Yellow
} else {
    Write-Host "│  Tip: open a second terminal and run: ngrok http 3001              │" -ForegroundColor DarkGray
    Write-Host "│       then copy the HTTPS URL into telegram-fleet-app/.env         │" -ForegroundColor DarkGray
}
Write-Host "│                                                                    │" -ForegroundColor Cyan
Write-Host "│  Once ngrok is running, send /fleet to your bot in Telegram.       │" -ForegroundColor Cyan
Write-Host "└────────────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""

Push-Location $appDir
node src/bot.mjs
Pop-Location
