<#
.SYNOPSIS
    Start the Fleet Console web app FRESH: stop any running instance, refresh the in-distro WSL
    runners, then launch a clean orchestrator.

.DESCRIPTION
    Use this after pulling changes or when a session is stuck. It:
      1. Stops any orchestrator already listening on the port (so you get a clean process — the
         orchestrator keeps sessions in memory, so this also clears stale/dead sessions).
      2. Re-stages the updated runner into every WSL distro registered in
         fleet-console/wsl-runners.json (the staged runners are copies, so WSL sessions otherwise
         keep running old runner code). Each distro is best-effort; a stopped one is skipped.
      3. Resolves Node, installs deps on first run, applies token/host/port, and starts the app.

.PARAMETER Token
    Require this bearer token for all API/SSE calls. Open the UI as /?token=<Token>.

.PARAMETER BindHost
    Interface to bind. Default 127.0.0.1 (local only). Use 0.0.0.0 for laptop/iPad access.

.PARAMETER Port
    TCP port. Default 4318.

.PARAMETER Install
    Force `npm install` even if dependencies already exist.

.PARAMETER NoRestage
    Skip re-staging the WSL runners (faster; only the orchestrator restart).

.EXAMPLE
    PS> .\scripts\start-fleet-console.ps1
    Stops any running instance, refreshes WSL runners, starts fresh at http://127.0.0.1:4318

.EXAMPLE
    PS> .\scripts\start-fleet-console.ps1 -BindHost 0.0.0.0 -Token "a-long-secret"
#>

param(
    [string]$Token = "",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 4318,
    [switch]$Install,
    [switch]$NoRestage
)

$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $ScriptDirectory
$FleetDirectory = Join-Path $RepositoryRoot "fleet-console"
if (-not (Test-Path $FleetDirectory)) {
    throw "fleet-console folder not found at $FleetDirectory."
}

function ConvertTo-Mnt([string]$winPath) {
    $p = (Resolve-Path $winPath).Path
    if ($p -match '^([A-Za-z]):\\(.*)$') {
        return "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\','/')"
    }
    return ($p -replace '\\', '/')
}

# Seed config/config.yaml from the example on first run so there is a file to edit (gitignored).
$ConfigDir = Join-Path $FleetDirectory "config"
$ConfigFile = Join-Path $ConfigDir "config.yaml"
$ConfigExample = Join-Path $ConfigDir "config.example.yaml"
if (-not (Test-Path $ConfigFile) -and (Test-Path $ConfigExample)) {
    Copy-Item $ConfigExample $ConfigFile
    Write-Host "Created config/config.yaml from the example — edit it to change port, sessions dir, usage poll, etc." -ForegroundColor Green
}

# 1) Stop any orchestrator already on this port.
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
if ($pids) {
    foreach ($processId in $pids) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "Stopped existing instance (pid $processId) on port $Port." -ForegroundColor Yellow
        } catch {
            Write-Warning "Could not stop pid ${processId}: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Milliseconds 600
} else {
    Write-Host "No existing instance on port $Port."
}

# 2) runner.mjs is served from the Windows host via /mnt/ — no per-distro restaging needed.
#    (setup-wsl-distro.ps1 records only the node + claude paths, not a runner copy)
$mapFile = Join-Path $FleetDirectory "wsl-runners.json"
if (-not $NoRestage -and (Test-Path $mapFile)) {
    try { $map = Get-Content $mapFile -Raw | ConvertFrom-Json } catch { $map = $null }
    if ($map) {
        $hasLegacy = $false
        foreach ($prop in $map.PSObject.Properties) {
            if ($prop.Value.runnerPath) { $hasLegacy = $true; break }
        }
        if ($hasLegacy) {
            Write-Warning "wsl-runners.json has legacy runnerPath entries. Re-run setup-wsl-distro.ps1 per distro to upgrade."
        } else {
            Write-Host "runner.mjs served from /mnt/ — no restaging needed." -ForegroundColor DarkGray
        }
    }
}

# 3) Resolve Node, install on first run, configure, and start.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $NodeDirectory = Join-Path $env:ProgramFiles "nodejs"
    if (Test-Path (Join-Path $NodeDirectory "node.exe")) {
        $env:Path = "$NodeDirectory;$env:Path"
    }
}
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found. Install Node.js 18+ and re-run."
}
Write-Host "Node: $(node --version)  ($($NodeCommand.Source))"

Set-Location $FleetDirectory

if ($Install -or -not (Test-Path (Join-Path $FleetDirectory "node_modules"))) {
    Write-Host "Installing dependencies (npm install)..."
    npm install --no-fund --no-audit
}

if ($Token) { $env:FLEET_TOKEN = $Token }
$env:HOST = $BindHost
$env:PORT = "$Port"

$displayHost = if ($BindHost -eq "0.0.0.0") { "<host-ip>" } else { $BindHost }
$tokenSuffix = if ($Token) { "/?token=$Token" } else { "" }

# ── Web-IDE (React UI) ────────────────────────────────────────────────────────
# If web-ide/dist/ exists, start vite preview on $WebIdePort in the background.
$WebIdePort = 5174
$WebIdeDist = Join-Path $RepositoryRoot "web-ide\dist\index.html"
$WebIdeJob  = $null
if (Test-Path $WebIdeDist) {
    # Kill anything already on $WebIdePort
    $prev = Get-NetTCPConnection -LocalPort $WebIdePort -State Listen -ErrorAction SilentlyContinue
    foreach ($p in ($prev | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
    }
    $WebIdeJob = Start-Job -ScriptBlock {
        param($root, $port)
        Set-Location (Join-Path $root "web-ide")
        npx vite preview --port $port --strictPort 2>&1
    } -ArgumentList $RepositoryRoot, $WebIdePort
    Start-Sleep -Milliseconds 800
} else {
    Write-Host "  web-ide/dist/ not found — run .\scripts\build-ui.ps1 first for the React UI." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "┌─ Fleet Console ─────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "│  API + vanilla UI : http://${displayHost}:${Port}${tokenSuffix}" -ForegroundColor Cyan
if ($WebIdeJob) {
    Write-Host "│  React UI (web-ide): http://localhost:${WebIdePort}" -ForegroundColor Green
} else {
    Write-Host "│  React UI (web-ide): NOT running  →  run build-ui.ps1 -Serve" -ForegroundColor Yellow
}
Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
if (-not $Token -and $BindHost -eq "0.0.0.0") {
    Write-Warning "Bound to 0.0.0.0 without a token. Anyone on the network can drive your agents. Use -Token."
}
Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor DarkGray
Write-Host ""

try {
    node src/orchestrator.mjs
} finally {
    if ($WebIdeJob) {
        Stop-Job  $WebIdeJob -ErrorAction SilentlyContinue
        Remove-Job $WebIdeJob -ErrorAction SilentlyContinue
    }
}
