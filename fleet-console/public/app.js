/**
 * Fleet Console web client.
 *
 * Subscribes to the fleet SSE stream (session list + account countdown), opens a per-session
 * SSE stream for the selected session (interactive chat + approval prompts), and issues
 * actions over REST. Plain fetch + EventSource + DOM so it runs on iPad Safari unmodified.
 * If the orchestrator requires a token, open the page as `/?token=YOURTOKEN`.
 */

"use strict";

// Must match orchestrator BUILD. If the server reports a different build, this page is running a
// stale cached app.js — we show a banner so it's never a silent mystery. Bump both on UI changes.
const APP_BUILD = "2026-06-16e";

const TOKEN = new URLSearchParams(location.search).get("token") || "";
const tokenQuery = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";

let latest = null;
let clockOffset = 0;
let selectedId = null;
let sessionES = null;
let approvalQueue = [];

const el = (id) => document.getElementById(id);
const sessionsEl = el("sessions");
const messagesEl = el("messages");
const chatHeaderEl = el("chat-header");
const countdownEl = el("account-countdown");
const connEl = el("conn");
const usageBarEl = el("usage-bar");
const workingEl = el("working");
const workingTextEl = el("working-text");
const workingCmdEl = el("working-cmd");
const workingStopEl = el("working-stop");
const statusbarEl = el("statusbar");
const sbTextEl = el("sb-text");
const sbUsageEl = el("sb-usage");
const cmdbarEl = el("cmdbar");
const cmdListEl = el("cmd-list");
const cmdFilterEl = el("cmd-filter");
const rbControlsEl = el("rb-controls");
const rbIntelligenceEl = el("rb-intelligence");

function api(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
}

function getJson(path, timeoutMs) {
  // Optional timeout so a hung request can't permanently block the coalesced sync loop.
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  return fetch(path, { headers: { "x-fleet-token": TOKEN }, signal: ctrl ? ctrl.signal : undefined })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .finally(() => { if (timer) clearTimeout(timer); });
}

function serverNow() {
  return Date.now() + clockOffset;
}

function fmtCountdown(target) {
  if (!target) return "—";
  let s = Math.max(0, Math.floor((target - serverNow()) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function escapeHtml(s) {
  // Escape quotes too: rendered text goes through innerHTML and some of it lands in attribute
  // context (e.g. a markdown link href), where an unescaped " would allow attribute breakout.
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- minimal, dependency-free markdown renderer (Claude's output is markdown) --------------
// Everything is HTML-escaped first; only a known-safe set of tags is introduced, and link hrefs
// are restricted, so agent output can't inject markup.

/** Inline formatting: bold, italic, strikethrough, inline code, links. Input must be escaped. */
function mdInline(s) {
  const codes = [];
  // Protect code spans (token avoids colliding with real digits) so emphasis/links skip them.
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

// ---- lightweight syntax highlighting for fenced code blocks --------------------------------
// Tokenizes RAW source and emits HTML-escaped, span-wrapped tokens, so highlighting can never
// inject markup. YAML has a dedicated line highlighter; common languages share a tokenizer.

const cspan = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

const JS_KW = ["const", "let", "var", "function", "return", "if", "else", "for", "while", "await", "async", "import", "export", "from", "new", "class", "try", "catch", "switch", "case", "break", "this", "typeof", "true", "false", "null", "undefined"];
const SH_KW = ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "case", "esac", "while", "function", "return", "export", "local", "echo", "cd", "set"];
const PS_KW = ["if", "else", "elseif", "foreach", "function", "return", "param", "try", "catch", "throw", "Write-Host"];
const GENERIC_LANGS = {
  json: { line: null, block: false, keywords: ["true", "false", "null"] },
  bash: { line: "#", block: false, keywords: SH_KW },
  sh: { line: "#", block: false, keywords: SH_KW },
  shell: { line: "#", block: false, keywords: SH_KW },
  powershell: { line: "#", block: false, keywords: PS_KW },
  ps1: { line: "#", block: false, keywords: PS_KW },
  js: { line: "//", block: true, keywords: JS_KW },
  mjs: { line: "//", block: true, keywords: JS_KW },
  javascript: { line: "//", block: true, keywords: JS_KW },
  ts: { line: "//", block: true, keywords: JS_KW },
  typescript: { line: "//", block: true, keywords: JS_KW },
};

// Skip highlighting very large blocks (just escape) — keeps rendering snappy and is a hard backstop
// against pathological inputs.
const HIGHLIGHT_MAX = 40000;

function highlightCode(code, lang) {
  lang = (lang || "").toLowerCase();
  if (code.length > HIGHLIGHT_MAX) return escapeHtml(code);
  if (lang === "yaml" || lang === "yml") return highlightYaml(code);
  const cfg = GENERIC_LANGS[lang];
  return cfg ? highlightGeneric(code, cfg) : escapeHtml(code);
}

function hlWords(escaped, kwRe) {
  return kwRe ? escaped.replace(kwRe, '<span class="tok-keyword">$1</span>') : escaped;
}

/** Tokenize a segment that contains no block comments (strings, line comments, numbers, keywords). */
function tokenizeSegment(src, cfg, kwRe) {
  const parts = [];
  if (cfg.line === "//") parts.push("//[^\\n]*");
  if (cfg.line === "#") parts.push("#[^\\n]*");
  parts.push('"(?:[^"\\\\]|\\\\.)*"', "'(?:[^'\\\\]|\\\\.)*'", "`(?:[^`\\\\]|\\\\.)*`", "\\b\\d+(?:\\.\\d+)*\\b");
  const tokenRe = new RegExp(parts.join("|"), "g");
  let out = "";
  let last = 0;
  let m;
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
  const kwRe = cfg.keywords && cfg.keywords.length ? new RegExp("\\b(" + cfg.keywords.join("|") + ")\\b", "g") : null;
  if (!cfg.block) {
    return tokenizeSegment(src, cfg, kwRe);
  }
  // Extract /* */ block comments with a linear scan (a backtracking regex over the whole string is
  // O(n^2) on many unterminated "/*" openers and can freeze the tab).
  let out = "";
  let idx = 0;
  for (;;) {
    const start = src.indexOf("/*", idx);
    if (start === -1) {
      out += tokenizeSegment(src.slice(idx), cfg, kwRe);
      break;
    }
    out += tokenizeSegment(src.slice(idx, start), cfg, kwRe);
    let end = src.indexOf("*/", start + 2);
    end = end === -1 ? src.length : end + 2;
    out += cspan("comment", src.slice(start, end));
    idx = end;
  }
  return out;
}

function highlightYaml(src) {
  const lines = src.split("\n");
  const out = [];
  let blockIndent = -1; // >=0 while inside a "|"/">" block scalar; deeper-indented lines are literal
  for (const line of lines) {
    if (blockIndent >= 0) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > blockIndent) {
        out.push(cspan("string", line)); // literal block-scalar content
        continue;
      }
      blockIndent = -1; // dedent ends the block
    }
    out.push(highlightYamlLine(line));
    // A value of "|", ">", "|-", ">2", etc. starts a block scalar; following deeper lines are literal.
    if (/:\s*[|>][+-]?\d*\s*$/.test(line)) {
      blockIndent = line.length - line.trimStart().length;
    }
  }
  return out.join("\n");
}

/** Index of an inline "#" comment in a YAML line (preceded by whitespace, not inside quotes). */
function yamlCommentIndex(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

function yamlValue(v) {
  const lead = v.slice(0, v.length - v.trimStart().length);
  const trail = v.slice(v.trimEnd().length); // preserve trailing whitespace (don't drop characters)
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

/** Block-level markdown → HTML: headings, lists, tables, code fences, blockquotes, paragraphs. */
function mdToHtml(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const splitRow = (l) =>
    l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => mdInline(escapeHtml(c.trim())));

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const lang = (fence[1] || "").toLowerCase();
      const buf = [];
      i++;
      // Close on any line that starts with ``` (mirrors the loose open) so a fence with trailing
      // text or extra backticks still closes instead of swallowing the rest of the message.
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"><code class="lang-${lang || "text"}">${highlightCode(buf.join("\n"), lang)}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const tag = "h" + Math.min(h[1].length, 6);
      out.push(`<${tag}>${mdInline(escapeHtml(h[2].trim()))}</${tag}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr />"); i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      let t = "<table><thead><tr>" + headers.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        t += "<tr>" + splitRow(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
        i++;
      }
      out.push(t + "</tbody></table>");
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${mdInline(escapeHtml(buf.join(" ")))}</blockquote>`);
      continue;
    }

    const ordered = /^\s*\d+\.\s+/.test(line);
    const listRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length && listRe.test(lines[i])) items.push(lines[i++].replace(listRe, "$1"));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>` + items.map((it) => `<li>${mdInline(escapeHtml(it))}</li>`).join("") + `</${tag}>`);
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${mdInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br />")}</p>`);
  }
  return out.join("");
}

let connected = false;
function setConnected(on) {
  connected = on;
  connEl.textContent = on ? "live" : "offline";
  connEl.className = "conn " + (on ? "online" : "offline");
  renderStatusBar();
}

// ---- account usage card ----------------------------------------------------

