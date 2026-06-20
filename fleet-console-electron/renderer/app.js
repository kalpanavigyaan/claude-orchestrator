/**
 * Fleet Console Electron – renderer process
 *
 * Communicates with the orchestrator server (started by main.js) over the same
 * HTTP/SSE API used by the original web UI. Implements a VS Code-like layout
 * with activity-bar navigation, per-section sidebar panels, history tree view
 * organized by date + repo, repos checkbox tree, and all existing chat/session
 * functionality.
 */
"use strict";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// PORT is resolved asynchronously before init() runs (see bottom of file)
let PORT = 4318;
let BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "";                // token support can be added if needed
const tokenQ = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";

// ─── State ────────────────────────────────────────────────────────────────────
let latest        = null;  // latest fleet snapshot
let selectedId    = null;  // active session id
let sessionES     = null;  // per-session SSE
let approvalQueue = [];    // pending approvals
let historyData   = null;  // { root, sessions[] }
let reposData     = null;  // { groups[] }
let wslData       = null;  // { distros[] }
let checkedRepos  = new Set();
let activeRightPanel = "usage";  // which right-sidebar panel is shown
let activeUsageTab   = "overview"; // which usage sub-tab
let scatterData      = null;       // cached /api/usage/exchanges
let historyLoaded    = false;      // lazy-load history on first paint
let wslLoaded        = false;
let viewingRel    = null;  // history item path being viewed
let historyFilter = "";
let cmdFilter     = "";
let isViewingHistory = false; // true while a saved session transcript is displayed

// UI state caches to avoid thrashing DOM
let lastControlsSig = "";
let lastIntelSig    = "";
let clockOffset     = 0;
let reposLoading    = false;

// Pending approval we're showing
let currentApproval = null;

// Instructions modal state
let currentInstrSession = null;

// History modal state
let histModalRel = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ─── Session status helpers ───────────────────────────────────────────────────
// Track when each session first appeared in "starting" state so we can detect
// runners that are stuck (never sent a ready event).
const sessionStartingAt = new Map();

function liveDisplayStatus(s) {
  const raw = s.status || "idle";
  if (raw === "starting") {
    if (!sessionStartingAt.has(s.id)) sessionStartingAt.set(s.id, Date.now());
    const elapsed = Date.now() - sessionStartingAt.get(s.id);
    // After 45 s without a ready event the runner is stuck — show as idle
    return elapsed > 45000 ? "idle" : "starting";
  }
  sessionStartingAt.delete(s.id); // clear when status leaves starting
  return raw;
}

// For saved (history) sessions: starting/running are legacy artifacts from an
// interrupted save — map them to a neutral display status.
function historyDisplayStatus(rawStatus) {
  if (!rawStatus) return "idle";
  if (rawStatus === "starting" || rawStatus === "running") return "idle";
  if (rawStatus === "ended") return "done";
  return rawStatus;
}

// ─── Apply settings from settings.json ────────────────────────────────────────
let lastSettings = null;
function applySettings(s) {
  lastSettings = s;
  const root = document.documentElement.style;
  // Sidebar widths
  const lw = s["sidebar.width"];
  if (lw) { const sb = el("sidebar"); if (sb) sb.style.width = lw + "px"; }
  const rw = s["sidebar.right.width"];
  if (rw) { const rs = el("right-sidebar"); if (rs) rs.style.width = rw + "px"; }
  const sh = s["sidebar.sessions.height"];
  if (sh) { const p = el("lp-sessions"); if (p) p.style.height = sh + "px"; }
  const ch = s["sidebar.controls.height"];
  if (ch) { const p = el("lp-controls"); if (p) p.style.height = ch + "px"; }
  // Default right panel
  const dp = s["sidebar.right.defaultPanel"];
  if (dp && dp !== activeRightPanel) switchRightPanel(dp);
  // Chat formatting
  const cf = s["chat.fontSize"];
  if (cf) root.setProperty("--chat-font-size", cf + "px");
  const cl = s["chat.lineHeight"];
  if (cl) root.setProperty("--chat-line-height", String(cl));
  const ff = s["chat.fontFamily"];
  if (ff) root.setProperty("--chat-font-family", String(ff));
  const cff = s["chat.codeFontFamily"];
  if (cff) root.setProperty("--chat-code-font-family", String(cff));
  // Theme colour overrides — each key is applied as a CSS custom property.
  const colors = s["theme.colors"];
  if (colors && typeof colors === "object") {
    for (const [key, val] of Object.entries(colors)) {
      if (!val) continue;
      root.setProperty(key.startsWith("--") ? key : "--" + key, String(val));
    }
  }
}

// ─── Settings editor (raw settings.json) ──────────────────────────────────────
async function openSettingsModal() {
  const ta = el("settings-editor");
  setSettingsStatus("");
  if (ta && window.fleetApp?.getSettingsRaw) {
    try { ta.value = await window.fleetApp.getSettingsRaw(); } catch { ta.value = ""; }
  }
  el("settings-modal")?.classList.remove("hidden");
}

function setSettingsStatus(msg, isError) {
  const s = el("settings-status");
  if (!s) return;
  s.textContent = msg || "";
  s.style.display = msg ? "" : "none";
  s.style.color = isError ? "var(--vsc-red)" : "var(--vsc-green)";
}

async function saveSettingsFromEditor() {
  const ta = el("settings-editor");
  if (!ta || !window.fleetApp?.saveSettingsRaw) return;
  const res = await window.fleetApp.saveSettingsRaw(ta.value);
  if (res?.ok) {
    applySettings(res.settings); // colours / fonts apply live
    setSettingsStatus("Saved. Port & session-storage changes take effect on app restart.", false);
    setTimeout(() => el("settings-modal")?.classList.add("hidden"), 900);
  } else {
    setSettingsStatus("Invalid JSON — not saved: " + (res?.error || "parse error"), true);
  }
}

function serverNow() { return Date.now() + clockOffset; }

// ─── Fetch helpers ────────────────────────────────────────────────────────────
function api(path, body) {
  return fetch(BASE + path, {
    method:  "POST",
    headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
    body:    JSON.stringify(body || {}),
  }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
}

function getJson(path, timeoutMs) {
  const ctrl  = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  return fetch(BASE + path, {
    headers: { "x-fleet-token": TOKEN },
    signal:  ctrl ? ctrl.signal : undefined,
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .finally(() => { if (timer) clearTimeout(timer); });
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtCountdown(target, alwaysShowDays = false) {
  if (!target) return "—";
  let s = Math.max(0, Math.floor((target - serverNow()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return (d > 0 || alwaysShowDays) ? `${d}d ${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}:${p(s)}`;
}

// ─── Security ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── Minimal Markdown Renderer ────────────────────────────────────────────────
// (adapted from the original fleet-console web UI)

function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`);
  s = s
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
      const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : "#";
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
  return s.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codes[+i]}</code>`);
}
const isTableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l);

// ── Syntax highlighting ──
const cspan = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
const JS_KW = ["const","let","var","function","return","if","else","for","while","await","async","import","export","from","new","class","try","catch","switch","case","break","this","typeof","true","false","null","undefined"];
const SH_KW = ["if","then","else","elif","fi","for","in","do","done","case","esac","while","function","return","export","local","echo","cd","set"];
const PS_KW = ["if","else","elseif","foreach","function","return","param","try","catch","throw","Write-Host"];
const GENERIC_LANGS = {
  json:       { line: null,  block: false, keywords: ["true","false","null"] },
  bash:       { line: "#",   block: false, keywords: SH_KW },
  sh:         { line: "#",   block: false, keywords: SH_KW },
  shell:      { line: "#",   block: false, keywords: SH_KW },
  powershell: { line: "#",   block: false, keywords: PS_KW },
  ps1:        { line: "#",   block: false, keywords: PS_KW },
  js:         { line: "//",  block: true,  keywords: JS_KW },
  mjs:        { line: "//",  block: true,  keywords: JS_KW },
  javascript: { line: "//",  block: true,  keywords: JS_KW },
  ts:         { line: "//",  block: true,  keywords: JS_KW },
  typescript: { line: "//",  block: true,  keywords: JS_KW },
};
const HIGHLIGHT_MAX = 40000;

function highlightCode(code, lang) {
  lang = (lang || "").toLowerCase();
  if (code.length > HIGHLIGHT_MAX) return escapeHtml(code);
  if (lang === "yaml" || lang === "yml") return highlightYaml(code);
  const cfg = GENERIC_LANGS[lang];
  return cfg ? highlightGeneric(code, cfg) : escapeHtml(code);
}
function hlWords(esc, kwRe) {
  return kwRe ? esc.replace(kwRe, '<span class="tok-keyword">$1</span>') : esc;
}
function tokenizeSegment(src, cfg, kwRe) {
  const parts = [];
  if (cfg.line === "//") parts.push("//[^\\n]*");
  if (cfg.line === "#") parts.push("#[^\\n]*");
  parts.push('"(?:[^"\\\\]|\\\\.)*"', "'(?:[^'\\\\]|\\\\.)*'", "`(?:[^`\\\\]|\\\\.)*`", "\\b\\d+(?:\\.\\d+)*\\b");
  const tokenRe = new RegExp(parts.join("|"), "g");
  let out = ""; let last = 0; let m;
  while ((m = tokenRe.exec(src))) {
    if (m[0].length === 0) { tokenRe.lastIndex++; continue; }
    out += hlWords(escapeHtml(src.slice(last, m.index)), kwRe);
    const tok = m[0];
    let cls = "string";
    if (tok.startsWith("//") || tok.startsWith("#")) cls = "comment";
    else if (/^\d/.test(tok)) cls = "num";
    out += cspan(cls, tok);
    last = m.index + tok.length;
  }
  return out + hlWords(escapeHtml(src.slice(last)), kwRe);
}
function highlightGeneric(src, cfg) {
  const kwRe = cfg.keywords?.length ? new RegExp("\\b(" + cfg.keywords.join("|") + ")\\b", "g") : null;
  if (!cfg.block) return tokenizeSegment(src, cfg, kwRe);
  let out = ""; let idx = 0;
  for (;;) {
    const start = src.indexOf("/*", idx);
    if (start === -1) { out += tokenizeSegment(src.slice(idx), cfg, kwRe); break; }
    out += tokenizeSegment(src.slice(idx, start), cfg, kwRe);
    let end = src.indexOf("*/", start + 2);
    end = end === -1 ? src.length : end + 2;
    out += cspan("comment", src.slice(start, end));
    idx = end;
  }
  return out;
}
function highlightYaml(src) {
  const lines = src.split("\n"); const out = []; let blockIndent = -1;
  for (const line of lines) {
    if (blockIndent >= 0) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > blockIndent) { out.push(cspan("string", line)); continue; }
      blockIndent = -1;
    }
    out.push(highlightYamlLine(line));
    if (/:\s*[|>][+-]?\d*\s*$/.test(line)) blockIndent = line.length - line.trimStart().length;
  }
  return out.join("\n");
}
function yamlCommentIndex(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") { quote = ch; }
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}
function yamlValue(v) {
  const lead = v.slice(0, v.length - v.trimStart().length);
  const trail = v.slice(v.trimEnd().length);
  const t = v.trim();
  if (t === "") return escapeHtml(v);
  let cls = "plain";
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(t)) cls = "bool";
  else if (/^-?\d+(\.\d+)?$/.test(t)) cls = "num";
  else if (/^(".*"|'.*')$/.test(t)) cls = "string";
  return escapeHtml(lead) + cspan(cls, t) + escapeHtml(trail);
}
function highlightYamlLine(line) {
  const full = line.match(/^(\s*)(#.*)$/);
  if (full) return escapeHtml(full[1]) + cspan("comment", full[2]);
  const ci = yamlCommentIndex(line);
  const body = ci === -1 ? line : line.slice(0, ci);
  const tail = ci === -1 ? "" : cspan("comment", line.slice(ci));
  const kv = body.match(/^(\s*)(-\s+)?([^:#\s][^:]*?):(\s|$)(.*)$/);
  if (kv) {
    const [, indent, dash, key, sep, value] = kv;
    let h = escapeHtml(indent);
    if (dash) h += cspan("punct", "-") + escapeHtml(dash.slice(1));
    h += cspan("key", key) + cspan("punct", ":") + escapeHtml(sep) + yamlValue(value);
    return h + tail;
  }
  const li = body.match(/^(\s*)(-\s+)(.*)$/);
  if (li) return escapeHtml(li[1]) + cspan("punct", "-") + escapeHtml(li[2].slice(1)) + yamlValue(li[3]) + tail;
  return escapeHtml(body) + tail;
}
function mdToHtml(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = []; let i = 0;
  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => mdInline(escapeHtml(c.trim())));
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const lang = (fence[1] || "").toLowerCase();
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"><code class="lang-${lang || "text"}">${highlightCode(buf.join("\n"), lang)}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${Math.min(h[1].length,6)}>${mdInline(escapeHtml(h[2].trim()))}</h${Math.min(h[1].length,6)}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr />"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line); i += 2;
      let t = "<table><thead><tr>" + headers.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        t += "<tr>" + splitRow(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>"; i++;
      }
      out.push(t + "</tbody></table>"); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${mdInline(escapeHtml(buf.join(" ")))}</blockquote>`); continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    const listRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length && listRe.test(lines[i])) items.push(lines[i++].replace(listRe, "$1"));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>` + items.map((it) => `<li>${mdInline(escapeHtml(it))}</li>`).join("") + `</${tag}>`); continue;
    }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    out.push(`<p>${mdInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br />")}</p>`);
  }
  return out.join("");
}

// ─── Right panel navigation ───────────────────────────────────────────────────
function switchRightPanel(id) {
  activeRightPanel = id;
  qsa(".rab-icon").forEach((b) => b.classList.toggle("active", b.dataset.rpanel === id));
  qsa(".rp-panel").forEach((p) => p.classList.toggle("active", p.id === `rpanel-${id}`));
  if (id === "usage")        loadAndRenderRightPanel();
  // Re-scan every time the VM panel is opened: distro state (running/stopped) goes stale
  // quickly, so we revalidate on open. Cached data stays on screen meanwhile (no flash).
  if (id === "vms" || id === "wsl") { wslLoaded = true; loadAndRenderVMs(); }
  if (id === "intelligence") renderIntelligence();
  if (id === "commands")     renderCommands();
  if (id === "repos")        renderReposTree();
  if (id === "directories")  renderDirectoriesPanel();
}
function switchUsageTab(tab) {
  activeUsageTab = tab;
  qsa(".rp-tab").forEach((t) => t.classList.toggle("active", t.dataset.utab === tab));
  if (tab === "scatter" && !scatterData) loadScatterData().then(() => renderUsageTabContent());
  else renderUsageTabContent();
}
async function loadScatterData() {
  const d = await getJson("/api/usage/exchanges");
  if (d) scatterData = d;
}
// openSection kept for backward compat (no-op for old calls referencing "sessions")
function openSection() {}

// ─── Connection & SSE ─────────────────────────────────────────────────────────
let fleetES = null;
function connectFleet() {
  if (fleetES) { fleetES.close(); fleetES = null; }
  fleetES = new EventSource(`${BASE}/api/events${tokenQ}`);
  fleetES.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    clockOffset = (data.now || Date.now()) - Date.now();
    latest = data;
    setConnected(true);
    renderFleet();
  };
  fleetES.onerror = () => {
    setConnected(false);
    // Retry after 3 s
    setTimeout(connectFleet, 3000);
  };
}
function setConnected(on) {
  const c = el("conn");
  c.textContent = on ? "live" : "offline";
  c.className = "conn-status " + (on ? "online" : "offline");
  el("sb-text").textContent = on ? "Connected" : "Disconnected";
  el("sb-dot").className = "sb-dot " + (on ? "idle" : "error");
}

