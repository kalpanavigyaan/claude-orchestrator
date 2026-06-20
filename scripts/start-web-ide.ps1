# Start Web IDE Fleet Console
# Runs at http://localhost:5174 (fixed port matching the electron app's companion port)

$ErrorActionPreference = "SilentlyContinue"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$WEB_IDE = Join-Path $ROOT "..\web-ide"

Write-Host ""
Write-Host "  Fleet Console Web UI" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Dir  : $WEB_IDE" -ForegroundColor DarkGray

# Check the web-ide directory exists
if (-not (Test-Path $WEB_IDE)) {
    Write-Host "  ERROR: web-ide directory not found at $WEB_IDE" -ForegroundColor Red
    exit 1
}

# Check node_modules are installed
if (-not (Test-Path (Join-Path $WEB_IDE "node_modules"))) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    Push-Location $WEB_IDE
    npm install --legacy-peer-deps
    Pop-Location
}

# Launch Vite on the fixed port 5174
Write-Host "  Port : http://localhost:5174" -ForegroundColor Green
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

Push-Location $WEB_IDE
npx vite --port 5174 --strictPort
Pop-Location
