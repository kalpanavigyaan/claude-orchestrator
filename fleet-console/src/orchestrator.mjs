#!/usr/bin/env node
/**
 * Fleet Console orchestrator.
 *
 * Owns multiple Claude Agent SDK sessions by spawning one runner child process per session,
 * routes messages between the browser and each runner, serves the web UI, streams live
 * updates over SSE, schedules automatic continuation after the 5-hour usage reset, and
 * optionally guards everything behind a bearer token.
 *
 * Built-in Node modules only (the Agent SDK lives in the runner). Run: `node src/orchestrator.mjs`.
 * Env: PORT (4318), HOST (127.0.0.1), FLEET_TOKEN (optional), CONTINUE_BUFFER_SECONDS (30),
 *      CONTINUE_MIN_INTERVAL_SECONDS (300).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { buildSpawn } from "./hosts.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, "runner.mjs");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = Number(process.env.PORT || 4318);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.FLEET_TOKEN || "";
const BUFFER_MS = Number(process.env.CONTINUE_BUFFER_SECONDS || 30) * 1000;
const MIN_INTERVAL_MS = Number(process.env.CONTINUE_MIN_INTERVAL_SECONDS || 300) * 1000;
const MESSAGE_CAP = 500;

/** @type {Map<string, any>} */
const sessions = new Map();
/** Fleet-level SSE subscribers. */
const fleetSse = new Set();
let manualAccountReset = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function now() {
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
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-fleet-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

function authorized(req, query) {
  if (!TOKEN) {
    return true;
  }
  const header = req.headers["x-fleet-token"];
  return header === TOKEN || query.token === TOKEN;
}

function accountResetAt() {
  if (manualAccountReset && manualAccountReset > now()) {
    return manualAccountReset;
  }
  let max = null;
  for (const s of sessions.values()) {
    if (typeof s.resetAt === "number" && s.resetAt > now()) {
      max = max === null ? s.resetAt : Math.max(max, s.resetAt);
    }
  }
  return max;
}

function sessionSummary(s) {
  return {
    id: s.id,
    label: s.label,
    host: s.host,
    distro: s.distro || null,
    cwd: s.cwd,
    model: s.model || null,
    policy: s.policy,
    status: s.status,
    resetAt: s.resetAt,
    nextContinueAt: s.nextContinueAt,
    lastContinueAt: s.lastContinueAt,
    autoContinue: s.autoContinue,
    pendingApprovals: [...s.pendingApprovals.values()],
    lastResult: s.lastResult || null,
    createdAt: s.createdAt,
  };
}

function fleetSnapshot() {
  return {
    now: now(),
    account: { resetAt: accountResetAt(), manualReset: manualAccountReset },
    sessions: [...sessions.values()].map(sessionSummary),
  };
}

function broadcastFleet() {
  const data = `data: ${JSON.stringify(fleetSnapshot())}\n\n`;
  for (const res of fleetSse) {
    try {
      res.write(data);
    } catch {
      fleetSse.delete(res);
    }
  }
}

function pushSessionEvent(s, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of s.sse) {
    try {
      res.write(data);
    } catch {
      s.sse.delete(res);
    }
  }
}

function recordMessage(s, message) {
  s.messages.push({ ts: now(), ...message });
  if (s.messages.length > MESSAGE_CAP) {
    s.messages.shift();
  }
  pushSessionEvent(s, { kind: "message", message: { ts: now(), ...message } });
}