// ─── Fleet rendering ──────────────────────────────────────────────────────────
function renderFleet() {
  if (!latest) return;
  // Countdown
  el("account-countdown").textContent = latest.account?.resetAt
    ? fmtCountdown(latest.account.resetAt)
    : "—";
  // Sessions panel (always visible)
  renderSessionsList();
  // Update session badge
  const n = latest.sessions?.length || 0;
  const badge = el("sessions-badge");
  if (n > 0) { badge.textContent = n; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
  // Update active session view
  if (selectedId) {
    const s = latest.sessions?.find((x) => x.id === selectedId);
    if (s) updateChatHeader(s);
    renderWorkingState(s);
  }
  // Status bar + right panel
  renderStatusBar();
  renderRightPanel(); // handles usage/intelligence/commands based on activeRightPanel
  // Always render controls (permanent left pane)
  renderControls();
  // Drain approval queue
  drainApprovals();
}

// ─── Status bar rendering ─────────────────────────────────────────────────────
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

// ─── Shared window metadata ───────────────────────────────────────────────────
const WINDOW_LABELS = {
  five_hour:            "5h session",
  seven_day:            "Weekly · all models",
  seven_day_opus:       "Weekly · Opus",
  seven_day_sonnet:     "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · apps",
  day_requests:         "Today · requests",
  week_requests:        "This week · requests",
};
const WINDOW_SHORT = {
  five_hour:            "5h",
  seven_day:            "wk",
  seven_day_opus:       "wk-opus",
  seven_day_sonnet:     "wk-sonnet",
  seven_day_oauth_apps: "wk-apps",
  day_requests:         "today",
  week_requests:        "wk-req",
};
const WINDOW_ORDER = ["five_hour","seven_day","seven_day_sonnet","seven_day_opus","seven_day_oauth_apps","day_requests","week_requests"];
function sortedWindows(ws) {
  return (ws || []).slice().sort((a, b) => {
    const ia = WINDOW_ORDER.indexOf(a.type), ib = WINDOW_ORDER.indexOf(b.type);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function renderStatusBar() {
  if (!latest) return;
  const u      = latest.usage || {};
  const totals = u.totals || {};
  const wins   = sortedWindows(u.windows);
  const pipe   = `<span class="sb-pipe">│</span>`;
  const parts  = [];

  // Tokens
  const inp = totals.inputTokens || 0, out = totals.outputTokens || 0;
  const cacheR = totals.cacheReadTokens || 0, cacheC = totals.cacheCreationTokens || 0;
  const cache = cacheR + cacheC;
  if (inp > 0 || out > 0) {
    const tip = `Input: ${inp.toLocaleString()} · Output: ${out.toLocaleString()} · Cache: ${cache.toLocaleString()}`;
    parts.push(`<span class="sb-chip" title="${escapeHtml(tip)}">↑${fmtTok(inp)} ↓${fmtTok(out)}${cache > 0 ? ` ⟳${fmtTok(cache)}` : ""}</span>`);
  }
  // Run cost
  if (totals.costUsd > 0) parts.push(`<span class="sb-chip" title="Total cost this run">$${totals.costUsd.toFixed(4)}</span>`);
  // Active session
  if (selectedId) {
    const s = latest.sessions?.find((x) => x.id === selectedId);
    const r = s?.lastResult || {}, tu = r.usage || {};
    const si = tu.input_tokens || 0, so = tu.output_tokens || 0;
    if (r.cost > 0 || si > 0) {
      const d = r.cost > 0 ? `$${r.cost.toFixed(4)} ↑${fmtTok(si)} ↓${fmtTok(so)}` : `↑${fmtTok(si)} ↓${fmtTok(so)}`;
      parts.push(`<span class="sb-chip sess" title="Session: ${escapeHtml(s?.label||"")}">sess ${d}</span>`);
    }
  }
  // All account windows
  for (const w of wins) {
    const short = WINDOW_SHORT[w.type] || w.type;
    const full  = WINDOW_LABELS[w.type] || w.type;
    if (typeof w.utilization === "number") {
      const pct = Math.max(0, Math.min(100, w.utilization));
      const cls = pct >= 90 ? "high" : pct >= 70 ? "warn" : "";
      const cd  = w.resetAt ? ` ↺${fmtCountdown(w.resetAt, w.type.startsWith('seven_day') || w.type === 'week_requests')}` : "";
      parts.push(`<span class="sb-chip ${cls}" title="${escapeHtml(full)}">${short}:${pct.toFixed(0)}%${cd}</span>`);
    } else if (w.requestCount != null) {
      parts.push(`<span class="sb-chip" title="${escapeHtml(full)}">${short}:${w.requestCount.toLocaleString()}</span>`);
    }
  }
  // Build
  if (latest.build) parts.push(`<span class="sb-build">${escapeHtml(latest.build)}</span>`);

  el("sb-right").innerHTML = parts.map((p, i) => (i > 0 ? pipe : "") + p).join("");
}

// ─── Usage panel (right sidebar tab) ─────────────────────────────────────────
let usageHistData = null;
let usageHistLoadedAt = 0;

async function loadUsageHistory() {
  const now = Date.now();
  if (usageHistData && now - usageHistLoadedAt < 60000) return usageHistData;
  const d = await getJson("/api/usage/history");
  if (d) { usageHistData = d; usageHistLoadedAt = Date.now(); }
  return usageHistData;
}

async function loadAndRenderRightPanel() {
  if (activeRightPanel !== "usage") return;
  const body = el("rpanel-usage-body");
  if (!body) return;
  if (!usageHistData) body.innerHTML = `<div class="up-empty">Loading…</div>`;
  await loadUsageHistory();
  renderUsageTabContent();
}

function renderRightPanel() {
  if (activeRightPanel === "usage") renderUsageTabContent();
  else if (activeRightPanel === "intelligence") renderIntelligence();
  else if (activeRightPanel === "commands")     renderCommands();
  else if (activeRightPanel === "directories")  renderDirectoriesPanel();
}

// ── SVG primitives ──
function svgBarChart(entries, { width = 260, height = 60, color = "#58a6ff" } = {}) {
  if (!entries.length) return "";
  const max = Math.max(...entries.map((e) => e.v), 0.001);
  const padB = 14, padT = 4, chartH = height - padT - padB;
  const step = width / entries.length, barW = Math.max(2, step * 0.65);
  let rects = "", texts = "";
  entries.forEach((e, i) => {
    const h = Math.round((e.v / max) * chartH);
    const x = i * step + (step - barW) / 2;
    const y = padT + chartH - h;
    rects += `<rect x="${x.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${Math.max(1,h)}" fill="${color}" rx="1" opacity="${e.v>0?0.85:0.1}"/>`;
    if (i === 0 || i === entries.length-1 || i === Math.floor(entries.length/2))
      texts += `<text x="${(x+barW/2).toFixed(1)}" y="${height-1}" text-anchor="middle" font-size="7" fill="rgba(255,255,255,.35)">${escapeHtml(e.l)}</text>`;
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;width:100%">
    <line x1="0" y1="${padT+chartH}" x2="${width}" y2="${padT+chartH}" stroke="rgba(255,255,255,.06)"/>
    ${rects}${texts}</svg>`;
}

function svgStackedBarChart(entries, { width = 260, height = 70, colors = ["#3fb950","#bc8cff","#fbbf24","#f87171"] } = {}) {
  if (!entries.length) return "";
  const maxSum = Math.max(...entries.map((e) => e.values.reduce((a,b)=>a+b,0)), 0.001);
  const padB = 14, padT = 4, chartH = height - padT - padB;
  const step = width / entries.length, barW = Math.max(2, step * 0.65);
  let rects = "", texts = "";
  entries.forEach((e, i) => {
    const x = i * step + (step - barW) / 2;
    const sum = e.values.reduce((a,b)=>a+b,0);
    let y = padT + chartH;
    e.values.forEach((v, vi) => {
      if (!v) return;
      const h = Math.round((v / maxSum) * chartH);
      y -= h;
      rects += `<rect x="${x.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${h}" fill="${colors[vi]}" rx="1" opacity="0.8"/>`;
    });
    if (i === 0 || i === entries.length-1 || i === Math.floor(entries.length/2))
      texts += `<text x="${(x+barW/2).toFixed(1)}" y="${height-1}" text-anchor="middle" font-size="7" fill="rgba(255,255,255,.35)">${escapeHtml(e.l)}</text>`;
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;width:100%">
    <line x1="0" y1="${padT+chartH}" x2="${width}" y2="${padT+chartH}" stroke="rgba(255,255,255,.06)"/>
    ${rects}${texts}</svg>`;
}

function svgScatter(exchanges, { width = 260, height = 100 } = {}) {
  if (!exchanges || !exchanges.length) return `<div class="up-empty">No exchange data</div>`;
  const sample = exchanges.slice(-800);
  const minTs = Math.min(...sample.map((e) => e.tsMs));
  const maxTs = Math.max(...sample.map((e) => e.tsMs), minTs + 1);
  const maxTok = Math.max(...sample.map((e) => (e.inp||0)+(e.out||0)), 1);
  const pL=8, pR=4, pT=4, pB=4;
  const dots = sample.map((e) => {
    const x = pL + ((e.tsMs - minTs) / (maxTs - minTs)) * (width - pL - pR);
    const tok = (e.inp||0) + (e.out||0);
    const y = pT + (1 - tok / maxTok) * (height - pT - pB);
    const r = Math.max(1.5, Math.min(4.5, tok / maxTok * 6));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#58a6ff" opacity="0.45"/>`;
  }).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;width:100%">${dots}</svg>`;
}

// ── Usage tab renderer ──
function renderUsageTabContent() {
  const body = el("rpanel-usage-body");
  if (!body || activeRightPanel !== "usage") return;  const tab  = activeUsageTab;
  const u    = latest?.usage || {};
  const totals = u.totals || {};
  const wins   = sortedWindows(u.windows);
  const hist   = usageHistData;

  if (tab === "overview") {
    // KPI cards + account windows + cost chart
    const inp = totals.inputTokens||0, out = totals.outputTokens||0;
    const cacheR = totals.cacheReadTokens||0, cacheC = totals.cacheCreationTokens||0;
    const hitPct = (inp+out+cacheR+cacheC) > 0 ? ((cacheR+cacheC)/(inp+out+cacheR+cacheC)*100).toFixed(1)+"%" : "—";
    let html = `<div class="uso-kpis">
      <div class="uso-kpi"><div class="uso-kpi-label">Total Cost</div><div class="uso-kpi-value">${totals.costUsd>0?"$"+totals.costUsd.toFixed(4):"—"}</div><div class="uso-kpi-sub">${u.subscriptionType||"plan"}</div></div>
      <div class="uso-kpi"><div class="uso-kpi-label">Input</div><div class="uso-kpi-value">${fmtTok(inp)}</div><div class="uso-kpi-sub">prompt tokens</div></div>
      <div class="uso-kpi"><div class="uso-kpi-label">Output</div><div class="uso-kpi-value">${fmtTok(out)}</div><div class="uso-kpi-sub">tokens generated</div></div>
      <div class="uso-kpi"><div class="uso-kpi-label">Cache Reads</div><div class="uso-kpi-value">${fmtTok(cacheR)}</div><div class="uso-kpi-sub">${hitPct} hit rate</div></div>
      <div class="uso-kpi"><div class="uso-kpi-label">Cache Writes</div><div class="uso-kpi-value">${fmtTok(cacheC)}</div><div class="uso-kpi-sub">new entries</div></div>
      <div class="uso-kpi"><div class="uso-kpi-label">Sessions</div><div class="uso-kpi-value">${(latest?.sessions||[]).length}</div><div class="uso-kpi-sub">${(totals.inputTokens||totals.outputTokens)?((latest?.sessions||[]).length+" active"):"this run"}</div></div>
    </div>`;
    // Account windows
    if (wins.some((w) => w.utilization != null || w.requestCount != null)) {
      html += `<div class="uso-section"><div class="uso-section-title">Account Limits</div>`;
      for (const w of wins) {
        const lbl = WINDOW_LABELS[w.type] || w.type;
        if (typeof w.utilization === "number") {
          const pct = Math.max(0, Math.min(100, w.utilization));
          const cls = pct >= 90 ? "high" : pct >= 70 ? "warn" : "ok";
          const cd  = w.resetAt ? `↺ ${fmtCountdown(w.resetAt, w.type.startsWith('seven_day') || w.type === 'week_requests')}` : "";
            <span class="uso-dot ${cls}"></span>
            <span class="uso-window-label">${escapeHtml(lbl)}</span>
            <div class="uso-window-track"><div class="uso-window-fill ${cls}" style="width:${pct.toFixed(0)}%"></div></div>
            <span class="uso-window-pct ${cls}">${pct.toFixed(0)}%</span>
          </div>${cd ? `<div class="uso-window-cd">${cd}</div>` : ""}`;
        } else if (w.requestCount != null) {
          html += `<div class="uso-window-row">
            <span class="uso-dot ok"></span>
            <span class="uso-window-label">${escapeHtml(lbl)}</span>
            <span class="uso-window-pct ok">${w.requestCount.toLocaleString()}</span>
          </div>`;
        }
      }
      html += `</div>`;
    }
    // Cost chart from history
    if (hist?.byDay) {
      const entries = Object.entries(hist.byDay).sort(([a],[b])=>a.localeCompare(b)).slice(-30)
        .map(([d,b]) => ({ l: d.slice(5), v: b.costUsd||0 }));
      if (entries.some((e) => e.v > 0)) {
        html += `<div class="uso-section"><div class="uso-section-title">Daily Cost — 30 days</div>
          <div class="uso-chart">${svgBarChart(entries, {color:"#3fb950"})}</div></div>`;
      }
    }
    body.innerHTML = html;

  } else if (tab === "daily" || tab === "monthly") {
    const key = tab === "daily" ? "byDay" : "byMonth";
    const entries = hist?.[key] ? Object.entries(hist[key]).sort(([a],[b])=>a.localeCompare(b)).slice(-30) : [];
    if (!entries.length) { body.innerHTML = `<div class="up-empty">No ${tab} data yet.</div>`; return; }
    const COLORS = ["#3fb950","#bc8cff","#fbbf24","#f87171"];
    const mapped = entries.map(([d,b]) => ({ l: d.slice(5), values: [b.inputTokens||0, b.outputTokens||0, b.cacheReadTokens||0, b.cacheCreationTokens||0] }));
    let html = `<div class="uso-section">
      <div class="uso-section-title">Input vs Output Tokens Per ${tab==="daily"?"Day":"Month"}</div>
      <div class="uso-legend">
        <span class="uso-leg-dot" style="background:${COLORS[0]}"></span>Input
        <span class="uso-leg-dot" style="background:${COLORS[1]}"></span>Output
        <span class="uso-leg-dot" style="background:${COLORS[2]}"></span>Cache read
        <span class="uso-leg-dot" style="background:${COLORS[3]}"></span>Cache write
      </div>
      <div class="uso-chart">${svgStackedBarChart(mapped, {colors:COLORS})}</div>
    </div>
    <div class="uso-section">
      <table class="uso-table"><thead><tr>
        <th>${tab==="daily"?"Date":"Month"}</th><th class="num">Input</th><th class="num">Output</th>
        <th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Hit%</th>
        <th class="num">Cost</th><th class="num">Sessions</th>
      </tr></thead><tbody>`;
    for (const [d, b] of [...entries].reverse()) {
      const total = (b.inputTokens||0)+(b.outputTokens||0)+(b.cacheReadTokens||0)+(b.cacheCreationTokens||0);
      const hit = total > 0 ? (((b.cacheReadTokens||0)+(b.cacheCreationTokens||0))/total*100).toFixed(1)+"%" : "—";
      const cost = b.costUsd > 0 ? `<span class="pos">$${b.costUsd.toFixed(4)}</span>` : "$0.0000";
      html += `<tr><td>${escapeHtml(d)}</td><td class="num">${fmtTok(b.inputTokens||0)}</td><td class="num">${fmtTok(b.outputTokens||0)}</td><td class="num">${fmtTok(b.cacheReadTokens||0)}</td><td class="num">${fmtTok(b.cacheCreationTokens||0)}</td><td class="num">${hit}</td><td class="num">${cost}</td><td class="num">${b.count||0}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    body.innerHTML = html;

  } else if (tab === "models") {
    const models = hist?.byModel ? Object.entries(hist.byModel).sort(([,a],[,b])=>(b.inputTokens+b.outputTokens)-(a.inputTokens+a.outputTokens)) : [];
    if (!models.length) { body.innerHTML = `<div class="up-empty">No model data yet.</div>`; return; }
    const maxTok = Math.max(...models.map(([,b])=>(b.inputTokens||0)+(b.outputTokens||0)),1);
    let html = `<div class="uso-section"><div class="uso-section-title">Token Usage by Model</div>`;
    for (const [model, b] of models) {
      const tok = (b.inputTokens||0)+(b.outputTokens||0);
      const w   = Math.round(tok/maxTok*100);
      html += `<div class="up-model-row">
        <div class="up-model-top"><span class="up-model-name" title="${escapeHtml(model)}">${escapeHtml(model.split("-").slice(-2).join("-"))}</span><span class="up-model-tok">${fmtTok(tok)}</span></div>
        <div class="up-model-track"><div class="up-model-fill" style="width:${w}%"></div></div>
      </div>`;
    }
    html += `</div><div class="uso-section"><table class="uso-table"><thead><tr>
        <th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache</th><th class="num">Sessions</th>
      </tr></thead><tbody>`;
    for (const [model, b] of models) {
      html += `<tr><td style="font-size:10px">${escapeHtml(model)}</td><td class="num">${fmtTok(b.inputTokens||0)}</td><td class="num">${fmtTok(b.outputTokens||0)}</td><td class="num">${fmtTok((b.cacheReadTokens||0)+(b.cacheCreationTokens||0))}</td><td class="num">${b.count||0}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    body.innerHTML = html;

  } else if (tab === "sessions-hist") {
    const sessions = hist?.sessions || [];
    if (!sessions.length) { body.innerHTML = `<div class="up-empty">No saved session data yet.</div>`; return; }
    let html = `<div class="uso-section"><table class="uso-table"><thead><tr>
        <th>Label</th><th class="num">Cost</th><th class="num">Input</th><th class="num">Output</th><th class="num">Turns</th>
      </tr></thead><tbody>`;
    for (const s of sessions.slice(0, 50)) {
      const cost = s.costUsd > 0 ? `<span class="pos">$${s.costUsd.toFixed(4)}</span>` : "—";
      html += `<tr><td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</td><td class="num">${cost}</td><td class="num">${fmtTok(s.inputTokens||0)}</td><td class="num">${fmtTok(s.outputTokens||0)}</td><td class="num">${s.turns||0}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    body.innerHTML = html;

  } else if (tab === "scatter") {
    const exchanges = scatterData?.exchanges || [];
    if (!exchanges.length) { body.innerHTML = `<div class="up-empty">No exchange data. Loading…</div>`; loadScatterData().then(() => renderUsageTabContent()); return; }
    const COLORS = ["#3fb950","#bc8cff","#fbbf24","#f87171"];
    // Scatter by day — group into days
    const byDay = {};
    for (const e of exchanges) {
      const d = e.day || new Date(e.tsMs).toISOString().slice(0,10);
      byDay[d] = byDay[d] || [];
      byDay[d].push(e);
    }
    const days = Object.keys(byDay).sort().slice(-14);
    const scatter = days.map((d) => ({
      l: d.slice(5),
      values: [
        byDay[d].reduce((a,e)=>a+(e.inp||0),0),
        byDay[d].reduce((a,e)=>a+(e.out||0),0),
        byDay[d].reduce((a,e)=>a+(e.cr||0),0),
        byDay[d].reduce((a,e)=>a+(e.cc||0),0),
      ]
    }));
    let html = `<div class="uso-section">
      <div class="uso-section-title">Exchanges (last 800) · each dot = 1 API call</div>
      <div class="uso-chart">${svgScatter(exchanges)}</div>
      <div class="uso-legend" style="margin-top:4px">
        <span style="opacity:.5;font-size:10px">${exchanges.length.toLocaleString()} exchanges · ${(scatterData?.totals?.inputTokens||0)>0?fmtTok(scatterData.totals.inputTokens)+" in":""}${(scatterData?.totals?.outputTokens||0)>0?" · "+fmtTok(scatterData.totals.outputTokens)+" out":""}</span>
      </div>
    </div>
    <div class="uso-section">
      <div class="uso-section-title">Tokens per Day (scatter aggregated)</div>
      <div class="uso-legend">
        <span class="uso-leg-dot" style="background:${COLORS[0]}"></span>Input
        <span class="uso-leg-dot" style="background:${COLORS[1]}"></span>Output
        <span class="uso-leg-dot" style="background:${COLORS[2]}"></span>Cache R
        <span class="uso-leg-dot" style="background:${COLORS[3]}"></span>Cache W
      </div>
      <div class="uso-chart">${svgStackedBarChart(scatter, {colors:COLORS})}</div>
    </div>`;
    body.innerHTML = html;
  }
}

// ─── Sessions list ────────────────────────────────────────────────────────────
function renderSessionsList() {
  const list = el("sessions-list");
  if (!latest?.sessions) { list.innerHTML = '<div class="ctrl-hint">No active sessions.</div>'; return; }
  const sessions = latest.sessions;
  if (!sessions.length) { list.innerHTML = '<div class="ctrl-hint">No active sessions. Click ＋ to create one.</div>'; return; }
  list.innerHTML = sessions.map((s) => {
    const displaySt = liveDisplayStatus(s);
    const dotCls = displaySt === "running" ? "running" : displaySt === "starting" ? "starting" : displaySt === "error" ? "error" : "idle";
    const repo = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : "";
    return `<div class="session-item${s.id === selectedId ? " selected" : ""}" data-id="${escapeHtml(s.id)}" tabindex="0">
      <div class="session-item-top">
        <span class="session-status-dot ${dotCls}"></span>
        <span class="session-label" title="${escapeHtml(s.label)} — double-click or F2 to rename">${escapeHtml(s.label)}</span>
      </div>
      <div class="session-meta">
        <span class="session-repo">${escapeHtml(repo)}</span>
        <span>${escapeHtml(s.host)}${s.distro ? ` · ${escapeHtml(s.distro)}` : ""}</span>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".session-item").forEach((item) => {
    item.addEventListener("click", () => selectSession(item.dataset.id));
    // Double-click → inline rename
    item.addEventListener("dblclick", (e) => { e.stopPropagation(); startInlineRename(item); });
    // Right-click → context menu
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); selectSession(item.dataset.id); showSessionContextMenu(e, item.dataset.id); });
    // F2 when the item has focus
    item.addEventListener("keydown", (e) => { if (e.key === "F2") { e.preventDefault(); startInlineRename(item); } });
  });
}

// ─── Inline session rename (shared by dblclick, F2, and context menu) ────────
function startInlineRename(item) {
  const id = item.dataset.id;
  if (!id) return;
  const labelEl = item.querySelector(".session-label");
  if (!labelEl) return;
  const current = labelEl.textContent;
  labelEl.contentEditable = "true";
  labelEl.style.outline = "1px solid var(--vsc-accent)";
  labelEl.style.background = "rgba(0,122,204,.15)";
  labelEl.focus();
  // Select all
  const range = document.createRange();
  range.selectNodeContents(labelEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = async (save) => {
    labelEl.contentEditable = "false";
    labelEl.style.outline = "";
    labelEl.style.background = "";
    if (save && labelEl.textContent.trim()) {
      await renameSession(id, labelEl.textContent);
    } else {
      labelEl.textContent = current;
    }
  };
  const kd = (e) => {
    if (e.key === "Enter") { e.preventDefault(); labelEl.removeEventListener("keydown", kd); labelEl.removeEventListener("blur", bl); finish(true); }
    if (e.key === "Escape") { labelEl.removeEventListener("keydown", kd); labelEl.removeEventListener("blur", bl); finish(false); }
  };
  const bl = () => { labelEl.removeEventListener("keydown", kd); finish(true); };
  labelEl.addEventListener("keydown", kd);
  labelEl.addEventListener("blur", bl, { once: true });
}

// ─── Session right-click context menu ────────────────────────────────────────
let activeCtxMenu = null;
function closeContextMenu() {
  if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; }
}
function showSessionContextMenu(e, id) {
  closeContextMenu();
  const s = latest?.sessions?.find(x => x.id === id);
  if (!s) return;
  const menu = document.createElement("div");
  menu.className = "ctx-popup";
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#252526;border:1px solid #454545;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.5);z-index:9000;min-width:170px;padding:4px 0;font-size:13px;color:#cccccc`;
  const item = (label, shortcut, action, danger) => {
    const el = document.createElement("div");
    el.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;justify-content:space-between${danger?";color:#f87171":""}`;
    el.innerHTML = `<span>${escapeHtml(label)}</span>${shortcut?`<span style="opacity:.4;font-size:11px">${escapeHtml(shortcut)}</span>`:""}`;
    el.addEventListener("mouseenter", () => { el.style.background = danger ? "rgba(248,113,113,.1)" : "#094771"; if (!danger) el.style.color = "#fff"; });
    el.addEventListener("mouseleave", () => { el.style.background = ""; el.style.color = danger ? "#f87171" : "#cccccc"; });
    el.addEventListener("click", () => { closeContextMenu(); action(); });
    return el;
  };
  const sep = () => { const d = document.createElement("div"); d.style.cssText = "height:1px;background:#3c3c3c;margin:4px 0"; return d; };
  // Get the session-item element for inline rename
  const listEl = document.getElementById("sessions-list");
  const itemEl = listEl ? listEl.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
  menu.appendChild(item(`✏️ Rename`, "F2", () => { if (itemEl) startInlineRename(itemEl); }));
  menu.appendChild(sep());
  menu.appendChild(item("📋 Copy label", "", () => navigator.clipboard.writeText(s.label).catch(() => {})));
  menu.appendChild(item("🆔 Copy session ID", "", () => navigator.clipboard.writeText(s.id).catch(() => {})));
  menu.appendChild(sep());
  menu.appendChild(item("⏹ Stop current task", "", () => api(`/api/sessions/${id}/interrupt`)));
  menu.appendChild(item("⏏ End session", "", async () => {
    if (confirm(`End session "${s.label}"?`)) { await api(`/api/sessions/${id}/stop`); }
  }, true));
  document.body.appendChild(menu);
  activeCtxMenu = menu;
  // Close on outside click
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) { closeContextMenu(); document.removeEventListener("click", close); } };
    document.addEventListener("click", close);
  }, 0);
}

// ─── Session selection ────────────────────────────────────────────────────────
function selectSession(id) {
  isViewingHistory = false;  // exit history view mode
  selectedId = id;
  viewingRel = null;
  lastControlsSig = "";
  lastIntelSig = "";
  // Update list highlight
  renderSessionsList();
  // Open SSE for this session
  openSessionSSE(id);
  // Update chat header
  const s = latest?.sessions?.find((x) => x.id === id);
  if (s) updateChatHeader(s);
  // Re-render open controls/intelligence
  renderControls();
  if (activeRightPanel === "intelligence") renderIntelligence();
  // Sync repos checkboxes with session's additionalDirectories
  if (s) syncRepoCheckboxesFromSession(s);
  // Refresh status bar session cost immediately
  if (latest) renderFleet();
}

function updateChatHeader(s) {
  const titleEl = el("chat-title");
  if (titleEl && titleEl.dataset.editing !== "1") titleEl.textContent = s.label;
  el("chat-meta").textContent = `${s.host}${s.distro ? ` · ${s.distro}` : ""} · ${s.cwd || ""}`;
}

async function renameSession(id, newLabel) {
  const trimmed = newLabel.trim();
  if (!trimmed || !id) return;
  await api(`/api/sessions/${id}/rename`, { label: trimmed });
}

// Recent tool/command executions shown as a live feed in the working box (newest at the bottom).
let recentTools = [];
const RECENT_TOOLS_CAP = 12;

function renderWorkingState(s) {
  const w = el("working");
  const running = !!(s && s.status === "running");
  if (!running) {
    w.classList.add("hidden");
    const wt0 = el("working-text"); if (wt0) { delete wt0.dataset.live; wt0.textContent = "Claude is working…"; }
    return;
  }
  w.classList.remove("hidden");
  w.classList.remove("idle");
  const wt = el("working-text");
  if (wt && !wt.dataset.live) wt.textContent = "Claude is working…";
}

// One-line summary of a tool/command execution for the feed above the composer.
function formatToolHtml(m) {
  const name = escapeHtml(m.name || "tool");
  let detail = "";
  if (m.input && typeof m.input === "object") {
    const v = m.input.command ?? m.input.cmd ?? m.input.file_path ?? m.input.path ??
              m.input.pattern ?? m.input.query ?? m.input.url;
    detail = v != null ? String(v) : JSON.stringify(m.input);
  } else if (m.input != null) {
    detail = String(m.input);
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 400);
  return `🔧 <strong>${name}</strong>${detail ? ` <span class="working-cmd-arg">${escapeHtml(detail)}</span>` : ""}`;
}

// "Jun 18 14:23:45" — log-style date+time for a feed entry.
function fmtLogTs(ms) {
  const d = ms ? new Date(ms) : new Date();
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour12: false })}`;
}

// Append a timestamped tool/command execution to the live feed above the chat input (a running log).
function pushToolActivity(m) {
  recentTools.push(`<span class="working-cmd-ts">${fmtLogTs(m.ts)}</span> ${formatToolHtml(m)}`);
  if (recentTools.length > RECENT_TOOLS_CAP) recentTools.shift();
  renderToolFeed();
}

function renderToolFeed() {
  const cmd = el("working-cmd");
  if (!cmd) return;
  cmd.innerHTML = recentTools.map((h) => `<div class="working-cmd-line">${h}</div>`).join("");
  cmd.scrollTop = cmd.scrollHeight; // keep the newest in view
}

// Live in-turn status: "Thinking…", "Responding…", or "Running a tool…", with a short preview.
function renderActivity(activity) {
  const s = latest?.sessions?.find((x) => x.id === selectedId);
  if (!s || s.status !== "running") return; // don't show animation when session is idle/stopped
  const wt = el("working-text");
  if (!wt) return;
  if (!activity || !activity.phase) { delete wt.dataset.live; wt.textContent = "Claude is working…"; return; }
  const LABEL = { thinking: "Thinking", responding: "Responding", tool: "Preparing a tool" };
  const label = LABEL[activity.phase] || "Working";
  const preview = (activity.preview || "").replace(/\s+/g, " ").trim().slice(0, 80);
  wt.dataset.live = "1";
  wt.textContent = preview ? `${label}… ${preview}` : `${label}…`;
  el("working").classList.remove("hidden");
}

// ─── Session SSE ──────────────────────────────────────────────────────────────
function openSessionSSE(id) {
  if (sessionES) { sessionES.close(); sessionES = null; }
  el("messages").innerHTML = "";
  recentTools = [];
  const cmd = el("working-cmd"); if (cmd) cmd.innerHTML = "";  // drop the previous session's tool feed
  sessionES = new EventSource(`${BASE}/api/sessions/${id}/events${tokenQ}`);
  sessionES.onmessage = (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    handleSessionEvent(data);
  };
  sessionES.onerror = () => {};
}

function handleSessionEvent(ev) {
  if (ev.kind === "backlog") {
    if (!isViewingHistory) el("messages").innerHTML = "";
    if (!isViewingHistory) (ev.messages || []).forEach(appendMessage);
    (ev.pendingApprovals || []).forEach((a) => approvalQueue.push(a));
    drainApprovals();
  } else if (ev.kind === "message") {
    if (!isViewingHistory) appendMessage(ev.message);
    if (!isViewingHistory) scrollMessages();
  } else if (ev.kind === "activity") {
    if (!isViewingHistory) renderActivity(ev.activity);
  } else if (ev.kind === "approval_request") {
    approvalQueue.push(ev);
    drainApprovals();
  }
}

// ─── Message rendering ────────────────────────────────────────────────────────
// ─── Message rendering ────────────────────────────────────────────────────────
const messagesEl = el("messages");
function appendMessage(m) {
  const div = document.createElement("div");
  const role = m.role || "system";
  div.className = "msg";
  div.dataset.role = role; // used by chat filter tabs
  const time = m.ts ? fmtTime(m.ts) : "";

  // Role-badge header (matches web app style)
  const roleColors = { user:"#61afef", assistant:"#98c379", result:"#4ade80", tool:"#e5c07b", system:"#6a737d" };
  const roleColor = roleColors[role] || "#cccccc";
  let header = `<div class="msg-header" style="display:flex;align-items:center;gap:6px;padding:3px 8px 2px;background:${roleColor}10;border-bottom:1px solid ${roleColor}18">` +
    `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;background:${roleColor}22;color:${roleColor}">${role}</span>` +
    `<span style="margin-left:auto;font-size:10px;opacity:.5">${time}</span></div>`;
  let body = "";

  if (role === "user") {
    recentTools = [];
    renderToolFeed();
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else if (role === "assistant") {
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else if (role === "tool") {
    // Also track in the "Tools" filter tab — show tool messages when that tab is active
    pushToolActivity(m);
    // Still create a filterable element for the Tools tab
    div.style.cssText = "display:none"; // hidden by default, shown when role=tool tab active
    body = `<div style="padding:5px 10px;font-family:monospace;font-size:12px;color:#e5c07b">🔧 <strong>${escapeHtml(m.name||"tool")}</strong>${m.input!=null?" "+escapeHtml(typeof m.input==="string"?m.input:JSON.stringify(m.input).slice(0,160)):""}</div>`;
    div.innerHTML = header + body;
    messagesEl.appendChild(div);
    applyChatFilter();
    return;
  } else if (role === "result") {
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else {
    body = `<div class="msg-system-text" style="text-align:center;font-size:11px;opacity:.6;padding:3px">${escapeHtml(m.text || "")}</div>`;
    header = ""; // no header for system messages
  }
  div.style.cssText = `border:1px solid ${roleColor}18;border-radius:6px;overflow:hidden;margin-bottom:5px;background:${role==="user"?"rgba(97,175,239,.08)":role==="result"?"rgba(74,222,128,.05)":"rgba(255,255,255,.03)"}`;
  div.innerHTML = header + body;
  messagesEl.appendChild(div);
  applyChatFilter();
}

function scrollMessages() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─── Approvals ────────────────────────────────────────────────────────────────
function drainApprovals() {
  if (currentApproval || !approvalQueue.length) return;
  currentApproval = approvalQueue.shift();
  showApproval(currentApproval);
}

function showApproval(a) {
  const body = el("approval-body");
  body.textContent = [
    a.tool ? `Tool: ${a.tool}` : "",
    a.input ? `Input: ${JSON.stringify(a.input, null, 2)}` : "",
    a.description || "",
  ].filter(Boolean).join("\n\n");
  el("approval-modal").classList.remove("hidden");
}

function resolveApproval(decision) {
  if (!currentApproval || !selectedId) return;
  api(`/api/sessions/${selectedId}/approval`, { id: currentApproval.id, decision });
  currentApproval = null;
  el("approval-modal").classList.add("hidden");
  drainApprovals();
}

// ─── Controls panel ───────────────────────────────────────────────────────────
const MODE_OPTIONS = [
  { value: "bypassPermissions", label: "Auto (full access)" },
  { value: "acceptEdits",       label: "Auto-accept edits" },
  { value: "default",           label: "Ask before edits" },
  { value: "plan",              label: "Plan (read-only)" },
];
const EFFORT_OPTIONS = [
  { value: "",      label: "Default" },
  { value: "low",   label: "Low" },
  { value: "medium",label: "Medium" },
  { value: "high",  label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max",   label: "Max" },
];
const THINKING_OPTIONS = [
  { value: "adaptive", label: "Adaptive (always on)" },
  { value: "off",      label: "Off" },
];

function renderControls() {
  const container = el("controls-content");
  if (!container) return;
  const s = latest?.sessions?.find((x) => x.id === selectedId);
  const models = latest?.models || [];
  const sig = s
    ? `live|${[s.id,s.status,s.mode,s.model,models.length,s.effort||"",s.thinking||"",s.browser?1:0,s.autoContinue===false?0:1,(s.additionalDirectories||[]).join(",")].join("|")}`
    : viewingRel
    ? `past|${viewingRel}`
    : "none";
  if (sig === lastControlsSig) return;
  lastControlsSig = sig;

  if (!s) {
    if (viewingRel) {
      container.innerHTML = `<div class="ctrl-hint">Saved session — resume it to continue chatting.</div>
        <div class="ctrl-actions"><button class="ctrl-btn primary" id="ctl-resume">▸ Resume Session</button></div>`;
      el("ctl-resume").addEventListener("click", async () => {
        const r = await api("/api/history/resume", { rel: viewingRel });
        if (r?.ok && r.id) selectSession(r.id);
        else alert("Could not resume this session.");
      });
    } else {
      container.innerHTML = '<div class="ctrl-hint">Select a session to see its controls.</div>';
    }
    return;
  }

  const selOpts = (opts, cur) =>
    opts.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === cur ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  let modelOpts = `<option value=""${!s.model ? " selected" : ""}>Default</option>`;
  for (const m of models) modelOpts += `<option value="${escapeHtml(m.value)}"${m.value === s.model ? " selected" : ""}>${escapeHtml(m.displayName || m.value)}</option>`;

  const extraDirs = (s.additionalDirectories || []).map((d, i) =>
    `<div class="ctrl-dir-item"><span class="ctrl-dir-path" title="${escapeHtml(d)}">${escapeHtml(d)}</span><button class="ctrl-dir-remove" data-idx="${i}">✕</button></div>`
  ).join("");

  container.innerHTML = `
    <div class="ctrl-section">
      <label class="ctrl-label">Mode</label>
      <select id="ctl-mode" class="ctrl-select">${selOpts(MODE_OPTIONS, s.mode || "default")}</select>
      <label class="ctrl-label">Model</label>
      <select id="ctl-model" class="ctrl-select">${modelOpts}</select>
      <label class="ctrl-label">Reasoning effort</label>
      <select id="ctl-effort" class="ctrl-select">${selOpts(EFFORT_OPTIONS, s.effort || "")}</select>
      <label class="ctrl-label">Extended thinking</label>
      <select id="ctl-thinking" class="ctrl-select">${selOpts(THINKING_OPTIONS, s.thinking || "adaptive")}</select>
      <label class="ctrl-check"><input type="checkbox" id="ctl-browser"${s.browser ? " checked" : ""}/> Enable Playwright browser tools</label>
      <label class="ctrl-check"><input type="checkbox" id="ctl-autocontinue"${s.autoContinue === false ? "" : " checked"}/> Auto-continue after 5h reset</label>
      <label class="ctrl-label" style="margin-top:6px">Directories</label>
      <div class="ctrl-dir-list">
        <div class="ctrl-dir-item"><span class="ctrl-dir-path">${escapeHtml(s.cwd || "")}</span><span class="ctrl-dir-badge">cwd</span></div>
        ${extraDirs}
      </div>
      <div class="ctrl-dir-add">
        <input id="ctl-dir-input" class="ctrl-dir-input" placeholder="/path/to/repo" />
        <button class="ctrl-btn" id="ctl-dir-add" style="flex-shrink:0">Add</button>
      </div>
    </div>
    <div class="ctrl-actions">
      <button class="ctrl-btn" id="ctl-instr">📄 Instructions</button>
      <button class="ctrl-btn danger" id="ctl-stop">⏹ Stop current task</button>
      <button class="ctrl-btn" id="ctl-continue">▶ Continue</button>
      <button class="ctrl-btn" id="ctl-restart">🔄 Restart runner</button>
      <button class="ctrl-btn danger" id="ctl-end">⏏ End session</button>
    </div>`;

  // Wire events
  el("ctl-mode").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-mode`, { mode: e.target.value });
    lastControlsSig = "";
  });
  el("ctl-model").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-model`, { model: e.target.value });
    lastControlsSig = "";
  });
  el("ctl-effort").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-effort`, { effort: e.target.value });
    lastControlsSig = "";
  });
  el("ctl-thinking").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-thinking`, { thinking: e.target.value });
    lastControlsSig = "";
  });
  el("ctl-browser").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-browser`, { enabled: e.target.checked });
    lastControlsSig = "";
  });
  el("ctl-autocontinue").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/auto-continue`, { enabled: e.target.checked });
    lastControlsSig = "";
  });
  el("ctl-instr").addEventListener("click", () => openInstructions(s.id));
  el("ctl-stop").addEventListener("click", async () => { await api(`/api/sessions/${s.id}/interrupt`); });
  el("ctl-continue").addEventListener("click", async () => { await api(`/api/sessions/${s.id}/continue`); });
  el("ctl-restart").addEventListener("click", async () => { await api(`/api/sessions/${s.id}/restart`); });
  el("ctl-end").addEventListener("click", async () => {
    if (!confirm(`End session "${s.label}"?`)) return;
    await api(`/api/sessions/${s.id}/stop`);
    selectedId = null; lastControlsSig = "";
    el("chat-title").textContent = "Select or create a session";
    el("chat-meta").textContent = "";
  });
  // Remove extra dir
  container.querySelectorAll(".ctrl-dir-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dirs = (s.additionalDirectories || []).slice();
      dirs.splice(Number(btn.dataset.idx), 1);
      await api(`/api/sessions/${s.id}/set-directories`, { directories: dirs });
      lastControlsSig = "";
    });
  });
  // Add extra dir
  const addDir = async () => {
    const inp = el("ctl-dir-input");
    const d = inp.value.trim();
    if (!d) return;
    const dirs = [...(s.additionalDirectories || []), d];
    await api(`/api/sessions/${s.id}/set-directories`, { directories: dirs });
    inp.value = "";
    lastControlsSig = "";
  };
  el("ctl-dir-add").addEventListener("click", addDir);
  el("ctl-dir-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addDir(); });
}

// ─── Intelligence panel ───────────────────────────────────────────────────────
const DEFAULT_INTEL_TOOLS = ["region_extract","tds"];
const INTELLIGENCE_TOOLS = [
  // Code intelligence
  { id: "safr",          label: "SAFR",          group: "Code Intelligence",  desc: "Symbol-aware file reader — reads files with context awareness" },
  { id: "chunkhound",    label: "ChunkHound",     group: "Code Intelligence",  desc: "Semantic chunk search with embeddings" },
  { id: "region_extract",label: "RegionExtract",  group: "Code Intelligence",  desc: "Extracts a named code region or function body" },
  { id: "symbol_scope",  label: "SymbolScope",    group: "Code Intelligence",  desc: "Finds where a symbol is defined / used" },
  // Token tools
  { id: "tds",           label: "TDS",            group: "Token Efficiency",   desc: "Token-diff summariser — compacts diffs" },
  { id: "noise_filter",  label: "NoiseFilter",    group: "Token Efficiency",   desc: "Strips irrelevant lines from tool output" },
  { id: "log_dedup",     label: "LogDedup",       group: "Token Efficiency",   desc: "Deduplicates repetitive log output" },
  { id: "stack_collapse",label: "StackCollapse",  group: "Token Efficiency",   desc: "Collapses deep stack traces" },
  // Memory
  { id: "cavemem_read",  label: "CavememRead",    group: "Memory",             desc: "Read from persistent memory store" },
  { id: "cavemem_write", label: "CavememWrite",   group: "Memory",             desc: "Write to persistent memory store" },
  // Analysis
  { id: "graphify",      label: "Graphify",       group: "Analysis",           desc: "Builds a dependency graph for a module" },
  { id: "ast_query",     label: "ASTQuery",       group: "Analysis",           desc: "Runs a tree-sitter query on source files" },
];
const TOOL_GROUPS = [...new Set(INTELLIGENCE_TOOLS.map((t) => t.group))];

function renderIntelligence() {
  const container = el("intelligence-content");
  if (!container) return;
  const s = latest?.sessions?.find((x) => x.id === selectedId);
  const tsEnabled = !!(latest?.toolServer?.enabled);
  const sessionOn = !!(s?.toolServer);
  const selected = new Set(s?.tools?.length ? s.tools : DEFAULT_INTEL_TOOLS);
  const sig = [tsEnabled?1:0, sessionOn?1:0, s?.id||"none", s?.status||"", [...selected].sort().join(",")].join("|");
  if (sig === lastIntelSig) return;
  lastIntelSig = sig;

  if (!tsEnabled) {
    container.innerHTML = `<div class="intel-banner">
      🧰 <strong>Tool Server not enabled</strong><br/>
      Set <code>toolServer.enabled: true</code> in <code>config/config.yaml</code>, then run:<br/>
      <code>scripts\\start-tool-server.ps1</code>
    </div>`;
    return;
  }

  const masterDis = s ? "" : "disabled";
  const toolDis   = s && sessionOn ? "" : "disabled";
  const selCount  = [...selected].filter((id) => INTELLIGENCE_TOOLS.some((t) => t.id === id)).length;

  let html = `<div class="intel-master">
    <label class="ctrl-check">
      <input type="checkbox" id="intel-master" ${sessionOn ? "checked" : ""} ${masterDis}/>
      <strong>Enable tool server</strong>
    </label>
    <div class="ctrl-note">${selCount}/${INTELLIGENCE_TOOLS.length} tools selected</div>
    <div class="intel-quick">
      <button class="intel-quick-btn" data-pick="defaults" ${toolDis}>Defaults</button>
      <button class="intel-quick-btn" data-pick="all"      ${toolDis}>All</button>
      <button class="intel-quick-btn" data-pick="none"     ${toolDis}>None</button>
    </div>
  </div>`;
  for (const group of TOOL_GROUPS) {
    const tools = INTELLIGENCE_TOOLS.filter((t) => t.group === group);
    html += `<div class="intel-group-title">${group}</div>`;
    for (const tool of tools) {
      const isDef = DEFAULT_INTEL_TOOLS.includes(tool.id);
      html += `<label class="intel-tool" title="${escapeHtml(tool.desc)}">
        <input type="checkbox" class="intel-tool-cb" data-tool="${escapeHtml(tool.id)}" ${selected.has(tool.id)?"checked":""} ${toolDis}/>
        <div class="intel-tool-body">
          <div class="intel-tool-label">${escapeHtml(tool.label)}${isDef?'<span class="intel-default-tag">default</span>':""}</div>
          <div class="intel-tool-desc">${escapeHtml(tool.desc)}</div>
        </div>
      </label>`;
    }
  }
  container.innerHTML = html;

  const pushTools = async () => {
    if (!s) return;
    const tools = [...container.querySelectorAll(".intel-tool-cb:checked")].map((cb) => cb.dataset.tool);
    await api(`/api/sessions/${s.id}/set-tools`, { tools });
    lastIntelSig = "";
  };
  const masterEl = el("intel-master");
  if (masterEl && s) {
    masterEl.addEventListener("change", async (e) => {
      await api(`/api/sessions/${s.id}/set-tool-server`, { enabled: e.target.checked });
      lastIntelSig = "";
    });
  }
  for (const btn of container.querySelectorAll(".intel-quick-btn")) {
    btn.addEventListener("click", async () => {
      if (!s || !sessionOn) return;
      const pick = btn.dataset.pick;
      let next = pick === "all" ? INTELLIGENCE_TOOLS.map((t) => t.id) : pick === "defaults" ? DEFAULT_INTEL_TOOLS.slice() : [];
      const sel = new Set(next);
      for (const cb of container.querySelectorAll(".intel-tool-cb")) cb.checked = sel.has(cb.dataset.tool);
      await pushTools();
    });
  }
  for (const cb of container.querySelectorAll(".intel-tool-cb")) {
    cb.addEventListener("change", pushTools);
  }
}

// ─── Commands panel ───────────────────────────────────────────────────────────
function renderCommands() {
  const listEl = el("cmd-list");
  if (!listEl) return;
  const cmds = latest?.commands || [];
  const q = cmdFilter.toLowerCase();
  const filtered = cmds.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description||"").toLowerCase().includes(q)).sort((a,b) => a.name.localeCompare(b.name));
  if (!filtered.length) {
    listEl.innerHTML = `<div class="ctrl-hint">${cmds.length ? "No matches." : "No commands yet — start a session."}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map((c) => `
    <div class="cmd-item" data-name="${escapeHtml(c.name)}">
      <div><span class="cmd-name">/${escapeHtml(c.name)}</span>${c.argumentHint ? `<span class="cmd-arg">${escapeHtml(c.argumentHint)}</span>` : ""}</div>
      ${c.description ? `<div class="cmd-desc">${escapeHtml(c.description)}</div>` : ""}
    </div>`).join("");
  listEl.querySelectorAll(".cmd-item").forEach((item) => {
    item.addEventListener("click", () => {
      if (!selectedId) { alert("Open a session first."); return; }
      const inp = el("composer-input");
      if (inp) { inp.value = `/${item.dataset.name} `; inp.focus(); }
    });
  });
}

// ─── History tree ─────────────────────────────────────────────────────────────
async function loadAndRenderHistory() {
  const treeEl = el("history-tree");
  if (treeEl && !historyData) treeEl.innerHTML = '<div class="ctrl-hint">Loading…</div>';
  const data = await getJson("/api/history");
  if (data) historyData = data;
  renderHistoryTree();
}

function dateGroup(isoOrMs) {
  if (!isoOrMs) return "Older";
  const d = new Date(isoOrMs);
  if (isNaN(d)) return "Older";
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 14) return "Last Week";
  if (diffDays < 30) return "This Month";
  return "Older";
}

// Track open/collapsed state for history tree groups
const historyGroupOpen = {};
const historyRepoOpen  = {};

function renderHistoryTree() {
  const treeEl = el("history-tree");
  if (!treeEl) return;
  const sessions = historyData?.sessions || [];
  const q = historyFilter.toLowerCase();
  const filtered = q
    ? sessions.filter((s) => (s.label||"").toLowerCase().includes(q) || (s.repo||"").toLowerCase().includes(q))
    : sessions;

  if (!filtered.length) {
    treeEl.innerHTML = `<div class="ctrl-hint">${sessions.length ? "No matches." : "No saved sessions found."}</div>`;
    return;
  }

  // Group by date only — session is the primary navigation item, repo is metadata below it
  const DATE_ORDER = ["Today","Yesterday","This Week","Last Week","This Month","Older"];
  const byDate = {};
  for (const s of filtered) {
    const grp = dateGroup(s.createdAt || s.mtime);
    if (!byDate[grp]) byDate[grp] = [];
    byDate[grp].push(s);
  }

  let gIdx = 0;
  const groupIndex = {};

  let html = "";
  for (const grp of DATE_ORDER) {
    if (!byDate[grp]) continue;
    const gi = gIdx++;
    groupIndex[grp] = gi;
    const gOpen = historyGroupOpen[grp] !== false;
    const items = byDate[grp];

    html += `<div class="tree-group-header${gOpen?" open":""}" data-gi="${gi}">
      <span class="tree-expand-icon${gOpen?" open":""}">▶</span>
      ${escapeHtml(grp)}
      <span style="font-size:10px;opacity:.5;margin-left:4px">(${items.length})</span>
    </div>
    <div class="tree-group-children${gOpen?"":" collapsed"}" data-gi-body="${gi}">`;

    for (const s of items) {
      const histSt  = historyDisplayStatus(s.status);
      const statusCls = histSt === "done" ? "done" : histSt;
      const time = s.createdAt ? fmtDate(s.createdAt) : (s.mtime ? fmtDate(s.mtime) : "");
      const repo = s.repo || "";
      const isSelected = viewingRel === s.rel;
      html += `<div class="tree-session-item${isSelected?" selected":""}" data-rel="${escapeHtml(s.rel||"")}">
        <div class="tree-session-row">
          <span class="tree-session-name" title="${escapeHtml(s.label||s.title||"")}">
            ${escapeHtml(s.label || s.title || "Unnamed")}
          </span>
          ${histSt && histSt !== "idle" ? `<span class="tree-session-status ${statusCls}">${escapeHtml(histSt)}</span>` : ""}
        </div>
        <div class="tree-session-sub">
          ${repo ? `<span class="tree-session-repo">📁 ${escapeHtml(repo)}</span>` : ""}
          <span class="tree-session-time">${escapeHtml(time)}${s.messages ? ` · ${s.messages} msg` : ""}</span>
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  treeEl.innerHTML = html;

  // Wire group header expand/collapse
  treeEl.querySelectorAll(".tree-group-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const gi   = hdr.dataset.gi;
      const body = treeEl.querySelector(`[data-gi-body="${gi}"]`);
      const icon = hdr.querySelector(".tree-expand-icon");
      const grp  = Object.entries(groupIndex).find(([,v]) => String(v) === gi)?.[0];
      if (!grp || !body) return;
      const isOpen = historyGroupOpen[grp] !== false;
      historyGroupOpen[grp] = !isOpen;
      icon.classList.toggle("open", !isOpen);
      body.classList.toggle("collapsed", isOpen);
    });
  });
  // Wire session item clicks
  treeEl.querySelectorAll(".tree-session-item").forEach((item) => {
    item.addEventListener("click",    () => viewHistoryItem(item.dataset.rel));
    item.addEventListener("keydown",  (e) => { if (e.key === "F2") startHistoryItemRename(item); });
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); showHistoryContextMenu(e, item); });
  });
}

