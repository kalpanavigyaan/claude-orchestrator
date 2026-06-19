"use strict";
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs   = require("fs");
const os   = require("os");
const { spawn } = require("child_process");

// ── Suppress Chromium disk-cache errors ──────────────────────────────────────
// Use %LOCALAPPDATA%\FleetConsole so the path is always writable and
// never locked by another Electron instance from the project directory.
const USER_DATA = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "FleetConsole"
);
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch { /* ignore */ }
app.setPath("userData", USER_DATA);

// Kill the GPU shader disk-cache and minimise other Chromium caches.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disk-cache-size", "1");       // near-zero HTTP cache
app.commandLine.appendSwitch("disable-http-cache");          // disable HTTP cache
app.commandLine.appendSwitch("disable-features", "NetworkServiceInProcess");


// ---------------------------------------------------------------------------
// Settings — load settings.json (VS Code-style, comments stripped)
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const DEFAULTS = {
  "window.width": 1440, "window.height": 920,
  "window.minWidth": 900, "window.minHeight": 600,
  "orchestrator.port": 4318,
  "orchestrator.token": "",
  "sessions.dir": "",
  "vm.repoRoots.windows": [
    "C:\\Users\\*\\source\\repos", "C:\\Users\\*\\Documents", "C:\\Users\\*\\Projects",
    "C:\\dev", "C:\\src", "C:\\repos", "C:\\GitHub", "C:\\Projects",
  ],
  "vm.repoRoots.linux": ["/root", "/home", "/srv", "/opt"],
  "vm.repoScanDepth": 4,
  "theme.colors": {},
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    // Strip // comments (not valid JSON, but used in settings.json like VS Code)
    const stripped = raw.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1");
    return { ...DEFAULTS, ...JSON.parse(stripped) };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = loadSettings();
const ORCH_PORT = settings["orchestrator.port"] || 4318;

// Orchestrator lives in the sibling fleet-console package
const ORCH_SCRIPT = path.join(__dirname, "..", "fleet-console", "src", "orchestrator.mjs");
const ORCH_CWD   = path.join(__dirname, "..", "fleet-console");

let mainWindow = null;
let orchProc   = null;

// ---------------------------------------------------------------------------
// Orchestrator lifecycle
// ---------------------------------------------------------------------------

function startOrchestrator() {
  try {
    // Propagate settings that the orchestrator honours via env vars (env wins over its
    // config.yaml). This lets the in-app settings editor drive the port, bearer token and
    // session-storage location without editing the orchestrator's own config.
    const orchEnv = { ...process.env };
    if (settings["orchestrator.port"]) orchEnv.PORT = String(settings["orchestrator.port"]);
    if (settings["orchestrator.token"]) orchEnv.FLEET_TOKEN = String(settings["orchestrator.token"]);
    if (settings["sessions.dir"])       orchEnv.SESSIONS_DIR = String(settings["sessions.dir"]);

    orchProc = spawn(process.execPath, [ORCH_SCRIPT], {
      cwd:         ORCH_CWD,
      stdio:       ["pipe", "pipe", "pipe"],
      env:         orchEnv,
      windowsHide: true,
    });
    orchProc.stdout.on("data", (d) => process.stdout.write("[orch] " + d));
    orchProc.stderr.on("data", (d) => process.stderr.write("[orch] " + d));
    orchProc.on("exit", (code) => {
      console.log("[orch] exited", code);
      orchProc = null;
    });
    orchProc.on("error", (e) => {
      console.error("[orch] spawn error:", e.message);
      orchProc = null;
    });
  } catch (e) {
    console.error("Failed to start orchestrator:", e.message);
  }
}

function killOrchestrator() {
  if (orchProc) {
    try { orchProc.kill(); } catch { /* ignore */ }
    orchProc = null;
  }
}

/**
 * Poll until the orchestrator answers a GET /api/state or we exhaust retries.
 * Never rejects — callers always get a callback.
 */
function waitForOrchestrator(cb, retries = 50) {
  if (retries <= 0) { cb(new Error("timeout")); return; }
  const req = http.request(
    { hostname: "127.0.0.1", port: ORCH_PORT, path: "/api/state", method: "GET", timeout: 800 },
    (res) => { res.resume(); cb(null); }
  );
  req.on("error",   () => setTimeout(() => waitForOrchestrator(cb, retries - 1), 300));
  req.on("timeout", () => { req.destroy(); setTimeout(() => waitForOrchestrator(cb, retries - 1), 300); });
  req.end();
}

// ---------------------------------------------------------------------------
// Browser window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           settings["window.width"]    || 1440,
    height:          settings["window.height"]   || 920,
    minWidth:        settings["window.minWidth"]  || 900,
    minHeight:       settings["window.minHeight"] || 600,
    minHeight:       600,
    frame:           false,   // custom title bar
    backgroundColor: "#1e1e1e",
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Show once the page is ready — avoids a white flash
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Open DevTools in dev mode
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // External links open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("maximize",   () => mainWindow?.webContents.send("window-maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window-maximized", false));
  mainWindow.on("closed",     () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  startOrchestrator();
  // Wait for the orchestrator to be ready, then create the window.
  // If it never starts we open anyway so the user can see an error.
  waitForOrchestrator((err) => {
    if (err) console.warn("[main] Orchestrator not ready; opening window anyway");
    createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killOrchestrator();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", killOrchestrator);

// ---------------------------------------------------------------------------
// IPC — window controls + port query
// ---------------------------------------------------------------------------

ipcMain.handle("window:minimize",    () => mainWindow?.minimize());
ipcMain.handle("window:maximize",    () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle("window:close",       () => mainWindow?.close());
ipcMain.handle("window:is-maximized",() => mainWindow?.isMaximized() ?? false);
ipcMain.handle("get-port",           () => ORCH_PORT);
ipcMain.handle("get-settings",       () => settings);
ipcMain.handle("set-settings", (_ev, patch) => {
  settings = { ...settings, ...patch };
  try {
    fs.writeFileSync(
      SETTINGS_FILE.replace(".json", ".user.json"),
      JSON.stringify(settings, null, 2),
      "utf8"
    );
  } catch { /* best effort */ }
  return settings;
});

// Raw settings editor: hand the renderer the verbatim settings.json text (comments and
// all) and accept a verbatim replacement. We validate that the (comment-stripped) text
// parses before writing, so a typo can never brick the file.
ipcMain.handle("get-settings-raw", () => {
  try { return fs.readFileSync(SETTINGS_FILE, "utf8"); }
  catch { return JSON.stringify(DEFAULTS, null, 2); }
});
ipcMain.handle("save-settings-raw", (_ev, text) => {
  const raw = String(text == null ? "" : text);
  try {
    const stripped = raw.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(stripped);            // throws on invalid JSON → reported below
    fs.writeFileSync(SETTINGS_FILE, raw, "utf8");    // persist the user's exact text (keeps comments)
    settings = { ...DEFAULTS, ...parsed };
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------------------
// VM discovery — Hyper-V, VMware Workstation, VirtualBox
// ---------------------------------------------------------------------------
const { exec } = require("child_process");

function runCmd(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 12000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "").trim(), err: (stderr || "").trim() });
    });
  });
}

/** Encode a PowerShell script as -EncodedCommand (UTF-16LE Base64) to avoid all quoting issues. */
function psEncode(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Escape a value for safe embedding inside a PowerShell single-quoted string literal. */
function psQuote(v) {
  return String(v == null ? "" : v).replace(/'/g, "''");
}

/**
 * PowerShell snippet that sets `$cred` from a username/password, or `$null` when no username is
 * given (Invoke-Command then runs as the current host user). Kept non-interactive — no Get-Credential
 * prompt, which would throw under -NonInteractive and silently drop the credentials.
 */
function psCredBlock(user, pass) {
  if (!user) return "$cred = $null";
  return (
    `$cred = New-Object System.Management.Automation.PSCredential(` +
    `'${psQuote(user)}', (ConvertTo-SecureString '${psQuote(pass)}' -AsPlainText -Force))`
  );
}

// Caches so the periodic VM rescan stays cheap: guest-OS strings are static, and a host
// without Hyper-V shouldn't pay a PowerShell + module-import on every cycle.
const osInfoCache = new Map();   // distro/VM name → osInfo string (only successful probes cached)
let hyperVUnavailable = false;   // true once Hyper-V is confirmed absent (not merely needing elevation)
let hyperVErrorMsg = null;       // remembered error so the UI card persists without re-running

ipcMain.handle("get-vms",  async () => {
  const vms = [];

  // ── WSL Distros ──────────────────────────────────────────────────────────
  // Running state comes from `--list --running --quiet` (distro NAMES only) so a localized
  // Windows STATE word ("Wird ausgeführt", "En cours…") can't make us mislabel a distro.
  const runningOut = await runCmd("wsl.exe --list --running --quiet", { encoding: "utf16le" });
  const runningSet = new Set(
    (runningOut.ok ? runningOut.out : "").split(/\r?\n/).map((l) => l.replace(/\x00/g, "").trim()).filter(Boolean)
  );
  const wslOut = await runCmd("wsl.exe --list --verbose", { encoding: "utf16le" });
  if (wslOut.ok) {
    const lines = wslOut.out.split(/\r?\n/)
      .map((l) => l.replace(/\x00/g, "").trim()).filter(Boolean);
    // The first non-empty line is always the (possibly localized) header — skip by index.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const isDefault = /^\s*\*/.test(line);
      const parts = line.replace(/^\s*\*?\s*/, "").trim().split(/\s+/);
      if (!parts[0]) continue;
      const name = parts[0];
      // Version is the trailing numeric token (localized state may span multiple tokens).
      const last = parts[parts.length - 1] || "";
      const version = /^\d+$/.test(last) ? last : "";
      const running = runningSet.has(name);
      const stateRaw = running ? "Running" : "Stopped";
      let osInfo = null;

      if (running) {
        if (osInfoCache.has(name)) {
          osInfo = osInfoCache.get(name);  // static — don't shell into the guest again
        } else {
          // Probe guest OS from /etc/os-release
          const probe = await runCmd(
            `wsl.exe -d ${name} -- sh -c "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\\"'"`,
            { timeout: 5000 }
          );
          if (probe.ok && probe.out.trim()) osInfo = probe.out.trim();
          if (!osInfo) {
            // Fallback: /etc/issue
            const iss = await runCmd(`wsl.exe -d ${name} -- sh -c "head -1 /etc/issue 2>/dev/null | tr -d '\\\\'"`, { timeout: 3000 });
            if (iss.ok && iss.out.trim()) osInfo = iss.out.trim().replace(/\\.*$/, "").trim();
          }
          if (osInfo) osInfoCache.set(name, osInfo);  // only cache success, so a miss retries later
        }
      }

      vms.push({ type: "WSL", name, state: running ? "running" : "stopped",
        stateRaw, isDefault, version, osInfo, ip: null });
    }
  }

  // ── Hyper-V ──────────────────────────────────────────────────────────────
  // Once Hyper-V is confirmed absent, don't pay a PowerShell + module-import every scan —
  // just re-surface the remembered error card (if any). Elevation errors are NOT treated as
  // "absent", so running the app as Administrator still retries.
  if (hyperVUnavailable) {
    if (hyperVErrorMsg) vms.push({ type: "Hyper-V", _error: hyperVErrorMsg });
  } else {
  // Use -EncodedCommand to avoid cmd.exe mangling quotes, braces and @ signs.
  // NOTE: try/catch cannot be used as an expression inside @{} hashtables in
  //       PowerShell — pre-calculate all values into variables first.
  const hvPs = `
$ErrorActionPreference = 'SilentlyContinue'
try { Import-Module Hyper-V -ErrorAction Stop } catch { Write-Error $_.Exception.Message; exit 1 }
$result = @(Get-VM) | ForEach-Object {
  $vm = $_
  $ip   = ($vm.NetworkAdapters | Select-Object -First 1).IPAddresses -join ','
  $os   = "$($vm.OSName)"
  $cpu  = $vm.CPUUsage
  $mem  = [math]::Round($vm.MemoryAssigned / 1GB, 1)
  $gen  = $vm.Generation
  $st   = $vm.State.ToString()
  [pscustomobject]@{
    Name  = $vm.Name
    State = $st
    OS    = $os
    IP    = $ip
    CPU   = $cpu
    MemGB = $mem
    Gen   = $gen
  }
}
$result | ConvertTo-Json -Compress
  `.trim();
  const hv = await runCmd(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(hvPs)}`, { timeout: 20000 });
  const hvTrimmed = hv.out.trim().replace(/^\xEF\xBB\xBF/, ""); // strip BOM if present
  if (hvTrimmed.startsWith("[") || hvTrimmed.startsWith("{")) {
    try {
      const arr = JSON.parse(hvTrimmed);
      const list = Array.isArray(arr) ? arr : [arr];
      for (const vm of list) {
        const running = String(vm.State || "").toLowerCase().includes("running");
        vms.push({
          type:     "Hyper-V",
          name:     vm.Name    || "Unknown",
          state:    running ? "running" : "stopped",
          stateRaw: String(vm.State || ""),
          ip:       (vm.IP || "").split(",").filter(Boolean)[0] || null,
          cpu:      running ? (vm.CPU  ?? null) : null,
          memGb:    running ? (vm.MemGB ?? null) : null,
          gen:      vm.Gen     || null,
          osInfo:   (vm.OS || "").trim() || null,
        });
      }
    } catch (e) {
      console.error("[get-vms] Hyper-V JSON parse error:", e.message, hvTrimmed.slice(0, 200));
    }
  } else if (hv.err) {
    // Strip CLIXML wrapper if present — extract first <S S="Error">...</S> text
    const raw = hv.err.replace(/#< CLIXML[\s\S]*?<S S="Error">/,"").replace(/<\/S>[\s\S]*/,"")
      .replace(/_x000D__x000A_/g, " ").replace(/<[^>]+>/g, "").trim();
    const msg = raw || hv.err.replace(/<[^>]+>/g, "").trim();
    const elevation = /Access.*denied|Administrator|elevation|privilege/i.test(msg);
    if (!elevation) { hyperVUnavailable = true; hyperVErrorMsg = msg.slice(0, 300); }  // absent → stop re-probing
    vms.push({ type: "Hyper-V", _error: msg.slice(0, 300) });
    console.warn("[get-vms] Hyper-V error:", msg.slice(0, 300));
  }
  }  // end !hyperVUnavailable

  // ── VMware Workstation ───────────────────────────────────────────────────
  const vmrunPaths = [
    "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
    "C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe",
  ];
  for (const p of vmrunPaths) {
    if (!fs.existsSync(p)) continue;
    const vw = await runCmd(`"${p}" list`);
    if (vw.ok) {
      const running = new Set(
        vw.out.split(/\r?\n/).filter((l) => l.trim().endsWith(".vmx")).map((l) => l.trim())
      );
      // Also list all VMs
      const vwAll = await runCmd(`"${p}" listRegisteredVMs 2>nul`);
      const allVmx = new Set([
        ...running,
        ...(vwAll.ok ? vwAll.out.split(/\r?\n/).filter((l) => l.trim().endsWith(".vmx")) : []),
      ]);
      for (const vmx of allVmx) {
        const name = path.basename(vmx, ".vmx");
        const isRunning = running.has(vmx);
        vms.push({ type: "VMware", name, state: isRunning ? "running" : "stopped",
          stateRaw: isRunning ? "running" : "stopped", ip: null, vmx, osInfo: null });
      }
    }
    break;
  }

  // ── VirtualBox ───────────────────────────────────────────────────────────
  const rv = await runCmd("VBoxManage list runningvms 2>nul");
  const running_vb = new Set();
  if (rv.ok) { for (const m of rv.out.matchAll(/"([^"]+)"/g)) running_vb.add(m[1]); }
  const vbAll = await runCmd("VBoxManage list vms 2>nul");
  if (vbAll.ok && vbAll.out) {
    for (const m of vbAll.out.matchAll(/"([^"]+)"/g)) {
      const name = m[1];
      if (!name) continue;
      const isRunning = running_vb.has(name);
      let osInfo = null;
      if (isRunning) {
        const info = await runCmd(`VBoxManage showvminfo "${name}" --machinereadable 2>nul`);
        if (info.ok) {
          const gm = info.out.match(/^GuestOSType="(.+)"$/m);
          if (gm) osInfo = gm[1];
        }
      }
      vms.push({ type: "VirtualBox", name, state: isRunning ? "running" : "stopped",
        stateRaw: isRunning ? "running" : "stopped", ip: null, osInfo });
    }
  }

  return vms;
});

// ---------------------------------------------------------------------------
// List directories inside a VM for the folder-browser
// ---------------------------------------------------------------------------
ipcMain.handle("list-vm-dirs", async (_ev, { vmType, vmName, dirPath, user, pass }) => {
  // Sanitise path — disallow shell metacharacters
  const safe = (dirPath || "").replace(/[;&|`$<>]/g, "").trim();

  // ── WSL ────────────────────────────────────────────────────────────────
  if (vmType === "WSL") {
    const startPath = safe || "/";
    const script = `ls -1d ${JSON.stringify(startPath)}/*/  2>/dev/null | head -200`;
    const r = await runCmd(`wsl.exe -d ${vmName} -- bash -c ${JSON.stringify(script)}`, { timeout: 8000 });
    if (r.ok && r.out) {
      return r.out.split(/\r?\n/).filter(Boolean).map((p) => {
        const clean = p.trim().replace(/\/$/, "");
        return { name: clean.split("/").pop(), path: clean };
      });
    }
    // Fallback: plain ls
    const r2 = await runCmd(`wsl.exe -d ${vmName} -- ls -1ap ${JSON.stringify(safe || "/")} 2>/dev/null`, { timeout: 5000 });
    if (r2.ok) {
      return r2.out.split(/\r?\n/).filter((l) => l.endsWith("/") && l !== "./").map((l) => {
        const name = l.replace(/\/$/, "");
        return { name, path: (safe || "").replace(/\/$/, "") + "/" + name };
      });
    }
    return [];
  }

  // ── Hyper-V (PowerShell Direct) ────────────────────────────────────────
  if (vmType === "Hyper-V") {
    const winPath = safe || "C:\\";
    const ps = `
${psCredBlock(user, pass)}
$sb = { param($p) @(Get-ChildItem -Path $p -Directory -Force -ErrorAction SilentlyContinue) | Select-Object Name,FullName | ConvertTo-Json -Compress }
$invArgs = @{ VMName = '${psQuote(vmName)}'; ScriptBlock = $sb; ArgumentList = '${psQuote(winPath)}' }
if ($cred) { $invArgs.Credential = $cred }
Invoke-Command @invArgs
    `.trim();
    const r = await runCmd(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(ps)}`,
      { timeout: 15000 }
    );
    const trimmed = r.out.trim().replace(/^\xEF\xBB\xBF/, "");
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const arr = JSON.parse(trimmed);
        const list = Array.isArray(arr) ? arr : [arr];
        return list.map((d) => ({ name: d.Name || d.name || "", path: d.FullName || d.fullname || "" }));
      } catch { /* fall through */ }
    }
    if (r.err) console.warn("[list-vm-dirs] Hyper-V:", r.err.slice(0, 200));
    return [];
  }

  return [];
});

// ---------------------------------------------------------------------------
// Discover git repositories INSIDE a VM (for the New Session repo picker).
// Roots come from settings (vm.repoRoots.{windows,linux}); the guest OS is
// detected at runtime so the right list is used. PowerShell is cross-platform,
// so one scriptblock serves both Windows and Linux guests that have PowerShell.
// ---------------------------------------------------------------------------
ipcMain.handle("list-vm-repos", async (_ev, { vmType, vmName, user, pass } = {}) => {
  if (vmType !== "Hyper-V") {
    // WSL/local repos are already served by the orchestrator's /api/repos.
    return { os: null, repos: [], error: vmType ? `repo discovery not supported for ${vmType}` : "no VM type" };
  }
  if (!vmName) return { os: null, repos: [], error: "no VM selected" };

  const winRoots   = Array.isArray(settings["vm.repoRoots.windows"]) ? settings["vm.repoRoots.windows"] : DEFAULTS["vm.repoRoots.windows"];
  const linuxRoots = Array.isArray(settings["vm.repoRoots.linux"])   ? settings["vm.repoRoots.linux"]   : DEFAULTS["vm.repoRoots.linux"];
  const depth      = Number(settings["vm.repoScanDepth"]) || DEFAULTS["vm.repoScanDepth"];

  // The guest scriptblock: detect OS, pick the matching roots, find every `.git` dir
  // (bounded by depth), and report repo path + branch + uncommitted-change count.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
try { Import-Module Hyper-V -ErrorAction Stop } catch { Write-Error $_.Exception.Message; exit 1 }
${psCredBlock(user, pass)}
$winRoots   = '${psQuote(JSON.stringify(winRoots))}'   | ConvertFrom-Json
$linuxRoots = '${psQuote(JSON.stringify(linuxRoots))}' | ConvertFrom-Json
$sb = {
  param($winRoots, $linuxRoots, $depth)
  $isLin = $false
  try { if (Get-Variable -Name IsLinux -ValueOnly -ErrorAction SilentlyContinue) { $isLin = $true } } catch {}
  $roots = if ($isLin) { $linuxRoots } else { $winRoots }
  $repos = @()
  foreach ($root in $roots) {
    foreach ($base in @(Get-Item -Path $root -Force -ErrorAction SilentlyContinue)) {
      if (-not $base.PSIsContainer) { continue }
      foreach ($g in @(Get-ChildItem -LiteralPath $base.FullName -Filter '.git' -Directory -Recurse -Depth $depth -Force -ErrorAction SilentlyContinue)) {
        $repo = Split-Path -Parent $g.FullName
        $branch = (& git -C $repo rev-parse --abbrev-ref HEAD 2>$null)
        $changes = ((& git -C $repo status --porcelain 2>$null | Measure-Object -Line).Lines)
        $repos += [pscustomobject]@{ Path = $repo; Name = (Split-Path -Leaf $repo); Branch = "$branch"; Changes = [int]$changes }
      }
    }
  }
  [pscustomobject]@{ os = $(if ($isLin) { 'linux' } else { 'windows' }); repos = @($repos) }
}
$invArgs = @{ VMName = '${psQuote(vmName)}'; ScriptBlock = $sb; ArgumentList = @($winRoots, $linuxRoots, ${depth}) }
if ($cred) { $invArgs.Credential = $cred }
Invoke-Command @invArgs | ConvertTo-Json -Compress -Depth 6
  `.trim();

  const r = await runCmd(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(ps)}`, { timeout: 45000 });
  const trimmed = r.out.trim().replace(/^\xEF\xBB\xBF/, "");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(trimmed);
      const node = Array.isArray(obj) ? (obj[0] || {}) : obj;
      const rawRepos = node.repos == null ? [] : (Array.isArray(node.repos) ? node.repos : [node.repos]);
      const repos = rawRepos
        .filter((x) => x && (x.Path || x.path))
        .map((x) => ({
          path:    (x.Path || x.path || "").replace(/\\/g, "/"),
          name:    x.Name || x.name || "",
          branch:  (x.Branch || x.branch || "").trim() || null,
          changes: (x.Changes ?? x.changes ?? null),
        }));
      repos.sort((a, b) => a.name.localeCompare(b.name));
      return { os: node.os || null, repos };
    } catch (e) {
      console.error("[list-vm-repos] parse error:", e.message, trimmed.slice(0, 200));
    }
  }
  // Surface a readable error (strip CLIXML/markup the same way get-vms does).
  let msg = "";
  if (r.err) {
    msg = r.err.replace(/#< CLIXML[\s\S]*?<S S="Error">/, "").replace(/<\/S>[\s\S]*/, "")
      .replace(/_x000D__x000A_/g, " ").replace(/<[^>]+>/g, "").trim() || r.err.replace(/<[^>]+>/g, "").trim();
  }
  if (!msg) msg = trimmed ? `unexpected output: ${trimmed.slice(0, 120)}` : "VM unreachable (is it running and PowerShell Direct available?)";
  console.warn("[list-vm-repos] Hyper-V error:", msg.slice(0, 300));
  return { os: null, repos: [], error: msg.slice(0, 300) };
});
