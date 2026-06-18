<#
.SYNOPSIS
    Start the centralised tool server (Rust gRPC core + Node.js MCP adapter + optional Python embeddings).

.DESCRIPTION
    1. Builds and starts tool-server-core (Rust, gRPC :50051).
    2. Optionally starts the Python embeddings service (FAISS + sentence-transformers, gRPC :50052).
    3. Installs npm deps (once) and starts the MCP HTTP adapter (:4319).
    4. Waits for all services to be healthy before returning.

    All sessions created by fleet-console automatically connect to the tool server
    when toolServer.enabled = true in config.yaml — no per-distro install needed.

.PARAMETER NoBuild
    Skip `cargo build --release` (use when the binary is already compiled).

.PARAMETER WithEmbeddings
    Also start the Python embeddings service (requires Python 3.10+, pip install -e tool-server/embeddings).

.PARAMETER GrpcPort
    Override the gRPC port (default 50051).

.PARAMETER EmbPort
    Override the embeddings gRPC port (default 50052).

.PARAMETER McpPort
    Override the MCP HTTP port (default 4319).

.PARAMETER Tools
    Which tools to expose to Claude (passed to the adapter as TOOL_SERVER_TOOLS).
    Fewer tools = fewer schemas shipped in every request = lower token cost.
      "" / "default"  curated high-leverage subset (recommended, the default)
      "all"           every one of the 26 tools
      "a,b,c"         exactly those tool names

.EXAMPLE
    PS> .\scripts\start-tool-server.ps1
    PS> .\scripts\start-tool-server.ps1 -NoBuild -WithEmbeddings
    PS> .\scripts\start-tool-server.ps1 -Tools "all"
#>

param(
    [switch]$NoBuild,
    [switch]$WithEmbeddings,
    [int]$GrpcPort = 50051,
    [int]$EmbPort  = 50052,
    [int]$McpPort  = 4319,
    [string]$Tools = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot     = Split-Path -Parent $ScriptDir
$CoreDir      = Join-Path $RepoRoot "tool-server\core"
$AdapterDir   = Join-Path $RepoRoot "tool-server\mcp-adapter"
$EmbDir       = Join-Path $RepoRoot "tool-server\embeddings"
$PidsDir      = Join-Path $RepoRoot "tool-server\.pids"

if (-not (Test-Path $PidsDir)) { New-Item -ItemType Directory -Path $PidsDir | Out-Null }

function Stop-Pid([string]$name) {
    $f = Join-Path $PidsDir "$name.pid"
    if (Test-Path $f) {
        $pid = Get-Content $f -ErrorAction SilentlyContinue
        if ($pid) {
            try { Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue } catch {}
        }
        Remove-Item $f -ErrorAction SilentlyContinue
    }
}

# Kill any previous instances
Stop-Pid "core"
Stop-Pid "mcp-adapter"
Stop-Pid "embeddings"

# ── 1. Build Rust core ──────────────────────────────────────────────────────
if (-not $NoBuild) {
    Write-Host "Building tool-server-core (cargo release)..." -ForegroundColor Cyan
    Push-Location $CoreDir
    & cargo build --release 2>&1
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
    Pop-Location
}

$binaryPath = Join-Path $CoreDir "target\release\tool-server-core.exe"
if (-not (Test-Path $binaryPath)) {
    throw "Binary not found at $binaryPath — run without -NoBuild"
}

# ── 2. Start Rust gRPC core ─────────────────────────────────────────────────
Write-Host "Starting tool-server-core on gRPC :$GrpcPort..." -ForegroundColor Cyan
$coreProc = Start-Process -FilePath $binaryPath `
    -ArgumentList @() `
    -WorkingDirectory $CoreDir `
    -PassThru -WindowStyle Hidden `
    -Environment @{ TOOL_SERVER_GRPC_PORT = "$GrpcPort"; RUST_LOG = "info" }
$coreProc.Id | Set-Content (Join-Path $PidsDir "core.pid") -Encoding utf8

# Wait for gRPC port
$gRpcReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $GrpcPort)
        $c.Close()
        $gRpcReady = $true
        break
    } catch {}
}
if (-not $gRpcReady) { throw "tool-server-core did not start on :$GrpcPort within 15s" }
Write-Host "  gRPC core ready on :$GrpcPort" -ForegroundColor Green