// ─── History item inline rename ──────────────────────────────────────────────
function startHistoryItemRename(item) {
  const rel = item.dataset.rel;
  if (!rel) return;
  const nameEl = item.querySelector(".tree-session-name");
  if (!nameEl) return;
  const current = nameEl.textContent;
  nameEl.contentEditable = "true";
  nameEl.style.outline = "1px solid var(--vsc-accent)";
  nameEl.style.background = "rgba(0,122,204,.15)";
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = async (save) => {
    nameEl.contentEditable = "false";
    nameEl.style.outline = "";
    nameEl.style.background = "";
    if (save && nameEl.textContent.trim() && nameEl.textContent.trim() !== current) {
      await api("/api/history/rename", { rel, label: nameEl.textContent.trim() });
      // Update chat header if this item is currently being viewed
      if (viewingRel === rel) {
        el("chat-title").textContent = nameEl.textContent.trim();
      }
    } else {
      nameEl.textContent = current;
    }
  };
  const kd = (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameEl.removeEventListener("keydown", kd); nameEl.removeEventListener("blur", bl); finish(true); }
    if (e.key === "Escape") { nameEl.removeEventListener("keydown", kd); nameEl.removeEventListener("blur", bl); finish(false); }
  };
  const bl = () => { nameEl.removeEventListener("keydown", kd); finish(true); };
  nameEl.addEventListener("keydown", kd);
  nameEl.addEventListener("blur", bl, { once: true });
}