const WINDOW_LABELS = {
  five_hour: "Current session · 5h",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · apps",
  day_requests: "Today · requests",
  week_requests: "This week · requests",
};
// Display order; any window not listed is appended after these.
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
function windowLabel(type) {
  if (WINDOW_LABELS[type]) return WINDOW_LABELS[type];
  return String(type || "Usage").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function clampPct(u) {
  if (typeof u !== "number" || !isFinite(u)) return null;
  return Math.max(0, Math.min(100, u)); // /usage utilization is already a 0-100 percentage
}
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

let lastUsageSig = null;

function renderUsage() {
  if (!usageBarEl) return;
  const u = latest && latest.usage;
  const fetching = !!(u && u.fetching);
  const totals = (u && u.totals) || { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const windows = ((u && u.windows) || [])
    .slice()
    .sort((a, b) => {
      const ia = WINDOW_ORDER.indexOf(a.type);
      const ib = WINDOW_ORDER.indexOf(b.type);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  const hasTotals = totals.costUsd > 0 || totals.inputTokens > 0 || totals.outputTokens > 0;

  // Show a loading skeleton while the usage-fetcher is running and we have no data yet.
  if (fetching && !windows.length) {
    if (lastUsageSig !== "loading") {
      lastUsageSig = "loading";
      usageBarEl.classList.remove("hidden");
      usageBarEl.innerHTML =
        `<div class="usage-card usage-loading">
          <div class="uc-head"><span class="uc-title">Fetching account usage…</span><span class="uc-spinner"></span></div>
          <div class="uc-bar"><div class="uc-fill loading" style="width:100%"></div></div>
          <div class="uc-meta"><span class="usage-loading-note">Connecting to Claude API to read usage limits</span></div>
        </div>`;
    }
    return;
  }

  if (!windows.length && !hasTotals) {
    if (lastUsageSig !== "empty") {
      lastUsageSig = "empty";
      usageBarEl.classList.add("hidden");
      usageBarEl.innerHTML = "";
    }
    return;
  }

  // Build a stable signature from data only (exclude fetching so spinner toggling never triggers a rebuild).
  const nSessions = (latest && latest.sessions ? latest.sessions.length : 0);
  const sessionTokenSig = ((latest && latest.sessions) || [])
    .map((s) => { const r = s.lastResult || {}; return `${s.id}:${r.cost || 0}`; }).join(",");
  const dataSig = windows.map((w) => `${w.type}:${w.utilization}:${w.requestCount}:${w.resetAt}`).join("|")
    + "|" + totals.costUsd + "|" + totals.inputTokens + "|" + totals.outputTokens + "|" + nSessions
    + "|" + sessionTokenSig;

  // Only update the spinner visibility (no layout change) when data hasn't changed.
  if (dataSig === lastUsageSig) {
    const spinner = usageBarEl.querySelector(".uc-refreshing");
    if (spinner) spinner.style.visibility = fetching ? "visible" : "hidden";
    return;
  }
  lastUsageSig = dataSig;
  usageBarEl.classList.remove("hidden");

  let html = "";
  for (const w of windows) {
    const p = clampPct(w.utilization);
    const cls = p != null ? (p >= 90 ? "high" : p >= 70 ? "warn" : "") : "";
    // Count-only card (Max plan — no utilization %, just request/session counts)
    if (p == null && (w.requestCount != null)) {
      html +=
        `<div class="usage-card">
          <div class="uc-head">
            <span class="uc-title">${escapeHtml(windowLabel(w.type))}</span>
            <span class="uc-pct">${w.requestCount.toLocaleString()} req</span>
          </div>
          <div class="uc-meta">
            <span>${w.requestCount.toLocaleString()} requests · ${w.sessionCount || 0} sessions</span>
          </div>
        </div>`;
      continue;
    }
    if (p == null) continue;
    html +=
      `<div class="usage-card">
        <div class="uc-head">
          <span class="uc-title">${escapeHtml(windowLabel(w.type))}</span>
          <span class="uc-pct ${cls}">${p.toFixed(0)}%</span>
        </div>
        <div class="uc-bar"><div class="uc-fill ${cls}" style="width:${p.toFixed(0)}%"></div></div>
        <div class="uc-meta">
          <span>${p.toFixed(0)}% used</span>
          <span class="usage-reset" data-reset="${w.resetAt || ""}">${w.resetAt ? "resets " + fmtCountdown(w.resetAt) : ""}</span>
        </div>
      </div>`;
  }
  const plan = u && u.subscriptionType ? ` · ${escapeHtml(String(u.subscriptionType))} plan` : "";
  const cached = totals.cacheReadTokens || 0;
  const refreshing = `<span class="uc-refreshing" title="Refreshing usage data…" style="visibility:${fetching ? 'visible' : 'hidden'}">↻</span>`;
  html +=
    `<div class="usage-card totals">
      <div class="uc-head"><span class="uc-title">This run${plan}</span>${refreshing}</div>
      <div class="uc-big">$${(totals.costUsd || 0).toFixed(4)}</div>
      <div class="uc-sub">${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out${cached ? " · " + fmtTokens(cached) + " cached" : ""} · ${nSessions} session${nSessions === 1 ? "" : "s"}</div>
    </div>`;
  // Per-session token usage. The account 5h/weekly windows above only expose a utilization % (Anthropic
  // doesn't break them into tokens), so per-session in/out lives here — from each session's cumulative
  // result.usage. Costs nothing: it's metadata the SDK already returns with every turn's result.
  for (const s of (latest && latest.sessions) || []) {
    const r = s.lastResult || {};
    const tu = r.usage || {};
    const inTok = tu.input_tokens || 0;
    const outTok = tu.output_tokens || 0;
    const cacheTok = (tu.cache_read_input_tokens || 0) + (tu.cache_creation_input_tokens || 0);
    if (!inTok && !outTok && !cacheTok && !(r.cost > 0)) continue; // no turn recorded yet
    html +=
      `<div class="usage-card session">
        <div class="uc-head"><span class="uc-title" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span></div>
        <div class="uc-big">$${(r.cost || 0).toFixed(4)}</div>
        <div class="uc-sub">${fmtTokens(inTok)} in · ${fmtTokens(outTok)} out${cacheTok ? " · " + fmtTokens(cacheTok) + " cached" : ""}</div>
      </div>`;
  }
  usageBarEl.innerHTML = html;
}

// ---- fleet rendering -------------------------------------------------------

function renderFleet() {
  if (!latest) return;
  countdownEl.textContent = latest.account.resetAt ? fmtCountdown(latest.account.resetAt) : "—";
  renderUsage();

  const ids = new Set();
  for (const node of sessionsEl.children) ids.add(node.dataset.id);

  const seen = new Set();
  for (const s of latest.sessions) {
    seen.add(s.id);
    let node = [...sessionsEl.children].find((n) => n.dataset.id === s.id);
    if (!node) {
      node = document.createElement("div");
      node.className = "session-item";
      node.dataset.id = s.id;
      node.addEventListener("click", () => selectSession(s.id));
      sessionsEl.appendChild(node);
    }
    node.classList.toggle("active", s.id === selectedId);
    const timer = s.status === "limited" && s.nextContinueAt ? `<span class="timer">⌛ ${fmtCountdown(s.nextContinueAt)}</span>` : "";
    node.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(s.label)}</span>
        <span class="badge ${s.status}">${s.status}</span>
      </div>
      <div class="sub">${escapeHtml(s.host)}${s.distro ? " · " + escapeHtml(s.distro) : ""} · ${escapeHtml(s.cwd || "")}</div>
      <div class="sub">${s.policy}${s.pendingApprovals && s.pendingApprovals.length ? " · ⚠ approval needed" : ""} ${timer}</div>`;
  }
  for (const node of [...sessionsEl.children]) {
    if (!seen.has(node.dataset.id)) node.remove();
  }

  // Surface approvals for the selected session.
  const sel = latest.sessions.find((x) => x.id === selectedId);
  if (sel) {
    renderChatHeader(sel);
    if (sel.pendingApprovals) {
      for (const a of sel.pendingApprovals) enqueueApproval(a);
    }
  }
  updateWorking();
  renderStatusBar();
  updateComposer();
  renderControls(sel);
  if (cmdbarEl && !cmdbarEl.classList.contains("hidden") && !el("rb-commands").classList.contains("hidden")) renderCommands();
}

/** Show a status line under the chat so the user always knows what the agent is doing. */
function updateWorking() {
  if (!workingEl) return;
  const s = latest && selectedId ? latest.sessions.find((x) => x.id === selectedId) : null;
  if (!s) { workingEl.classList.add("hidden"); return; }
  let text = "";
  let err = false;
  let showCmd = false;
  switch (s.status) {
    case "running": text = "Claude is working…"; showCmd = true; break;
    case "starting": text = "Starting the session…"; break;
    case "limited": text = "Usage limit reached — will auto-continue after the reset."; break;
    case "error": text = "Runner stopped. Press Restart to try again."; err = true; break;
    default: workingEl.classList.add("hidden"); return; // idle, ended
  }
  workingTextEl.textContent = text;
  if (workingCmdEl) {
    workingCmdEl.textContent = showCmd ? workingDetail() : "";
  }
  if (workingStopEl) {
    // Only offer "Stop" when there's an active turn to interrupt.
    workingStopEl.classList.toggle("hidden", !(s.status === "running" || s.status === "starting"));
  }
  workingEl.classList.toggle("err", err);
  workingEl.classList.remove("hidden");
}

if (workingStopEl) {
  workingStopEl.addEventListener("click", async () => {
    if (!selectedId) return;
    workingStopEl.disabled = true;
    await api(`/api/sessions/${selectedId}/interrupt`);
    pollFleet();
    syncSession(selectedId);
    setTimeout(() => { workingStopEl.disabled = false; }, 800);
  });
}

// ---- bottom status bar -----------------------------------------------------
// Always-visible: connection to Claude + the selected session's activity, with a live elapsed
// timer so a slow first response (runner start + model call) clearly reads as "working", not stuck.

let sbBusyKey = null;
let sbBusySince = 0;
let sendingSince = 0; // set on send so the bar shows "Sending…" until the status flips to running

function renderStatusBar() {
  if (!statusbarEl || !sbTextEl) return;
  // Connection first.
  if (!connected || !latest) {
    statusbarEl.className = "statusbar offline";
    sbTextEl.textContent = latest ? "Reconnecting to the orchestrator…" : "Connecting to the orchestrator…";
    if (sbUsageEl) sbUsageEl.textContent = "";
    sbBusyKey = null;
    return;
  }
  // Account usage on the right — always visible while connected (fetched at startup, refreshed each poll).
  if (sbUsageEl) {
    const u = latest.usage || {};
    const fetching = !!u.fetching;
    const w = u.windows || [];
    const fh = w.find((x) => x.type === "five_hour");
    const sd = w.find((x) => x.type === "seven_day");
    const dayReq = w.find((x) => x.type === "day_requests");
    const wkReq = w.find((x) => x.type === "week_requests");
    const parts = [];
    if (fh && typeof fh.utilization === "number") parts.push(`5h ${fh.utilization}%`);
    if (sd && typeof sd.utilization === "number") parts.push(`wk ${sd.utilization}%`);
    if (!parts.length && dayReq) parts.push(`today ${dayReq.requestCount.toLocaleString()} req`);
    if (!parts.length && wkReq) parts.push(`wk ${wkReq.requestCount.toLocaleString()} req`);
    const plan = u.subscriptionType ? u.subscriptionType : "";
    if (parts.length) {
      sbUsageEl.textContent = (plan ? plan + " · " : "") + parts.join(" · ");
      sbUsageEl.removeAttribute("data-loading");
    } else {
      sbUsageEl.textContent = fetching ? "fetching account usage…" : "account usage unavailable";
      sbUsageEl.dataset.loading = fetching ? "1" : "";
    }
  }
  // Viewing a saved session (read-only).
  if (viewingRel && !selectedId) {
    statusbarEl.className = "statusbar";
    sbTextEl.textContent = "Viewing a past session — click Resume ▸ to continue";
    sbBusyKey = null;
    return;
  }
  const s = selectedId && latest.sessions ? latest.sessions.find((x) => x.id === selectedId) : null;
  if (!s) {
    statusbarEl.className = "statusbar";
    const n = latest.sessions ? latest.sessions.length : 0;
    sbTextEl.textContent = n ? "Connected · select a session to chat" : "Connected · no active session — click New session";
    sbBusyKey = null;
    return;
  }
  const busy = s.status === "running" || s.status === "starting";
  const key = busy ? s.id + ":" + s.status : null;
  if (key && key !== sbBusyKey) { sbBusyKey = key; sbBusySince = serverNow(); }
  if (!busy) sbBusyKey = null;
  if (s.status === "running" || s.status === "idle") sendingSince = 0; // request reached the agent
  const secs = (since) => Math.max(0, Math.round((serverNow() - since) / 1000)) + "s";

  let cls = "statusbar";
  let text;
  if (sendingSince && (s.status === "idle" || s.status === "ended")) {
    cls = "statusbar busy";
    text = `Sending to Claude… ${secs(sendingSince)}`;
  } else if (s.status === "running") {
    cls = "statusbar busy";
    const detail = workingDetail();
    text = `Claude is working… ${secs(sbBusySince)}` + (detail ? `  ·  ${detail}` : "");
  } else if (s.status === "starting") {
    cls = "statusbar busy";
    text = `Starting session… ${secs(sbBusySince)}`;
  } else if (s.status === "limited") {
    cls = "statusbar warn";
    text = "Usage limit — auto-continues" + (s.nextContinueAt ? " in " + fmtCountdown(s.nextContinueAt) : " after reset");
  } else if (s.status === "error") {
    cls = "statusbar err";
    text = "Runner stopped — press Restart";
  } else if (s.status === "ended") {
    cls = "statusbar";
    text = "Session ended — press Restart or send a message";
  } else {
    text = "Connected · ready";
  }
  statusbarEl.className = cls;
  sbTextEl.textContent = `${s.label} · ${text}`;
}

/** Enable/disable the composer and set a helpful placeholder based on what's selected. */
function updateComposer() {
  if (!composer || !input) return;
  const canSend = !!selectedId; // a live session is selected (past read-only views clear selectedId)
  input.disabled = !canSend;
  const btn = composer.querySelector("button");
  if (btn) btn.disabled = !canSend;
  input.placeholder = canSend
    ? "Message the agent… (Enter to send, Shift+Enter for newline)"
    : viewingRel
      ? "Past session — click Resume ▸ to continue chatting"
      : "Create or select a session to chat";
}

// Permission modes use Claude's own naming. Each is a preset over what runs without asking.
const MODE_OPTIONS = [
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Auto-accept edits" },
  { value: "plan", label: "Plan (read-only)" },
  { value: "bypassPermissions", label: "Auto (full access)" },
];
// Reasoning effort + extended thinking (models that support it; Opus 4.x do).
const EFFORT_OPTIONS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];
const THINKING_OPTIONS = [
  { value: "adaptive", label: "Adaptive (default)" },
  { value: "off", label: "Off" },
];

function renderChatHeader(s) {
  // Slim header — the session controls live in the right-side "Controls" tab now.
  const cost = s.lastResult ? " · $" + (s.lastResult.cost || 0).toFixed(4) : "";
  chatHeaderEl.innerHTML =
    `<span><strong>${escapeHtml(s.label)}</strong> — <span class="badge ${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>${cost}</span>`;
}

let lastControlsSig = null;

/** Render the session controls into the right "Controls" pane — for a live session, a past session
 *  (Resume), or nothing selected. */
function renderControls(s) {
  if (!rbControlsEl) return;
  const models = (latest && latest.models) || [];
  // Stable signature so the inputs don't reset on every poll; covers all three states.
  const sig = s
    ? "live|" + [s.id, s.status, s.mode, s.model, models.length, s.effort || "", s.thinking || "", s.browser ? 1 : 0, s.autoContinue === false ? 0 : 1].join("|")
    : viewingRel
      ? "past|" + viewingRel
      : "none";
  if (sig === lastControlsSig) return;
  lastControlsSig = sig;

  // Past (saved) session: the meaningful control is Resume — bring it live, then full controls show.
  if (!s) {
    if (viewingRel) {
      rbControlsEl.innerHTML =
        `<div class="rb-section"><div class="rb-note">Saved session — resume it to continue chatting.</div></div>
         <div class="rb-actions"><button id="ctl-resume" class="primary">▸ Resume session</button></div>`;
      el("ctl-resume").addEventListener("click", async () => {
        const r = await api("/api/history/resume", { rel: viewingRel });
        if (r && r.ok && r.id) {
          await pollFleet();
          selectSession(r.id);
        } else {
          alert("Could not resume this session.");
        }
      });
    } else {
      rbControlsEl.innerHTML = '<div class="rb-hint">Select or create a session to see its controls.</div>';
    }
    return;
  }

  const selOpts = (opts, cur) =>
    opts.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === cur ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  const modeOpts = selOpts(MODE_OPTIONS, s.mode || "default");
  const effortOpts = selOpts(EFFORT_OPTIONS, s.effort || "");
  const thinkingOpts = selOpts(THINKING_OPTIONS, s.thinking || "adaptive");
  let modelOpts = `<option value="" ${!s.model ? "selected" : ""}>Default</option>`;
  for (const m of models) {
    modelOpts += `<option value="${escapeHtml(m.value)}" ${m.value === s.model ? "selected" : ""}>${escapeHtml(m.displayName || m.value)}</option>`;
  }
  rbControlsEl.innerHTML =
    `<div class="rb-section">
       <label class="rb-label">🛡 Mode</label>
       <select id="ctl-mode" class="hdr-select">${modeOpts}</select>
       <div class="rb-note">Ask before edits · Auto-accept edits · Plan (read-only) · Auto (runs everything). Reads always run.</div>
       <label class="rb-label">🧠 Model</label>
       <select id="ctl-model" class="hdr-select">${modelOpts}</select>
       <label class="rb-label">🎚 Reasoning effort</label>
       <select id="ctl-effort" class="hdr-select">${effortOpts}</select>
       <label class="rb-label">💭 Extended thinking</label>
       <select id="ctl-thinking" class="hdr-select">${thinkingOpts}</select>
       <label class="rb-label">🌐 Browser (UI testing)</label>
       <label class="rb-check"><input type="checkbox" id="ctl-browser" ${s.browser ? "checked" : ""}/> Enable Playwright browser tools</label>
       <div class="rb-note">Lets Claude navigate, click, type &amp; screenshot a real browser. First use may take a few seconds to start.</div>
       <label class="rb-label">♻ Auto-continue</label>
       <label class="rb-check"><input type="checkbox" id="ctl-autocontinue" ${s.autoContinue === false ? "" : "checked"}/> Auto-continue after the 5-hour reset</label>
       <div class="rb-note">When on, this session runs a turn unattended after each usage reset — that spends tokens on its own. Turn off to make it wait for you.</div>
     </div>
     <div class="rb-actions">
       <button id="ctl-instr">📄 Instructions</button>
       <button id="ctl-stop" class="rb-stop">⏹ Stop current task</button>
       <button id="ctl-continue">▶ Continue</button>
       <button id="ctl-restart">🔄 Restart runner</button>
       <button id="ctl-end" class="rb-end">⏏ End session</button>
     </div>`;
  el("ctl-browser").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-browser`, { enabled: e.target.checked });
    pollFleet();
  });
  el("ctl-autocontinue").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/auto-continue`, { enabled: e.target.checked });
    pollFleet();
  });
  el("ctl-mode").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-mode`, { mode: e.target.value });
    pollFleet();
  });
  el("ctl-model").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-model`, { model: e.target.value });
    pollFleet();
  });
  el("ctl-effort").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-effort`, { effort: e.target.value });
    pollFleet();
  });
  el("ctl-thinking").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-thinking`, { thinking: e.target.value });
    pollFleet();
  });
  el("ctl-instr").addEventListener("click", () => openInstructions(s.id));
  el("ctl-stop").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/interrupt`);
    pollFleet();
    syncSession(s.id);
  });
  el("ctl-continue").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/continue`);
    pollFleet();
  });
  el("ctl-restart").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/restart`);
    pollFleet();
    syncSession(s.id);
  });
  el("ctl-end").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/stop`);
    pollFleet();
  });
}

