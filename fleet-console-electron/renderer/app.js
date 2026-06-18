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
let checkedRepos  = new Set(); // repo paths checked in the sidebar tree
const sectionsOpen = { sessions: true, history: false, wsl: false, controls: false, intelligence: false, commands: false, repos: false };
let historyLoaded = false;   // lazy-load sentinel for history
let wslLoaded     = false;   // lazy-load sentinel for wsl
let activeView    = "chat";
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
function fmtCountdown(target) {
  if (!target) return "—";
  let s = Math.max(0, Math.floor((target - serverNow()) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);   s -= m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
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

// ─── Accordion section toggle ────────────────────────────────────────────────
function toggleSection(id) {
  sectionsOpen[id] = !sectionsOpen[id];
  const header = qs(`[data-sec="${id}"]`);
  const body   = el(`sec-body-${id}`);
  if (!header || !body) return;
  header.classList.toggle("open", sectionsOpen[id]);
  body.classList.toggle("open",   sectionsOpen[id]);
  // Lazy-load on first open
  if (sectionsOpen[id]) {
    if (id === "history" && !historyLoaded) { historyLoaded = true; loadAndRenderHistory(); }
    if (id === "wsl"     && !wslLoaded)     { wslLoaded = true;     loadAndRenderWsl(); }
    if (id === "controls")    renderControls();
    if (id === "intelligence") renderIntelligence();
    if (id === "commands")    renderCommands();
    if (id === "repos")       renderReposTree();
  }
}

function openSection(id) {
  if (!sectionsOpen[id]) toggleSection(id);
}

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
  renderRightPanel();
  // Build tag is part of renderStatusBar now
  // Re-render open side panels
  if (sectionsOpen.controls)    renderControls();
  if (sectionsOpen.intelligence) renderIntelligence();
  if (sectionsOpen.commands)    renderCommands();
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
      const cd  = w.resetAt ? ` ↺${fmtCountdown(w.resetAt)}` : "";
      parts.push(`<span class="sb-chip ${cls}" title="${escapeHtml(full)}">${short}:${pct.toFixed(0)}%${cd}</span>`);
    } else if (w.requestCount != null) {
      parts.push(`<span class="sb-chip" title="${escapeHtml(full)}">${short}:${w.requestCount.toLocaleString()}</span>`);
    }
  }
  // Build
  if (latest.build) parts.push(`<span class="sb-build">${escapeHtml(latest.build)}</span>`);

  el("sb-right").innerHTML = parts.map((p, i) => (i > 0 ? pipe : "") + p).join("");
}

// ─── Right panel (usage) ──────────────────────────────────────────────────────
let rightPanelVisible = true;  // visible by default
let usageHistData = null;
let usageHistLoadedAt = 0;

async function loadUsageHistory() {
  const now = Date.now();
  if (usageHistData && now - usageHistLoadedAt < 60000) return usageHistData;
  const d = await getJson("/api/usage/history");
  if (d) { usageHistData = d; usageHistLoadedAt = Date.now(); }
  return usageHistData;
}