// ─── History item context menu ───────────────────────────────────────────────
function showHistoryContextMenu(e, item) {
  closeContextMenu(); // reuse the session context menu closer
  const rel = item.dataset.rel;
  if (!rel) return;
  const menu = document.createElement("div");
  menu.className = "ctx-popup";
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#252526;border:1px solid #454545;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.6);z-index:9000;min-width:180px;padding:4px 0;font-size:13px;color:#cccccc`;
  const row = (label, shortcut, action) => {
    const el2 = document.createElement("div");
    el2.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;justify-content:space-between";
    el2.innerHTML = `<span>${label}</span>${shortcut?`<span style="opacity:.4;font-size:11px">${shortcut}</span>`:""}`;
    el2.addEventListener("mouseenter", () => { el2.style.background = "#094771"; el2.style.color = "#fff"; });
    el2.addEventListener("mouseleave", () => { el2.style.background = ""; el2.style.color = "#cccccc"; });
    el2.addEventListener("click", () => { closeContextMenu(); action(); });
    return el2;
  };
  const sep = () => { const d = document.createElement("div"); d.style.cssText = "height:1px;background:#3c3c3c;margin:4px 0"; return d; };
  menu.appendChild(row("✏️ Rename", "F2", () => startHistoryItemRename(item)));
  menu.appendChild(sep());
  menu.appendChild(row("📖 View Transcript", "", () => viewHistoryItem(rel)));
  menu.appendChild(row("▸ Resume Session", "", async () => { const r = await api("/api/history/resume", { rel }); if (r?.id) selectSession(r.id); }));
  document.body.appendChild(menu);
  activeCtxMenu = menu;
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) { closeContextMenu(); document.removeEventListener("click", close); } };
    document.addEventListener("click", close);
  }, 0);
}

