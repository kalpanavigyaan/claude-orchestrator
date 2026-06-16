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
 * Configuration lives in config.yaml (see config.example.yaml); env vars still override.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { buildSpawn, toMnt } from "./hosts.mjs";
import { config, configSource } from "./config.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, "runner.mjs");
const USAGE_FETCHER_PATH = path.join(__dirname, "usage-fetcher.mjs");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = config.server.port;
const HOST = config.server.host;
const TOKEN = config.server.token;
const BUFFER_MS = config.continue.bufferSeconds * 1000;
const MIN_INTERVAL_MS = config.continue.minIntervalSeconds * 1000;
const USAGE_POLL_MS = Math.max(1000, config.usage.pollSeconds * 1000);
const MESSAGE_CAP = 500;
const SESSIONS_DIR = config.sessions.dir;
const REPO_LOCAL_ROOTS = (config.repos && Array.isArray(config.repos.localRoots)) ? config.repos.localRoots : [];
const REPO_MAX_DEPTH = (config.repos && config.repos.maxDepth) || 3;
// Tool categories for the per-category auto-approve toggles (mirrors runner.mjs).
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Update", "Create", "ApplyPatch"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);
function toolCategory(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edits";
  if (SHELL_TOOLS.has(name)) return "shell";
  return "other";
}

// Permission modes use Claude's own naming. Each maps to the SDK permissionMode (plan vs default;
// canUseTool governs execution) and the set of auto-approved tool categories that canUseTool runs
// without asking. Reads always run. "auto" = bypassPermissions (everything runs unattended).
const MODES = {
  default: { permissionMode: "default", approve: [] }, // Ask before edits
  acceptEdits: { permissionMode: "default", approve: ["edits"] }, // Auto-accept edits
  plan: { permissionMode: "plan", approve: [] }, // Plan (read-only)
  bypassPermissions: { permissionMode: "default", approve: ["edits", "shell", "other"] }, // Auto
};
/** Normalize an incoming mode string to a known mode key. */
function normalizeMode(m) {
  return MODES[m] ? m : "default";
}
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
} catch {
  /* ignore */
}

/** Sanitize a label/filename component: keep it a safe single path segment. */
function safeSegment(value, fallback = "session") {
  const cleaned = String(value || "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/** @type {Map<string, any>} */
const sessions = new Map();
/** Fleet-level SSE subscribers. */
const fleetSse = new Set();
let manualAccountReset = null;
/**
 * Latest account-wide plan usage, from the SDK's /usage data (same across sessions/devices). Keyed
 * by window (five_hour, seven_day, seven_day_opus, …); each value is { type, utilization (0-100),
 * resetAt (ms) }.
 */
const accountUsage = new Map();
let accountSubscription = null;
let accountRateLimitsAvailable = false;
/** Models the SDK reports as available (same across sessions); for the on-the-fly model switcher. */
let availableModels = [];
/** Slash commands the SDK reports (for the commands panel). */
let availableCommands = [];

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
  // 1) An explicit manual reset wins.
  if (manualAccountReset && manualAccountReset > now()) {
    return manualAccountReset;
  }
  // 2) An actual rate-limit hit (a session recorded a reject's resetAt).
  let max = null;
  for (const s of sessions.values()) {
    if (typeof s.resetAt === "number" && s.resetAt > now()) {
      max = max === null ? s.resetAt : Math.max(max, s.resetAt);
    }
  }
  if (max !== null) {
    return max;
  }
  // 3) Otherwise show the normal 5-hour window reset from the SDK /usage data, so the header always
  //    has a meaningful "Account reset" countdown even when you're nowhere near a limit.
  const fiveHour = accountUsage.get("five_hour");
  if (fiveHour && typeof fiveHour.resetAt === "number" && fiveHour.resetAt > now()) {
    return fiveHour.resetAt;
  }
  return null;
}

function sessionSummary(s) {
  return {
    id: s.id,
    label: s.label,
    host: s.host,
    distro: s.distro || null,
    cwd: s.cwd,
    model: s.model || null,
    mode: s.mode || "default",
    permissionMode: s.permissionMode || "default",
    autoApprove: s.autoApprove || [],
    effort: s.effort || null,
    thinking: s.thinking || "adaptive",
    browser: !!s.browser,
    policy: s.policy,
    status: s.status,
    resetAt: s.resetAt,
    nextContinueAt: s.nextContinueAt,
    lastContinueAt: s.lastContinueAt,
    autoContinue: s.autoContinue,
    pendingApprovals: [...s.pendingApprovals.values()],
    lastResult: s.lastResult || null,
    createdAt: s.createdAt,
    sessionDir: s.sessionDir || null,
    instructionsDir: s.instructionsDir || null,
  };
}

/** Aggregate cost + tokens across sessions this run, from each session's last result (cumulative). */
function aggregateUsage() {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of sessions.values()) {
    if (s.lastResult) {
      costUsd += s.lastResult.cost || 0;
      const u = s.lastResult.usage || {};
      inputTokens += u.input_tokens || 0;
      outputTokens += u.output_tokens || 0;
    }
  }
  return { costUsd, inputTokens, outputTokens };
}

/**
 * Apply a /usage report (from the usage-fetcher) to the account-wide window state. rate_limits is
 * account-wide; each window's utilization is a 0-100 percentage and resets_at is an ISO timestamp.
 */
