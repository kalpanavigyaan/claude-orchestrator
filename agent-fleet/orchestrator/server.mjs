#!/usr/bin/env node
/**
 * Claude Agent Fleet — orchestrator.
 *
 * A zero-dependency Node service (built-in modules only) that:
 *   - receives heartbeats from each window's extension and tracks per-agent state,
 *   - maintains an account-level 5-hour reset clock (the limit is account-wide),
 *   - queues commands from the dashboard and returns them on the next heartbeat,
 *   - serves the static dashboard and a live SSE stream,
 *   - focuses a VS Code window on the host (PowerShell), and
 *   - optionally triggers CDP injection into a panel webview (spawns cdp-inject.mjs).
 *
 * Run:  node server.mjs        (PORT and HOST overridable via env)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const CDP_MAP_FILE = path.join(__dirname, "agent-cdp.json");
const OFFLINE_AFTER_MS = 12000;

/** @type {Map<string, {agent:any, state:any, lastSeen:number, events:any[]}>} */
const registry = new Map();
/** @type {Map<string, any[]>} */
const commandQueues = new Map();
/** Global event log (most recent last). */
const eventLog = [];
/** SSE response objects. */
const sseClients = new Set();
/** Manual account reset override (epoch ms) or null. */
let manualAccountReset = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function enqueue(id, command) {
  if (!commandQueues.has(id)) {
    commandQueues.set(id, []);
  }
  commandQueues.get(id).push(command);
}

function dequeue(id) {
  const q = commandQueues.get(id) || [];
  commandQueues.set(id, []);
  return q;
}

function logEvent(level, message, agentId) {
  const event = { ts: nowMs(), level, message, agentId: agentId || null };
  eventLog.push(event);
  if (eventLog.length > 1000) {
    eventLog.shift();
  }
}

function accountResetAt() {
  if (manualAccountReset && manualAccountReset > nowMs()) {
    return manualAccountReset;
  }
  let max = null;
  for (const entry of registry.values()) {
    const r = entry.state && entry.state.resetAt;
    if (typeof r === "number" && r > nowMs()) {
      max = max === null ? r : Math.max(max, r);
    }
  }
  return max;
}