// ---- instructions modal ----------------------------------------------------

let currentInstrSession = null;

async function openInstructions(id) {
  currentInstrSession = id;
  el("instr-modal").classList.remove("hidden");
  await refreshInstructions();
}

async function refreshInstructions() {
  if (!currentInstrSession) return;
  const data = await getJson(`/api/sessions/${currentInstrSession}/instructions`);
  el("instr-folder").textContent = (data && data.instructionsDir) || "—";
  const listEl = el("instr-list");
  listEl.innerHTML = "";
  const files = (data && data.files) || [];
  if (!files.length) {
    listEl.innerHTML = '<div class="instr-empty">No .md files yet.</div>';
    return;
  }
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "instr-file";
    row.innerHTML =
      `<span class="fname">${escapeHtml(f.name)}</span>` +
      `<span class="fsize">${f.size} B</span>` +
      `<button class="fdel" title="delete">✕</button>`;
    row.querySelector(".fdel").addEventListener("click", async () => {
      await api(`/api/sessions/${currentInstrSession}/instructions/delete`, { filename: f.name });
      refreshInstructions();
    });
    listEl.appendChild(row);
  }
}

el("instr-close").addEventListener("click", () => el("instr-modal").classList.add("hidden"));
el("instr-save").addEventListener("click", async () => {
  if (!currentInstrSession) return;
  const filename = el("instr-name").value.trim();
  const content = el("instr-content").value;
  if (!content.trim() && !filename) {
    alert("Enter a filename and/or content.");
    return;
  }
  const r = await api(`/api/sessions/${currentInstrSession}/instructions`, { filename, content });
  if (r && r.ok) {
    el("instr-name").value = "";
    el("instr-content").value = "";
    refreshInstructions();
  } else {
    alert("Save failed: " + ((r && r.reason) || "unknown"));
  }
});
el("instr-read").addEventListener("click", async () => {
  if (!currentInstrSession) return;
  const r = await api(`/api/sessions/${currentInstrSession}/read-instructions`);
  if (r && r.ok === false) {
    alert("Couldn't reach the runner to read instructions — it may need a Restart or distro setup.");
    return; // keep the modal open so the user can retry
  }
  el("instr-modal").classList.add("hidden");
});

// ---- per-session chat ------------------------------------------------------

let sessionPollTimer = null;
let renderedCount = 0;
let seenApprovalIds = new Set();

function selectSession(id) {
  if (sessionES) { sessionES.close(); sessionES = null; }
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
  selectedId = id;
  viewingRel = null; // leaving any past-session view
  lastControlsSig = null; // force the Controls pane (mode/model selects) to rebuild for the new session
  messagesEl.innerHTML = "";
  renderedCount = 0;
  approvalQueue = [];
  seenApprovalIds = new Set();
  lastTool = null;
  currentActivity = null;
  lastAssistantText = "";
  for (const n of el("history-list-side") ? el("history-list-side").children : []) n.classList.remove("active");
  updateComposer(); // enable the composer immediately, without waiting for the next poll
  renderStatusBar();
  renderFleet();

  // Poll-driven so the conversation loads/updates in ANY browser (including embedded ones
  // where SSE may not work). SSE, when available, just triggers an immediate resync.
  syncSession(id);
  sessionPollTimer = setInterval(() => syncSession(id), 1500);
  try {
    sessionES = new EventSource(`/api/sessions/${id}/events${tokenQuery}`);
    sessionES.onmessage = () => syncSession(id);
    // On a dropped SSE (flaky link), the 1.5s poll keeps the conversation live until EventSource
    // auto-reconnects (its reconnect replays the backlog and resyncs).
    sessionES.onerror = () => syncSession(id);
  } catch {
    /* polling covers it */
  }
}

// The 1.5s poll and the per-session SSE both call syncSession. The SSE fires once per server message,
// so during a turn there's a BURST of calls. We must COALESCE them, not race them: keep at most one
// fetch in flight and one queued re-run. A "newest-started-wins" generation race fails here — on a
// slow link each GET takes longer than the gap between SSE events, so every sync is superseded by the
// next event and dropped, freezing the chat mid-turn until a reload. Coalescing avoids that: each
// fetch returns the FULL latest s.messages, so the single trailing re-run always converges to current
// state. getJson has a timeout so a genuinely hung request can't wedge the lock (and the 1.5s poll is
// an extra backstop). renderedCount advances per item; duplicate result bubbles are skipped in
// appendMessage.
let syncing = false;
let syncDirty = false;
async function syncSession(id) {
  if (id !== selectedId) return;
  if (syncing) {
    syncDirty = true; // a sync is running; remember to re-run once with fresh data
    return;
  }
  syncing = true;
  try {
    const d = await getJson(`/api/sessions/${id}`, 6000);
    if (id === selectedId && d && Array.isArray(d.messages)) {
      if (d.messages.length < renderedCount) {
        messagesEl.innerHTML = "";
        renderedCount = 0;
      }
      while (renderedCount < d.messages.length) {
        const m = d.messages[renderedCount];
        renderedCount++; // advance first so one bad message can't wedge the loop
        try {
          appendMessage(m);
        } catch (e) {
          console.error("appendMessage failed", e);
        }
      }
      for (const a of d.pendingApprovals || []) {
        if (!seenApprovalIds.has(a.id)) {
          seenApprovalIds.add(a.id);
          enqueueApproval(a);
        }
      }
      // Live in-turn activity (thinking/responding). Refresh the working line + status bar immediately
      // so progress shows between full messages, not just on the next fleet poll.
      currentActivity = d.activity || null;
      updateWorking();
      renderStatusBar();
    }
  } finally {
    syncing = false;
    if (syncDirty && id === selectedId) {
      syncDirty = false;
      syncSession(id); // coalesced re-run picks up anything that arrived while we were fetching
    }
  }
}

let lastTool = null;
// Live in-turn activity from the runner's partial-message stream (thinking / drafting a reply). Lets
// the working line show real progress instead of a bare "Claude is working…" during long silent phases.
let currentActivity = null;

/** Short label for the current in-turn activity (thinking/responding). Tool prep defers to lastTool. */
function activityLabel(act) {
  if (!act || !act.phase) return "";
  const preview = (act.preview || "").replace(/\s+/g, " ").trim().slice(-80);
  if (act.phase === "thinking") return preview ? `💭 Thinking… ${preview}` : "💭 Thinking…";
  if (act.phase === "responding") return preview ? `✍️ ${preview}` : "✍️ Responding…";
  return ""; // "tool" phase: let the concrete tool summary (lastTool) show instead
}

/** The best one-line detail for the working line: live activity if any, else the latest tool call. */
function workingDetail() {
  return activityLabel(currentActivity) || (lastTool ? "🔧 " + toolSummary(lastTool) : "");
}

/** Compact one-line summary of a tool call: "Bash · git status", "Edit · src/app.js", etc. */
function toolSummary(m) {
  const name = m.name || "tool";
  const inp = m.input || {};
  let detail =
    inp.command || inp.file_path || inp.path || inp.pattern || inp.url || inp.description || "";
  if (!detail && inp && typeof inp === "object") {
    detail = Object.values(inp).find((v) => typeof v === "string") || "";
  }
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 90);
  return detail ? `${name} · ${detail}` : name;
}

let lastAssistantText = "";

