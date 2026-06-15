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

# 2) Re-stage the runner into each registered WSL distro so WSL sessions run the latest code.
$mapFile = Join-Path $FleetDirectory "wsl-runners.json"
if (-not $NoRestage -and (Test-Path $mapFile)) {
    $fcMnt = ConvertTo-Mnt $FleetDirectory
    try {
        $map = Get-Content $mapFile -Raw | ConvertFrom-Json
    } catch {
        $map = $null
    }
    if ($map) {
        foreach ($prop in $map.PSObject.Properties) {
            $distro = $prop.Name
            $runnerPath = $prop.Value.runnerPath
            if (-not $runnerPath) { continue }
            $destDir = ($runnerPath -replace '/[^/]+$', '')
            $cmd = "mkdir -p '$destDir' && cp '$fcMnt/src/runner.mjs' '$destDir/runner.mjs' && cp '$fcMnt/src/asyncQueue.mjs' '$destDir/asyncQueue.mjs' && echo staged"
            $out = (& wsl.exe -d $distro -- bash -lc $cmd) 2>&1
            if ($LASTEXITCODE -eq 0 -and ($out -match "staged")) {
                Write-Host "Refreshed runner in '$distro'." -ForegroundColor Green
            } else {
                Write-Warning "Could not refresh runner in '$distro' (distro stopped or not set up): $out"
            }
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
Write-Host ""
Write-Host "Starting Fleet Console (fresh) at http://${displayHost}:${Port}${tokenSuffix}" -ForegroundColor Cyan
if (-not $Token -and $BindHost -eq "0.0.0.0") {
    Write-Warning "Bound to 0.0.0.0 without a token. Anyone on the network can drive your agents. Use -Token."
}
Write-Host "Press Ctrl+C to stop."
Write-Host ""

node src/orchestrator.mjs
