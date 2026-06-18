#!/usr/bin/env pwsh
# start-fleet-console.ps1
# Launches the Fleet Console Electron app.
# Run from the repo root or from this directory.

param(
  [switch]$Dev   # open DevTools
)

$ErrorActionPreference = "Stop"

$script:rootDir = Split-Path $PSScriptRoot -Parent
$script:appDir  = Join-Path $script:rootDir "fleet-console-electron"

# Ensure dependencies are installed
if (-not (Test-Path (Join-Path $script:appDir "node_modules\electron\dist\electron.exe"))) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  Push-Location $script:appDir
  npm install
  Pop-Location
  # Extract cached binary if needed
  $electronCacheDir = Join-Path $env:LOCALAPPDATA "electron\Cache"
  $cachedZip = Get-ChildItem $electronCacheDir -Filter "electron-v*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cachedZip) {
    Write-Host "Extracting Electron binary from cache..." -ForegroundColor Cyan
    Expand-Archive -Path $cachedZip.FullName -DestinationPath (Join-Path $script:appDir "node_modules\electron\dist") -Force
  }
}

$electronExe = Join-Path $script:appDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
  Write-Error "Electron binary not found. Run 'npm install' in fleet-console-electron/"
}

$args = @($script:appDir)
if ($Dev) { $args += "--dev" }

Write-Host "Starting Fleet Console..." -ForegroundColor Green
& $electronExe @args
