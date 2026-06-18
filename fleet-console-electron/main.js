"use strict";
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

// Silence the GPU-shader-disk-cache access-denied errors that appear on Windows
// when the app data directory has restricted permissions.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-software-rasterizer");
// Store GPU / session cache in a known writable location next to the app.
app.setPath("userData", path.join(__dirname, ".app-data"));

const ORCH_PORT = 4318;

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
    orchProc = spawn(process.execPath, [ORCH_SCRIPT], {
      cwd:         ORCH_CWD,
      stdio:       ["pipe", "pipe", "pipe"],
      env:         { ...process.env },
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
    width:           1440,
    height:          920,
    minWidth:        900,
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