function writeToRunner(s, obj) {
  if (s.proc && s.proc.stdin && s.proc.stdin.writable) {
    s.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------

function createSession(spec) {
  const id = crypto.randomBytes(5).toString("hex");
  const policy = spec.policy === "ask" ? "ask" : "auto";
  const permissionMode =
    spec.permissionMode || (policy === "auto" ? "acceptEdits" : "default");

  const runnerConfig = {
    cwd: spec.cwd,
    model: spec.model || null,
    permissionMode,
    policy,
    additionalDirectories: Array.isArray(spec.additionalDirectories) ? spec.additionalDirectories : [],
    initialPrompt: spec.initialPrompt || "",
    systemPromptAppend:
      policy === "auto"
        ? "You are running unattended. Work autonomously; do not wait for confirmation."
        : "",
    limitPattern: spec.limitPattern || "",
    maxTurns: spec.maxTurns || undefined,
  };

  const session = {
    id,
    label: spec.label || spec.cwd || id,
    host: spec.host === "wsl" ? "wsl" : "local",
    distro: spec.distro || null,
    runnerPath: spec.runnerPath || null,
    node: spec.node || null,
    cwd: spec.cwd,
    model: spec.model || null,
    permissionMode,
    policy,
    autoContinue: spec.autoContinue !== false,
    status: "starting",
    resetAt: null,
    nextContinueAt: null,
    lastContinueAt: null,
    createdAt: now(),
    messages: [],
    pendingApprovals: new Map(),
    sse: new Set(),
    stdoutRemainder: "",
    runnerConfig,
    lastResult: null,
    proc: null,
  };

  sessions.set(id, session);
  spawnRunner(session);
  return session;
}

function spawnRunner(s) {
  const { command, args } = buildSpawn(s, RUNNER_PATH);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  s.proc = child;

  const out = readline.createInterface({ input: child.stdout });
  out.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      return;
    }
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    handleRunnerEvent(s, event);
  });

  child.stderr.on("data", (d) => {
    // Runner diagnostics; keep last line as a log message.
    const msg = String(d).trim();
    if (msg) {
      recordMessage(s, { role: "system", text: msg.slice(-500) });
    }
  });

  child.on("exit", (code) => {
    s.status = code === 0 ? "ended" : "error";
    s.proc = null;
    recordMessage(s, { role: "system", text: `runner exited (code ${code})` });
    broadcastFleet();
  });

  child.on("error", (err) => {
    s.status = "error";
    recordMessage(s, { role: "system", text: `runner spawn error: ${err}` });
    broadcastFleet();
  });
}

function handleRunnerEvent(s, event) {
  switch (event.type) {
    case "status":
      if (event.status === "ready") {
        s.status = s.status === "starting" ? "idle" : s.status;
      } else if (event.status === "idle") {
        s.status = "idle";
      } else if (event.status === "error") {
        s.status = "error";
        recordMessage(s, { role: "system", text: `error: ${event.detail || ""}` });
      } else if (event.status === "ended") {
        s.status = "ended";
      }
      break;
    case "assistant":
      s.status = "running";
      recordMessage(s, { role: "assistant", text: event.text });
      break;
    case "tool_use":
      recordMessage(s, { role: "tool", name: event.name, input: event.input });
      break;
    case "approval_request":
      s.pendingApprovals.set(event.id, { id: event.id, tool: event.tool, input: event.input, ts: now() });
      pushSessionEvent(s, { kind: "approval", approval: { id: event.id, tool: event.tool, input: event.input } });
      break;
    case "result":
      s.lastResult = { subtype: event.subtype, cost: event.cost, turns: event.turns, usage: event.usage };
      s.status = "idle";
      if (event.resultText) {
        recordMessage(s, { role: "result", text: event.resultText });
      }
      break;
    case "rate_limit":
      s.resetAt = event.resetAt;
      s.status = "limited";
      s.nextContinueAt = event.resetAt + BUFFER_MS;
      recordMessage(s, {
        role: "system",
        text: `usage limit reached; reset ${new Date(event.resetAt).toLocaleString()}`,
      });
      break;
    case "log":
      // low-noise; ignore unless useful
      break;
  }
  broadcastFleet();
}

// ---------------------------------------------------------------------------
// 5-hour reset scheduler
// ---------------------------------------------------------------------------