async function viewHistoryItem(rel) {
  viewingRel = rel;
  isViewingHistory = true;   // prevent live SSE from overwriting
  selectedId = null;          // deselect any live session
  // Highlight in tree
  el("history-tree").querySelectorAll(".tree-session-item").forEach((i) => i.classList.toggle("selected", i.dataset.rel === rel));
  lastControlsSig = "";
  renderControls();
  // Clear messages and show loading
  const msgDiv = el("messages");
  msgDiv.innerHTML = '<div class="msg"><div class="msg-system-text">Loading transcript…</div></div>';
  const data = await getJson(`/api/history/item?path=${encodeURIComponent(rel)}`);
  if (!data || !isViewingHistory) return;  // user may have clicked away
  const meta = data.meta || {};
  el("chat-title").textContent = meta.label || rel;
  el("chat-meta").textContent = `Saved · ${fmtDate(meta.createdAt || meta.ts)} · ${meta.host || ""}${meta.distro ? ` · ${meta.distro}` : ""} · ${meta.status || ""}`;
  msgDiv.innerHTML = "";
  const interactions = meta.interactions || [];
  if (interactions.length > 0) {
    for (const m of interactions) {
      // Interactions from session.json: {ts, role, text?, tool?, input?}
      appendMessage({
        role:  m.role  || "system",
        text:  m.text  != null ? m.text : (m.tool || ""),
        ts:    m.ts    ? (typeof m.ts === "number" ? m.ts : Date.parse(m.ts)) : 0,
        name:  m.tool  || null,
        input: m.input || null,
      });
    }
  } else if (data.markdown) {
    // Fallback: render the conversation.md directly
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<div class="msg-body">${mdToHtml(data.markdown)}</div>`;
    msgDiv.appendChild(div);
  } else {
    msgDiv.innerHTML = '<div class="msg"><div class="msg-system-text">No conversation content found in this session.</div></div>';
  }
  scrollMessages();
}

async function viewHistoryItemModal(rel) {
  const data = await getJson(`/api/history/item?path=${encodeURIComponent(rel)}`);
  if (!data) return;
  const meta = data.meta || {};
  histModalRel = rel;
  el("hist-modal-title").textContent = meta.label || rel;
  el("hist-modal-meta").textContent = `${fmtDate(meta.createdAt)} · ${meta.host||""}${meta.distro?` · ${meta.distro}`:""} · ${meta.cwd||""} · ${meta.status||""}`;
  const bodyEl = el("hist-modal-body");
  bodyEl.innerHTML = "";
  for (const m of (meta.interactions || [])) {
    appendMessageTo(bodyEl, { role: m.role, text: m.text || "", ts: m.ts ? Date.parse(m.ts) : 0, name: m.tool, input: m.input });
  }
  el("history-modal").classList.remove("hidden");
}

function appendMessageTo(container, m) {
  const div = document.createElement("div");
  div.className = "msg";
  const role = m.role || "system";
  div.innerHTML = `<div class="msg-header"><span class="msg-role ${role}">${role}</span></div>` +
    (role === "tool"
      ? `<div class="msg-tool-use">🔧 <strong>${escapeHtml(m.name||"")}</strong></div>`
      : `<div class="msg-body">${mdToHtml(m.text || "")}</div>`);
  container.appendChild(div);
}

// ─── WSL Distros panel ────────────────────────────────────────────────────────
// ─── Virtual Machines panel (WSL + Hyper-V + VMware + VirtualBox) ────────────
let vmData = null;
let vmLoading = false;

async function loadAndRenderVMs() {
  if (vmLoading) return;
  const listEl = el("vms-list");
  if (listEl && !vmData) listEl.innerHTML = '<div class="ctrl-hint">Scanning for virtual machines…</div>';
  vmLoading = true;
  try {
    if (window.fleetApp?.getVMs) {
      vmData = await window.fleetApp.getVMs();
    } else {
      // Fallback: fetch WSL distros from orchestrator
      const d = await getJson("/api/wsl/distros");
      vmData = (d?.distros || []).map((dist) => ({
        type: "WSL", name: dist.name, state: /running/i.test(dist.state) ? "running" : "stopped",
        stateRaw: dist.state, isDefault: dist.default, version: dist.version, ip: null, osInfo: null,
      }));
    }
  } catch (e) {
    console.error("VM scan error:", e);
    vmData = [];
  }
  vmLoading = false;
  renderVMsPanel();
}

// Legacy alias kept so any stray call still works
async function loadAndRenderWsl() { return loadAndRenderVMs(); }
function renderWslList() { renderVMsPanel(); }

function renderVMsPanel() {
  const listEl = el("vms-list");
  if (!listEl) return;
  const vms = vmData || [];

  if (!vms.length) {
    listEl.innerHTML = '<div class="vm-none">No virtual machines found.<br><small>Requires Hyper-V, WSL, VMware Workstation or VirtualBox.</small></div>';
    return;
  }

  // Group by type
  const groups = {};
  const errors = {};
  const TYPE_ORDER = ["WSL", "Hyper-V", "VMware", "VirtualBox"];
  for (const vm of vms) {
    if (vm._error) { errors[vm.type] = vm._error; continue; }
    if (!groups[vm.type]) groups[vm.type] = [];
    groups[vm.type].push(vm);
  }

  // Sort each group: running first, then alphabetical
  for (const g of Object.values(groups)) {
    g.sort((a, b) => {
      if (a.state === b.state) return a.name.localeCompare(b.name);
      return a.state === "running" ? -1 : 1;
    });
  }

  const typeIcon = { WSL: "🐧", "Hyper-V": "🪟", VMware: "💿", VirtualBox: "📦" };
  const typeBadgeClass = { WSL: "", "Hyper-V": "hyper-v", VMware: "vmware", VirtualBox: "virtualbox" };

  let html = "";
  for (const type of [...TYPE_ORDER, ...Object.keys(groups).filter((k) => !TYPE_ORDER.includes(k))]) {
    const items = groups[type];
    const errMsg = errors[type];
    if (!items && !errMsg) continue;

    const running = (items || []).filter((v) => v.state === "running").length;
    const count   = (items || []).length;
    html += `<div class="vm-section-title">${escapeHtml(type)}${count ? ` · ${count} (${running} running)` : ""}</div>`;

    // Show error (e.g. needs elevation, module not found)
    if (errMsg) {
      const needsElevation = /Access.*denied|Administrator|elevation|privilege/i.test(errMsg);
      html += `<div class="vm-error">
        ${needsElevation
          ? `⚠️ Needs elevation — run Fleet Console as <strong>Administrator</strong> to query ${escapeHtml(type)}.`
          : `⚠️ ${escapeHtml(errMsg.split("\n")[0].slice(0, 160))}`}
      </div>`;
      if (!items) continue;
    }

    for (const vm of items) {
      const isRunning = vm.state === "running";
      const badgeCls = typeBadgeClass[type] || "";
      const icon = typeIcon[type] || "💻";

      // Build meta row for running machines
      let metaParts = [];
      if (isRunning) {
        if (vm.osInfo) metaParts.push(`<span>${escapeHtml(vm.osInfo)}</span>`);
        if (vm.ip)    metaParts.push(`<span class="vm-meta-ip">⬡ ${escapeHtml(vm.ip)}</span>`);
        if (vm.memGb != null) metaParts.push(`<span>RAM ${vm.memGb}GB</span>`);
        if (vm.cpu  != null && vm.cpu > 0) metaParts.push(`<span>CPU ${vm.cpu}%</span>`);
        if (vm.gen)  metaParts.push(`<span>Gen${vm.gen}</span>`);
        if (vm.version) metaParts.push(`<span>WSL${vm.version}</span>`);
      }

      html += `<div class="vm-card${isRunning ? " running" : ""}">
        <div class="vm-card-header">
          <span class="vm-state-dot ${vm.state}"></span>
          <span class="vm-name" title="${escapeHtml(vm.name)}">${icon} ${escapeHtml(vm.name)}</span>
          ${vm.isDefault ? '<span class="vm-type-badge">default</span>' : ""}
          <span class="vm-type-badge ${badgeCls}">${escapeHtml(vm.stateRaw || vm.state)}</span>
        </div>
        ${metaParts.length ? `<div class="vm-meta">${metaParts.join("")}</div>` : ""}
        <div class="vm-actions">
          ${(isRunning || type === "WSL") ? `
            <button class="vm-btn primary" data-vm-new data-vm-name="${escapeHtml(vm.name)}" data-vm-type="${escapeHtml(type)}" data-vm-ip="${escapeHtml(vm.ip||"")}">
              ＋ New Session
            </button>
            ${isRunning && vm.ip ? `<button class="vm-btn" data-vm-ssh data-vm-ip="${escapeHtml(vm.ip)}" data-vm-name="${escapeHtml(vm.name)}">SSH</button>` : ""}
            ${!isRunning && type === "WSL" ? `<span class="vm-hint-inline" title="The distro starts automatically when the session launches">starts on launch</span>` : ""}
          ` : `<span style="font-size:10px;color:var(--gh-muted)">Start to create a session</span>`}
        </div>
      </div>`;
    }
  }

  listEl.innerHTML = html;

  // Wire "New Session" buttons — reuse the shared modal opener so the repo dropdown,
  // extra-repos field and host rows are all set up the same as the toolbar button.
  listEl.querySelectorAll("[data-vm-new]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.vmName;
      const type = btn.dataset.vmType;
      if (type === "WSL")          openNewSessionModal({ host: "wsl",    distro: name, label: name });
      else if (type === "Hyper-V") openNewSessionModal({ host: "hyperv", vmName: name, label: name });
      else                         openNewSessionModal({ host: "local",  label: name });
    });
  });
}

// ─── Repos checkbox tree ──────────────────────────────────────────────────────
// Track which repo groups are open
const reposGroupOpen = {};

async function loadRepos() {
  if (reposLoading) return;
  reposLoading = true;
  const data = await getJson("/api/repos");
  reposLoading = false;
  if (data) {
    reposData = data;
    if (activeRightPanel === "repos") renderReposTree();
    else if (activeRightPanel === "directories") {
      // Refresh any open repo-tree pickers in the Directories panel with the loaded data.
      if (dirCwdTreeShown) renderDirTree("dir-cwd-tree", "cwd");
      if (dirAddTreeShown) renderDirTree("dir-add-tree", "add");
    }
  }
}

function renderReposTree() {
  const container = el("repos-tree");
  if (!container) return;
  const groups = reposData?.groups || [];
  if (!groups.length) {
    container.innerHTML = `<div class="repos-hint">No repositories found. Check <code>repos.localRoots</code> in config.yaml.</div>`;
    return;
  }
  let html = "";
  for (const group of groups) {
    const key = `${group.host}::${group.label}`;
    const isOpen = reposGroupOpen[key] !== false;
    html += `<div class="repos-group-header" data-repo-group="${escapeHtml(key)}">
      <span class="tree-expand-icon${isOpen?" open":""}">▶</span>
      ${group.host === "wsl" ? "🐧" : "💻"} ${escapeHtml(group.label)}
      ${group.stopped ? `<span class="repo-stopped-tag">stopped</span>` : `<span class="muted" style="font-size:10px;margin-left:4px">(${group.repos.length})</span>`}
    </div>
    <div class="repos-group-children${isOpen?"":" collapsed"}" data-repo-group-body="${escapeHtml(key)}">`;
    if (group.stopped) {
      // Repos aren't enumerated for a stopped distro (would auto-start it). Offer an on-demand load.
      html += `<button class="repos-load-btn" data-load-distro="${escapeHtml(group.distro)}">▸ Start distro &amp; list repos</button>`;
    }
    for (const repo of group.repos) {
      const isChecked = checkedRepos.has(repo.path);
      html += `<div class="repo-check-item">
        <input type="checkbox" class="repo-checkbox" data-path="${escapeHtml(repo.path)}"${isChecked?" checked":""}/>
        <span class="repo-name" title="${escapeHtml(repo.path)}">${escapeHtml(repo.name)}</span>
        ${repo.branch ? `<span class="repo-branch">${escapeHtml(repo.branch)}</span>` : ""}
        ${repo.changes ? `<span class="repo-changes">${repo.changes}±</span>` : ""}
      </div>`;
    }
    html += `</div>`;
  }
  // Apply button shown when a session is active
  if (selectedId) {
    html += `<button class="repos-apply-btn" id="repos-apply">Apply checked repos to session</button>`;
  }
  container.innerHTML = html;

  // Wire group toggles
  container.querySelectorAll(".repos-group-header").forEach((hdr) => {
    hdr.addEventListener("click", (e) => {
      if (e.target.closest(".repo-checkbox")) return;
      const key = hdr.dataset.repoGroup;
      const isOpen = reposGroupOpen[key] !== false;
      reposGroupOpen[key] = !isOpen;
      const icon = hdr.querySelector(".tree-expand-icon");
      const body = container.querySelector(`[data-repo-group-body="${CSS.escape(key)}"]`);
      icon.classList.toggle("open", !isOpen);
      body.classList.toggle("collapsed", isOpen);
    });
  });

  // Wire checkboxes
  container.querySelectorAll(".repo-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) checkedRepos.add(cb.dataset.path);
      else checkedRepos.delete(cb.dataset.path);
    });
  });

  // Wire stopped-distro lazy loaders
  container.querySelectorAll(".repos-load-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); loadStoppedDistroRepos(btn.dataset.loadDistro, btn); });
  });

  // Apply button
  el("repos-apply")?.addEventListener("click", applyCheckedReposToSession);
}

/** Fetch a stopped distro's repos on demand (starts the distro) and merge them into reposData. */
async function loadStoppedDistroRepos(distro, btn) {
  if (!distro) return;
  if (btn) { btn.disabled = true; btn.textContent = `Scanning ${distro}…`; }
  const data = await getJson(`/api/wsl/repos?distro=${encodeURIComponent(distro)}`);
  const paths = (data?.repos || []).slice().sort();
  // Merge into the cached group so a re-render keeps them and the count updates.
  const group = (reposData?.groups || []).find((g) => g.host === "wsl" && g.distro === distro);
  if (group) {
    group.repos = paths.map((p) => ({ path: p, name: p.split("/").filter(Boolean).pop() || p, branch: null, changes: null }));
    group.stopped = false;
    reposGroupOpen[`${group.host}::${group.label}`] = true;
  }
  renderReposTree();
}

function syncAllRepoCheckboxes() {
  el("repos-tree")?.querySelectorAll(".repo-checkbox").forEach((cb) => {
    cb.checked = checkedRepos.has(cb.dataset.path);
  });
}

function syncRepoCheckboxesFromSession(s) {
  // Initialize checkedRepos from the session's additionalDirectories
  checkedRepos.clear();
  for (const d of (s.additionalDirectories || [])) {
    checkedRepos.add(d.replace(/\\/g, "/"));
  }
  syncAllRepoCheckboxes();
}

async function applyCheckedReposToSession() {
  if (!selectedId) { alert("Select a session first."); return; }
  const s = latest?.sessions?.find((x) => x.id === selectedId);
  if (!s) return;
  // Keep existing dirs (preserving their read/write access) + add checked repos as read-only.
  const access = s.directoryAccess || {};
  const existing = new Set((s.additionalDirectories || []).map((d) => d.replace(/\\/g, "/")));
  const toAdd = [...checkedRepos].filter((p) => !existing.has(p));
  const dirs = [
    ...(s.additionalDirectories || []).map((p) => ({ path: p, access: access[p] === "write" ? "write" : "read" })),
    ...toAdd.map((p) => ({ path: p, access: "read" })),
  ];
  await api(`/api/sessions/${s.id}/set-directories`, { directories: dirs });
  lastControlsSig = "";
}

// ─── Directories panel ─────────────────────────────────────────────────────────
// Local working copy so in-progress edits survive periodic re-renders; re-seeded when the
// selected session changes.
let dirPanel = { sid: null, dirs: [], cwd: "" };
let dirTreeOpen = {};        // per-group expand state for the dir-panel repo trees
let dirCwdTreeShown = false; // working-dir browse tree expanded?
let dirAddTreeShown = false; // add-dir browse tree expanded?

function seedDirPanel(s) {
  const access = s.directoryAccess || {};
  dirPanel = {
    sid: s.id,
    cwd: s.cwd || "",
    dirs: (s.additionalDirectories || []).map((p) => ({ path: p, access: access[p] === "write" ? "write" : "read" })),
  };
  dirCwdTreeShown = false;
  dirAddTreeShown = false;
}

// Called on panel-open and on every fleet update. To avoid clobbering in-progress typing/trees, only
// (re)build the skeleton when the session changes or it hasn't been built; edits re-render granularly.
function renderDirectoriesPanel() {
  const host = el("dir-panel-body");
  if (!host) return;
  const s = latest?.sessions?.find((x) => x.id === selectedId);
  if (!s) {
    dirPanel = { sid: null, dirs: [], cwd: "" };
    host.innerHTML = `<div class="rp-hint">Select a session to manage its working directory and extra folders.</div>`;
    return;
  }
  if (dirPanel.sid !== s.id) { seedDirPanel(s); buildDirPanel(s); return; }
  if (!host.querySelector(".dir-section")) buildDirPanel(s);  // first build for this session
}

function buildDirPanel(s) {
  const host = el("dir-panel-body");
  if (!host) return;
  const wslLike = s.host === "wsl";
  host.innerHTML = `
    <div class="dir-section">
      <div class="dir-label">Working directory</div>
      <div class="dir-cwd-row">
        <input id="dir-cwd" value="${escapeHtml(dirPanel.cwd)}" placeholder="${wslLike ? "/home/user/app" : "E:/GitHub/app"}" />
        <button id="dir-cwd-browse" class="btn-secondary" title="Pick from repositories">📁</button>
        <button id="dir-cwd-apply" class="btn-secondary">Change</button>
      </div>
      <div id="dir-cwd-tree" class="dir-tree${dirCwdTreeShown ? "" : " hidden"}"></div>
      <div class="dir-hint">Switches the working dir live and tells Claude to work there — the conversation is kept.</div>
    </div>
    <div class="dir-section">
      <div class="dir-label">Additional directories <span class="muted">(<span id="dir-count">${dirPanel.dirs.length}</span>)</span></div>
      <div class="dir-list" id="dir-list"></div>
      <button id="dir-add-browse" class="dir-browse-btn">📁 Add from repositories ${dirAddTreeShown ? "▲" : "▼"}</button>
      <div id="dir-add-tree" class="dir-tree${dirAddTreeShown ? "" : " hidden"}"></div>
      <div class="dir-add-row">
        <input id="dir-add-input" placeholder="${wslLike ? "/home/user/other-repo" : "or type a path…"}" />
        <button id="dir-add-btn" class="btn-secondary">+ Add</button>
      </div>
      <button id="dir-update" class="dir-update-btn">Update &amp; tell Claude</button>
      <div class="dir-hint">Added folders are <b>read-only</b> by default — toggle <b>write</b> to allow edits. Read-only is enforced (edits blocked) and Claude is told the policy.</div>
    </div>`;

  renderDirList();
  if (dirCwdTreeShown) renderDirTree("dir-cwd-tree", "cwd");
  if (dirAddTreeShown) renderDirTree("dir-add-tree", "add");

  el("dir-cwd-apply")?.addEventListener("click", changeSessionCwd);
  el("dir-update")?.addEventListener("click", updateDirectories);
  el("dir-cwd-browse")?.addEventListener("click", () => {
    dirCwdTreeShown = !dirCwdTreeShown;
    el("dir-cwd-tree").classList.toggle("hidden", !dirCwdTreeShown);
    if (dirCwdTreeShown) renderDirTree("dir-cwd-tree", "cwd");
  });
  el("dir-add-browse")?.addEventListener("click", () => {
    dirAddTreeShown = !dirAddTreeShown;
    const t = el("dir-add-tree"); t.classList.toggle("hidden", !dirAddTreeShown);
    el("dir-add-browse").textContent = `📁 Add from repositories ${dirAddTreeShown ? "▲" : "▼"}`;
    if (dirAddTreeShown) renderDirTree("dir-add-tree", "add");
  });
  el("dir-add-btn")?.addEventListener("click", () => {
    const inp = el("dir-add-input");
    const p = (inp?.value || "").trim();
    if (!p) return;
    if (!dirPanel.dirs.some((d) => d.path === p)) dirPanel.dirs.push({ path: p, access: "read" });
    if (inp) inp.value = "";
    renderDirList();
    if (dirAddTreeShown) renderDirTree("dir-add-tree", "add");
  });
}

// Re-render only the list of chosen directories (toggles + remove), not the whole panel.
function renderDirList() {
  const list = el("dir-list");
  if (!list) return;
  list.innerHTML = dirPanel.dirs.length ? dirPanel.dirs.map((d, i) => {
    const isWrite = d.access !== "read";
    return `<div class="dir-item">
      <label class="dir-acc ${isWrite ? "write" : "read"}" title="Toggle read-only / write">
        <input type="checkbox" class="dir-write" data-i="${i}"${isWrite ? " checked" : ""}/>
        <span>${isWrite ? "write" : "read-only"}</span>
      </label>
      <span class="dir-path" title="${escapeHtml(d.path)}">${escapeHtml(d.path)}</span>
      <button class="dir-remove" data-i="${i}" title="Remove">✕</button>
    </div>`;
  }).join("") : '<div class="dir-hint">No extra directories yet — pick from the tree below or type a path.</div>';
  const cnt = el("dir-count"); if (cnt) cnt.textContent = dirPanel.dirs.length;
  list.querySelectorAll(".dir-write").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = +cb.dataset.i;
      if (dirPanel.dirs[i]) dirPanel.dirs[i].access = cb.checked ? "write" : "read";
      renderDirList();
    });
  });
  list.querySelectorAll(".dir-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      dirPanel.dirs.splice(+btn.dataset.i, 1);
      renderDirList();
      if (dirAddTreeShown) renderDirTree("dir-add-tree", "add");
    });
  });
}

// Build the collapsible repo tree (same data as the Repositories panel). `checkedSet` (a Set of
// already-chosen paths) shows checkboxes for the multi-select "add" tree; null = single-pick "cwd".
function repoGroupsTreeHtml(checkedSet) {
  const groups = reposData?.groups || [];
  if (!groups.length) return '<div class="dir-hint">No repositories found. Check repos.localRoots in config, or type a path.</div>';
  let html = "";
  for (const group of groups) {
    const key = `${group.host}::${group.label}`;
    const isOpen = dirTreeOpen[key] !== false;
    html += `<div class="dirtree-group" data-key="${escapeHtml(key)}">
      <span class="tree-expand-icon${isOpen ? " open" : ""}">▶</span>
      ${group.host === "wsl" ? "🐧" : "💻"} ${escapeHtml(group.label)}
      ${group.stopped ? '<span class="repo-stopped-tag">stopped</span>' : `<span class="muted" style="font-size:10px;margin-left:4px">(${group.repos.length})</span>`}
    </div>
    <div class="dirtree-children${isOpen ? "" : " collapsed"}">`;
    if (group.stopped) {
      html += `<button class="repos-load-btn" data-load-distro="${escapeHtml(group.distro)}">▸ Start distro &amp; list repos</button>`;
    }
    for (const repo of group.repos) {
      const picked = checkedSet && checkedSet.has(repo.path);
      html += `<div class="dirtree-item${picked ? " picked" : ""}" data-path="${escapeHtml(repo.path)}" title="${escapeHtml(repo.path)}">
        <span class="dirtree-check">${checkedSet ? (picked ? "☑" : "☐") : "▸"}</span>
        <span class="repo-name">${escapeHtml(repo.name)}</span>
        ${repo.branch ? `<span class="repo-branch">${escapeHtml(repo.branch)}</span>` : ""}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function renderDirTree(containerId, mode) {
  const c = el(containerId);
  if (!c) return;
  if (!reposData) {
    // loadRepos() re-renders open dir trees once data arrives (see loadRepos), so just kick it off.
    c.innerHTML = '<div class="dir-hint">Loading repositories…</div>';
    if (!reposLoading) loadRepos();
    return;
  }
  const checkedSet = mode === "add" ? new Set(dirPanel.dirs.map((d) => d.path)) : null;
  c.innerHTML = repoGroupsTreeHtml(checkedSet);
  c.querySelectorAll(".dirtree-group").forEach((hdr) => {
    hdr.addEventListener("click", (e) => {
      if (e.target.closest(".repos-load-btn")) return;
      const key = hdr.dataset.key;
      dirTreeOpen[key] = dirTreeOpen[key] === false; // flip (default open)
      renderDirTree(containerId, mode);
    });
  });
  c.querySelectorAll(".repos-load-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadStoppedDistroRepos(btn.dataset.loadDistro, btn).then(() => renderDirTree(containerId, mode));
    });
  });
  c.querySelectorAll(".dirtree-item").forEach((item) => {
    item.addEventListener("click", () => {
      const p = item.dataset.path;
      if (mode === "cwd") {
        const inp = el("dir-cwd"); if (inp) inp.value = p;
        dirPanel.cwd = p;
        dirCwdTreeShown = false;
        c.classList.add("hidden");
      } else {
        const idx = dirPanel.dirs.findIndex((d) => d.path === p);
        if (idx === -1) dirPanel.dirs.push({ path: p, access: "read" }); else dirPanel.dirs.splice(idx, 1);
        renderDirList();
        renderDirTree(containerId, mode); // refresh checkmarks
      }
    });
  });
}

