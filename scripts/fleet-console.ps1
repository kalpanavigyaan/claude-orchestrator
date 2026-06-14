<#
.SYNOPSIS
    Launch the Fleet Console web app (own and drive multiple Claude sessions from a browser).

.DESCRIPTION
    Locates Node.js (PATH or the standard install location), installs the app's dependencies
    on first run, applies optional token / host / port settings, and starts the orchestrator.
    Open the printed URL from this machine, or from your laptop/iPad when bound to the LAN.

.PARAMETER Token
    Require this bearer token for all API/SSE calls. Open the UI as /?token=<Token>.
    Strongly recommended whenever you bind to the LAN.

.PARAMETER BindHost
    Interface to bind. Default 127.0.0.1 (local only). Use 0.0.0.0 for laptop/iPad access.

.PARAMETER Port
    TCP port. Default 4318.

.PARAMETER Install
    Force `npm install` even if dependencies already exist.

.EXAMPLE
    PS> .\scripts\fleet-console.ps1
    Runs locally at http://127.0.0.1:4318

.EXAMPLE
    PS> .\scripts\fleet-console.ps1 -BindHost 0.0.0.0 -Token "a-long-secret"
    Exposes it on the LAN; open http://<host-ip>:4318/?token=a-long-secret from your iPad.
#>

param(
    [string]$Token = "",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 4318,
    [switch]$Install
)

$ErrorActionPreference = "Stop"

# Resolve the repository root (parent of this scripts/ directory) and the app folder.
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $ScriptDirectory
$FleetDirectory = Join-Path $RepositoryRoot "fleet-console"

if (-not (Test-Path $FleetDirectory)) {
    throw "fleet-console folder not found at $FleetDirectory. Check out the feat/fleet-console branch."
}

# Ensure Node.js is available; fall back to the standard install location.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $NodeDirectory = Join-Path $env:ProgramFiles "nodejs"
    if (Test-Path (Join-Path $NodeDirectory "node.exe")) {
        $env:Path = "$NodeDirectory;$env:Path"
    }
}
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found. Install Node.js 18+ (for example via UniGetUI: OpenJS.NodeJS.LTS) and re-run."
}
Write-Host "Node: $(node --version)  ($($NodeCommand.Source))"

Set-Location $FleetDirectory

# Install dependencies on first run (or when -Install is given).
if ($Install -or -not (Test-Path (Join-Path $FleetDirectory "node_modules"))) {
    Write-Host "Installing dependencies (npm install)..."
    npm install --no-fund --no-audit
}

# Apply runtime configuration via environment variables read by the orchestrator.
if ($Token) { $env:FLEET_TOKEN = $Token }
$env:HOST = $BindHost
$env:PORT = "$Port"

$displayHost = if ($BindHost -eq "0.0.0.0") { "<host-ip>" } else { $BindHost }
$tokenSuffix = if ($Token) { "/?token=$Token" } else { "" }
Write-Host ""
Write-Host "Starting Fleet Console at http://${displayHost}:${Port}${tokenSuffix}"
if (-not $Token -and $BindHost -eq "0.0.0.0") {
    Write-Warning "Bound to 0.0.0.0 without a token. Anyone on the network can drive your agents. Use -Token."
}
Write-Host "Press Ctrl+C to stop."
Write-Host ""

node src/orchestrator.mjs