function schedulerTick() {
  for (const s of sessions.values()) {
    if (s.status !== "limited" || !s.autoContinue || !s.nextContinueAt) {
      continue;
    }
    if (now() < s.nextContinueAt) {
      continue;
    }
    if (s.lastContinueAt && now() - s.lastContinueAt < MIN_INTERVAL_MS) {
      s.nextContinueAt = null;
      continue;
    }
    s.lastContinueAt = now();
    s.nextContinueAt = null;
    s.resetAt = null;
    s.status = "running";
    writeToRunner(s, { type: "continue" });
    recordMessage(s, { role: "system", text: "auto-continued after reset" });
    broadcastFleet();
  }
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
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
  const query = parsed.query || {};

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  // Static UI is unauthenticated so the page can load and then supply the token.
  if (method === "GET" && !pathname.startsWith("/api/")) {
    serveStatic(res, pathname);
    return;
  }

  if (!authorized(req, query)) {
    sendJson(res, 401, { ok: false, reason: "unauthorized" });
    return;
  }

  // Fleet SSE
  if (pathname === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`data: ${JSON.stringify(fleetSnapshot())}\n\n`);
    fleetSse.add(res);
    req.on("close", () => fleetSse.delete(res));
    return;
  }

  if (pathname === "/api/state" && method === "GET") {
    sendJson(res, 200, fleetSnapshot());
    return;
  }

  if (pathname === "/api/sessions" && method === "POST") {
    const body = await readBody(req);
    if (!body.cwd) {
      sendJson(res, 400, { ok: false, reason: "cwd is required" });
      return;
    }
    const s = createSession(body);
    broadcastFleet();
    sendJson(res, 200, { ok: true, id: s.id, session: sessionSummary(s) });
    return;
  }

  // Per-session detail
  const detail = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (detail && method === "GET") {
    const s = sessions.get(detail[1]);
    if (!s) {
      sendJson(res, 404, { ok: false });
      return;
    }
    sendJson(res, 200, { ...sessionSummary(s), messages: s.messages });
    return;
  }

  // Per-session SSE
  const evt = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (evt && method === "GET") {
    const s = sessions.get(evt[1]);
    if (!s) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`data: ${JSON.stringify({ kind: "backlog", messages: s.messages, pendingApprovals: [...s.pendingApprovals.values()] })}\n\n`);
    s.sse.add(res);
    req.on("close", () => s.sse.delete(res));
    return;
  }

  // Per-session actions
  const act = pathname.match(/^\/api\/sessions\/([^/]+)\/([a-z-]+)$/);
  if (act && method === "POST") {
    const s = sessions.get(act[1]);
    const verb = act[2];
    if (!s) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const body = await readBody(req);
    if (verb === "message") {
      const text = String(body.text || "");
      recordMessage(s, { role: "user", text });
      s.status = "running";
      writeToRunner(s, { type: "user", text });
      sendJson(res, 200, { ok: true });
    } else if (verb === "approval") {
      s.pendingApprovals.delete(body.id);
      writeToRunner(s, { type: "approval", id: body.id, decision: body.decision, message: body.message });
      sendJson(res, 200, { ok: true });
    } else if (verb === "continue") {
      s.status = "running";
      s.resetAt = null;
      s.nextContinueAt = null;
      writeToRunner(s, { type: "continue" });
      sendJson(res, 200, { ok: true });
    } else if (verb === "stop") {
      writeToRunner(s, { type: "shutdown" });
      setTimeout(() => {
        if (s.proc) {
          s.proc.kill();
        }
      }, 1000);
      sendJson(res, 200, { ok: true });
    } else if (verb === "auto-continue") {
      s.autoContinue = body.enabled !== false;
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { ok: false, reason: "unknown action" });
    }
    broadcastFleet();
    return;
  }

  // Account actions
  if (pathname === "/api/account/continue-all" && method === "POST") {
    let count = 0;
    for (const s of sessions.values()) {
      if (s.status === "limited" || s.status === "idle") {
        s.status = "running";
        s.resetAt = null;
        s.nextContinueAt = null;
        s.lastContinueAt = now();
        writeToRunner(s, { type: "continue" });
        count++;
      }
    }
    broadcastFleet();
    sendJson(res, 200, { ok: true, count });
    return;
  }
  if (pathname === "/api/account/set-reset" && method === "POST") {
    const body = await readBody(req);
    manualAccountReset = Number(body.resetAt) || null;
    if (manualAccountReset) {
      for (const s of sessions.values()) {
        if (s.status === "limited" || s.autoContinue) {
          s.resetAt = manualAccountReset;
          s.nextContinueAt = manualAccountReset + BUFFER_MS;
          if (s.status !== "limited") {
            s.status = "limited";
          }
        }
      }
    }
    broadcastFleet();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, reason: "not found" });
});

setInterval(schedulerTick, 1000);
setInterval(broadcastFleet, 1000);

server.listen(PORT, HOST, () => {
  const auth = TOKEN ? " (token required)" : " (no token — set FLEET_TOKEN to lock down)";
  console.log(`[fleet-console] http://${HOST}:${PORT}${auth}`);
});
