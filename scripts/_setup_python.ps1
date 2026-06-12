<#
.SYNOPSIS
    Bootstraps the complete Python environment for claude-orchestrator using uv only.

.DESCRIPTION
    This script is the single source of truth for the Python environment. It deletes any
    existing virtual environment and project metadata, then recreates everything from
    scratch so the environment is fully reproducible from this script alone. It does not
    depend on a pre-existing pyproject.toml; if pyproject.toml is deleted, running this
    script restores Python and every package.

    Steps performed:
      1. Ensure the uv package manager is installed (installs it if missing).
      2. Ensure CPython 3.13 is available through uv.
      3. Remove any existing .venv, pyproject.toml, and uv.lock.
      4. Initialize a fresh uv project pinned to Python 3.13.
      5. Create the virtual environment.
      6. Add every runtime package with "uv add" (never "uv pip add").
      7. Add development packages.

.EXAMPLE
    PS> .\scripts\_setup_python.ps1
    Installs uv (if needed), Python 3.13, creates .venv, and adds all packages.
    Afterwards run the application with:
        uv run python scripts/orchestrator.py --help
#>

$ErrorActionPreference = "Stop"

# The Python version is defined once here as a variable, per project convention.
$PythonVersion = "3.13"

# Resolve the repository root as the parent of this scripts/ directory.
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $ScriptDirectory
Set-Location $RepositoryRoot

Write-Host "Repository root: $RepositoryRoot"
Write-Host "Target Python version: $PythonVersion"

# 1. Ensure the uv package manager is installed.
$UvCommand = Get-Command uv -ErrorAction SilentlyContinue
if (-not $UvCommand) {
    Write-Host "uv is not installed. Installing uv via the official installer..."
    Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" | Invoke-Expression
    # The installer adds uv to a user directory; make it available for the rest of this session.
    $UvInstallDirectory = Join-Path $env:USERPROFILE ".local\bin"
    if (Test-Path $UvInstallDirectory) {
        $env:PATH = "$UvInstallDirectory;$env:PATH"
    }
    $UvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $UvCommand) {
        throw "uv installation did not complete. Open a new terminal and re-run this script."
    }
}
Write-Host "uv version: $(uv --version)"

# 2. Ensure CPython 3.13 is available through uv (uv downloads it if missing).
uv python install $PythonVersion

# 3. Remove any existing environment and project metadata for a clean rebuild.
if (Test-Path ".venv") {
    Write-Host "Removing existing .venv..."
    Remove-Item -Recurse -Force ".venv"
}
if (Test-Path "pyproject.toml") {
    Write-Host "Removing existing pyproject.toml..."
    Remove-Item -Force "pyproject.toml"
}
if (Test-Path "uv.lock") {
    Write-Host "Removing existing uv.lock..."
    Remove-Item -Force "uv.lock"
}

# 4. Initialize a fresh, bare uv project pinned to Python 3.13.
#    --bare keeps it to a minimal pyproject.toml with no sample package or VCS files.
uv init --bare --python $PythonVersion

# 5. Create the virtual environment explicitly.
uv venv --python $PythonVersion

# 6. Add every runtime package. Keep this list in sync whenever a package is introduced.
uv add claude-agent-sdk
uv add typer
uv add pydantic
uv add pyyaml
uv add python-frontmatter
uv add rich

# 7. Add development packages.
uv add --dev pytest

Write-Host ""
Write-Host "Environment ready."
Write-Host "Run the orchestrator with:  uv run python scripts/orchestrator.py --help"
Write-Host "Run the tests with:         uv run pytest"