function applyUsageReport(report) {
  if (!report) {
    return;
  }
  if (report.subscriptionType) {
    accountSubscription = report.subscriptionType;
  }
  accountRateLimitsAvailable = !!report.available;
  const limits = report.rateLimits || {};
  for (const [key, w] of Object.entries(limits)) {
    if (!w || typeof w.utilization !== "number") {
      continue;
    }
    accountUsage.set(key, {
      type: key,
      utilization: w.utilization,
      resetAt: w.resets_at ? Date.parse(w.resets_at) || null : null,
      updatedAt: now(),
    });
  }
}

function fleetSnapshot() {
  return {
    now: now(),
    account: { resetAt: accountResetAt(), manualReset: manualAccountReset },
    usage: {
      windows: [...accountUsage.values()],
      totals: aggregateUsage(),
      subscriptionType: accountSubscription,
      available: accountRateLimitsAvailable,
    },
    models: availableModels,
    commands: availableCommands,
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
  s.dirty = true;
  pushSessionEvent(s, { kind: "message", message: { ts: now(), ...message } });
}

/** Build the canonical JSON record of a session (metadata + interactions). */
function sessionRecordObject(s) {
  return {
    id: s.id,
    label: s.label,
    host: s.host,
    distro: s.distro || null,
    cwd: s.cwd,
    model: s.model || null,
    policy: s.policy,
    mode: s.mode || "default",
    permissionMode: s.permissionMode,
    effort: s.effort || null,
    thinking: s.thinking || "adaptive",
    browser: !!s.browser,
    sdkSessionId: s.sdkSessionId || null,
    status: s.status,
    createdAt: new Date(s.createdAt).toISOString(),
    lastResult: s.lastResult || null,
    interactions: s.messages.map((m) => {
      const entry = { ts: new Date(m.ts).toISOString(), role: m.role };
      if (m.text != null) entry.text = m.text;
      if (m.name != null) entry.tool = m.name;
      if (m.input != null) entry.input = m.input;
      return entry;
    }),
  };
}

/** Render a human-readable markdown transcript of the session for display/archival. */
function renderConversationMarkdown(s) {
  const lines = [
    `# ${s.label}`,
    "",
    `- Host: ${s.host}${s.distro ? ` (${s.distro})` : ""}`,
    `- Working dir: ${s.cwd}`,
    `- Created: ${new Date(s.createdAt).toISOString()}`,
    `- Status: ${s.status}`,
  ];
  if (s.lastResult) {
    lines.push(`- Cost: $${(s.lastResult.cost || 0).toFixed(4)} · turns: ${s.lastResult.turns || 0}`);
  }
  lines.push("", "---", "");
  for (const m of s.messages) {
    const t = new Date(m.ts).toISOString();
    if (m.role === "user") {
      lines.push(`### 🧑 User · ${t}`, "", m.text || "", "");
    } else if (m.role === "assistant") {
      lines.push(`### 🤖 Claude · ${t}`, "", m.text || "", "");
    } else if (m.role === "tool") {
      lines.push(`> 🔧 \`${m.name}\` ${m.input ? "`" + JSON.stringify(m.input) + "`" : ""}`, "");
    } else if (m.role === "result") {
      lines.push(`### ✅ Result · ${t}`, "", m.text || "", "");
    } else {
      lines.push(`_${m.role}: ${m.text || ""}_`, "");
    }
  }
  return lines.join("\n");
}

/** Write the session as session.json (canonical) + conversation.md (display) in its folder. */
function persistSession(s) {
  try {
    const dir = s.sessionDir || SESSIONS_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(sessionRecordObject(s), null, 2));
    fs.writeFileSync(path.join(dir, "conversation.md"), renderConversationMarkdown(s));
  } catch {
    /* best effort */
  }
}

/** Repo/working-dir name (last path segment) from a Windows or POSIX cwd. */
function repoNameOf(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "repo";
}

function listSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Walk the sessions tree (<root>/<WSL|Windows>/<distro-or-host>/<repo>/<title>/) and return
 * a flat, newest-first list of saved sessions for the history browser.
 */