function appendMessage(m) {
  const role = m.role || "system";
  // Tool calls aren't shown as chat bubbles — they bury the actual responses. The latest one is
  // surfaced compactly in the working line; the full record stays in History.
  if (role === "tool") {
    lastTool = m;
    updateWorking();
    return;
  }
  const text = m.text || "";
  if (role === "assistant") {
    lastAssistantText = text.trim();
  }
  // The SDK emits the final answer as BOTH an assistant text block and a "result" message — skip the
  // result bubble when it just repeats the assistant text (that's the duplicate-response the user saw).
  if (role === "result" && text.trim() && text.trim() === lastAssistantText) {
    return;
  }
  const div = document.createElement("div");
  div.className = "msg " + role;
  // Claude's responses are markdown (tables, bold, lists, code) — render them; keep user/system
  // text literal.
  if (role === "assistant" || role === "result") {
    div.classList.add("md");
    div.innerHTML = mdToHtml(text);
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- approvals -------------------------------------------------------------

function enqueueApproval(a) {
  if (approvalQueue.find((x) => x.id === a.id)) return;
  approvalQueue.push(a);
  showNextApproval();
}

function showNextApproval() {
  const modal = el("approval-modal");
  if (approvalQueue.length === 0) { modal.classList.add("hidden"); return; }
  const a = approvalQueue[0];
  el("approval-body").innerHTML =
    `<p>Session <strong>${escapeHtml((latest && (latest.sessions.find((s) => s.id === selectedId) || {}).label) || "")}</strong> wants to run:</p>
     <p><strong>${escapeHtml(a.tool)}</strong></p>
     <pre>${escapeHtml(JSON.stringify(a.input, null, 2))}</pre>`;
  modal.classList.remove("hidden");
}

el("appr-allow").addEventListener("click", () => decideApproval("allow"));
el("appr-deny").addEventListener("click", () => decideApproval("deny"));
function decideApproval(decision) {
  const a = approvalQueue.shift();
  if (a && selectedId) {
    api(`/api/sessions/${selectedId}/approval`, { id: a.id, decision });
  }
  showNextApproval();
}

// ---- composer --------------------------------------------------------------

const composer = el("composer");
const input = el("composer-input");
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
async function sendMessage() {
  const text = input.value.trim();
  if (!text || !selectedId) return;
  const id = selectedId;
  input.value = "";
  sendingSince = serverNow(); // status bar shows "Sending to Claude…" until the agent picks it up
  renderStatusBar();
  // Optimistic feedback so the UI reacts instantly even before the next poll cycle.
  if (workingEl) {
    workingTextEl.textContent = "Claude is working…";
    workingEl.classList.remove("hidden", "err");
  }
  const r = await api(`/api/sessions/${id}/message`, { text });
  if (id !== selectedId) return; // user switched sessions during the await — don't touch the shared UI
  syncSession(id); // pull the recorded user message (and any immediate reply) right away
  pollFleet(); // refresh status so the working indicator reflects reality
  if (r && r.ok === false) {
    workingTextEl.textContent = "Couldn't reach the runner — it may need a Restart or distro setup.";
    workingEl.classList.add("err");
  }
}

// ---- new session modal -----------------------------------------------------

el("btn-new").addEventListener("click", () => {
  el("new-modal").classList.remove("hidden");
  setupHostFields();
});
el("f-cancel").addEventListener("click", () => el("new-modal").classList.add("hidden"));
el("f-host").addEventListener("change", setupHostFields);
el("f-distro").addEventListener("change", () => loadRepos(el("f-distro").value));
el("f-repos").addEventListener("change", () => {
  if (el("f-repos").value) el("f-cwd").value = el("f-repos").value;
});

/** Show/hide the WSL distro+repo dropdowns based on the chosen host, loading distros for WSL. */
function setupHostFields() {
  const isWsl = el("f-host").value === "wsl";
  el("f-distro-row").classList.toggle("hidden", !isWsl);
  el("f-repos-row").classList.toggle("hidden", !isWsl);
  if (isWsl) loadDistros();
}

/** Populate the distro dropdown; optionally select a name; then load its repos. */
async function loadDistros(selectedName) {
  const data = await getJson("/api/wsl/distros");
  const sel = el("f-distro");
  const distros = (data && data.distros) || [];
  sel.innerHTML = "";
  for (const d of distros) {
    const o = document.createElement("option");
    o.value = d.name;
    o.textContent = `${d.name} (${d.state})`;
    sel.appendChild(o);
  }
  if (selectedName && distros.some((d) => d.name === selectedName)) {
    sel.value = selectedName;
  }
  if (sel.value) await loadRepos(sel.value);
}

/** Populate the repository dropdown for a distro; selecting one fills the cwd field. */
async function loadRepos(distro) {
  const sel = el("f-repos");
  sel.innerHTML = '<option value="">(loading…)</option>';
  const data = await getJson(`/api/wsl/repos?distro=${encodeURIComponent(distro)}`);
  const repos = (data && data.repos) || [];
  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = repos.length ? "(choose a repo)" : "(no git repos found — type a path below)";
  sel.appendChild(blank);
  for (const r of repos) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = r;
    sel.appendChild(o);
  }
  if (repos.length) {
    sel.value = repos[0];
    el("f-cwd").value = repos[0];
  }
}

/** Open the New Session modal pre-set to a WSL distro (from the sidebar). */
async function openNewSessionForDistro(name) {
  el("new-modal").classList.remove("hidden");
  el("f-host").value = "wsl";
  el("f-distro-row").classList.remove("hidden");
  el("f-repos-row").classList.remove("hidden");
  await loadDistros(name);
}

/** Render the sidebar list of WSL distros with running state; click to start a session there. */
async function renderWslList() {
  const data = await getJson("/api/wsl/distros");
  const listEl = el("wsl-list");
  if (!listEl) return;
  const distros = (data && data.distros) || [];
  listEl.innerHTML = "";
  for (const d of distros) {
    const running = /running/i.test(d.state);
    const item = document.createElement("div");
    item.className = "wsl-item";
    item.innerHTML =
      `<span class="dot ${running ? "running" : "stopped"}"></span>` +
      `<span class="name">${escapeHtml(d.name)}</span>` +
      (d.default ? '<span class="star">★</span>' : "") +
      `<span class="state">${escapeHtml(d.state)}</span>`;
    item.addEventListener("click", () => openNewSessionForDistro(d.name));
    listEl.appendChild(item);
  }
  if (distros.length === 0) {
    listEl.innerHTML = '<div class="side-title">none detected</div>';
  }
}

/** Open the New Session modal pre-filled for a repo from the Repositories panel. */
async function openNewSessionForRepo(g, r) {
  el("new-modal").classList.remove("hidden");
  el("f-host").value = g.host;
  el("f-label").value = r.name;
  setupHostFields();
  if (g.host === "wsl" && g.distro) {
    await loadDistros(g.distro);
  }
  el("f-cwd").value = r.path; // set after loadDistros (loadRepos would otherwise overwrite it)
}

/** Convert /api/repos groups into react-arborist node data (host group → repo leaves). */
function reposToArborist(groups) {
  return groups.map((g) => {
    const gid = g.host === "wsl" ? "wsl:" + g.distro : "local";
    return {
      id: gid,
      name: (g.host === "wsl" ? "🐧 " : "🖥 ") + g.label,
      children: (g.repos || []).map((r) => ({ id: gid + ":" + r.path, name: r.name, repo: r, group: g })),
    };
  });
}

/** react-arborist row for the repos tree: host groups + repo leaves (branch + change badge). */
function repoNode(a, info) {
  const { node, style, dragHandle } = info;
  const d = node.data;
  if (node.isInternal) {
    return a.html`<div ref=${dragHandle} style=${style} class="arb-row" onClick=${() => node.toggle()}>
      <span class="arb-arrow">${node.isOpen ? "▾" : "▸"}</span>
      <span class="arb-name">${d.name}</span>
    </div>`;
  }
  const r = d.repo;
  const badge =
    typeof r.changes === "number" && r.changes > 0
      ? a.html`<span class="repo-badge" title=${r.changes + " uncommitted change(s)"}>${r.changes}</span>`
      : r.changes === 0
        ? a.html`<span class="repo-clean" title="clean">✓</span>`
        : null;
  return a.html`<div ref=${dragHandle} style=${style} class="arb-row" title=${r.path} onClick=${() => openNewSessionForRepo(d.group, r)}>
    <span class="arb-arrow"></span>
    <span class="arb-icon">📦</span>
    <span class="arb-name">${r.name}</span>
    ${r.branch ? a.html`<span class="repo-branch">⎇ ${r.branch}</span>` : null}
    ${badge}
  </div>`;
}

let reposArborRoot = null;

function renderReposTree(a, listEl, groups) {
  try {
    if (!reposArborRoot) reposArborRoot = a.createRoot(listEl);
    const treeData = reposToArborist(groups);
    const total = treeData.reduce((n, g) => n + 1 + (g.children ? g.children.length : 0), 0);
    const width = Math.max(160, (listEl.clientWidth || 270) - 2);
    const height = Math.min(total * 26 + 6, 460);
    reposArborRoot.render(a.html`<${a.Tree}
      data=${treeData} openByDefault=${true} width=${width} height=${height}
      indent=${12} rowHeight=${26} disableDrag=${true} disableDrop=${true} disableMultiSelection=${true}
    >${(p) => repoNode(a, p)}</>`);
    setTimeout(() => {
      if (reposArborRoot && total && !listEl.querySelector(".arb-row")) {
        try { reposArborRoot.unmount(); } catch { /* ignore */ }
        reposArborRoot = null;
        renderReposFallback(listEl, groups);
      }
    }, 600);
    return true;
  } catch {
    try { if (reposArborRoot) reposArborRoot.unmount(); } catch { /* ignore */ }
    reposArborRoot = null;
    return false;
  }
}

function repoBadgeHtml(r) {
  if (typeof r.changes === "number" && r.changes > 0) {
    return `<span class="repo-badge" title="${r.changes} uncommitted change(s)">${r.changes}</span>`;
  }
  return r.changes === 0 ? '<span class="repo-clean" title="clean">✓</span>' : "";
}

/** Plain collapsible fallback tree (used if the CDN React/arborist can't load). */
function renderReposFallback(listEl, groups) {
  listEl.innerHTML = "";
  for (const g of groups) {
    const det = document.createElement("details");
    det.className = "tree-group";
    det.open = true;
    const sum = document.createElement("summary");
    sum.className = "tree-summary";
    sum.textContent = (g.host === "wsl" ? "🐧 " : "🖥 ") + g.label;
    det.appendChild(sum);
    for (const r of g.repos || []) {
      const item = document.createElement("div");
      item.className = "repo-item";
      item.style.paddingLeft = "18px";
      item.title = r.path + (r.branch ? " · " + r.branch : "");
      item.innerHTML =
        `<span class="arb-icon">📦</span><span class="repo-name">${escapeHtml(r.name)}</span>` +
        (r.branch ? `<span class="repo-branch">⎇ ${escapeHtml(r.branch)}</span>` : "") +
        repoBadgeHtml(r);
      item.addEventListener("click", () => openNewSessionForRepo(g, r));
      det.appendChild(item);
    }
    listEl.appendChild(det);
  }
}

/** Render the Repositories panel as a tree: host (local / running WSL distro) → repos with badges. */
async function renderRepos() {
  const listEl = el("repos-list");
  if (!listEl) return;
  const data = await getJson("/api/repos");
  const groups = (data && data.groups) || [];
  if (!groups.length) {
    if (reposArborRoot) {
      try { reposArborRoot.unmount(); } catch { /* ignore */ }
      reposArborRoot = null;
    }
    listEl.innerHTML =
      data && data.computing
        ? '<div class="muted-note" style="padding:4px 2px">scanning…</div>'
        : '<div class="muted-note" style="padding:4px 2px">none found</div>';
    return;
  }
  const a = await loadArborist();
  if (a && renderReposTree(a, listEl, groups)) return;
  renderReposFallback(listEl, groups);
}
el("f-create").addEventListener("click", async () => {
  const spec = {
    label: el("f-label").value.trim(),
    host: el("f-host").value,
    distro: el("f-distro").value.trim(),
    cwd: el("f-cwd").value.trim(),
    model: el("f-model").value.trim(),
    mode: el("f-mode").value,
    effort: el("f-effort").value,
    thinking: el("f-thinking").value,
    browser: el("f-browser").checked,
    autoContinue: el("f-autocontinue").checked,
    initialPrompt: el("f-prompt").value,
  };
  if (!spec.cwd) { alert("Working directory is required."); return; }
  const res = await api("/api/sessions", spec);
  el("new-modal").classList.add("hidden");
  if (res && res.id) {
    selectSession(res.id);
    renderHistorySidebar();
  }
});

// ---- past sessions in the sidebar (react-arborist tree, CDN-loaded) --------

let viewingRel = null;

/** Saved sessions not currently live, as a flat list. */
function computePast(data) {
  const sessions = (data && data.sessions) || [];
  const liveDirs = (latest && latest.sessions ? latest.sessions : []).map((s) => (s.sessionDir || "").replace(/\\/g, "/"));
  return sessions.filter((s) => {
    const rel = (s.rel || "").replace(/\\/g, "/");
    return rel && !liveDirs.some((d) => d.endsWith(rel));
  });
}

/** Group flat sessions into hostKind -> group -> repo -> [sessions]. */
function groupPast(past) {
  const tree = {};
  for (const s of past) {
    const hk = s.hostKind || "?";
    const g = s.group || "?";
    const r = s.repo || "?";
    tree[hk] = tree[hk] || {};
    tree[hk][g] = tree[hk][g] || {};
    tree[hk][g][r] = tree[hk][g][r] || [];
    tree[hk][g][r].push(s);
  }
  return tree;
}

/** Convert the grouped object into react-arborist node data ({id, name, children?}). */
function toArboristNodes(obj, prefix) {
  return Object.keys(obj).sort().map((key) => {
    const id = prefix ? prefix + "/" + key : key;
    const val = obj[key];
    if (Array.isArray(val)) {
      return {
        id,
        name: key,
        children: val.map((s) => ({ id: s.rel, name: s.title, rel: s.rel, status: s.status, messages: s.messages })),
      };
    }
    return { id, name: key, children: toArboristNodes(val, id) };
  });
}

function countArborist(nodes) {
  let n = 0;
  for (const x of nodes) {
    n++;
    if (x.children) n += countArborist(x.children);
  }
  return n;
}

// Lazy-load React + react-arborist from a CDN once (the app is zero-build, so no local bundler).
let arbor = null;
let arborRoot = null;
let arborFailed = false;
async function loadArborist() {
  if (arbor || arborFailed) return arbor;
  try {
    const [reactMod, domMod, arbMod, htmMod] = await Promise.all([
      import("https://esm.sh/react@18.3.1"),
      import("https://esm.sh/react-dom@18.3.1/client"),
      import("https://esm.sh/react-arborist@3.4.0?deps=react@18.3.1,react-dom@18.3.1"),
      import("https://esm.sh/htm@3.1.1"),
    ]);
    const R = reactMod.default || reactMod;
    const html = (htmMod.default || htmMod).bind(R.createElement);
    arbor = { R, html, createRoot: domMod.createRoot, Tree: arbMod.Tree };
  } catch {
    arborFailed = true; // offline / CDN blocked → fall back to the plain tree
    arbor = null;
  }
  return arbor;
}

/** react-arborist row renderer: folder/chat icons, name, status badge, message count. */
function nodeRenderer(a, info) {
  const { node, style, dragHandle } = info;
  const d = node.data;
  const internal = node.isInternal;
  const arrow = internal ? (node.isOpen ? "▾" : "▸") : "";
  const icon = internal ? (node.isOpen ? "📂" : "📁") : "💬";
  const cls = "arb-row" + (!internal && d.rel === viewingRel ? " active" : "");
  const onClick = () => (internal ? node.toggle() : viewPastSession(d.rel));
  return a.html`<div ref=${dragHandle} style=${style} class=${cls} title=${d.name} onClick=${onClick}>
    <span class="arb-arrow">${arrow}</span>
    <span class="arb-icon">${icon}</span>
    <span class="arb-name">${d.name}</span>
    ${internal
      ? null
      : a.html`<span class=${"badge " + (d.status || "")}>${d.status || "saved"}</span><span class="arb-meta">${d.messages}</span>`}
  </div>`;
}

function renderArborist(a, listEl, past) {
  try {
    if (!arborRoot) arborRoot = a.createRoot(listEl);
    if (!past.length) {
      arborRoot.render(a.html`<div class="muted-note" style=${{ padding: "4px 2px" }}>none yet</div>`);
      return true;
    }
    const treeData = toArboristNodes(groupPast(past), "");
    const width = Math.max(160, (listEl.clientWidth || 270) - 2);
    const height = Math.min(countArborist(treeData) * 28 + 6, 460);
    arborRoot.render(a.html`<${a.Tree}
      data=${treeData}
      openByDefault=${true}
      width=${width}
      height=${height}
      indent=${14}
      rowHeight=${28}
      disableDrag=${true}
      disableDrop=${true}
      disableMultiSelection=${true}
      className="arb-tree"
    >${(p) => nodeRenderer(a, p)}</>`);
    // Safety net: a React render error doesn't always throw synchronously (it can just render
    // nothing). If no rows appeared shortly after, abandon arborist and use the plain tree.
    setTimeout(() => {
      if (arborRoot && past.length && !listEl.querySelector(".arb-row")) {
        try { arborRoot.unmount(); } catch { /* ignore */ }
        arborRoot = null;
        arbor = null;
        arborFailed = true;
        renderFallbackTree(listEl, past);
      }
    }, 600);
    return true;
  } catch {
    try { if (arborRoot) arborRoot.unmount(); } catch { /* ignore */ }
    arborRoot = null;
    arbor = null;
    arborFailed = true;
    return false;
  }
}

/** Plain DOM fallback tree (used if the CDN React/arborist can't load). */
function renderFallbackTree(listEl, past) {
  listEl.innerHTML = "";
  if (!past.length) {
    listEl.innerHTML = '<div class="muted-note" style="padding:4px 2px">none yet</div>';
    return;
  }
  const tree = groupPast(past);
  const renderLevel = (obj, depth, container) => {
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      const det = document.createElement("details");
      det.className = "tree-group";
      det.open = depth < 2;
      const sum = document.createElement("summary");
      sum.className = "tree-summary";
      sum.style.paddingLeft = 4 + depth * 10 + "px";
      sum.textContent = (depth === 0 ? "🖥 " : Array.isArray(val) ? "📁 " : "") + key;
      det.appendChild(sum);
      if (Array.isArray(val)) {
        for (const s of val) {
          const leaf = document.createElement("div");
          leaf.className = "tree-leaf" + (s.rel === viewingRel ? " active" : "");
          leaf.style.paddingLeft = 8 + (depth + 1) * 10 + "px";
          leaf.innerHTML =
            `<span class="arb-icon">💬</span><span class="name">${escapeHtml(s.title)}</span>` +
            `<span class="badge ${escapeHtml(s.status || "")}">${escapeHtml(s.status || "saved")}</span>` +
            `<span class="leaf-meta">${s.messages}</span>`;
          leaf.addEventListener("click", () => viewPastSession(s.rel));
          det.appendChild(leaf);
        }
      } else {
        renderLevel(val, depth + 1, det);
      }
      container.appendChild(det);
    }
  };
  renderLevel(tree, 0, listEl);
}

