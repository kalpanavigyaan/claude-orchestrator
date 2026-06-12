<#
.SYNOPSIS
    Convenience wrapper that runs the orchestrator command-line interface through uv.

.DESCRIPTION
    Forwards all arguments to scripts/orchestrator.py inside the uv-managed virtual
    environment, so callers do not need to remember the full "uv run python ..." prefix.

.EXAMPLE
    PS> .\scripts\orchestrator.ps1 run instructions/example --now
    Runs the orchestrator against the example instructions immediately.

.EXAMPLE
    PS> .\scripts\orchestrator.ps1 validate --config config/orchestrator.yaml
    Validates the configuration and discovered instruction files.
#>

$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $ScriptDirectory
Set-Location $RepositoryRoot

uv run python scripts/orchestrator.py @args