function snapshot() {
  const now = nowMs();
  const agents = [];
  for (const entry of registry.values()) {
    agents.push({
      ...entry.agent,
      ...entry.state,
      online: now - entry.lastSeen < OFFLINE_AFTER_MS,
      lastSeen: entry.lastSeen,
    });
  }
  agents.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return {
    now,
    account: { resetAt: accountResetAt(), manualReset: manualAccountReset },
    agents,
    log: eventLog.slice(-200),
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function loadCdpMap() {
  try {
    return JSON.parse(fs.readFileSync(CDP_MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function focusWindow(agent) {
  // Host-side only: find a VS Code window whose title contains the agent label and raise it.
  // (Works for Windows-host and WSL-remote windows, which are host windows. Hyper-V guest
  // windows live inside the VM and are not reachable from the host.)
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, reason: "focus only supported on the Windows host" });
  }
  const label = String(agent.label || "").replace(/'/g, "''");
  const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FleetWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${label}*' -and $_.MainWindowTitle -like '*Visual Studio Code*' } | Select-Object -First 1
if (-not $p) { $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${label}*' } | Select-Object -First 1 }
if ($p) { [FleetWin]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [FleetWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'ok' } else { 'not-found' }
`;
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => resolve({ ok: out.includes("ok"), detail: out.trim() }));
    ps.on("error", (e) => resolve({ ok: false, reason: String(e) }));
  });
}

function cdpInject(agentId, text) {
  // Look up the per-agent CDP debug port from agent-cdp.json: { "<agentId>": 9222 }.
  const map = loadCdpMap();
  const port = map[agentId];
  if (!port) {
    return Promise.resolve({
      injected: false,
      reason: `no CDP port configured for ${agentId} in agent-cdp.json`,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "cdp-inject.mjs"), "--port", String(port), "--text", text],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const injected = code === 0 && /INJECTED/.test(out);
      resolve({ injected, detail: (out + err).trim().slice(-500) });
    });
    child.on("error", (e) => resolve({ injected: false, reason: String(e) }));
  });
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// request routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  // SSE stream
  if (pathname === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/state" && method === "GET") {
    sendJson(res, 200, snapshot());
    return;
  }

  // Heartbeat: POST /api/agents/:id/heartbeat
  const hb = pathname.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
  if (hb && method === "POST") {
    const id = decodeURIComponent(hb[1]);
    const body = await readBody(req);
    const prev = registry.get(id);
    registry.set(id, {
      agent: body.agent || (prev && prev.agent) || { id, label: id },
      state: body.state || (prev && prev.state) || {},
      lastSeen: nowMs(),
      events: (prev && prev.events) || [],
    });
    if (Array.isArray(body.events)) {
      for (const e of body.events) {
        logEvent(e.level || "info", e.message || "", id);
      }
    }
    sendJson(res, 200, { commands: dequeue(id) });
    broadcast();
    return;
  }

  // Per-agent action: POST /api/agents/:id/:action
  const action = pathname.match(/^\/api\/agents\/([^/]+)\/([a-z-]+)$/);
  if (action && method === "POST") {
    const id = decodeURIComponent(action[1]);
    const verb = action[2];
    const body = await readBody(req);
    const entry = registry.get(id);

    if (verb === "continue" || verb === "pause" || verb === "resume" || verb === "reset") {
      enqueue(id, { command: verb });
      logEvent("info", `Queued '${verb}' for ${id}`, id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (verb === "set-reset") {
      const resetAt = Number(body.resetAt);
      if (resetAt) {
        enqueue(id, { command: "setReset", payload: { resetAt } });
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 400, { ok: false, reason: "resetAt required" });
      }
      return;
    }
    if (verb === "focus") {
      const result = await focusWindow(entry ? entry.agent : { label: id });
      logEvent(result.ok ? "info" : "warn", `Focus ${id}: ${JSON.stringify(result)}`, id);
      sendJson(res, 200, result);
      return;
    }
    if (verb === "cdp-inject") {
      const result = await cdpInject(id, body.text || "continue");
      logEvent(result.injected ? "info" : "warn", `CDP inject ${id}: ${JSON.stringify(result)}`, id);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { ok: false, reason: "unknown action" });
    return;
  }

  // Account actions
  if (pathname === "/api/account/continue-all" && method === "POST") {
    let count = 0;
    for (const [id, entry] of registry.entries()) {
      if (entry.state && entry.state.enabled !== false) {
        enqueue(id, { command: "continue" });
        count++;
      }
    }
    logEvent("info", `Queued continue for ${count} agent(s).`);
    sendJson(res, 200, { ok: true, count });
    broadcast();
    return;
  }
  if (pathname === "/api/account/set-reset" && method === "POST") {
    const body = await readBody(req);
    const resetAt = Number(body.resetAt);
    manualAccountReset = resetAt || null;
    for (const id of registry.keys()) {
      if (resetAt) {
        enqueue(id, { command: "setReset", payload: { resetAt } });
      }
    }
    logEvent("info", `Account reset set to ${resetAt ? new Date(resetAt).toISOString() : "cleared"}.`);
    sendJson(res, 200, { ok: true });
    broadcast();
    return;
  }

  // Static dashboard
  if (method === "GET") {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 404, { ok: false, reason: "not found" });
});

// Periodic broadcast so countdowns stay live even without heartbeats.
setInterval(broadcast, 1000);

server.listen(PORT, HOST, () => {
  logEvent("info", `Orchestrator listening on http://${HOST}:${PORT}`);
  console.log(`[agent-fleet] orchestrator on http://${HOST}:${PORT}  (dashboard at /)`);
});