/** List saved sessions in the sidebar (excluding live ones) — react-arborist tree, with fallback. */
async function renderHistorySidebar() {
  const listEl = el("history-list-side");
  if (!listEl) return;
  const past = computePast(await getJson("/api/history"));
  const a = await loadArborist();
  if (a && renderArborist(a, listEl, past)) return;
  renderFallbackTree(listEl, past);
}

/** Render a saved session's conversation into the main chat area, read-only. */
async function viewPastSession(rel) {
  if (sessionES) { sessionES.close(); sessionES = null; }
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
  selectedId = null;
  viewingRel = rel;
  lastTool = null;
  lastAssistantText = "";
  approvalQueue = [];
  for (const n of sessionsEl.children) n.classList.remove("active");
  renderHistorySidebar();
  updateComposer(); // read-only past view → disable the composer with a hint
  renderControls(null); // show the Resume control for this past session
  renderStatusBar();
  if (workingEl) workingEl.classList.add("hidden");
  messagesEl.innerHTML = '<div class="msg system">Loading…</div>';
  const data = await getJson(`/api/history/item?path=${encodeURIComponent(rel)}`);
  if (rel !== viewingRel) return; // switched away while loading
  if (!data || !data.meta) {
    messagesEl.innerHTML = '<div class="msg system">Could not load this session.</div>';
    return;
  }
  const m = data.meta;
  const cost = m.lastResult ? " · $" + (m.lastResult.cost || 0).toFixed(4) : "";
  chatHeaderEl.innerHTML =
    `<span><strong>${escapeHtml(m.label || "")}</strong> — <span class="badge ${escapeHtml(m.status || "")}">${escapeHtml(m.status || "saved")}</span>` +
    `${cost} · <span class="muted-note">past session</span></span>` +
    `<span class="actions"><button id="hdr-resume" class="primary">Resume ▸</button></span>`;
  const resumeBtn = el("hdr-resume");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resuming…";
      const r = await api("/api/history/resume", { rel });
      if (r && r.ok && r.id) {
        await pollFleet();
        selectSession(r.id);
      } else {
        resumeBtn.disabled = false;
        resumeBtn.textContent = "Resume ▸";
        alert("Could not resume this session.");
      }
    });
  }
  messagesEl.innerHTML = "";
  for (const e of m.interactions || []) {
    appendMessage(e.tool ? { role: "tool", name: e.tool, input: e.input } : { role: e.role, text: e.text });
  }
}

// ---- slash commands panel --------------------------------------------------

/** Render the available slash commands (filtered) into the right-side panel. */
// ---------------------------------------------------------------------------
// Intelligence tab — 26 code-intelligence tools, per-session toggles
// ---------------------------------------------------------------------------

const INTELLIGENCE_TOOLS = [
  // Token tools
  { id: "rtk",           group: "Token",   label: "RTK",              desc: "Reduced Token Kernel — greedy-select chunks within a token budget by relevance density" },
  { id: "tds",           group: "Token",   label: "TDS",              desc: "Token Diff Slicer — extract unified diff hunks with token counts" },
  { id: "noise_filter",  group: "Token",   label: "Noise Filter",     desc: "Strip shebangs, auto-gen headers and redundant blanks from source" },
  { id: "budget",        group: "Token",   label: "Context Budgeter", desc: "Fractional-knapsack packing of context items by priority within a token budget" },
  { id: "cog",           group: "Token",   label: "COG",              desc: "Claude Output Governor — truncate output at a sentence/paragraph/line boundary" },
  // Log tools
  { id: "log_dedup",     group: "Logs",    label: "Log Deduper",      desc: "Replace numbers/UUIDs/hashes with placeholders; group identical log templates" },
  { id: "stack_collapse",group: "Logs",    label: "Stack Collapse",   desc: "Keep head + tail + app frames; collapse stdlib/vendor middle frames" },
  { id: "log_classify",  group: "Logs",    label: "LIC",              desc: "Log-Intent Classifier — label lines: failure / degraded / normal / verbose" },
  { id: "trace_minimize",group: "Logs",    label: "ETM",              desc: "Execution-Trace Minimizer — collapse cold paths below a time threshold" },
  // Memory
  { id: "mem_set",       group: "Memory",  label: "Cavemem Set",      desc: "Store a value in the central persistent key-value store with optional TTL" },
  { id: "mem_get",       group: "Memory",  label: "Cavemem Get",      desc: "Retrieve a stored Cavemem value" },
  { id: "mem_list",      group: "Memory",  label: "Cavemem List",     desc: "List all keys in a Cavemem namespace" },
  { id: "mem_delete",    group: "Memory",  label: "Cavemem Delete",   desc: "Delete a Cavemem key" },
  // AST tools
  { id: "chunkhound",    group: "AST",     label: "Chunkhound",       desc: "Walk AST and emit function/class/method chunk boundaries" },
  { id: "region_extract",group: "AST",     label: "Region Extractor", desc: "Find the AST node enclosing a symbol name or line number" },
  { id: "symbol_scope",  group: "AST",     label: "SSE",              desc: "Symbol-Scoped Extractor — definition + all usages across search roots" },
  { id: "ast_horizon",   group: "AST",     label: "AST Horizon",      desc: "Keep AST subtrees reachable from seed symbol within depth N" },
  { id: "safr",          group: "AST",     label: "SAFR",             desc: "Semantic-Aware File Router — detect language and recommend tool chain" },
  // Graph tools
  { id: "graphify",      group: "Graph",   label: "Graphify",         desc: "Build import/call graph from a seed file and BFS-slice to depth N" },
  { id: "import_prune",  group: "Graph",   label: "Import Pruner",    desc: "Return only import nodes reachable within horizon depth" },
  { id: "dhl",           group: "Graph",   label: "DHL",              desc: "Dependency Horizon Limiter — BFS prune any dependency graph" },
  // Embeddings (Phase 4)
  { id: "rlec_cache",    group: "Embed",   label: "RLEC Cache",       desc: "Embed and cache repo/file chunks into the central semantic index" },
  { id: "rlec_search",   group: "Embed",   label: "RLEC Search",      desc: "Semantic search over a cached namespace — return top-k relevant chunks" },
  { id: "semantic_dedupe",group:"Embed",   label: "Semantic Deduper", desc: "Cluster texts by cosine similarity; keep one representative per cluster" },
  { id: "context_rank",  group: "Embed",   label: "Context Ranker",   desc: "Score and rank candidate chunks against a query embedding" },
  { id: "embed",         group: "Embed",   label: "Embed",            desc: "Compute raw embedding vectors for a list of texts" },
];