function listHistory() {
  const out = [];
  for (const hostKind of listSubdirs(SESSIONS_DIR)) {
    const hkDir = path.join(SESSIONS_DIR, hostKind);
    for (const group of listSubdirs(hkDir)) {
      const grpDir = path.join(hkDir, group);
      for (const repo of listSubdirs(grpDir)) {
        const repoDir = path.join(grpDir, repo);
        for (const title of listSubdirs(repoDir)) {
          const dir = path.join(repoDir, title);
          let meta = {};
          try {
            meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
          } catch {
            /* folder without a session.json yet */
          }
          let mtime = 0;
          try {
            mtime = fs.statSync(dir).mtimeMs;
          } catch {
            /* ignore */
          }
          out.push({
            rel: path.relative(SESSIONS_DIR, dir),
            hostKind,
            group,
            repo,
            title,
            label: meta.label || title,
            createdAt: meta.createdAt || null,
            status: meta.status || null,
            messages: Array.isArray(meta.interactions) ? meta.interactions.length : 0,
            mtime,
          });
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Read one saved session for display: { meta (session.json), markdown (conversation.md) }. */
function readHistoryItem(rel) {
  const dir = path.resolve(path.join(SESSIONS_DIR, String(rel || "")));
  if (!dir.startsWith(path.resolve(SESSIONS_DIR))) {
    return null;
  }
  let meta = null;
  let markdown = "";
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  } catch {
    return null;
  }
  try {
    markdown = fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
  } catch {
    /* optional */
  }
  return { meta, markdown };
}

/** List the .md instruction files in a session's instructions folder (sorted). */
function listInstructionFiles(s) {
  try {
    return fs
      .readdirSync(s.instructionsDir)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort()
      .map((n) => {
        let size = 0;
        try {
          size = fs.statSync(path.join(s.instructionsDir, n)).size;
        } catch {
          /* ignore */
        }
        return { name: n, size };
      });
  } catch {
    return [];
  }
}

/** Write an instruction .md file into the session's instructions folder (sanitized). */
function writeInstructionFile(s, rawName, content) {
  let name = path.basename(String(rawName || "").trim()).replace(/[^a-z0-9._-]+/gi, "-");
  if (!name || name === "-") {
    name = `instruction_${Date.now()}`;
  }
  if (!/\.md$/i.test(name)) {
    name += ".md";
  }
  const full = path.resolve(path.join(s.instructionsDir, name));
  if (!full.startsWith(path.resolve(s.instructionsDir))) {
    return { ok: false, reason: "invalid filename" };
  }
  try {
    fs.mkdirSync(s.instructionsDir, { recursive: true });
    fs.writeFileSync(full, String(content == null ? "" : content), "utf8");
    return { ok: true, name };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** Delete an instruction file from the session's instructions folder (sanitized). */
function deleteInstructionFile(s, rawName) {
  const full = path.resolve(path.join(s.instructionsDir, path.basename(String(rawName || ""))));
  if (!full.startsWith(path.resolve(s.instructionsDir))) {
    return { ok: false, reason: "invalid filename" };
  }
  try {
    fs.unlinkSync(full);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** The message sent to the agent to read its instruction files (uses the agent-visible path). */
function readInstructionsMessage(s) {
  return (
    `Read all markdown (.md) instruction files in this directory, sorted by filename, and ` +
    `follow them: ${s.agentInstructionsDir}\n` +
    `First list which files you read; then carry out the instructions.`
  );
}

/** Persist every session whose log changed since the last sweep. */
function persistDirtySessions() {
  for (const s of sessions.values()) {
    if (s.dirty) {
      s.dirty = false;
      persistSession(s);
    }
  }
}

function writeToRunner(s, obj) {
  if (s.proc && s.proc.stdin && s.proc.stdin.writable) {
    s.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }
  return false;
}

/** True if the session has a live runner we can write to. */
function runnerAlive(s) {
  return !!(s.proc && s.proc.stdin && s.proc.stdin.writable);
}

/**
 * Make sure the session has a live runner.
 *
 * If one is already alive, returns { alive:true, respawned:false } — the caller delivers its
 * message/continue over stdin as usual. If the runner is dead, this starts a *fresh* SDK session
 * (no prior context). Any `pendingPrompt` is handed to that fresh runner as its initial prompt so
 * it is consumed reliably once the runner is ready, rather than racing a stdin write against a
 * just-spawned (or doomed) process. Returns { alive, respawned:true }.
 */
function ensureRunner(s, pendingPrompt = "") {
  if (runnerAlive(s)) {
    return { alive: true, respawned: false };
  }
  s.ready = false;
  s.runnerConfig = { ...s.runnerConfig, initialPrompt: String(pendingPrompt || "") };
  recordMessage(s, { role: "system", text: "Starting a fresh session runner…" });
  spawnRunner(s);
  return { alive: runnerAlive(s), respawned: true };
}

/**
 * Deliver a user message to a session's runner. A live runner gets it over stdin (status →
 * running); a dead one is respawned with the text as its initial prompt (status → starting, so the
 * ready event can settle it). Returns ensureRunner's { alive, respawned }.
 */
function deliverUserText(s, text) {
  const r = ensureRunner(s, text);
  if (r.alive && !r.respawned) {
    s.status = "running";
    writeToRunner(s, { type: "user", text });
  } else if (r.alive) {
    // Fresh runner will consume `text` as its initial prompt once ready.
    s.status = "starting";
  }
  return r;
}

/**
 * Run a command and capture stdout, never rejecting (resolves { ok, out, err }).
 * `encoding` is needed because `wsl.exe --list` emits UTF-16LE.
 */
function runCapture(command, args, { encoding = "utf8", timeoutMs = 15000, stdin = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, out: "", err: String(e) });
      return;
    }
    const chunks = [];
    let errText = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, out: Buffer.concat(chunks).toString(encoding), err: errText });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (errText += d.toString()));
    child.on("error", (e) => { errText += String(e); finish(false); });
    child.on("close", (code) => finish(code === 0));
    if (stdin != null) {
      // Feeding the script over stdin avoids Windows command-line arg quoting entirely
      // (passing it as an argv element mangled $vars, quotes, and backslashes via wsl.exe).
      child.stdin.on("error", () => { /* ignore broken pipe */ });
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/** List installed WSL distributions by name. */
async function listWslDistros() {
  const r = await runCapture("wsl.exe", ["--list", "--quiet"], { encoding: "utf16le" });
  return r.out
    .split(/\r?\n/)
    .map((s) => s.replace(/\x00/g, "").trim())
    .filter(Boolean);
}

/** List WSL distributions with their running state via `wsl --list --verbose`. */
async function listWslDistrosVerbose() {
  const r = await runCapture("wsl.exe", ["--list", "--verbose"], { encoding: "utf16le" });
  const lines = r.out
    .split(/\r?\n/)
    .map((l) => l.replace(/\x00/g, "").trim())
    .filter(Boolean);
  const distros = [];
  for (const line of lines) {
    if (/^\s*NAME\s+STATE/i.test(line)) {
      continue; // header row
    }
    const isDefault = /^\s*\*/.test(line);
    const parts = line.replace(/^\s*\*?\s*/, "").trim().split(/\s+/);
    if (parts.length >= 2) {
      distros.push({
        name: parts[0],
        state: parts[1],
        version: parts[2] || "",
        default: isDefault,
      });
    }
  }
  return distros;
}

const WSL_RUNNERS_FILE = path.join(__dirname, "..", "wsl-runners.json");

/**
 * Load the per-distro in-distro runner registry written by scripts/setup-wsl-distro.ps1:
 * { "<distro>": { "node": "/abs/path/to/node", "runnerPath": "/abs/.../src/runner.mjs" } }.
 */
function loadWslRunners() {
  try {
    return JSON.parse(fs.readFileSync(WSL_RUNNERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** List git repositories (directories containing .git) inside a WSL distro's home areas. */
async function listWslRepos(distro) {
  // The script is piped to `bash -s` over stdin (not passed as an argv element), so quotes,
  // $vars, globs, and backslashes are preserved exactly. `find -printf '%h\n'` prints each
  // .git's parent directory — i.e. the repo path — directly.
  const script =
    `for r in "$HOME" /root /home/*; do [ -d "$r" ] && find "$r" -maxdepth 4 -type d -name .git -printf '%h\\n' 2>/dev/null; done | sort -u | head -300\n`;
  const r = await runCapture("wsl.exe", ["-d", distro, "--", "bash", "-s"], {
    encoding: "utf8",
    timeoutMs: 30000,
    stdin: script,
  });
  return r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// repositories panel: git repos + status (local + running WSL distros), cached
// ---------------------------------------------------------------------------

/** Find git repos (dirs containing .git) under a local root, bounded by depth; don't recurse into one. */
function findLocalRepos(root, maxDepth) {
  const repos = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || repos.length >= 100) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      repos.push(dir);
      return; // a repo — don't descend further
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return repos;
}

/** Branch + uncommitted-change count for a local repo (null if git is unavailable). */
async function localRepoStatus(repo) {
  const br = await runCapture("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 8000 });
  const st = await runCapture("git", ["-C", repo, "status", "--porcelain"], { timeoutMs: 8000 });
  return {
    path: repo.replace(/\\/g, "/"),
    name: path.basename(repo),
    branch: br.ok ? br.out.trim() : null,
    changes: st.ok ? st.out.split(/\r?\n/).filter((l) => l.trim()).length : null,
  };
}

/** Repos + git status inside a running WSL distro (one spawn: find repos, then branch/changes each). */
async function wslRepoStatuses(distro) {
  const script =
    `for r in "$HOME" /root /home/*; do [ -d "$r" ] && find "$r" -maxdepth 4 -type d -name .git -printf '%h\\n' 2>/dev/null; done | sort -u | head -200 | ` +
    `while IFS= read -r d; do b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null); ` +
    `c=$(git -C "$d" status --porcelain 2>/dev/null | grep -c .); printf '%s\\t%s\\t%s\\n' "$d" "$b" "$c"; done\n`;
  const r = await runCapture("wsl.exe", ["-d", distro, "--", "bash", "-s"], { encoding: "utf8", timeoutMs: 45000, stdin: script });
  return r.out
    .split(/\r?\n/)
    .map((line) => {
      const [p, b, c] = line.split("\t");
      if (!p) return null;
      return { path: p, name: p.split("/").filter(Boolean).pop() || p, branch: (b || "").trim() || null, changes: c != null && c !== "" ? Number(c) : null };
    })
    .filter(Boolean);
}

/** Build the repositories list: local roots + each running WSL distro, with git status. */
async function computeRepos() {
  const groups = [];
  const localRepos = [];
  for (const root of REPO_LOCAL_ROOTS) {
    for (const repo of findLocalRepos(root, REPO_MAX_DEPTH)) {
      localRepos.push(repo);
    }
  }
  const localUnique = [...new Set(localRepos)].slice(0, 100);
  if (localUnique.length) {
    const repos = await Promise.all(localUnique.map(localRepoStatus));
    repos.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ host: "local", distro: null, label: os.hostname(), repos });
  }
  const distros = await listWslDistrosVerbose();
  for (const d of distros) {
    if (!/running/i.test(d.state)) {
      continue;
    }
    const repos = await wslRepoStatuses(d.name);
    repos.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ host: "wsl", distro: d.name, label: d.name, repos });
  }
  return groups;
}

let reposCache = { at: 0, data: [] };
let reposComputing = false;

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------

function createSession(spec) {
  const id = crypto.randomBytes(5).toString("hex");
  // Permission mode (Claude's naming) is the primary control. If only the legacy policy was given,
  // derive a mode from it (ask -> "Ask before edits", auto -> "Auto").
  const explicitPolicy = spec.policy === "ask" ? "ask" : spec.policy === "auto" ? "auto" : null;
  const mode = normalizeMode(spec.mode || (explicitPolicy === "auto" ? "bypassPermissions" : "default"));
  // policy drives the "work unattended" system note + auto-continue after the 5-hour reset. Only the
  // full-access "Auto" mode is treated as unattended; everything else is interactive.
  const policy = explicitPolicy || (mode === "bypassPermissions" ? "auto" : "ask");
  const permissionMode = MODES[mode].permissionMode; // plan vs default; execution is via autoApprove
  const autoApprove = MODES[mode].approve.slice(); // categories canUseTool runs without asking
  // Reasoning effort + extended thinking.
  const effort = spec.effort ? String(spec.effort) : null; // low|medium|high|xhigh|max|null(default)
  const thinking = spec.thinking === "off" ? "off" : "adaptive";
  // Browser / UI testing toolset (Playwright MCP). Per-session opt-in; default from config.
  const browser = spec.browser != null ? !!spec.browser : !!(config.browser && config.browser.enabled);
  const host = spec.host === "wsl" ? "wsl" : "local";
  const label = spec.label || spec.cwd || id;

  // For a WSL session, use the in-distro node + staged runner recorded by setup-wsl-distro.ps1
  // (the agent must run inside the distro with the Linux Agent SDK). Fall back to defaults.
  const wslReg = host === "wsl" ? loadWslRunners()[spec.distro] || null : null;
  const runnerPath = spec.runnerPath || (wslReg && wslReg.runnerPath) || null;
  const nodeBin = spec.node || (wslReg && wslReg.node) || null;

  // Organize like VS Code: <root>/<WSL|Windows>/<distro-or-host>/<repo>/<title>/, each session
  // folder holding session.json + conversation.md + an instructions/ subfolder. The title is
  // the session name; if that folder already exists, the short id is appended to keep it unique.
  const hostKind = host === "wsl" ? "WSL" : "Windows";
  const group = safeSegment(host === "wsl" ? spec.distro || "distro" : os.hostname());
  const repo = safeSegment(repoNameOf(spec.cwd));
  const title = safeSegment(label);
  // Resuming reuses the saved session's folder so the conversation continues in place; a new
  // session gets a fresh folder (uniquified if the title collides).
  let sessionDir = spec.sessionDirOverride || path.join(SESSIONS_DIR, hostKind, group, repo, title);
  if (!spec.sessionDirOverride && fs.existsSync(sessionDir)) {
    sessionDir = `${sessionDir}_${id}`;
  }
  const instructionsDir = path.join(sessionDir, "instructions");
  try {
    fs.mkdirSync(instructionsDir, { recursive: true });
  } catch {
    /* ignore */
  }

  // The agent must be able to READ the instructions. A WSL session's agent runs inside the
  // distro, so it sees /mnt/<drive>/...; a local session sees the Windows path unchanged.
  const agentInstructionsDir = host === "wsl" ? toMnt(instructionsDir) : instructionsDir;

  const autonomyNote =
    policy === "auto"
      ? "You are running unattended. Work autonomously; do not wait for confirmation.\n"
      : "";
  const instructionsNote =
    `Your session instruction files are markdown files in this directory: ${agentInstructionsDir}\n` +
    `When asked to read your instructions, read every .md file in that directory (sorted by filename) and follow them.`;

  const runnerConfig = {
    cwd: spec.cwd,
    model: spec.model || null,
    permissionMode,
    policy,
    additionalDirectories: [
      ...(Array.isArray(spec.additionalDirectories) ? spec.additionalDirectories : []),
      agentInstructionsDir,
    ],
    initialPrompt: spec.initialPrompt || "",
    systemPromptAppend: autonomyNote + instructionsNote,
    maxTurns: spec.maxTurns || undefined,
    autoApprove,
    browser,
    effort,
    thinking,
    // Resume a saved conversation: by SDK session id when known, else continue the most recent
    // conversation in this cwd (covers sessions created before ids were captured).
    resume: spec.resume || undefined,
    continueRecent: !!spec.continueRecent,
  };

  const session = {
    id,
    label,
    host,
    distro: spec.distro || null,
    runnerPath,
    node: nodeBin,
    cwd: spec.cwd,
    model: spec.model || null,
    mode,
    permissionMode,
    autoApprove,
    effort,
    thinking,
    browser,
    policy,
    autoContinue: spec.autoContinue !== false,
    status: "starting",
    ready: false,
    resetAt: null,
    nextContinueAt: null,
    lastContinueAt: null,
    createdAt: now(),
    sessionDir,
    instructionsDir,
    agentInstructionsDir,
    sdkSessionId: spec.sdkSessionId || null,
    messages: Array.isArray(spec.preload) ? spec.preload : [],
    pendingApprovals: new Map(),
    sse: new Set(),
    runnerConfig,
    lastResult: null,
    dirty: true,
    proc: null,
  };

  sessions.set(id, session);
  if (host === "wsl" && !wslReg) {
    recordMessage(session, {
      role: "system",
      text: `Distro "${spec.distro}" is not set up for fleet-console. Run: scripts\\setup-wsl-distro.ps1 -Distro ${spec.distro}`,
    });
  }
  spawnRunner(session);
  return session;
}

/**
 * Bring a saved (past) session back to life so the user can keep chatting. Reuses the session's
 * folder + transcript and asks the SDK to resume its conversation (by stored session id, or by
 * continuing the most recent conversation in that cwd for older sessions). Returns the live session,
 * or null if the saved record can't be read.
 */
function resumeSession(rel) {
  const dir = path.resolve(path.join(SESSIONS_DIR, String(rel || "")));
  if (!dir.startsWith(path.resolve(SESSIONS_DIR))) {
    return null;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  } catch {
    return null;
  }
  // If this folder is already open: return it when live, or drop the dead leftover and re-resume.
  for (const s of sessions.values()) {
    if (s.sessionDir && path.resolve(s.sessionDir) === dir) {
      if (runnerAlive(s)) {
        return s;
      }
      sessions.delete(s.id);
      break;
    }
  }
  const preload = (meta.interactions || []).map((e) => ({
    ts: Date.parse(e.ts) || now(),
    role: e.role || "system",
    ...(e.text != null ? { text: e.text } : {}),
    ...(e.tool != null ? { name: e.tool } : {}),
    ...(e.input != null ? { input: e.input } : {}),
  }));
  const session = createSession({
    label: meta.label || "resumed",
    host: meta.host === "wsl" ? "wsl" : "local",
    distro: meta.distro || undefined,
    cwd: meta.cwd,
    model: meta.model || "",
    mode: meta.mode || undefined,
    permissionMode: meta.permissionMode || undefined,
    policy: meta.policy || "auto",
    effort: meta.effort || undefined,
    thinking: meta.thinking || undefined,
    browser: meta.browser != null ? meta.browser : undefined,
    sessionDirOverride: dir,
    preload,
    sdkSessionId: meta.sdkSessionId || null,
    resume: meta.sdkSessionId || undefined,
    continueRecent: !meta.sdkSessionId,
  });
  recordMessage(session, {
    role: "system",
    text: meta.sdkSessionId
      ? "Resumed — continuing this conversation with full context."
      : "Resuming the most recent conversation in this folder (no saved session id).",
  });
  return session;
}

function spawnRunner(s) {
  const { command, args } = buildSpawn(s, RUNNER_PATH);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  s.proc = child;

  // Swallow EPIPE/errors on stdin: writing a command just as the runner dies would otherwise raise
  // an unhandled 'error' event and crash the whole orchestrator.
  if (child.stdin) {
    child.stdin.on("error", () => {});
  }

  // Only the current child may mutate session state; a superseded (respawned) child is ignored.
  const isCurrent = () => s.proc === child;

  const out = readline.createInterface({ input: child.stdout });
  out.on("line", (line) => {
    if (!isCurrent()) {
      return;
    }
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
    if (!isCurrent()) {
      return;
    }
    // Runner diagnostics; keep last line as a log message.
    const msg = String(d).trim();
    if (msg) {
      recordMessage(s, { role: "system", text: msg.slice(-500) });
    }
  });

  child.on("exit", (code) => {
    // Ignore a stale child's exit if it has already been superseded by a respawn (restart).
    if (s.proc && s.proc !== child) {
      return;
    }
    s.status = code === 0 ? "ended" : "error";
    s.proc = null;
    // A non-zero exit *before the runner ever became ready* almost always means the runner could
    // not be launched inside the distro — surface an actionable message instead of a bare code.
    if (code !== 0 && !s.ready) {
      if (s.host === "wsl" && code === 127) {
        recordMessage(s, {
          role: "system",
          text:
            `Runner could not start in "${s.distro}" (node not found, exit 127). Set the distro up: ` +
            `scripts\\setup-wsl-distro.ps1 -Distro ${s.distro} — then restart the orchestrator and recreate the session.`,
        });
      } else {
        recordMessage(s, {
          role: "system",
          text: `Runner failed to start (exit ${code}). Check the distro/working directory and try again.`,
        });
      }
    } else {
      recordMessage(s, { role: "system", text: `runner exited (code ${code})` });
    }
    broadcastFleet();
  });

  child.on("error", (err) => {
    if (!isCurrent()) {
      return;
    }
    s.status = "error";
    recordMessage(s, { role: "system", text: `runner spawn error: ${err}` });
    broadcastFleet();
  });
}

function handleRunnerEvent(s, event) {
  switch (event.type) {
    case "status":
      if (event.status === "ready") {
        s.ready = true;
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
    case "models":
      if (Array.isArray(event.models)) {
        availableModels = event.models;
      }
      break;
    case "commands":
      if (Array.isArray(event.commands)) {
        availableCommands = event.commands;
      }
      break;
    case "mode":
      if (event.mode) {
        s.permissionMode = event.mode;
      }
      break;
    case "model":
      s.model = event.model || null;
      break;
    case "auto_approve":
      if (Array.isArray(event.categories)) {
        s.autoApprove = event.categories;
      }
      break;
    case "browser":
      s.browser = !!event.enabled;
      break;
    case "effort":
      s.effort = event.effort || null;
      break;
    case "thinking":
      s.thinking = event.thinking === "off" ? "off" : "adaptive";
      break;
    case "session_id":
      if (event.id && event.id !== s.sdkSessionId) {
        s.sdkSessionId = event.id; // captured so this session can be resumed later
        s.dirty = true;
      }
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
    s.nextContinueAt = null;
    s.resetAt = null;
    // A "continue" is only meaningful to a live session; the runner stays alive through a normal
    // rate-limit pause, so the healthy path writes directly. If the runner has died (crash, distro
    // shutdown), don't write into a dead pipe and leave the session stuck on "running" — surface an
    // error so the user can Restart. (We don't auto-respawn: a fresh session has no context to
    // continue.)
    if (!runnerAlive(s)) {
      s.status = "error";
      recordMessage(s, {
        role: "system",
        text: "Auto-continue skipped: the runner is no longer running. Press Restart to start a fresh session.",
      });
      broadcastFleet();
      continue;
    }
    s.lastContinueAt = now();
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
    // No-cache so a browser never serves a stale app.js/styles.css after an update — without this,
    // UI fixes silently don't reach the user until a hard refresh (they keep running old code).
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache, no-store, must-revalidate",
    });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// request routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // WHATWG URL (url.parse is deprecated, DEP0169). req.url is a path+query; give it any base.
  const parsed = new URL(req.url || "/", "http://localhost");
  const pathname = parsed.pathname || "/";
  const method = req.method || "GET";
  const query = Object.fromEntries(parsed.searchParams.entries());

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

  // Session history (browse past sessions saved on disk)
  if (pathname === "/api/history" && method === "GET") {
    sendJson(res, 200, { root: SESSIONS_DIR, sessions: listHistory() });
    return;
  }
  if (pathname === "/api/repos" && method === "GET") {
    // Return the cached repo list immediately; refresh in the background when stale (git status
    // across repos is slow, so we never block the request on it).
    const fresh = now() - reposCache.at < 12000;
    if (!fresh && !reposComputing) {
      reposComputing = true;
      computeRepos()
        .then((data) => { reposCache = { at: now(), data }; })
        .catch(() => {})
        .finally(() => { reposComputing = false; });
    }
    sendJson(res, 200, { groups: reposCache.data, computing: reposComputing && !fresh });
    return;
  }
  if (pathname === "/api/history/item" && method === "GET") {
    const item = readHistoryItem(query.path);
    if (!item) {
      sendJson(res, 404, { ok: false, reason: "not found" });
      return;
    }
    sendJson(res, 200, item);
    return;
  }
  if (pathname === "/api/history/resume" && method === "POST") {
    const body = await readBody(req);
    const s = resumeSession(body.rel);
    if (!s) {
      sendJson(res, 400, { ok: false, reason: "could not resume" });
      return;
    }
    broadcastFleet();
    sendJson(res, 200, { ok: true, id: s.id });
    return;
  }

  if (pathname === "/api/wsl/distros" && method === "GET") {
    sendJson(res, 200, { distros: await listWslDistrosVerbose() });
    return;
  }

  if (pathname === "/api/wsl/repos" && method === "GET") {
    const distro = query.distro ? String(query.distro) : "";
    if (!distro) {
      sendJson(res, 400, { ok: false, reason: "distro is required" });
      return;
    }
    sendJson(res, 200, { repos: await listWslRepos(distro) });
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

  // List instruction files: GET /api/sessions/:id/instructions
  const instrList = pathname.match(/^\/api\/sessions\/([^/]+)\/instructions$/);
  if (instrList && method === "GET") {
    const s = sessions.get(instrList[1]);
    if (!s) {
      sendJson(res, 404, { ok: false });
      return;
    }
    sendJson(res, 200, {
      files: listInstructionFiles(s),
      sessionDir: s.sessionDir,
      instructionsDir: s.instructionsDir,
    });
    return;
  }

  // Add/overwrite an instruction file: POST /api/sessions/:id/instructions { filename, content }
  if (instrList && method === "POST") {
    const s = sessions.get(instrList[1]);
    if (!s) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const body = await readBody(req);
    const result = writeInstructionFile(s, body.filename, body.content);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // Delete an instruction file: POST /api/sessions/:id/instructions/delete { filename }
  const instrDelete = pathname.match(/^\/api\/sessions\/([^/]+)\/instructions\/delete$/);
  if (instrDelete && method === "POST") {
    const s = sessions.get(instrDelete[1]);
    if (!s) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const body = await readBody(req);
    sendJson(res, 200, deleteInstructionFile(s, body.filename));
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
    if (verb === "read-instructions") {
      const text = readInstructionsMessage(s);
      recordMessage(s, { role: "user", text });
      const r = deliverUserText(s, text);
      sendJson(res, 200, { ok: r.alive });
    } else if (verb === "message") {
      const text = String(body.text || "");
      recordMessage(s, { role: "user", text });
      // Deliver to a live runner, or hand the text to a freshly respawned one as its initial prompt
      // so messages are never silently dropped into a dead process (which previously left the UI
      // stuck on "running").
      const r = deliverUserText(s, text);
      sendJson(res, 200, { ok: r.alive });
    } else if (verb === "approval") {
      s.pendingApprovals.delete(body.id);
      writeToRunner(s, { type: "approval", id: body.id, decision: body.decision, message: body.message });
      sendJson(res, 200, { ok: true });
    } else if (verb === "continue") {
      s.resetAt = null;
      s.nextContinueAt = null;
      const r = ensureRunner(s); // no pending prompt: "continue" is only meaningful to a live session
      if (r.alive && !r.respawned) {
        s.status = "running";
        writeToRunner(s, { type: "continue" });
      } else if (r.alive) {
        // The old session had ended — a bare "continue" means nothing to a fresh, context-free
        // session, so don't send it; just bring the runner up and tell the user.
        s.status = "starting";
        recordMessage(s, {
          role: "system",
          text: "The previous session had ended; started a fresh one. Send a message to carry on.",
        });
      }
      sendJson(res, 200, { ok: r.alive });
    } else if (verb === "interrupt") {
      // Stop the current task without ending the session (the SDK keeps the conversation alive).
      const ok = writeToRunner(s, { type: "interrupt" });
      if (ok) {
        s.status = "idle"; // optimistic; the runner confirms via a status event
        recordMessage(s, { role: "system", text: "Interrupted — Claude stopped the current task." });
      }
      sendJson(res, 200, { ok });
    } else if (verb === "set-mode") {
      // A mode (Claude's naming) sets both the SDK permissionMode (plan/default) and which tool
      // categories canUseTool runs without asking. Apply both to the runner.
      const mode = normalizeMode(body.mode);
      const permissionMode = MODES[mode].permissionMode;
      const categories = MODES[mode].approve.slice();
      s.mode = mode;
      s.permissionMode = permissionMode; // optimistic; runner echoes "mode"
      s.autoApprove = categories;
      const ok = writeToRunner(s, { type: "set_mode", mode: permissionMode });
      writeToRunner(s, { type: "set_auto_approve", categories });
      // Release any approval already waiting whose category is now auto-approved.
      const allow = new Set(categories);
      for (const [id, appr] of s.pendingApprovals) {
        if (allow.has(toolCategory(appr.tool))) {
          s.pendingApprovals.delete(id);
          writeToRunner(s, { type: "approval", id, decision: "allow" });
        }
      }
      sendJson(res, 200, { ok });
    } else if (verb === "set-effort") {
      const effort = body.effort ? String(body.effort) : null;
      s.effort = effort; // optimistic; runner echoes "effort"
      const ok = writeToRunner(s, { type: "set_effort", effort });
      sendJson(res, 200, { ok });
    } else if (verb === "set-thinking") {
      const thinking = body.thinking === "off" ? "off" : "adaptive";
      s.thinking = thinking; // optimistic; runner echoes "thinking"
      const ok = writeToRunner(s, { type: "set_thinking", thinking });
      sendJson(res, 200, { ok });
    } else if (verb === "set-auto-approve") {
      const categories = Array.isArray(body.categories) ? body.categories.map(String) : [];
      s.autoApprove = categories;
      const ok = writeToRunner(s, { type: "set_auto_approve", categories });
      // Release any approval already waiting whose category is now auto-approved — via the normal
      // approval channel, so the runner unblocks AND the modal clears.
      const allow = new Set(categories);
      for (const [id, appr] of s.pendingApprovals) {
        if (allow.has(toolCategory(appr.tool))) {
          s.pendingApprovals.delete(id);
          writeToRunner(s, { type: "approval", id, decision: "allow" });
        }
      }
      sendJson(res, 200, { ok });
    } else if (verb === "set-browser") {
      // Attach/detach the Playwright browser toolset for UI testing (runner echoes "browser").
      const enabled = !!body.enabled;
      s.browser = enabled; // optimistic
      const ok = writeToRunner(s, { type: "set_browser", enabled });
      sendJson(res, 200, { ok });
    } else if (verb === "set-model") {
      const model = body.model ? String(body.model) : null;
      s.model = model; // optimistic; runner echoes back a "model" event on success
      const ok = writeToRunner(s, { type: "set_model", model });
      sendJson(res, 200, { ok });
    } else if (verb === "restart") {
      // Bring the in-distro agent down cleanly (a SIGTERM to the wsl.exe relay would not reach it)
      // before respawning. Kill only the *captured* old child so a later respawn isn't affected.
      const old = s.proc;
      if (old) {
        writeToRunner(s, { type: "shutdown" });
        s.proc = null; // detach: the old child's exit is now treated as stale
        setTimeout(() => {
          try {
            if (!old.killed) old.kill();
          } catch {
            /* ignore */
          }
        }, 1200);
      }
      // Fresh runner with no queued work — "starting" lets the runner's ready event settle it to
      // idle (whereas "running" would stick, since ready only clears the "starting" state).
      const r = ensureRunner(s);
      if (r.alive) {
        s.status = "starting";
      }
      sendJson(res, 200, { ok: r.alive });
    } else if (verb === "stop") {
      const old = s.proc; // kill the child being stopped, not whatever s.proc is 1s from now
      writeToRunner(s, { type: "shutdown" });
      if (old) {
        setTimeout(() => {
          try {
            if (!old.killed) old.kill();
          } catch {
            /* ignore */
          }
        }, 1000);
      }
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
        // Only continue sessions with a live runner; writing into a dead pipe would silently drop
        // the continue and pin the session on "running". Dead sessions are left for a manual Restart.
        if (!runnerAlive(s)) {
          continue;
        }
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
        // Only schedule sessions whose runner is actually alive. Marking a dead session "limited"
        // would feed it to the scheduler/continue-all, which can't continue a process that exited.
        if (!runnerAlive(s)) {
          continue;
        }
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

/**
 * Fetch fresh account usage by spawning the one-shot usage-fetcher (a throwaway SDK session). The
 * SDK caches /usage per session, so reusing a chat session goes stale — a fresh session each poll is
 * the only way to track account-wide usage that other sessions/devices are also consuming. Runs on
 * the host, where the SDK is installed and Claude is logged in. No turn is taken, so it costs nothing.
 */
let usageFetchInFlight = false;
function usageTick() {
  if (usageFetchInFlight) {
    return;
  }
  usageFetchInFlight = true;
  let child;
  try {
    child = spawn(process.execPath, [USAGE_FETCHER_PATH], {
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    usageFetchInFlight = false;
    return;
  }
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
  });
  child.on("error", () => {
    usageFetchInFlight = false;
  });
  child.on("exit", () => {
    usageFetchInFlight = false;
    for (const line of buf.split("\n")) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      try {
        const event = JSON.parse(text);
        if (event.type === "usage_report") {
          applyUsageReport(event.report);
          broadcastFleet();
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  });
}

setInterval(schedulerTick, 1000);
setInterval(broadcastFleet, 1000);
setInterval(persistDirtySessions, 1000);
setInterval(usageTick, USAGE_POLL_MS);

server.listen(PORT, HOST, () => {
  const auth = TOKEN ? " (token required)" : " (no token — set FLEET_TOKEN to lock down)";
  console.log(`[fleet-console] http://${HOST}:${PORT}${auth}`);
  console.log(`[fleet-console] config: ${configSource} · sessions: ${SESSIONS_DIR} · usage poll: ${USAGE_POLL_MS / 1000}s`);
  usageTick(); // fetch account usage right away so it's available at startup
});
