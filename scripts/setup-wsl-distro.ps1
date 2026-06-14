<#
.SYNOPSIS
    Make a WSL distribution ready to run fleet-console sessions (turnkey).

.DESCRIPTION
    Inside the chosen distro this: ensures Node.js (installs nvm + LTS if missing), stages a
    WSL-native runner at ~/.fleet-console-runner with the Linux Claude Agent SDK installed,
    and installs the `claude` CLI for login. It then records the distro's node + runner paths
    in fleet-console/wsl-runners.json, which the orchestrator reads so WSL sessions run the
    agent INSIDE the distro (with the correct Linux binary).

    After this, log Claude in once inside the distro (the script prints how).

.PARAMETER Distro
    The WSL distribution name (see `wsl --list --quiet`).

.EXAMPLE
    PS> .\scripts\setup-wsl-distro.ps1 -Distro Ubuntu-24-04-Vani
#>

param(
    [Parameter(Mandatory = $true)][string]$Distro
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$FleetDir = Join-Path $RepoRoot "fleet-console"
if (-not (Test-Path $FleetDir)) { throw "fleet-console not found at $FleetDir" }

function ConvertTo-Mnt([string]$winPath) {
    $p = (Resolve-Path $winPath).Path
    if ($p -match '^([A-Za-z]):\\(.*)$') {
        return "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\','/')"
    }
    return ($p -replace '\\', '/')
}

# Verify the distro exists.
$known = (& wsl.exe --list --quiet) -replace "\x00", "" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($known -notcontains $Distro) {
    Write-Host "Known distros:`n  $($known -join "`n  ")"
    throw "Distro '$Distro' not found."
}

# Bash setup script (written with LF so WSL bash can run it).
$bash = @'
#!/usr/bin/env bash
set -e
FC="$1"
export NVM_DIR="$HOME/.nvm"

ensure_node() {
  command -v node >/dev/null 2>&1 && return 0
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v node >/dev/null 2>&1 && return 0
  echo ">> Installing nvm + Node LTS (one-time)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  else
    wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
}

ensure_node
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || true
NODE_BIN="$(command -v node)"
echo ">> node: $NODE_BIN ($(node -v))"

DEST="$HOME/.fleet-console-runner"
mkdir -p "$DEST/src"
cp "$FC/src/runner.mjs" "$DEST/src/runner.mjs"
cp "$FC/src/asyncQueue.mjs" "$DEST/src/asyncQueue.mjs"
cat > "$DEST/package.json" <<'JSON'
{ "name": "fleet-console-runner", "private": true, "type": "module", "dependencies": { "@anthropic-ai/claude-agent-sdk": "latest" } }
JSON

echo ">> Installing the Linux Claude Agent SDK in the distro (this can take a few minutes)..."
( cd "$DEST" && npm install --no-fund --no-audit )

echo ">> Installing the claude CLI for login..."
npm install -g @anthropic-ai/claude-code --no-fund --no-audit >/dev/null 2>&1 || true

echo "FLEET_NODE=$NODE_BIN"
echo "FLEET_RUNNER=$DEST/src/runner.mjs"
'@

$tmp = Join-Path $env:TEMP ("fleet-setup-{0}.sh" -f ([System.Guid]::NewGuid().ToString("N")))
[System.IO.File]::WriteAllText($tmp, ($bash -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
$tmpMnt = ConvertTo-Mnt $tmp
$fcMnt = ConvertTo-Mnt $FleetDir

Write-Host "Setting up '$Distro' for fleet-console..." -ForegroundColor Cyan
$out = & wsl.exe -d $Distro -- bash $tmpMnt $fcMnt 2>&1 | Tee-Object -Variable shown
Remove-Item $tmp -ErrorAction SilentlyContinue

$nodeLine = ($out | Select-String '^FLEET_NODE=' | Select-Object -Last 1)
$runnerLine = ($out | Select-String '^FLEET_RUNNER=' | Select-Object -Last 1)
if (-not $nodeLine -or -not $runnerLine) {
    throw "Setup did not finish (no FLEET_NODE/FLEET_RUNNER marker). See output above."
}
$nodePath = ($nodeLine.Line) -replace '^FLEET_NODE=', ''
$runnerPath = ($runnerLine.Line) -replace '^FLEET_RUNNER=', ''

# Record into fleet-console/wsl-runners.json
$mapFile = Join-Path $FleetDir "wsl-runners.json"
$map = @{}
if (Test-Path $mapFile) {
    try { $map = Get-Content $mapFile -Raw | ConvertFrom-Json -AsHashtable } catch { $map = @{} }
}
if ($null -eq $map) { $map = @{} }
$map[$Distro] = @{ node = $nodePath; runnerPath = $runnerPath }
($map | ConvertTo-Json -Depth 5) | Set-Content $mapFile -Encoding utf8

Write-Host ""
Write-Host "Recorded '$Distro':" -ForegroundColor Green
Write-Host "  node   = $nodePath"
Write-Host "  runner = $runnerPath"
Write-Host ""
Write-Host "One-time final step — log Claude in INSIDE the distro:" -ForegroundColor Cyan
Write-Host "    wsl -d $Distro"
Write-Host "    claude            # then run: /login"
Write-Host ""
Write-Host "Then create a WSL session for '$Distro' in fleet-console and it will run in the distro."