const TOOL_GROUPS = ["Token", "Logs", "Memory", "AST", "Graph", "Embed"];

// Curated default selection for new sessions — mirrors the backend DEFAULT_INTEL_TOOLS and the MCP
// adapter's DEFAULT_TOOLS. High-leverage, zero-setup tools that need no embeddings service.
const DEFAULT_INTEL_TOOLS = [
  "safr", "chunkhound", "region_extract", "symbol_scope",
  "tds", "noise_filter", "log_dedup", "stack_collapse",
];

let lastIntelSig = null;

function renderIntelligence() {
  if (!rbIntelligenceEl) return;
  const s = latest && selectedId ? latest.sessions.find((x) => x.id === selectedId) : null;
  const tsEnabled = !!(latest && latest.toolServer && latest.toolServer.enabled);
  const sessionOn = !!(s && s.toolServer);
  // Per-session tool selection (defaults to the curated set when the backend hasn't sent one yet).
  const selected = new Set(
    s && Array.isArray(s.tools) ? s.tools : DEFAULT_INTEL_TOOLS,
  );
  // Use a stable sig so checkboxes don't reset on every fleet poll tick.
  const sig = [
    tsEnabled ? 1 : 0,
    sessionOn ? 1 : 0,
    s ? s.id : "none",
    s ? s.status : "",
    [...selected].sort().join(","),
  ].join("|");
  if (sig === lastIntelSig) return;
  lastIntelSig = sig;

  if (!tsEnabled) {
    rbIntelligenceEl.innerHTML =
      `<div class="intel-banner intel-off">
        <div class="intel-banner-title">🧰 Tool Server not enabled</div>
        <div class="rb-note">Set <code>toolServer.enabled: true</code> in <code>config/config.yaml</code>, then run:<br><code>scripts\\start-tool-server.ps1</code></div>
       </div>`;
    return;
  }

  const masterChecked = sessionOn ? "checked" : "";
  const masterDisabled = s ? "" : "disabled";
  // Individual tool checkboxes are usable only when the tool server is enabled for this session.
  const toolDisabled = s && sessionOn ? "" : "disabled";
  const selCount = [...selected].filter((id) => INTELLIGENCE_TOOLS.some((t) => t.id === id)).length;
  let html =
    `<div class="intel-master rb-section">
       <label class="rb-check">
         <input type="checkbox" id="intel-master" ${masterChecked} ${masterDisabled}/>
         <strong>Enable tool server for this session</strong>
       </label>
       <div class="rb-note">Attaches the tool-server MCP so Claude can call the <em>selected</em> tools below
         (${selCount}/${INTELLIGENCE_TOOLS.length}). Deselected tools are blocked even in auto mode.</div>
       <div class="intel-quick">
         <button type="button" class="intel-quick-btn" data-pick="defaults" ${toolDisabled}>Defaults</button>
         <button type="button" class="intel-quick-btn" data-pick="all" ${toolDisabled}>All</button>
         <button type="button" class="intel-quick-btn" data-pick="none" ${toolDisabled}>None</button>
       </div>
     </div>`;

  for (const group of TOOL_GROUPS) {
    const tools = INTELLIGENCE_TOOLS.filter((t) => t.group === group);
    html += `<div class="intel-group rb-section"><div class="intel-group-title rb-label">${group}</div>`;
    for (const tool of tools) {
      const isDefault = DEFAULT_INTEL_TOOLS.includes(tool.id);
      html +=
        `<label class="rb-check intel-tool" title="${escapeHtml(tool.desc)}">
           <input type="checkbox" class="intel-tool-cb" data-tool="${escapeHtml(tool.id)}" ${selected.has(tool.id) ? "checked" : ""} ${toolDisabled}/>
           <span class="intel-tool-label">${escapeHtml(tool.label)}${isDefault ? ' <span class="intel-default-tag">default</span>' : ""}</span>
           <span class="intel-tool-desc">${escapeHtml(tool.desc)}</span>
         </label>`;
    }
    html += `</div>`;
  }

  rbIntelligenceEl.innerHTML = html;

  const masterEl = document.getElementById("intel-master");

  /** Persist the current per-tool selection to the backend. */
  const pushTools = async () => {
    if (!s) return;
    const tools = [...rbIntelligenceEl.querySelectorAll(".intel-tool-cb:checked")].map((cb) => cb.dataset.tool);
    await api(`/api/sessions/${s.id}/set-tools`, { tools });
    lastIntelSig = null; // force a re-render with the new selection
  };

  // Master toggle — enable/disable the tool server for the session.
  if (masterEl && s) {
    masterEl.addEventListener("change", async (e) => {
      await api(`/api/sessions/${s.id}/set-tool-server`, { enabled: e.target.checked });
      lastIntelSig = null; // force re-render (also enables/disables the tool checkboxes)
      pollFleet();
    });
  }

  // Quick-pick buttons: defaults / all / none.
  for (const btn of rbIntelligenceEl.querySelectorAll(".intel-quick-btn")) {
    btn.addEventListener("click", async () => {
      if (!s || !sessionOn) return;
      const pick = btn.dataset.pick;
      let next = [];
      if (pick === "all") next = INTELLIGENCE_TOOLS.map((t) => t.id);
      else if (pick === "defaults") next = DEFAULT_INTEL_TOOLS.slice();
      // "none" → []
      const sel = new Set(next);
      for (const cb of rbIntelligenceEl.querySelectorAll(".intel-tool-cb")) {
        cb.checked = sel.has(cb.dataset.tool);
      }
      await pushTools();
      pollFleet();
    });
  }

  // Individual tool checkboxes — persist the selection so Claude can only call checked tools.
  for (const cb of rbIntelligenceEl.querySelectorAll(".intel-tool-cb")) {
    cb.addEventListener("change", async () => {
      await pushTools();
      pollFleet();
    });
  }
}

function renderCommands() {
  if (!cmdListEl) return;
  const cmds = (latest && latest.commands) || [];
  const q = ((cmdFilterEl && cmdFilterEl.value) || "").trim().toLowerCase();
  cmdListEl.innerHTML = "";
  if (!cmds.length) {
    cmdListEl.innerHTML = '<div class="muted-note" style="padding:8px">No commands yet — start or open a session.</div>';
    return;
  }
  const filtered = cmds
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description || "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!filtered.length) {
    cmdListEl.innerHTML = '<div class="muted-note" style="padding:8px">No matches.</div>';
    return;
  }
  for (const c of filtered) {
    const item = document.createElement("div");
    item.className = "cmd-item";
    item.innerHTML =
      `<div><span class="cmd-name">/${escapeHtml(c.name)}</span>` +
      `${c.argumentHint ? `<span class="cmd-arg">${escapeHtml(c.argumentHint)}</span>` : ""}</div>` +
      `${c.description ? `<div class="cmd-desc">${escapeHtml(c.description)}</div>` : ""}`;
    item.addEventListener("click", () => insertCommand(c));
    cmdListEl.appendChild(item);
  }
}

/** Insert "/<name> " into the composer so the user can add arguments and send. */
function insertCommand(c) {
  if (!selectedId) {
    alert("Open or create a session first, then pick a command.");
    return;
  }
  if (!input) return;
  input.value = `/${c.name} `;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

function setRightTab(tab) {
  for (const t of document.querySelectorAll(".rb-tab")) t.classList.toggle("active", t.dataset.tab === tab);
  el("rb-controls").classList.toggle("hidden", tab !== "controls");
  el("rb-intelligence").classList.toggle("hidden", tab !== "intelligence");
  el("rb-commands").classList.toggle("hidden", tab !== "commands");
  if (tab === "controls") renderControls(latest && selectedId ? latest.sessions.find((x) => x.id === selectedId) : null);
  if (tab === "intelligence") renderIntelligence();
  if (tab === "commands") renderCommands();
}
for (const t of document.querySelectorAll(".rb-tab")) {
  t.addEventListener("click", () => setRightTab(t.dataset.tab));
}
if (cmdFilterEl) cmdFilterEl.addEventListener("input", renderCommands);

// ---- account actions -------------------------------------------------------

el("btn-continue-all").addEventListener("click", () => api("/api/account/continue-all"));
el("btn-set-reset").addEventListener("click", () => {
  const v = prompt("Account reset time (e.g. 2026-06-14 03:11, or +5h):", "+5h");
  if (!v) return;
  const rel = v.trim().match(/^\+\s*(\d+(?:\.\d+)?)\s*([hm])$/i);
  let resetAt;
  if (rel) {
    resetAt = serverNow() + parseFloat(rel[1]) * (rel[2].toLowerCase() === "h" ? 3600000 : 60000);
  } else {
    const p = Date.parse(v.trim().replace(" ", "T"));
    resetAt = isNaN(p) ? null : p;
  }
  if (resetAt) api("/api/account/set-reset", { resetAt });
  else alert("Could not parse: " + v);
});

// ---- history browser -------------------------------------------------------

el("btn-history").addEventListener("click", openHistory);
el("history-close").addEventListener("click", () => el("history-modal").classList.add("hidden"));

async function openHistory() {
  el("history-modal").classList.remove("hidden");
  el("history-detail").innerHTML = '<div class="muted-note">Select a session to view its conversation.</div>';
  const listEl = el("history-list");
  listEl.innerHTML = '<div class="muted-note">Loading…</div>';
  const data = await getJson("/api/history");
  el("history-root").textContent = (data && data.root) ? "Stored in: " + data.root : "";
  const sessions = (data && data.sessions) || [];
  listEl.innerHTML = "";
  if (!sessions.length) {
    listEl.innerHTML = '<div class="muted-note">No saved sessions yet.</div>';
    return;
  }
  let lastGroup = "";
  for (const s of sessions) {
    const groupLabel = `${s.hostKind} / ${s.group} / ${s.repo}`;
    if (groupLabel !== lastGroup) {
      const h = document.createElement("div");
      h.className = "history-group";
      h.textContent = groupLabel;
      listEl.appendChild(h);
      lastGroup = groupLabel;
    }
    const item = document.createElement("div");
    item.className = "history-item";
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
    item.innerHTML =
      `<span class="ht">${escapeHtml(s.title)}</span>` +
      `<span class="hmeta">${s.messages} msgs${when ? " · " + escapeHtml(when) : ""}${s.status ? " · " + escapeHtml(s.status) : ""}</span>`;
    item.addEventListener("click", () => {
      for (const n of listEl.querySelectorAll(".history-item")) n.classList.remove("active");
      item.classList.add("active");
      loadHistoryItem(s.rel);
    });
    listEl.appendChild(item);
  }
}

async function loadHistoryItem(rel) {
  const detail = el("history-detail");
  detail.innerHTML = '<div class="muted-note">Loading…</div>';
  const data = await getJson(`/api/history/item?path=${encodeURIComponent(rel)}`);
  if (!data || !data.meta) {
    detail.innerHTML = '<div class="muted-note">Could not load this session.</div>';
    return;
  }
  const m = data.meta;
  const cost = m.lastResult ? " · $" + (m.lastResult.cost || 0).toFixed(4) : "";
  let html =
    `<div class="hd-head"><strong>${escapeHtml(m.label || "")}</strong> — ${escapeHtml(m.host || "")}` +
    `${m.distro ? " (" + escapeHtml(m.distro) + ")" : ""} · ${escapeHtml(m.status || "")}${cost}<br />` +
    `<span class="muted-note">${escapeHtml(m.cwd || "")}</span></div>`;
  html += '<div class="hd-msgs">';
  let prevAssistant = "";
  for (const e of m.interactions || []) {
    const role = e.role || "system";
    const text = e.text || "";
    if (e.tool) {
      html += `<div class="msg tool">🔧 ${escapeHtml(e.tool)} ${escapeHtml(e.input ? JSON.stringify(e.input).slice(0, 200) : "")}</div>`;
    } else if (role === "assistant") {
      prevAssistant = text.trim();
      html += `<div class="msg assistant md">${mdToHtml(text)}</div>`;
    } else if (role === "result") {
      if (text.trim() && text.trim() === prevAssistant) continue; // skip result that repeats the assistant text
      html += `<div class="msg result md">${mdToHtml(text)}</div>`;
    } else {
      html += `<div class="msg ${escapeHtml(role)}">${escapeHtml(text)}</div>`;
    }
  }
  html += "</div>";
  detail.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage statistics overlay — powered by /api/usage/history
// ─────────────────────────────────────────────────────────────────────────────
const usageOverlayEl = el("usage-overlay");
let usageCharts = {}; // name → Chart instance (destroyed/recreated on refresh)
let usageData = null; // last fetched data

el("btn-usage-tab").addEventListener("click", openUsageOverlay);
const closeUsageOverlay = () => { usageOverlayEl.classList.add("hidden"); el("btn-usage-tab").classList.remove("active"); };
el("uso-close").addEventListener("click", closeUsageOverlay);
el("uso-back").addEventListener("click", closeUsageOverlay);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !usageOverlayEl.classList.contains("hidden")) closeUsageOverlay(); });