# ── 3. Optionally start Python embeddings service ────────────────────────────
$embPid = $null
if ($WithEmbeddings) {
    Write-Host "Starting Python embeddings service on gRPC :$EmbPort..." -ForegroundColor Cyan
    $embProc = Start-Process -FilePath "python" `
        -ArgumentList @("-m", "src.server") `
        -WorkingDirectory $EmbDir `
        -PassThru -WindowStyle Hidden `
        -Environment @{ EMBEDDINGS_GRPC_PORT = "$EmbPort" }
    $embProc.Id | Set-Content (Join-Path $PidsDir "embeddings.pid") -Encoding utf8
    $embPid = $embProc.Id

    $embReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 1000
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect("127.0.0.1", $EmbPort)
            $c.Close()
            $embReady = $true
            break
        } catch {}
    }
    if (-not $embReady) { Write-Warning "Embeddings service did not start on :$EmbPort within 30s (continuing anyway)" }
    else { Write-Host "  Embeddings ready on :$EmbPort" -ForegroundColor Green }
}

# ── 3. Install MCP adapter npm deps (once) ──────────────────────────────────
if (-not (Test-Path (Join-Path $AdapterDir "node_modules"))) {
    Write-Host "Installing MCP adapter dependencies (npm install)..." -ForegroundColor Cyan
    Push-Location $AdapterDir
    & npm install --no-fund --no-audit 2>&1
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Pop-Location
}

# ── 4. Build TS → JS ────────────────────────────────────────────────────────
Write-Host "Compiling MCP adapter TypeScript..." -ForegroundColor Cyan
Push-Location $AdapterDir
& npm run build 2>&1
if ($LASTEXITCODE -ne 0) { throw "tsc build failed" }
Pop-Location

# ── 5. Start MCP adapter ────────────────────────────────────────────────────
Write-Host "Starting MCP adapter on HTTP :$McpPort..." -ForegroundColor Cyan
$adapterProc = Start-Process -FilePath "node" `
    -ArgumentList @("dist/index.js") `
    -WorkingDirectory $AdapterDir `
    -PassThru -WindowStyle Hidden `
    -Environment @{
        TOOL_SERVER_MCP_PORT   = "$McpPort"
        TOOL_SERVER_GRPC_ADDR  = "127.0.0.1:$GrpcPort"
        EMBEDDINGS_GRPC_ADDR   = "127.0.0.1:$EmbPort"
        TOOL_SERVER_TOOLS      = "$Tools"
    }
$adapterProc.Id | Set-Content (Join-Path $PidsDir "mcp-adapter.pid") -Encoding utf8

# Wait for health endpoint
$mcpReady = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$McpPort/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $mcpReady = $true; break }
    } catch {}
}
if (-not $mcpReady) { throw "MCP adapter did not respond on :$McpPort within 10s" }

Write-Host ""
Write-Host "tool-server is running:" -ForegroundColor Green
Write-Host "  gRPC core  :$GrpcPort  (pid $($coreProc.Id))"
if ($embPid) { Write-Host "  Embeddings :$EmbPort  (pid $embPid)" }
Write-Host "  MCP HTTP   http://127.0.0.1:$McpPort/mcp  (pid $($adapterProc.Id))"
Write-Host ""
Write-Host "Enable in fleet-console: set toolServer.enabled = true in config/config.yaml" -ForegroundColor Cyan
if (-not $WithEmbeddings) {
    Write-Host "Embeddings service not started — run with -WithEmbeddings to enable Phase 4 tools." -ForegroundColor DarkGray
}
Write-Host "PIDs saved to tool-server/.pids/ — run Stop-Process to shut down."