async function updateDirectories() {
  if (!selectedId) { alert("Select a session first."); return; }
  // Persist the working copy so a refresh mid-request doesn't reset the field.
  const cwdInput = el("dir-cwd"); if (cwdInput) dirPanel.cwd = cwdInput.value.trim();
  const btn = el("dir-update");
  if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  const r = await api(`/api/sessions/${selectedId}/set-directories`, {
    directories: dirPanel.dirs.map((d) => ({ path: d.path, access: d.access })),
    inject: true,
  });
  if (btn) { btn.disabled = false; btn.textContent = "Update & tell Claude"; }
  if (!r?.ok) alert("Failed to update directories (is the session runner alive?).");
  lastControlsSig = "";
}

async function changeSessionCwd() {
  if (!selectedId) { alert("Select a session first."); return; }
  const newCwd = (el("dir-cwd")?.value || "").trim();
  if (!newCwd) { alert("Enter a working directory."); return; }
  dirPanel.cwd = newCwd;
  const btn = el("dir-cwd-apply");
  if (btn) { btn.disabled = true; btn.textContent = "Switching…"; }
  const r = await api(`/api/sessions/${selectedId}/set-cwd`, { cwd: newCwd });
  if (btn) { btn.disabled = false; btn.textContent = "Change"; }
  if (!r?.ok) { alert("Failed to change working directory (is the session runner alive?)."); return; }
  dirPanel.sid = null; // re-seed from server so the new dir shows in the list
}