for (const t of document.querySelectorAll(".uso-tab")) {
  t.addEventListener("click", () => {
    document.querySelectorAll(".uso-tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".uso-pane").forEach((x) => x.classList.add("hidden"));
    t.classList.add("active");
    el("uso-pane-" + t.dataset.utab).classList.remove("hidden");
    if (t.dataset.utab === "scatter") {
      loadScatterTab();
    } else if (usageData) {
      renderUsageTab(t.dataset.utab, usageData);
    }
  });
}

async function openUsageOverlay() {
  usageOverlayEl.classList.remove("hidden");
  el("btn-usage-tab").classList.add("active");
  el("uso-footer").textContent = "Loading…";
  const data = await getJson("/api/usage/history");
  if (!data) { el("uso-footer").textContent = "Failed to load usage data."; return; }
  usageData = data;
  const activeTab = (document.querySelector(".uso-tab.active") || {}).dataset?.utab || "overview";
  renderUsageTab(activeTab, data);
  const { totals } = data;
  el("uso-footer").textContent =
    `${totals.sessionCount} sessions · ` +
    `${fmtK(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens)} total tokens · ` +
    `$${totals.costUsd.toFixed(4)} tracked cost · ` +
    `Data: ${el("uso-footer").textContent.includes("Loading") ? new Date().toLocaleString() : new Date().toLocaleString()}`;
  el("uso-footer").textContent =
    `${totals.sessionCount} sessions · ${fmtK(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens)} tokens · $${totals.costUsd.toFixed(4)} tracked cost · refreshed ${new Date().toLocaleTimeString()}`;
}

function fmtK(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
function fmtCost(n) { return "$" + (n || 0).toFixed(4); }
function cachePct(b) {
  const total = (b.inputTokens || 0) + (b.cacheReadTokens || 0);
  return total > 0 ? ((b.cacheReadTokens / total) * 100).toFixed(1) + "%" : "—";
}

const CHART_COLORS = [
  "#6ea8fe","#4ade80","#fbbf24","#f87171","#a78bfa","#67e8f9","#fb923c","#f472b6",
  "#34d399","#818cf8","#facc15","#38bdf8","#fb7185","#a3e635","#e879f9",
];

function destroyChart(name) {
  if (usageCharts[name]) { try { usageCharts[name].destroy(); } catch {} usageCharts[name] = null; }
}

function mkChart(canvasId, config) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  usageCharts[canvasId] = chart;
  return chart;
}

const CHART_DEFAULTS = {
  color: "#9aa3b2",
  plugins: { legend: { labels: { color: "#9aa3b2", boxWidth: 12, font: { size: 11 } } }, tooltip: { backgroundColor: "#181b24", borderColor: "#2a2f3d", borderWidth: 1, titleColor: "#e6e8ee", bodyColor: "#9aa3b2" } },
  scales: {
    x: { ticks: { color: "#9aa3b2", font: { size: 10 } }, grid: { color: "rgba(42,47,61,.5)" } },
    y: { ticks: { color: "#9aa3b2", font: { size: 10 } }, grid: { color: "rgba(42,47,61,.5)" } },
  },
};

function sortedDays(byDay, limit) {
  return Object.keys(byDay).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-(limit || 9999));
}
function sortedMonths(byMonth) {
  return Object.keys(byMonth).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
}

function renderUsageTab(tab, data) {
  const { sessions, byDay, byMonth, byModel, totals } = data;
  if (tab === "overview") renderOverview(data);
  else if (tab === "daily") renderDaily(data);
  else if (tab === "monthly") renderMonthly(data);
  else if (tab === "models") renderModels(data);
  else if (tab === "sessions") renderSessionsTable(sessions);
}

function renderOverview({ byDay, byModel, totals }) {
  // KPI cards
  const cacheTotal = totals.cacheReadTokens + totals.cacheCreationTokens;
  const allTokens = totals.inputTokens + totals.outputTokens + cacheTotal;
  const cacheHitRate = (totals.inputTokens + totals.cacheReadTokens) > 0
    ? (totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens) * 100).toFixed(1)
    : 0;
  el("uso-kpis").innerHTML = [
    { label: "Total cost (tracked)", value: fmtCost(totals.costUsd), sub: "fleet-console sessions" },
    { label: "Input tokens", value: fmtK(totals.inputTokens), sub: "prompt tokens sent" },
    { label: "Output tokens", value: fmtK(totals.outputTokens), sub: "tokens generated" },
    { label: "Cache reads", value: fmtK(totals.cacheReadTokens), sub: `${cacheHitRate}% cache hit rate` },
    { label: "Cache writes", value: fmtK(totals.cacheCreationTokens), sub: "new cache entries" },
    { label: "Sessions", value: String(totals.sessionCount), sub: `${totals.turns || 0} total turns` },
  ].map((k) => `<div class="uso-kpi"><div class="uso-kpi-label">${escapeHtml(k.label)}</div><div class="uso-kpi-value">${escapeHtml(k.value)}</div><div class="uso-kpi-sub">${escapeHtml(k.sub)}</div></div>`).join("");

  const days60 = sortedDays(byDay, 60);
  const costs = days60.map((d) => +(byDay[d].costUsd || 0).toFixed(6));
  const labels60 = days60.map((d) => d.slice(5));

  // Daily cost bar
  mkChart("chart-daily-cost", {
    type: "bar",
    data: { labels: labels60, datasets: [{ label: "Cost USD", data: costs, backgroundColor: "rgba(110,168,254,.6)", borderColor: "#6ea8fe", borderWidth: 1, borderRadius: 3 }] },
    options: { ...CHART_DEFAULTS, responsive: true, plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } } },
  });

  // Token types stacked area
  mkChart("chart-token-types", {
    type: "bar",
    data: {
      labels: labels60,
      datasets: [
        { label: "Input", data: days60.map((d) => byDay[d].inputTokens || 0), backgroundColor: "rgba(110,168,254,.7)" },
        { label: "Output", data: days60.map((d) => byDay[d].outputTokens || 0), backgroundColor: "rgba(74,222,128,.7)" },
        { label: "Cache read", data: days60.map((d) => byDay[d].cacheReadTokens || 0), backgroundColor: "rgba(251,191,36,.5)" },
      ],
    },
    options: { ...CHART_DEFAULTS, responsive: true, scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, stacked: true }, y: { ...CHART_DEFAULTS.scales.y, stacked: true } } },
  });

  // Model cost pie
  const mKeys = Object.keys(byModel).sort((a, b) => (byModel[b].costUsd || 0) - (byModel[a].costUsd || 0));
  mkChart("chart-model-cost", {
    type: "pie",
    data: { labels: mKeys.map((m) => m.replace("claude-", "").replace(/-\d{8}$/, "")), datasets: [{ data: mKeys.map((m) => +(byModel[m].costUsd || 0).toFixed(6)), backgroundColor: CHART_COLORS }] },
    options: { ...CHART_DEFAULTS, responsive: true },
  });

  // Cache hit rate line
  const cacheRates = days60.map((d) => {
    const b = byDay[d]; const denom = (b.inputTokens || 0) + (b.cacheReadTokens || 0);
    return denom > 0 ? +((b.cacheReadTokens / denom) * 100).toFixed(1) : 0;
  });
  mkChart("chart-cache-rate", {
    type: "line",
    data: { labels: labels60, datasets: [{ label: "Cache hit %", data: cacheRates, borderColor: "#4ade80", backgroundColor: "rgba(74,222,128,.1)", fill: true, tension: .3, pointRadius: 2 }] },
    options: { ...CHART_DEFAULTS, responsive: true, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: (v) => v + "%" } } } },
  });
}

