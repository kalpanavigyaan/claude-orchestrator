<#
.SYNOPSIS
    Build the Fleet Console React UI (web-ide) into a production bundle.

.DESCRIPTION
    Compiles TypeScript + Vite for the web-ide React app and writes the output
    to web-ide/dist/. The fleet-console backend (port 4318) must be running
    separately; the built UI connects to it at 127.0.0.1:4318.

    After a successful build, use -Serve to start a lightweight preview server
    on port 5174 (the same port as the dev server, so bookmarks stay the same).
    Or run start-web-ide.ps1 for the hot-reload dev server instead.

.PARAMETER Serve
    After building, start a Vite preview server on port 5174. Ctrl+C to stop.

.PARAMETER Port
    Preview server port. Default 5174.

.PARAMETER Install
    Force npm install even if node_modules already exists.

.EXAMPLE
    .\scripts\build-ui.ps1
    Build only.

.EXAMPLE
    .\scripts\build-ui.ps1 -Serve
    Build then start the preview server at http://localhost:5174
#>

param(
    [switch]$Serve,
    [int]$Port = 5174,
    [switch]$Install
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir
$WebIde    = Join-Path $Root "web-ide"

if (-not (Test-Path $WebIde)) {
    throw "web-ide directory not found at $WebIde"
}

# ── 1. Install deps if missing (or forced) ───────────────────────────────────
$NodeModules = Join-Path $WebIde "node_modules"
if ($Install -or -not (Test-Path $NodeModules)) {
    Write-Host "Installing dependencies (npm install)..." -ForegroundColor Yellow
    Push-Location $WebIde
    try { npm install --legacy-peer-deps --no-fund --no-audit }
    finally { Pop-Location }
}

# ── 2. Build ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Building Fleet Console UI..." -ForegroundColor Cyan
Write-Host "  Source : $WebIde\src" -ForegroundColor DarkGray
Write-Host "  Output : $WebIde\dist" -ForegroundColor DarkGray
Write-Host ""

Push-Location $WebIde
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  Build failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

# ── 3. Report ─────────────────────────────────────────────────────────────────
$DistJs  = Get-ChildItem "$WebIde\dist\assets" -Filter "*.js"  -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$DistCss = Get-ChildItem "$WebIde\dist\assets" -Filter "*.css" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host ""
Write-Host "  Build complete." -ForegroundColor Green
if ($DistJs)  { Write-Host "  JS  : $([math]::Round($DistJs.Length  / 1KB)) KB  ($($DistJs.Name))"  -ForegroundColor DarkGray }
if ($DistCss) { Write-Host "  CSS : $([math]::Round($DistCss.Length / 1KB)) KB  ($($DistCss.Name))" -ForegroundColor DarkGray }
Write-Host ""

# ── 4. Optional preview server ────────────────────────────────────────────────
if (-not $Serve) {
    Write-Host "  To serve: .\scripts\build-ui.ps1 -Serve" -ForegroundColor DarkGray
    Write-Host "  Or dev  : .\scripts\start-web-ide.ps1   (hot-reload)" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# Kill any existing process on that port so preview starts cleanly.
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    foreach ($pid in ($existing | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try { Stop-Process -Id $pid -Force -ErrorAction Stop; Write-Host "  Stopped existing process on port $Port (pid $pid)." -ForegroundColor Yellow } catch {}
    }
    Start-Sleep -Milliseconds 400
}

Write-Host "  Starting preview at http://localhost:$Port" -ForegroundColor Cyan
Write-Host "  (fleet-console API must be running at http://127.0.0.1:4318)" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

Push-Location $WebIde
try { npx vite preview --port $Port --strictPort }
finally { Pop-Location }