// ─── Usage view ────────────────────────────────────────────────────────────────
function renderUsageView() {
  const u = latest?.usage;
  if (!u) return;
  const accountEl = el("uso-account");
  const totals = u.totals || {};
  const windows = (u.windows || []).sort((a, b) => {
    const ORDER = ["five_hour","seven_day","seven_day_opus","seven_day_sonnet"];
    return (ORDER.indexOf(a.type) + 99) - (ORDER.indexOf(b.type) + 99);
  });
  const WINDOW_LABELS = {
    five_hour: "Current 5h session",
    seven_day: "Weekly (all models)",
    seven_day_opus: "Weekly (Opus)",
    seven_day_sonnet: "Weekly (Sonnet)",
    day_requests: "Today (requests)",
    week_requests: "This week (requests)",
  };
  const fmtTok = (n) => {
    n = n || 0;
    if (n >= 1e6) return (n/1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n/1e3).toFixed(1) + "k";
    return String(n);
  };
  let html = `<div class="uso-kpis">
    <div class="uso-kpi"><div class="uso-kpi-label">Cost this run</div><div class="uso-kpi-value">$${(totals.costUsd||0).toFixed(4)}</div></div>
    <div class="uso-kpi"><div class="uso-kpi-label">Input tokens</div><div class="uso-kpi-value">${fmtTok(totals.inputTokens)}</div></div>
    <div class="uso-kpi"><div class="uso-kpi-label">Output tokens</div><div class="uso-kpi-value">${fmtTok(totals.outputTokens)}</div></div>
    <div class="uso-kpi"><div class="uso-kpi-label">Cached tokens</div><div class="uso-kpi-value">${fmtTok(totals.cacheReadTokens)}</div></div>
  </div>`;
  for (const w of windows) {
    const pct = typeof w.utilization === "number" ? Math.max(0, Math.min(100, w.utilization)) : null;
    const label = WINDOW_LABELS[w.type] || w.type.replace(/_/g," ");
    html += `<div class="uso-kpi"><div class="uso-kpi-label">${escapeHtml(label)}</div>
      ${pct !== null ? `<div class="uso-kpi-value">${pct.toFixed(0)}%</div><div style="background:#3c3c3c;border-radius:3px;height:4px;margin-top:4px"><div style="background:${pct>90?"#f87171":pct>70?"#fbbf24":"#4ade80"};width:${pct}%;height:100%;border-radius:3px"></div></div>` : `<div class="uso-kpi-value">${(w.requestCount||0).toLocaleString()} req</div>`}
      ${w.resetAt ? `<div class="uso-kpi-sub">resets ${fmtCountdown(w.resetAt)}</div>` : ""}
    </div>`;
  }
  accountEl.innerHTML = html;

  const sessionsEl2 = el("uso-sessions");
  html = `<div class="uso-kpis">` + (latest?.sessions || []).map((s) => {
    const r = s.lastResult || {};
    const tu = r.usage || {};
    if (!r.cost && !tu.input_tokens) return "";
    return `<div class="uso-kpi"><div class="uso-kpi-label">${escapeHtml(s.label)}</div>
      <div class="uso-kpi-value">$${(r.cost||0).toFixed(4)}</div>
      <div class="uso-kpi-sub">${fmtTok(tu.input_tokens)} in · ${fmtTok(tu.output_tokens)} out</div>
    </div>`;
  }).filter(Boolean).join("") + `</div>`;
  sessionsEl2.innerHTML = html;
}

// ─── New session modal ─────────────────────────────────────────────────────────
// Show/hide the host-specific rows and populate the matching Repository list. Shared by the
// host <select> change handler AND programmatic opens (so every entry point sets up identically).
function applyHostSelection() {
  const host     = el("f-host").value;
  const isWsl    = host === "wsl";
  const isHyperV = host === "hyperv";
  el("f-distro-row").classList.toggle("hidden", !isWsl);
  el("f-hyperv-row").style.display = isHyperV ? "" : "none";
  el("f-repos-row").classList.remove("hidden");
  el("vm-browser").classList.add("hidden");
  showHypervError("");
  // Repository picker: VM repos for Hyper-V, the selected distro's repos for WSL,
  // the local list otherwise.
  if (isHyperV)     populateHypervRepos();
  else if (isWsl)   populateWslRepos(el("f-distro").value);
  else              populateNewSessionRepos();
  const browseBtn = el("btn-browse-cwd");
  if (browseBtn) browseBtn.style.display = (isWsl || isHyperV) ? "" : "none";
}

/**
 * Open the New Session modal. `prefill` lets a caller (e.g. a VM/distro card) pre-select the
 * host, distro or Hyper-V VM and seed the label; without it the modal opens for the default host.
 */
function openNewSessionModal(prefill = {}) {
  // Reset fields so a prior open never leaks state into this one.
  el("f-label").value  = prefill.label || "";
  el("f-cwd").value    = "";
  el("f-prompt").value = "";
  el("f-host").value   = prefill.host || lastSettings?.["session.defaultHost"] || "local";
  // Seed extra dirs from checked repos only on a plain open (not when prefilling from a VM card).
  el("f-extra-dirs").value = prefill.host ? "" : [...checkedRepos].join("\n");

  populateNewSessionDistros().then(() => {
    if (prefill.distro && el("f-distro")) {
      if ([...el("f-distro").options].some((o) => o.value === prefill.distro)) el("f-distro").value = prefill.distro;
    }
    // Load repos for the now-selected distro (prefilled or the default first option).
    if (el("f-host").value === "wsl") populateWslRepos(el("f-distro").value);
  });
  populateHypervVMs().then(() => {
    if (prefill.vmName && el("f-hyperv-vm")) {
      if ([...el("f-hyperv-vm").options].some((o) => o.value === prefill.vmName)) el("f-hyperv-vm").value = prefill.vmName;
      if (el("f-host").value === "hyperv") populateHypervRepos();
    }
  });
  applyHostSelection();              // shows correct rows + populates the repo dropdown
  el("vm-browser").classList.add("hidden");
  el("new-modal").classList.remove("hidden");
}

async function populateHypervVMs({ refresh = false } = {}) {
  const sel = el("f-hyperv-vm");
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading VMs…</option>';
  // Use cached vmData if available, otherwise fetch fresh (refresh forces a rescan)
  if (refresh) vmData = null;
  const vms = vmData || (window.fleetApp?.getVMs ? await window.fleetApp.getVMs() : []);
  if (!vmData && vms.length) vmData = vms;
  const hvVMs = vms.filter((v) => v.type === "Hyper-V" && !v._error);
  sel.innerHTML = "";
  if (!hvVMs.length) {
    sel.innerHTML = '<option value="">No Hyper-V VMs found</option>';
    return;
  }
  for (const vm of hvVMs) {
    const opt = document.createElement("option");
    opt.value = vm.name;
    opt.textContent = `${vm.name} (${vm.state})`;
    opt.dataset.state = vm.state;
    sel.appendChild(opt);
  }
  // Auto-load repos for the first (selected) VM so the picker is populated on open.
  if (el("f-host")?.value === "hyperv") populateHypervRepos();
}

/** Credentials typed into the Hyper-V section (in-memory only, never persisted). */
function getHypervCreds() {
  return { user: el("f-hv-user")?.value.trim() || "", pass: el("f-hv-pass")?.value || "" };
}
function showHypervError(msg) {
  const e = el("f-hyperv-error");
  if (!e) return;
  e.textContent = msg;
  e.style.display = msg ? "" : "none";
}

/** Discover and list git repos inside the selected Hyper-V VM (OS-detected on the guest). */
async function populateHypervRepos() {
  const sel = el("f-repos");
  if (!sel) return;
  const vmName = el("f-hyperv-vm")?.value;
  el("f-repos-row").classList.remove("hidden");
  if (!vmName) { sel.innerHTML = '<option value="">— select a VM first —</option>'; return; }
  showHypervError("");
  sel.innerHTML = `<option value="">Scanning ${vmName} for repos…</option>`;
  sel.disabled = true;

  let res = null;
  try {
    res = window.fleetApp?.listVMRepos
      ? await window.fleetApp.listVMRepos({ vmType: "Hyper-V", vmName, ...getHypervCreds() })
      : { error: "VM bridge unavailable" };
  } catch (e) { res = { error: String(e?.message || e) }; }
  sel.disabled = false;

  if (res?.error) {
    showHypervError(res.error);
    sel.innerHTML = '<option value="">— no repos (see message above) —</option>';
    return;
  }
  const repos = res?.repos || [];
  const osLabel = res?.os ? ` (${res.os} guest)` : "";
  sel.innerHTML = `<option value="">— choose repo${osLabel} —</option>`;
  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = r.path;
    const meta = r.branch ? `  · ${r.branch}${r.changes ? ` (${r.changes}±)` : ""}` : "";
    opt.textContent = `${r.name}${meta}`;
    sel.appendChild(opt);
  }
  if (!repos.length) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.textContent = "No git repos found in configured roots (edit vm.repoRoots in Settings)";
    sel.appendChild(opt);
  }
}

async function populateNewSessionDistros() {
  const data = wslData || (await getJson("/api/wsl/distros"));
  const sel = el("f-distro");
  sel.innerHTML = "";
  for (const d of data?.distros || []) {
    const opt = document.createElement("option");
    opt.value = d.name; opt.textContent = d.name;
    sel.appendChild(opt);
  }
}

async function populateNewSessionRepos() {
  const rData = reposData || (await getJson("/api/repos"));
  const sel = el("f-repos");
  sel.innerHTML = '<option value="">— choose repo —</option>';
  for (const group of rData?.groups || []) {
    for (const repo of group.repos) {
      const opt = document.createElement("option");
      opt.value = repo.path; opt.textContent = repo.name + (group.host === "wsl" ? ` (${group.label})` : "");
      sel.appendChild(opt);
    }
  }
  if (sel.options.length > 1) el("f-repos-row").classList.remove("hidden");
}

/**
 * Repos for a specific WSL distro. Uses /api/wsl/repos which runs `wsl -d <distro>` and so
 * lists repos even for a STOPPED distro (the call auto-starts it) — unlike /api/repos, which
 * the orchestrator builds only from already-running distros.
 */
async function populateWslRepos(distro) {
  const sel = el("f-repos");
  if (!sel) return;
  el("f-repos-row").classList.remove("hidden");
  if (!distro) { sel.innerHTML = '<option value="">— select a distro —</option>'; return; }
  sel.innerHTML = `<option value="">Scanning ${escapeHtml(distro)} for repos…</option>`;
  sel.disabled = true;
  const data = await getJson(`/api/wsl/repos?distro=${encodeURIComponent(distro)}`);
  sel.disabled = false;
  // Guard against a stale response if the user changed distro while this was in flight.
  if (el("f-host").value !== "wsl" || el("f-distro").value !== distro) return;
  const repos = (data?.repos || []).slice().sort();
  sel.innerHTML = '<option value="">— choose repo —</option>';
  for (const p of repos) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = `${p.split("/").filter(Boolean).pop() || p}  (${distro})`;
    sel.appendChild(opt);
  }
  if (!repos.length) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.textContent = "No git repos found in this distro";
    sel.appendChild(opt);
  }
}

// ─── VM folder browser ────────────────────────────────────────────────────────
let vmBrowserState = { path: "/", vmType: null, vmName: null, targetField: "cwd" };

function getVMHostInfo() {
  const host = el("f-host")?.value;
  if (host === "wsl")   return { vmType: "WSL",    vmName: el("f-distro")?.value };
  if (host === "hyperv") return { vmType: "Hyper-V", vmName: el("f-hyperv-vm")?.value };
  return null;
}

async function openVMBrowser(targetField = "cwd") {
  const info = getVMHostInfo();
  if (!info?.vmName) { alert("Select a VM/distro first."); return; }
  vmBrowserState.vmType      = info.vmType;
  vmBrowserState.vmName      = info.vmName;
  vmBrowserState.targetField = targetField;
  // Use current cwd as starting path if set, else default
  const cur = el("f-cwd")?.value.trim();
  vmBrowserState.path = cur || (info.vmType === "WSL" ? "/home" : "C:\\");
  el("vm-browser").classList.remove("hidden");
  el("vm-browser-target").textContent = targetField === "cwd" ? "(working dir)" : "(extra repo)";
  await loadVMBrowserDir(vmBrowserState.path);
}

async function loadVMBrowserDir(dirPath) {
  const listEl = el("vm-browser-list");
  listEl.innerHTML = '<div class="vm-browser-loading">Loading…</div>';
  el("vm-browser-path").textContent = dirPath;
  vmBrowserState.path = dirPath;

  let dirs = [];
  try {
    if (window.fleetApp?.listVMDirs) {
      dirs = await window.fleetApp.listVMDirs({
        vmType: vmBrowserState.vmType,
        vmName: vmBrowserState.vmName,
        dirPath,
        ...(vmBrowserState.vmType === "Hyper-V" ? getHypervCreds() : {}),
      });
    }
  } catch (e) { /* ignore */ }

  if (!dirs.length) {
    listEl.innerHTML = '<div class="vm-browser-empty">No subdirectories found (or access denied)</div>';
    return;
  }

  listEl.innerHTML = dirs.map((d) =>
    `<div class="vm-browser-item" data-path="${escapeHtml(d.path)}" data-name="${escapeHtml(d.name)}">
      📁 ${escapeHtml(d.name)}
    </div>`
  ).join("");

  listEl.querySelectorAll(".vm-browser-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      // Single click selects, double-click navigates into
      listEl.querySelectorAll(".vm-browser-item").forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");
      if (e.detail === 2) loadVMBrowserDir(item.dataset.path);
    });
  });
}

function vmBrowserUp() {
  const p = vmBrowserState.path;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(/[\\/]/).filter(Boolean);
  parts.pop();
  const parent = parts.length
    ? (sep === "\\" ? parts.join("\\") + "\\" : "/" + parts.join("/"))
    : (sep === "\\" ? "C:\\" : "/");
  loadVMBrowserDir(parent);
}

function vmBrowserApply(addAsRepo = false) {
  const selected = el("vm-browser-list")?.querySelector(".vm-browser-item.selected");
  const chosenPath = selected ? selected.dataset.path : vmBrowserState.path;
  if (addAsRepo) {
    const ta = el("f-extra-dirs");
    const existing = ta.value.trim();
    ta.value = existing ? existing + "\n" + chosenPath : chosenPath;
  } else {
    el("f-cwd").value = chosenPath;
  }
  el("vm-browser").classList.add("hidden");
}

async function createNewSession() {
  const host   = el("f-host").value;
  const distro = host === "wsl"    ? el("f-distro").value    : "";
  const hvVM   = host === "hyperv" ? el("f-hyperv-vm").value : "";
  const repoSel = el("f-repos").value;
  let cwd = el("f-cwd").value.trim();
  if (!cwd && repoSel) cwd = repoSel;
  if (!cwd) { alert("Working directory is required."); return; }
  // A WSL session's cwd must be a Linux path inside the distro; a leftover Windows path
  // (e.g. E:/GitHub/app) would make the runner chdir to a path that doesn't exist in the guest.
  if (host === "wsl" && /^[A-Za-z]:[\\/]/.test(cwd)) {
    alert("This is a Windows path, but the host is WSL. Pick a repo from the dropdown or enter a Linux path (e.g. /home/user/app).");
    return;
  }

  const realHost  = host === "hyperv" ? "local" : host; // hyperv sessions run as local+SSH later
  const realLabel = hvVM ? `[${hvVM}] ${el("f-label").value.trim() || cwd.split(/[\\/]/).pop()}`
                         : (el("f-label").value.trim() || cwd.split(/[\\/]/).pop());
  const extraDirs = el("f-extra-dirs").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const spec = {
    label:                realLabel,
    host:                 realHost,
    distro,
    cwd,
    additionalDirectories: extraDirs,
    model:                el("f-model").value.trim(),
    mode:                 el("f-mode").value,
    effort:               el("f-effort").value,
    thinking:             el("f-thinking").value,
    browser:              el("f-browser").checked,
    toolServer:           !!(latest?.toolServer?.enabled),
    autoContinue:         el("f-autocontinue").checked,
    initialPrompt:        el("f-prompt").value.trim(),
  };
  el("new-modal").classList.add("hidden");
  const r = await api("/api/sessions", spec);
  if (r?.ok && r.id) {
    openSection("sessions");
    setTimeout(() => selectSession(r.id), 300);
  } else {
    alert("Failed to create session.");
  }
}

// ─── Instructions modal ────────────────────────────────────────────────────────
async function openInstructions(id) {
  currentInstrSession = id;
  el("instr-modal").classList.remove("hidden");
  await refreshInstructions();
}
async function refreshInstructions() {
  if (!currentInstrSession) return;
  const data = await getJson(`/api/sessions/${currentInstrSession}/instructions`);
  el("instr-folder").textContent = data?.instructionsDir || "—";
  const listEl = el("instr-list");
  listEl.innerHTML = "";
  const files = data?.files || [];
  if (!files.length) { listEl.innerHTML = '<div class="instr-empty">No .md files yet.</div>'; return; }
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "instr-file";
    row.innerHTML = `<span class="instr-file-name">${escapeHtml(f.name)}</span>
      <span class="instr-file-size">${(f.size/1024).toFixed(1)}kB</span>
      <button class="instr-file-del" data-name="${escapeHtml(f.name)}">✕</button>`;
    listEl.appendChild(row);
  }
  listEl.querySelectorAll(".instr-file-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/sessions/${currentInstrSession}/instructions/delete`, { filename: btn.dataset.name });
      refreshInstructions();
    });
  });
}