function renderDaily({ byDay }) {
  const days = sortedDays(byDay);
  const labels = days.map((d) => d.slice(5));
  mkChart("chart-daily-tokens", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Input", data: days.map((d) => byDay[d].inputTokens || 0), backgroundColor: "rgba(110,168,254,.75)", stack: "t" },
        { label: "Output", data: days.map((d) => byDay[d].outputTokens || 0), backgroundColor: "rgba(74,222,128,.75)", stack: "t" },
        { label: "Cache read", data: days.map((d) => byDay[d].cacheReadTokens || 0), backgroundColor: "rgba(251,191,36,.6)", stack: "t" },
        { label: "Cache write", data: days.map((d) => byDay[d].cacheCreationTokens || 0), backgroundColor: "rgba(248,113,113,.5)", stack: "t" },
      ],
    },
    options: { ...CHART_DEFAULTS, responsive: true, scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, stacked: true }, y: { ...CHART_DEFAULTS.scales.y, stacked: true } } },
  });

  // Table
  const rows = [...days].reverse().map((d) => {
    const b = byDay[d];
    return `<tr>
      <td>${d}</td>
      <td class="num">${fmtK(b.inputTokens||0)}</td>
      <td class="num">${fmtK(b.outputTokens||0)}</td>
      <td class="num">${fmtK(b.cacheReadTokens||0)}</td>
      <td class="num">${fmtK(b.cacheCreationTokens||0)}</td>
      <td class="num cache-pct">${cachePct(b)}</td>
      <td class="num cost">${fmtCost(b.costUsd)}</td>
      <td class="num">${b.count||0}</td>
    </tr>`;
  }).join("");
  el("uso-daily-table").innerHTML = `<table class="uso-table"><thead><tr><th>Date</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Hit%</th><th class="num">Cost</th><th class="num">Sessions</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMonthly({ byMonth }) {
  const months = sortedMonths(byMonth);
  mkChart("chart-monthly-cost", {
    type: "bar",
    data: { labels: months, datasets: [{ label: "Cost USD", data: months.map((m) => +(byMonth[m].costUsd||0).toFixed(6)), backgroundColor: CHART_COLORS.slice(0, months.length), borderRadius: 4 }] },
    options: { ...CHART_DEFAULTS, responsive: true, plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } } },
  });
  mkChart("chart-monthly-tokens", {
    type: "bar",
    data: {
      labels: months,
      datasets: [
        { label: "Input", data: months.map((m) => byMonth[m].inputTokens||0), backgroundColor: "rgba(110,168,254,.75)", stack: "t" },
        { label: "Output", data: months.map((m) => byMonth[m].outputTokens||0), backgroundColor: "rgba(74,222,128,.75)", stack: "t" },
        { label: "Cache read", data: months.map((m) => byMonth[m].cacheReadTokens||0), backgroundColor: "rgba(251,191,36,.5)", stack: "t" },
      ],
    },
    options: { ...CHART_DEFAULTS, responsive: true, scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, stacked: true }, y: { ...CHART_DEFAULTS.scales.y, stacked: true } } },
  });
  const rows = [...months].reverse().map((m) => {
    const b = byMonth[m];
    return `<tr><td>${m}</td><td class="num">${fmtK(b.inputTokens||0)}</td><td class="num">${fmtK(b.outputTokens||0)}</td><td class="num">${fmtK(b.cacheReadTokens||0)}</td><td class="num cache-pct">${cachePct(b)}</td><td class="num cost">${fmtCost(b.costUsd)}</td><td class="num">${b.count||0}</td></tr>`;
  }).join("");
  el("uso-monthly-table").innerHTML = `<table class="uso-table"><thead><tr><th>Month</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Hit%</th><th class="num">Cost</th><th class="num">Sessions</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderModels({ byModel }) {
  const mKeys = Object.keys(byModel).sort((a, b) => ((byModel[b].inputTokens||0)+(byModel[b].outputTokens||0)) - ((byModel[a].inputTokens||0)+(byModel[a].outputTokens||0)));
  mkChart("chart-model-sessions", {
    type: "doughnut",
    data: { labels: mKeys.map((m) => m.replace("claude-", "").replace(/-\d{8}$/, "")), datasets: [{ data: mKeys.map((m) => byModel[m].count||0), backgroundColor: CHART_COLORS }] },
    options: { ...CHART_DEFAULTS, responsive: true },
  });
  mkChart("chart-model-tokens", {
    type: "doughnut",
    data: { labels: mKeys.map((m) => m.replace("claude-", "").replace(/-\d{8}$/, "")), datasets: [{ data: mKeys.map((m) => (byModel[m].inputTokens||0)+(byModel[m].outputTokens||0)), backgroundColor: CHART_COLORS }] },
    options: { ...CHART_DEFAULTS, responsive: true },
  });
  const rows = mKeys.map((m) => {
    const b = byModel[m];
    return `<tr><td><span class="model-chip">${escapeHtml(m)}</span></td><td class="num">${fmtK(b.inputTokens||0)}</td><td class="num">${fmtK(b.outputTokens||0)}</td><td class="num">${fmtK(b.cacheReadTokens||0)}</td><td class="num cache-pct">${cachePct(b)}</td><td class="num cost">${fmtCost(b.costUsd)}</td><td class="num">${b.count||0}</td></tr>`;
  }).join("");
  el("uso-models-table").innerHTML = `<table class="uso-table"><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Hit%</th><th class="num">Cost</th><th class="num">Sessions</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSessionsTable(sessions) {
  const top = sessions.slice(0, 250);
  const rows = top.map((s) => {
    const totalTok = (s.inputTokens||0)+(s.outputTokens||0)+(s.cacheReadTokens||0);
    return `<tr>
      <td title="${escapeHtml(s.label)}">${escapeHtml((s.label||"").slice(0,36))}</td>
      <td>${s.day||""}</td>
      <td><span class="model-chip">${escapeHtml((s.model||"?").replace("claude-","").replace(/-\d{8}$/,""))}</span></td>
      <td class="num">${fmtK(s.inputTokens||0)}</td>
      <td class="num">${fmtK(s.outputTokens||0)}</td>
      <td class="num">${fmtK(s.cacheReadTokens||0)}</td>
      <td class="num cache-pct">${cachePct(s)}</td>
      <td class="num cost">${fmtCost(s.costUsd)}</td>
      <td class="num">${s.turns||0}</td>
      <td>${escapeHtml(s.repo||"")}</td>
    </tr>`;
  }).join("");
  el("uso-sessions-table").innerHTML = `<table class="uso-table"><thead><tr><th>Label</th><th>Date</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Hit%</th><th class="num">Cost</th><th class="num">Turns</th><th>Repo</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scatter tab — per-exchange scatter subplots from all ~/.claude/projects/ JSONL
// ─────────────────────────────────────────────────────────────────────────────
let scatterData = null;
let scatterLoaded = false;

async function loadScatterTab() {
  if (scatterLoaded && scatterData) { renderScatterTab(scatterData); return; }
  el("uso-scatter-note").textContent = "Reading all exchanges from ~/.claude/projects/ … (first load may take a moment)";
  const data = await getJson("/api/usage/exchanges");
  if (!data) { el("uso-scatter-note").textContent = "Failed to load exchange data."; return; }
  scatterData = data;
  scatterLoaded = true;
  renderScatterTab(data);
}

function renderScatterTab({ exchanges, byDay, byWeek, byMonth, byModel, totals }) {
  const days = Object.keys(byDay).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const weeks = Object.keys(byWeek).filter((w) => /^\d{4}-W\d{2}$/.test(w)).sort();
  const months = Object.keys(byMonth).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();

  // x = ms at noon of the date so scatter points don't cluster at midnight
  const dayMs = (d) => Date.parse(d + "T12:00:00Z");
  const weekMs = (w) => {
    const [y, wn] = w.split("-W").map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    return jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000 + (wn - 1) * 7 * 86400000 + 3.5 * 86400000;
  };
  const monthMs = (m) => Date.parse(m + "-15T12:00:00Z");

  const xFmt = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
  };

  const scatterOpts = (xLabel, yLabel, yFmt) => ({
    responsive: true,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#181b24", borderColor: "#2a2f3d", borderWidth: 1,
        titleColor: "#e6e8ee", bodyColor: "#9aa3b2",
        callbacks: {
          title: (items) => items[0] ? xFmt(items[0].parsed.x) : "",
          label: (item) => `${yLabel}: ${yFmt(item.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        ticks: { color: "#9aa3b2", font: { size: 9 }, maxTicksLimit: 8, callback: (v) => xFmt(v) },
        grid: { color: "rgba(42,47,61,.5)" },
      },
      y: {
        ticks: { color: "#9aa3b2", font: { size: 9 }, callback: yFmt },
        grid: { color: "rgba(42,47,61,.5)" },
      },
    },
  });

  const mkScatter = (id, pts, color, label, yFmt) => {
    mkChart(id, {
      type: "scatter",
      data: { datasets: [{ label, data: pts, backgroundColor: color, pointRadius: 4, pointHoverRadius: 6 }] },
      options: scatterOpts(label, label, yFmt || fmtK),
    });
  };

  // 1. Daily input tokens
  mkScatter("sc-daily-inp",
    days.map((d) => ({ x: dayMs(d), y: byDay[d].inputTokens || 0 })),
    "rgba(110,168,254,.75)", "Input tokens", fmtK);

  // 2. Daily output tokens
  mkScatter("sc-daily-out",
    days.map((d) => ({ x: dayMs(d), y: byDay[d].outputTokens || 0 })),
    "rgba(74,222,128,.75)", "Output tokens", fmtK);

  // 3. Daily cache reads
  mkScatter("sc-daily-cr",
    days.map((d) => ({ x: dayMs(d), y: byDay[d].cacheReadTokens || 0 })),
    "rgba(251,191,36,.75)", "Cache reads", fmtK);

  // 4. Daily cache hit rate %
  mkScatter("sc-daily-hitrate",
    days.map((d) => {
      const b = byDay[d]; const denom = (b.inputTokens||0)+(b.cacheReadTokens||0);
      return { x: dayMs(d), y: denom > 0 ? +((b.cacheReadTokens/denom)*100).toFixed(1) : 0 };
    }),
    "rgba(167,139,250,.8)", "Hit rate %", (v) => v.toFixed(0) + "%");

  // 5. Weekly total tokens
  mkScatter("sc-weekly-total",
    weeks.map((w) => {
      const b = byWeek[w];
      return { x: weekMs(w), y: (b.inputTokens||0)+(b.outputTokens||0)+(b.cacheReadTokens||0) };
    }),
    "rgba(103,232,249,.8)", "Total tokens", fmtK);

  // 6. Monthly total tokens
  mkScatter("sc-monthly-total",
    months.map((m) => {
      const b = byMonth[m];
      return { x: monthMs(m), y: (b.inputTokens||0)+(b.outputTokens||0)+(b.cacheReadTokens||0) };
    }),
    "rgba(248,113,113,.8)", "Total tokens", fmtK);

  // Summary note
  const cacheHitPct = (totals.inputTokens + totals.cacheReadTokens) > 0
    ? ((totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens)) * 100).toFixed(1)
    : 0;
  el("uso-scatter-note").textContent =
    `${totals.exchanges.toLocaleString()} exchanges across ${days.length} days from all ~/.claude/projects/ JSONL files · ` +
    `${fmtK(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens)} total tokens · ${cacheHitPct}% cache hit rate`;

  // Per-model table
  const mKeys = Object.keys(byModel).sort((a, b) => ((byModel[b].inputTokens||0)+(byModel[b].outputTokens||0)) - ((byModel[a].inputTokens||0)+(byModel[a].outputTokens||0)));
  const rows = mKeys.map((m) => {
    const b = byModel[m];
    const denom = (b.inputTokens||0)+(b.cacheReadTokens||0);
    const hitPct = denom > 0 ? ((b.cacheReadTokens/denom)*100).toFixed(1)+"%" : "—";
    return `<tr><td><span class="model-chip">${escapeHtml(m)}</span></td><td class="num">${fmtK(b.inputTokens||0)}</td><td class="num">${fmtK(b.outputTokens||0)}</td><td class="num">${fmtK(b.cacheReadTokens||0)}</td><td class="num cache-pct">${hitPct}</td><td class="num">${(b.count||0).toLocaleString()}</td></tr>`;
  }).join("");
  el("uso-scatter-model-table").innerHTML = `<div class="uso-chart-title" style="margin-bottom:6px">Per-model breakdown (all account JSONL data)</div><table class="uso-table"><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Hit%</th><th class="num">Exchanges</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---- live connection -------------------------------------------------------

function applyFleet(snapshot) {
  if (!snapshot) return;
  latest = snapshot;
  clockOffset = snapshot.now - Date.now();
  setConnected(true);
  checkBuild(snapshot.build);
  renderFleet();
}

// Detect a stale cached app.js: if the server's build differs from ours, this page is running old
// code. Show a sticky banner (click = reload) so it's obvious, instead of silently misbehaving.
function checkBuild(serverBuild) {
  if (!serverBuild || serverBuild === APP_BUILD) {
    const b = el("stale-banner");
    if (b) b.classList.add("hidden");
    return;
  }
  let b = el("stale-banner");
  if (!b) {
    b = document.createElement("div");
    b.id = "stale-banner";
    b.className = "stale-banner";
    b.addEventListener("click", () => location.reload());
    document.body.appendChild(b);
  }
  b.textContent = `⚠ This page is running an OLD version (build ${APP_BUILD}); the server is ${serverBuild}. Click here, or press Ctrl+Shift+R, to load the update.`;
  b.classList.remove("hidden");
}

function connectFleet() {
  try {
    const es = new EventSource(`/api/events${tokenQuery}`);
    es.onmessage = (ev) => {
      try { applyFleet(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    es.onerror = () => setConnected(false);
  } catch {
    /* polling covers it */
  }
}

// Polling fallback so the sidebar/usage update even where SSE is blocked (embedded browsers).
async function pollFleet() {
  const d = await getJson("/api/state");
  if (d) applyFleet(d);
  else setConnected(false);
}

function tick() {
  renderStatusBar(); // keep the elapsed timer / "Sending…" counter live
  if (!latest) return;
  countdownEl.textContent = latest.account.resetAt ? fmtCountdown(latest.account.resetAt) : "—";
  for (const span of usageBarEl ? usageBarEl.querySelectorAll(".usage-reset") : []) {
    const r = Number(span.dataset.reset);
    if (r) span.textContent = "resets " + fmtCountdown(r);
  }
  for (const node of sessionsEl.children) {
    const s = latest.sessions.find((x) => x.id === node.dataset.id);
    const timerEl = node.querySelector(".timer");
    if (s && s.status === "limited" && s.nextContinueAt && timerEl) {
      timerEl.textContent = "⌛ " + fmtCountdown(s.nextContinueAt);
    }
  }
}

if (el("sb-build")) el("sb-build").textContent = "build " + APP_BUILD;
console.log("[fleet-console] UI build " + APP_BUILD);
renderStatusBar();
updateComposer();
renderControls(null); // populate the always-visible Controls pane before the first poll
connectFleet();
pollFleet();
renderWslList();
renderHistorySidebar();
renderRepos();
setInterval(tick, 1000);
setInterval(pollFleet, 3000);
setInterval(renderWslList, 15000);
setInterval(renderHistorySidebar, 15000);
setInterval(renderRepos, 20000);