// ── SVG chart primitives ──
function svgRing(pct, cls, size = 52) {
  const r = (size / 2) - 5;
  const circ = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(100, pct)) / 100 * circ;
  const color = cls === "high" ? "#f87171" : cls === "warn" ? "#fbbf24" : "#007acc";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="4"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="4"
      stroke-dasharray="${dash.toFixed(2)} ${(circ-dash).toFixed(2)}"
      stroke-dashoffset="${(circ/4).toFixed(2)}" stroke-linecap="round"/>
    <text x="${size/2}" y="${size/2+4}" text-anchor="middle" font-size="10" font-weight="700"
      fill="${color}">${pct.toFixed(0)}%</text>
  </svg>`;
}

function svgTokenBar(inp, out, cache, width = 220) {
  const total = inp + out + cache || 1;
  const iw = Math.max(0, Math.round(inp / total * width));
  const ow = Math.max(0, Math.round(out / total * width));
  const cw = Math.max(0, width - iw - ow);
  return `<svg width="${width}" height="14" viewBox="0 0 ${width} 14" style="display:block;width:100%">
    ${iw > 0 ? `<rect x="0" y="3" width="${iw}" height="8" fill="#4ec9b0" rx="2"/>` : ""}
    ${ow > 0 ? `<rect x="${iw}" y="3" width="${ow}" height="8" fill="#c586c0"/>` : ""}
    ${cw > 0 ? `<rect x="${iw+ow}" y="3" width="${cw}" height="8" fill="#fbbf24" rx="2"/>` : ""}
  </svg>`;
}

function svgBarChart(entries, { width = 240, height = 56, color = "#007acc" } = {}) {
  if (!entries.length) return "";
  const max  = Math.max(...entries.map((e) => e.v), 0.001);
  const padB = 14, padT = 4;
  const chartH = height - padT - padB;
  const step   = width / entries.length;
  const barW   = Math.max(2, step * 0.65);
  let rects = "", texts = "";
  entries.forEach((e, i) => {
    const barH = Math.round((e.v / max) * chartH);
    const x = i * step + (step - barW) / 2;
    const y = padT + chartH - barH;
    rects += `<rect x="${x.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${Math.max(1, barH)}" fill="${color}" rx="1" opacity="${e.v > 0 ? 0.8 : 0.15}"/>`;
    if (i === 0 || i === entries.length - 1 || i === Math.floor(entries.length / 2)) {
      texts += `<text x="${(x + barW/2).toFixed(1)}" y="${height - 1}" text-anchor="middle" font-size="7" fill="rgba(255,255,255,.4)">${escapeHtml(e.l)}</text>`;
    }
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;width:100%;height:${height}px">
    <line x1="0" y1="${padT+chartH}" x2="${width}" y2="${padT+chartH}" stroke="rgba(255,255,255,.08)"/>
    ${rects}${texts}
  </svg>`;
}

function toggleRightPanel() {
  rightPanelVisible = !rightPanelVisible;
  el("right-panel").classList.toggle("hidden", !rightPanelVisible);
  el("btn-toggle-usage").classList.toggle("active", rightPanelVisible);
  if (rightPanelVisible) loadAndRenderRightPanel();
}

async function loadAndRenderRightPanel() {
  if (!rightPanelVisible) return;
  const body = el("right-panel-body");
  body.innerHTML = `<div class="rp-hint">Loading usage data…</div>`;
  await loadUsageHistory();
  renderRightPanel();
}