// ─── Sidebar resize (horizontal width) ────────────────────────────────────────
function setupSidebarResize() {
  const sidebar = el("sidebar");
  const handle  = el("sidebar-resize");
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(600, startW + (e.clientX - startX)));
    sidebar.style.width = w + "px";
    localStorage.setItem("sidebarWidth", w);
  });
  document.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; handle.classList.remove("dragging"); document.body.style.cursor = ""; }
  });
}

// ─── Vertical pane resize (within left sidebar) ────────────────────────────────
function setupVerticalResize(handle, topPane, bottomPane) {
  if (!handle || !topPane || !bottomPane) return;
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true; startY = e.clientY; startH = topPane.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const h = Math.max(60, startH + (e.clientY - startY));
    topPane.style.height = h + "px";
    topPane.style.flex = "none";
  });
  document.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; handle.classList.remove("dragging"); document.body.style.cursor = ""; }
  });
}

// ─── Composer ─────────────────────────────────────────────────────────────────
function setupComposer() {
  const form  = el("composer");
  const input = el("composer-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitMessage(); }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); submitMessage(); });
}
async function submitMessage() {
  const input = el("composer-input");
  const text  = input.value.trim();
  if (!text || !selectedId) return;
  input.value = "";
  await api(`/api/sessions/${selectedId}/message`, { text });
}

// ─── Window controls ──────────────────────────────────────────────────────────
function setupWindowControls() {
  if (!window.fleetApp) return;
  el("btn-minimize").addEventListener("click", () => window.fleetApp.minimize());
  el("btn-maximize").addEventListener("click", () => window.fleetApp.maximize());
  el("btn-close").addEventListener("click",    () => window.fleetApp.close());
  window.fleetApp.onMaximizedChange((max) => {
    const btn = el("btn-maximize");
    btn.title = max ? "Restore" : "Maximize";
    btn.querySelector("svg").innerHTML = max
      ? `<rect x=".5" y=".5" width="9" height="9" stroke="currentColor" fill="none"/><rect x="2" y="2" width="9" height="9" stroke="currentColor" fill="none" style="transform:translate(-1px,-1px)"/>`
      : `<rect x=".5" y=".5" width="9" height="9" stroke="currentColor" fill="none"/>`;
  });
}

// ─── Periodic refresh ─────────────────────────────────────────────────────────
function setupPeriodicRefresh() {
  // Repos: every 30 s
  setInterval(loadRepos, 30000);
  // VM/WSL state (running/stopped) while the panel is open AND the window is visible: every
  // 30 s. get-vms is a heavy multi-process scan, so we skip it when the window is hidden/
  // minimised (no point polling what nobody's looking at). loadAndRenderVMs keeps the current
  // list on screen while it re-fetches, so this never flashes. Also revalidate immediately when
  // the window becomes visible again with the panel open.
  setInterval(() => {
    if (document.hidden) return;
    if (activeRightPanel === "vms" || activeRightPanel === "wsl") loadAndRenderVMs();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (activeRightPanel === "vms" || activeRightPanel === "wsl")) loadAndRenderVMs();
  });
  // Tick countdowns every second (activity bar + status bar 5h reset)
  setInterval(() => {
    if (!latest) return;
    if (latest.account?.resetAt) {
      el("account-countdown").textContent = fmtCountdown(latest.account.resetAt);
    }
    // Re-render status bar so the 5h countdown ticks live
    renderStatusBar();
  }, 1000);
}

// ─── Wire all static event listeners ─────────────────────────────────────────
// ─── Chat role filter + message search ────────────────────────────────────────
let activeChatRole = "all";
let chatSearchText = "";

function applyChatFilter() {
  const msgs = qsa(".msg", el("messages"));
  msgs.forEach((div) => {
    const role = div.dataset.role || "system";
    const matchRole = activeChatRole === "all" || role === activeChatRole;
    const text = div.textContent || "";
    const matchSearch = !chatSearchText || text.toLowerCase().includes(chatSearchText.toLowerCase());
    div.classList.toggle("role-hidden", !matchRole || !matchSearch);
  });
  // Update search result count
  const visible = qsa(".msg:not(.role-hidden)", el("messages")).length;
  const countEl = el("chat-search-count");
  if (countEl && chatSearchText) countEl.textContent = `${visible} result${visible !== 1 ? "s" : ""}`;
  else if (countEl) countEl.textContent = "";
}

function wireStaticListeners() {
  // Chat role filter tabs
  qsa(".chat-filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      qsa(".chat-filter-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeChatRole = tab.dataset.role || "all";
      applyChatFilter();
    });
  });
  // Chat search toggle
  const searchToggle = el("btn-chat-search");
  const searchBar    = el("chat-search-bar");
  const searchInput  = el("chat-search-input");
  const searchClose  = el("btn-chat-search-close");
  if (searchToggle && searchBar) {
    searchToggle.addEventListener("click", () => {
      searchBar.classList.toggle("hidden");
      if (!searchBar.classList.contains("hidden")) searchInput?.focus();
    });
  }
  if (searchClose && searchBar) {
    searchClose.addEventListener("click", () => {
      searchBar.classList.add("hidden");
      chatSearchText = "";
      if (searchInput) searchInput.value = "";
      applyChatFilter();
    });
  }
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      chatSearchText = searchInput.value;
      applyChatFilter();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { searchBar.classList.add("hidden"); chatSearchText = ""; searchInput.value = ""; applyChatFilter(); }
    });
  }

  // Accordion section headers (no longer exist — no-op)
  // Right activity bar icons
  qsa(".rab-icon").forEach((btn) => {
    btn.addEventListener("click", () => switchRightPanel(btn.dataset.rpanel));
  });

  // Usage sub-tabs
  qsa(".rp-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchUsageTab(tab.dataset.utab));
  });

  // Editor tabs (chat only)
  qsa(".editor-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      qsa(".editor-tab").forEach((t) => t.classList.toggle("active", t === tab));
    });
  });

  // Usage right panel toggle — no longer needed (always visible in right sidebar)
  // but keep btn-toggle-usage wired to switchRightPanel for the RAB icon
  el("btn-refresh-vms")?.addEventListener("click", () => { vmData = null; loadAndRenderVMs(); });
  el("btn-refresh-wsl")?.addEventListener("click", () => { vmData = null; loadAndRenderVMs(); });

  // New session button
  el("btn-new-session").addEventListener("click", () => openNewSessionModal());

  // Settings editor
  el("btn-settings")?.addEventListener("click", openSettingsModal);
  el("settings-cancel")?.addEventListener("click", () => el("settings-modal").classList.add("hidden"));
  el("settings-save")?.addEventListener("click", saveSettingsFromEditor);

  // Set reset time
  el("btn-set-reset").addEventListener("click", () => {
    const now = new Date(Date.now() + 5*3600*1000);
    el("reset-time").value = now.toISOString().slice(0,16);
    el("reset-modal").classList.remove("hidden");
  });

  // New session modal
  el("f-cancel").addEventListener("click", () => {
    el("new-modal").classList.add("hidden");
    el("vm-browser").classList.add("hidden");
  });
  el("f-create").addEventListener("click", createNewSession);
  el("f-host").addEventListener("change", () => {
    applyHostSelection();
  });
  // Re-scan repos when the selected WSL distro or Hyper-V VM changes
  el("f-distro")?.addEventListener("change", () => populateWslRepos(el("f-distro").value));
  el("f-hyperv-vm")?.addEventListener("change", () => populateHypervRepos());
  // Manual VM rescan
  el("btn-refresh-hv-vms")?.addEventListener("click", () => populateHypervVMs({ refresh: true }));
  // Picking a repo fills the working directory
  el("f-repos")?.addEventListener("change", (e) => {
    if (e.target.value) el("f-cwd").value = e.target.value;
  });

  // VM folder browser buttons
  el("btn-browse-cwd")?.addEventListener("click", () => openVMBrowser("cwd"));
  el("vm-browser-up")?.addEventListener("click",  vmBrowserUp);
  el("vm-browser-cancel")?.addEventListener("click",   () => el("vm-browser").classList.add("hidden"));
  el("vm-browser-select")?.addEventListener("click",   () => vmBrowserApply(false));
  el("vm-browser-add-repo")?.addEventListener("click", () => vmBrowserApply(true));
  // Hide Browse button initially (only local host selected by default)
  el("btn-browse-cwd")?.style && (el("btn-browse-cwd").style.display = "none");

  // Approval modal
  el("appr-allow").addEventListener("click", () => resolveApproval("allow"));
  el("appr-deny").addEventListener("click",  () => resolveApproval("deny"));

  // Instructions modal
  el("instr-close").addEventListener("click", () => { el("instr-modal").classList.add("hidden"); currentInstrSession = null; });
  el("instr-read").addEventListener("click",  async () => {
    if (!currentInstrSession) return;
    await api(`/api/sessions/${currentInstrSession}/read-instructions`, {});
    el("instr-modal").classList.add("hidden");
  });
  el("instr-save").addEventListener("click", async () => {
    const name    = el("instr-name").value.trim();
    const content = el("instr-content").value;
    if (!name || !currentInstrSession) return;
    await api(`/api/sessions/${currentInstrSession}/instructions`, { filename: name, content });
    el("instr-name").value = ""; el("instr-content").value = "";
    refreshInstructions();
  });

  // History modal
  el("hist-modal-close").addEventListener("click", () => el("history-modal").classList.add("hidden"));
  el("hist-modal-resume").addEventListener("click", async () => {
    if (!histModalRel) return;
    const r = await api("/api/history/resume", { rel: histModalRel });
    el("history-modal").classList.add("hidden");
    if (r?.ok && r.id) {
      // Fetch fresh fleet state so the new session is in latest.sessions immediately
      const state = await getJson("/api/state");
      if (state) { latest = state; renderFleet(); }
      openSection("sessions");
      selectSession(r.id);
    } else alert("Could not resume session.");
  });

  // History filter
  el("history-filter").addEventListener("input", (e) => {
    historyFilter = e.target.value;
    renderHistoryTree();
  });

  // History refresh
  el("btn-refresh-history").addEventListener("click", loadAndRenderHistory);

  // WSL refresh
  el("btn-refresh-vms")?.addEventListener("click", () => { vmData = null; loadAndRenderVMs(); });

  // Commands filter
  el("cmd-filter").addEventListener("input", (e) => {
    cmdFilter = e.target.value;
    renderCommands();
  });

  // Working stop button
  el("working-stop").addEventListener("click", async () => {
    if (selectedId) await api(`/api/sessions/${selectedId}/interrupt`);
  });

  // Double-click chat title to rename the session inline
  el("chat-title").addEventListener("dblclick", () => {
    if (!selectedId) return;
    const titleEl = el("chat-title");
    const current = titleEl.textContent;
    titleEl.dataset.editing = "1";
    titleEl.contentEditable = "true";
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = async (save) => {
      titleEl.contentEditable = "false";
      delete titleEl.dataset.editing;
      if (save) await renameSession(selectedId, titleEl.textContent);
      else titleEl.textContent = current;
    };
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    }, { once: true });
    titleEl.addEventListener("blur", () => finish(true), { once: true });
  });

  // Reset modal
  el("reset-cancel").addEventListener("click", () => el("reset-modal").classList.add("hidden"));
  el("reset-save").addEventListener("click", async () => {
    const v = el("reset-time").value;
    if (!v) return;
    const ts = new Date(v).getTime();
    await api("/api/account/set-reset", { resetAt: ts });
    el("reset-modal").classList.add("hidden");
  });

  // Close modals on overlay click
  for (const id of ["new-modal","approval-modal","instr-modal","history-modal","reset-modal"]) {
    const overlay = el(id);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const id of ["approval-modal","instr-modal","history-modal","reset-modal","new-modal"]) {
        if (!el(id).classList.contains("hidden")) { el(id).classList.add("hidden"); return; }
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "n") { e.preventDefault(); openNewSessionModal(); }
  });
}

// ─── Restore sidebar width ────────────────────────────────────────────────────
function restoreSidebarWidth() {
  const w = parseInt(localStorage.getItem("sidebarWidth") || "260");
  el("sidebar").style.width = `${Math.max(160, Math.min(600, w))}px`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Resolve orchestrator port and settings from the main process
  if (window.fleetApp) {
    try { PORT = (await window.fleetApp.getPort()) || 4318; } catch { PORT = 4318; }
    BASE = `http://127.0.0.1:${PORT}`;
    try {
      const s = await window.fleetApp.getSettings();
      if (s) applySettings(s);
    } catch { /* ignore */ }
  }

  restoreSidebarWidth();
  setupWindowControls();
  wireStaticListeners();
  setupSidebarResize();
  setupComposer();
  setupPeriodicRefresh();
  // Initial render for always-open left panes
  renderControls();
  // Set up vertical pane resizers
  setupVerticalResize(el("vr-1"), el("lp-sessions"), el("lp-history"));
  setupVerticalResize(el("vr-2"), el("lp-history"), el("lp-controls"));
  // Start SSE
  connectFleet();
  // Load all background data
  loadRepos();
  loadAndRenderHistory();
  loadAndRenderRightPanel();
}

init().catch((e) => console.error("Fleet Console init error:", e));
