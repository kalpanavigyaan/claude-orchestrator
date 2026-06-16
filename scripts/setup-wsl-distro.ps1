<#
.SYNOPSIS
    Make a WSL distribution ready to run fleet-console sessions (zero-copy).

.DESCRIPTION
    Ensures Node.js (nvm + LTS) is available in the chosen distro and installs the claude CLI
    for login. Records only the distro's node path in fleet-console/wsl-runners.json.

    runner.mjs and its dependencies are served from the Windows host via the /mnt/ mount —
    no per-distro copy or npm install is needed. Adding a new distro takes ~2 minutes.

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
# runner.mjs + asyncQueue.mjs + the Claude Agent SDK are NOT copied into the distro;
# they are served from the Windows host via the /mnt/ mount.
$bash = @'
#!/usr/bin/env bash
set -e
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

echo ">> Installing the claude CLI for login..."
npm install -g @anthropic-ai/claude-code --no-fund --no-audit >/dev/null 2>&1 || true

echo "FLEET_NODE=$NODE_BIN"
'@

$tmp = Join-Path $env:TEMP ("fleet-setup-{0}.sh" -f ([System.Guid]::NewGuid().ToString("N")))
[System.IO.File]::WriteAllText($tmp, ($bash -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
$tmpMnt = ConvertTo-Mnt $tmp

Write-Host "Setting up '$Distro' for fleet-console (node + claude CLI only)..." -ForegroundColor Cyan
$out = & wsl.exe -d $Distro -- bash $tmpMnt 2>&1 | Tee-Object -Variable shown
Remove-Item $tmp -ErrorAction SilentlyContinue

$nodeLine = ($out | Select-String '^FLEET_NODE=' | Select-Object -Last 1)
if (-not $nodeLine) {
    throw "Setup did not finish (no FLEET_NODE marker). See output above."
}
$nodePath = ($nodeLine.Line) -replace '^FLEET_NODE=', ''

# Record only the node path — runnerPath is omitted so hosts.mjs uses the /mnt/ path automatically.
$mapFile = Join-Path $FleetDir "wsl-runners.json"
$map = @{}
if (Test-Path $mapFile) {
    try { $map = Get-Content $mapFile -Raw | ConvertFrom-Json -AsHashtable } catch { $map = @{} }
}
if ($null -eq $map) { $map = @{} }
# Preserve any existing keys for this distro, then update node; drop runnerPath.
if (-not $map.ContainsKey($Distro)) { $map[$Distro] = @{} }
$map[$Distro] = @{ node = $nodePath }
($map | ConvertTo-Json -Depth 5) | Set-Content $mapFile -Encoding utf8

Write-Host ""
Write-Host "Recorded '$Distro':" -ForegroundColor Green
Write-Host "  node = $nodePath"
Write-Host "  runner.mjs served from Windows host via /mnt/ (no copy needed)"
Write-Host ""
Write-Host "One-time final step — log Claude in INSIDE the distro:" -ForegroundColor Cyan
Write-Host "    wsl -d $Distro"
Write-Host "    claude            # then run: /login"
Write-Host ""
Write-Host "Then create a WSL session for '$Distro' in fleet-console and it will run immediately."