function renderRightPanel() {
  if (!rightPanelVisible || !latest) return;
  const body    = el("right-panel-body");
  const u       = latest.usage || {};
  const totals  = u.totals || {};
  const wins    = sortedWindows(u.windows);
  const hist    = usageHistData;
  const sessions = latest.sessions || [];
  const inp    = totals.inputTokens || 0;
  const out    = totals.outputTokens || 0;
  const cacheR = totals.cacheReadTokens || 0;
  const cacheC = totals.cacheCreationTokens || 0;
  const cache  = cacheR + cacheC;

  let html = "";

  // ── Hero card ─────────────────────────────────────────────────────────────
  const sub = u.subscriptionType || "";
  html += `<div class="up-hero">
    <div class="up-hero-top">
      <div class="up-hero-cost">${totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : "—"}</div>
      ${sub ? `<span class="up-hero-plan">${escapeHtml(sub)}</span>` : ""}
    </div>
    <div class="up-hero-tokens">${inp > 0 || out > 0
      ? `↑ ${fmtTok(inp)}&thinsp;in &nbsp;↓ ${fmtTok(out)}&thinsp;out${cache > 0 ? ` &nbsp;⟳ ${fmtTok(cache)}&thinsp;cache` : ""}`
      : `${sessions.length} session${sessions.length !== 1 ? "s" : ""} active`}
    </div>
  </div>`;

  // ── Account limits (Copilot-chat list style) ──────────────────────────────
  const utilWins = wins.filter((w) => typeof w.utilization === "number");
  const reqWins  = wins.filter((w) => w.utilization == null && w.requestCount != null);

  if (utilWins.length || reqWins.length) {
    html += `<div class="up-section"><div class="up-section-header">Account Limits</div>`;
    for (const w of utilWins) {
      const pct   = Math.max(0, Math.min(100, w.utilization));
      const cls   = pct >= 90 ? "high" : pct >= 70 ? "warn" : "ok";
      const label = WINDOW_LABELS[w.type] || w.type;
      const cd    = w.resetAt ? fmtCountdown(w.resetAt) : "";
      html += `<div class="up-limit-row">
        <div class="up-limit-top">
          <span class="up-dot ${cls}"></span>
          <span class="up-limit-label">${escapeHtml(label)}</span>
          <span class="up-limit-val ${cls}">${pct.toFixed(0)}%</span>
        </div>
        <div class="up-limit-track"><div class="up-limit-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
        ${cd ? `<div class="up-limit-cd">↺ resets ${escapeHtml(cd)}</div>` : ""}
      </div>`;
    }
    for (const w of reqWins) {
      const label = WINDOW_LABELS[w.type] || w.type;
      html += `<div class="up-limit-row">
        <div class="up-limit-top">
          <span class="up-dot ok"></span>
          <span class="up-limit-label">${escapeHtml(label)}</span>
          <span class="up-limit-val ok">${w.requestCount.toLocaleString()}</span>
        </div>
        ${w.sessionCount ? `<div class="up-limit-cd">${w.sessionCount.toLocaleString()} sessions</div>` : ""}
      </div>`;
    }
    html += `</div>`;
  }

  // ── Token breakdown ───────────────────────────────────────────────────────
  if (inp > 0 || out > 0 || cache > 0) {
    const tokenTotal = inp + out + cache;
    const iw = Math.round(inp / tokenTotal * 100);
    const ow = Math.round(out / tokenTotal * 100);
    const cw = 100 - iw - ow;
    html += `<div class="up-section">
      <div class="up-section-header">Tokens This Run</div>
      <div class="up-tok-bar">
        <div class="up-tok-seg inp" style="width:${iw}%" title="Input: ${inp.toLocaleString()}"></div>
        <div class="up-tok-seg out" style="width:${ow}%" title="Output: ${out.toLocaleString()}"></div>
        ${cw > 0 ? `<div class="up-tok-seg cach" style="width:${cw}%" title="Cache: ${cache.toLocaleString()}"></div>` : ""}
      </div>
      <div class="up-tok-legend">
        <span class="up-tok-dot inp"></span>↑&thinsp;${fmtTok(inp)}&thinsp;in
        <span class="up-tok-dot out"></span>↓&thinsp;${fmtTok(out)}&thinsp;out
        ${cache > 0 ? `<span class="up-tok-dot cach"></span>⟳&thinsp;${fmtTok(cache)}&thinsp;cache` : ""}
      </div>
      <div class="up-tok-rows">
        <div class="up-tok-row"><span>Input</span><span>${inp.toLocaleString()}</span></div>
        <div class="up-tok-row"><span>Output</span><span>${out.toLocaleString()}</span></div>
        ${cacheR > 0 ? `<div class="up-tok-row"><span>Cache read</span><span>${cacheR.toLocaleString()}</span></div>` : ""}
        ${cacheC > 0 ? `<div class="up-tok-row"><span>Cache create</span><span>${cacheC.toLocaleString()}</span></div>` : ""}
      </div>
    </div>`;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  const sessWithData = sessions.filter((s) => {
    const r = s.lastResult || {};
    return r.cost > 0 || (r.usage?.input_tokens || 0) > 0;
  });
  if (sessWithData.length) {
    const maxInp = Math.max(...sessWithData.map((s) => s.lastResult?.usage?.input_tokens || 0), 1);
    html += `<div class="up-section"><div class="up-section-header">Sessions</div>`;
    for (const s of sessWithData) {
      const r  = s.lastResult || {}, tu = r.usage || {};
      const si = tu.input_tokens || 0, so = tu.output_tokens || 0, sc = tu.cache_read_input_tokens || 0;
      const statusCls = s.status === "running" ? "running" : s.status === "idle" ? "ok" : "muted";
      const fillW = Math.round(si / maxInp * 100);
      html += `<div class="up-sess-row">
        <div class="up-sess-top">
          <span class="up-dot ${statusCls}"></span>
          <span class="up-sess-name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
          <span class="up-sess-cost">${r.cost > 0 ? `$${r.cost.toFixed(4)}` : ""}</span>
        </div>
        ${si > 0 ? `<div class="up-sess-bar-track"><div class="up-sess-bar-fill" style="width:${fillW}%"></div></div>
        <div class="up-sess-toks">↑${fmtTok(si)}&thinsp;in · ↓${fmtTok(so)}&thinsp;out${sc > 0 ? ` · ⟳${fmtTok(sc)}` : ""}</div>` : ""}
      </div>`;
    }
    html += `</div>`;
  }

  // ── Daily charts (from history) ───────────────────────────────────────────
  if (hist?.byDay) {
    const dayEntries = Object.entries(hist.byDay)
      .sort(([a],[b]) => a.localeCompare(b)).slice(-14)
      .map(([d, b]) => ({ l: d.slice(5), v: (b.inputTokens||0)+(b.outputTokens||0) }));
    if (dayEntries.some((e) => e.v > 0)) {
      html += `<div class="up-section">
        <div class="up-section-header">Daily Tokens — 14 days</div>
        <div class="up-chart">${svgBarChart(dayEntries, { color: "#58a6ff" })}</div>
      </div>`;
    }
    const costEntries = Object.entries(hist.byDay)
      .sort(([a],[b]) => a.localeCompare(b)).slice(-14)
      .map(([d, b]) => ({ l: d.slice(5), v: b.costUsd || 0 }));
    if (costEntries.some((e) => e.v > 0)) {
      html += `<div class="up-section">
        <div class="up-section-header">Daily Cost — 14 days</div>
        <div class="up-chart">${svgBarChart(costEntries, { color: "#3fb950" })}</div>
      </div>`;
    }
    if (hist.byModel && Object.keys(hist.byModel).length) {
      const models = Object.entries(hist.byModel)
        .sort(([,a],[,b]) => (b.inputTokens+b.outputTokens)-(a.inputTokens+a.outputTokens)).slice(0,6);
      const maxTok = Math.max(...models.map(([,b]) => (b.inputTokens||0)+(b.outputTokens||0)), 1);
      html += `<div class="up-section"><div class="up-section-header">By Model</div>`;
      for (const [model, b] of models) {
        const tok  = (b.inputTokens||0)+(b.outputTokens||0);
        const w    = Math.round(tok/maxTok*100);
        const name = model.includes("-") ? model.split("-").slice(-2).join("-") : model;
        html += `<div class="up-model-row">
          <div class="up-model-top">
            <span class="up-model-name" title="${escapeHtml(model)}">${escapeHtml(name)}</span>
            <span class="up-model-tok">${fmtTok(tok)}</span>
          </div>
          <div class="up-model-track"><div class="up-model-fill" style="width:${w}%"></div></div>
        </div>`;
      }
      html += `</div>`;
    }
  }

  if (!html) html = `<div class="up-empty">No usage data yet.<br>Start a session to see metrics.</div>`;
  body.innerHTML = html;
}

// ─── Sessions list ────────────────────────────────────────────────────────────
function renderSessionsList() {
  const list = el("sessions-list");
  if (!latest?.sessions) { list.innerHTML = '<div class="ctrl-hint">No active sessions.</div>'; return; }
  const sessions = latest.sessions;
  if (!sessions.length) { list.innerHTML = '<div class="ctrl-hint">No active sessions. Click ＋ to create one.</div>'; return; }
  list.innerHTML = sessions.map((s) => {
    const statusCls = s.status === "running" ? "running" : s.status === "starting" ? "starting" : s.status === "idle" ? "idle" : "done";
    const repo = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : "";
    return `<div class="session-item${s.id === selectedId ? " selected" : ""}" data-id="${escapeHtml(s.id)}">
      <div class="session-item-top">
        <span class="session-status-dot ${statusCls}"></span>
        <span class="session-label" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
      </div>
      <div class="session-meta">
        <span class="session-repo">${escapeHtml(repo)}</span>
        <span>${escapeHtml(s.host)}${s.distro ? ` · ${escapeHtml(s.distro)}` : ""}</span>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".session-item").forEach((item) => {
    item.addEventListener("click", () => selectSession(item.dataset.id));
  });
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
  if (sectionsOpen.controls)     renderControls();
  if (sectionsOpen.intelligence) renderIntelligence();
  // Sync repos checkboxes with session's additionalDirectories
  if (s) syncRepoCheckboxesFromSession(s);
  // Refresh status bar session cost immediately
  if (latest) renderFleet();
}

function updateChatHeader(s) {
  el("chat-title").textContent = s.label;
  el("chat-meta").textContent = `${s.host}${s.distro ? ` · ${s.distro}` : ""} · ${s.cwd || ""}`;
}

function renderWorkingState(s) {
  const w = el("working");
  if (!s || s.status !== "running") { w.classList.add("hidden"); return; }
  w.classList.remove("hidden");
  el("working-text").textContent = "Claude is working…";
}

// ─── Session SSE ──────────────────────────────────────────────────────────────
function openSessionSSE(id) {
  if (sessionES) { sessionES.close(); sessionES = null; }
  el("messages").innerHTML = "";
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
  } else if (ev.kind === "approval_request") {
    approvalQueue.push(ev);
    drainApprovals();
  }
}

// ─── Message rendering ────────────────────────────────────────────────────────
const messagesEl = el("messages");
function appendMessage(m) {
  const div = document.createElement("div");
  div.className = "msg";
  const role = m.role || "system";
  const time = m.ts ? fmtTime(m.ts) : "";
  let header = `<div class="msg-header"><span class="msg-role ${role}">${role}</span><span>${time}</span></div>`;
  let body = "";
  if (role === "user") {
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else if (role === "assistant") {
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else if (role === "tool") {
    const input = m.input ? escapeHtml(JSON.stringify(m.input).slice(0, 200)) : "";
    body = `<div class="msg-tool-use">🔧 <strong>${escapeHtml(m.name || "")}</strong>${input ? ` <span style="opacity:.6">${input}</span>` : ""}</div>`;
  } else if (role === "result") {
    body = `<div class="msg-body">${mdToHtml(m.text || "")}</div>`;
  } else {
    body = `<div class="msg-system-text">${escapeHtml(m.text || "")}</div>`;
  }
  div.innerHTML = header + body;
  messagesEl.appendChild(div);
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
const DEFAULT_INTEL_TOOLS = ["safr","chunkhound","region_extract","symbol_scope","tds","noise_filter","log_dedup","stack_collapse"];
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

  // Group by date, then by repo within each date group
  const DATE_ORDER = ["Today","Yesterday","This Week","Last Week","This Month","Older"];
  const byDate = {};
  for (const s of filtered) {
    const grp = dateGroup(s.createdAt || s.mtime);
    if (!byDate[grp]) byDate[grp] = {};
    const repo = s.repo || "unknown";
    if (!byDate[grp][repo]) byDate[grp][repo] = [];
    byDate[grp][repo].push(s);
  }

  // Use numeric indices instead of CSS.escape for data attributes to avoid selector edge cases
  let gIdx = 0;
  const groupIndex  = {};   // grp  → index
  const repoIndices = {};   // grp::repo → index

  let html = "";
  for (const grp of DATE_ORDER) {
    if (!byDate[grp]) continue;
    const gi   = gIdx++;
    groupIndex[grp] = gi;
    const gOpen = historyGroupOpen[grp] !== false;
    html += `<div class="tree-group-header${gOpen?" open":""}" data-gi="${gi}">
      <span class="tree-expand-icon${gOpen?" open":""}">▶</span>
      ${escapeHtml(grp)}
      <span style="font-size:10px;opacity:.5;margin-left:4px">(${Object.values(byDate[grp]).reduce((a,b)=>a+b.length,0)})</span>
    </div>
    <div class="tree-group-children${gOpen?"":" collapsed"}" data-gi-body="${gi}">`;

    for (const [repo, items] of Object.entries(byDate[grp])) {
      const rKey = `${grp}::${repo}`;
      const ri = gIdx++;
      repoIndices[rKey] = ri;
      const rOpen = historyRepoOpen[rKey] !== false;
      html += `<div class="tree-repo-header" data-ri="${ri}">
        <span class="tree-expand-icon${rOpen?" open":""}">▶</span>
        📁 ${escapeHtml(repo)}
        <span style="font-size:10px;opacity:.5;margin-left:4px">(${items.length})</span>
      </div>
      <div class="tree-repo-children${rOpen?"":" collapsed"}" data-ri-body="${ri}">`;
      for (const s of items) {
        const statusCls = s.status === "done" ? "done" : s.status || "idle";
        const time = s.createdAt ? fmtDate(s.createdAt) : (s.mtime ? fmtDate(s.mtime) : "");
        html += `<div class="tree-session-item${viewingRel === s.rel?" selected":""}" data-rel="${escapeHtml(s.rel||"")}">
          <div class="tree-session-row">
            <span class="tree-session-name" title="${escapeHtml(s.label||s.title||"")}">
              ${escapeHtml(s.label || s.title || "Unnamed")}
            </span>
            ${s.status ? `<span class="tree-session-status ${statusCls}">${escapeHtml(s.status)}</span>` : ""}
          </div>
          <div class="tree-session-time">${escapeHtml(time)}${s.messages ? ` · ${s.messages} msg` : ""}</div>
        </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  treeEl.innerHTML = html;

  // Wire group header expand/collapse (use data-gi index)
  treeEl.querySelectorAll(".tree-group-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      // Find the group name from the rendered data
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
  // Wire repo header expand/collapse
  treeEl.querySelectorAll(".tree-repo-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const ri   = hdr.dataset.ri;
      const body = treeEl.querySelector(`[data-ri-body="${ri}"]`);
      const icon = hdr.querySelector(".tree-expand-icon");
      const rKey = Object.entries(repoIndices).find(([,v]) => String(v) === ri)?.[0];
      if (!rKey || !body) return;
      const isOpen = historyRepoOpen[rKey] !== false;
      historyRepoOpen[rKey] = !isOpen;
      icon.classList.toggle("open", !isOpen);
      body.classList.toggle("collapsed", isOpen);
    });
  });
  // Wire session item clicks
  treeEl.querySelectorAll(".tree-session-item").forEach((item) => {
    item.addEventListener("click",    () => viewHistoryItem(item.dataset.rel));
    item.addEventListener("dblclick", () => viewHistoryItemModal(item.dataset.rel));
  });
}

async function viewHistoryItem(rel) {
  viewingRel = rel;
  isViewingHistory = true;   // prevent live SSE from overwriting
  selectedId = null;          // deselect any live session
  // Highlight in tree
  el("history-tree").querySelectorAll(".tree-session-item").forEach((i) => i.classList.toggle("selected", i.dataset.rel === rel));
  lastControlsSig = "";
  if (sectionsOpen.controls) renderControls();
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
async function loadAndRenderWsl() {
  const data = await getJson("/api/wsl/distros");
  if (data) wslData = data;
  renderWslList();
}
function renderWslList() {
  const listEl = el("wsl-list");
  if (!listEl) return;
  const distros = wslData?.distros || [];
  if (!distros.length) { listEl.innerHTML = '<div class="ctrl-hint">No WSL distros found.</div>'; return; }
  listEl.innerHTML = distros.map((d) => `
    <div class="wsl-item">
      <span class="wsl-name">🐧 ${escapeHtml(d.name)}</span>
      ${d.default ? '<span class="wsl-default-tag">default</span>' : ""}
      <span class="wsl-state ${/running/i.test(d.state) ? "running" : "stopped"}">${escapeHtml(d.state||"")}</span>
      ${d.version ? `<span class="wsl-version">v${escapeHtml(d.version)}</span>` : ""}
    </div>`).join("");
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
    if (sectionsOpen.repos) renderReposTree();
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
    const icon = isOpen ? "▼" : "▶";
    html += `<div class="repos-group-header" data-repo-group="${escapeHtml(key)}">
      <span class="tree-expand-icon${isOpen?" open":""}">▶</span>
      ${group.host === "wsl" ? "🐧" : "💻"} ${escapeHtml(group.label)}
      <span class="muted" style="font-size:10px;margin-left:4px">(${group.repos.length})</span>
    </div>
    <div class="repos-group-children${isOpen?"":" collapsed"}" data-repo-group-body="${escapeHtml(key)}">`;
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

  // Apply button
  el("repos-apply")?.addEventListener("click", applyCheckedReposToSession);
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
  // Build new directories: keep cwd + checked repos (avoid dupes)
  const existing = new Set((s.additionalDirectories || []).map((d) => d.replace(/\\/g, "/")));
  const toAdd = [...checkedRepos].filter((p) => !existing.has(p));
  const dirs = [...(s.additionalDirectories || []), ...toAdd];
  await api(`/api/sessions/${s.id}/set-directories`, { directories: dirs });
  lastControlsSig = "";
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
function openNewSessionModal() {
  // Pre-populate extra dirs from checked repos
  const checkedList = [...checkedRepos].join("\n");
  if (checkedList) el("f-extra-dirs").value = checkedList;
  // Populate distro options
  populateNewSessionDistros();
  // Populate repo options
  populateNewSessionRepos();
  el("new-modal").classList.remove("hidden");
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

async function createNewSession() {
  const host = el("f-host").value;
  const distro = host === "wsl" ? el("f-distro").value : "";
  const repoSel = el("f-repos").value;
  let cwd = el("f-cwd").value.trim();
  if (!cwd && repoSel) cwd = repoSel;
  if (!cwd) { alert("Working directory is required."); return; }

  const extraDirs = el("f-extra-dirs").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const spec = {
    label:                el("f-label").value.trim() || cwd.split(/[\\/]/).pop(),
    host, distro, cwd,
    additionalDirectories: extraDirs,
    model:                el("f-model").value.trim(),
    mode:                 el("f-mode").value,
    effort:               el("f-effort").value,
    thinking:             el("f-thinking").value,
    browser:              el("f-browser").checked,
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

// ─── Sidebar resize ───────────────────────────────────────────────────────────
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
function wireStaticListeners() {
  // Accordion section headers
  qsa(".sb-section-header").forEach((hdr) => {
    hdr.addEventListener("click", (e) => {
      if (e.target.closest(".sb-section-actions")) return; // let action buttons through
      toggleSection(hdr.dataset.sec);
    });
  });

  // Editor tabs (chat only now; usage is in the right panel)
  qsa(".editor-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      qsa(".editor-tab").forEach((t) => t.classList.toggle("active", t === tab));
    });
  });

  // Usage right panel toggle
  el("btn-toggle-usage").addEventListener("click", toggleRightPanel);
  el("btn-close-right-panel").addEventListener("click", () => {
    rightPanelVisible = true;  // force-set so toggle flips to false
    toggleRightPanel();
  });

  // New session button
  el("btn-new-session").addEventListener("click", openNewSessionModal);

  // Set reset time
  el("btn-set-reset").addEventListener("click", () => {
    const now = new Date(Date.now() + 5*3600*1000);
    el("reset-time").value = now.toISOString().slice(0,16);
    el("reset-modal").classList.remove("hidden");
  });

  // New session modal
  el("f-cancel").addEventListener("click", () => el("new-modal").classList.add("hidden"));
  el("f-create").addEventListener("click", createNewSession);
  el("f-host").addEventListener("change", (e) => {
    const isWsl = e.target.value === "wsl";
    el("f-distro-row").classList.toggle("hidden", !isWsl);
    el("f-repos-row").classList.toggle("hidden", false);
  });

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
  el("btn-refresh-wsl").addEventListener("click", loadAndRenderWsl);

  // Commands filter
  el("cmd-filter").addEventListener("input", (e) => {
    cmdFilter = e.target.value;
    renderCommands();
  });

  // Working stop button
  el("working-stop").addEventListener("click", async () => {
    if (selectedId) await api(`/api/sessions/${selectedId}/interrupt`);
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
  // Resolve orchestrator port from the main process (Electron) or fall back to default
  if (window.fleetApp) {
    try { PORT = (await window.fleetApp.getPort()) || 4318; } catch { PORT = 4318; }
    BASE = `http://127.0.0.1:${PORT}`;
  }

  restoreSidebarWidth();
  setupWindowControls();
  wireStaticListeners();
  setupSidebarResize();
  setupComposer();
  setupPeriodicRefresh();
  // Initial render for always-open sections
  renderControls(); // renders hint until session selected
  // Mark usage icon as active since panel starts visible
  el("btn-toggle-usage").classList.add("active");
  // Start SSE
  connectFleet();
  // Load background data + usage history (panel is visible by default)
  loadRepos();
  loadAndRenderRightPanel();
}

init().catch((e) => console.error("Fleet Console init error:", e));
