/**
 * Fleet Console web client.
 *
 * Subscribes to the fleet SSE stream (session list + account countdown), opens a per-session
 * SSE stream for the selected session (interactive chat + approval prompts), and issues
 * actions over REST. Plain fetch + EventSource + DOM so it runs on iPad Safari unmodified.
 * If the orchestrator requires a token, open the page as `/?token=YOURTOKEN`.
 */

"use strict";

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

function api(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
}

function getJson(path) {
  return fetch(path, { headers: { "x-fleet-token": TOKEN } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
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

function renderUsage() {
  if (!usageBarEl) return;
  const u = latest && latest.usage;
  const totals = (u && u.totals) || { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const windows = ((u && u.windows) || [])
    .slice()
    .sort((a, b) => {
      const ia = WINDOW_ORDER.indexOf(a.type);
      const ib = WINDOW_ORDER.indexOf(b.type);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  const hasTotals = totals.costUsd > 0 || totals.inputTokens > 0 || totals.outputTokens > 0;
  if (!windows.length && !hasTotals) {
    usageBarEl.classList.add("hidden");
    usageBarEl.innerHTML = "";
    return;
  }
  usageBarEl.classList.remove("hidden");

  let html = "";
  for (const w of windows) {
    const p = clampPct(w.utilization);
    if (p == null) continue;
    const cls = p >= 90 ? "high" : p >= 70 ? "warn" : "";
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
  const nSessions = (latest && latest.sessions ? latest.sessions.length : 0);
  const plan = u && u.subscriptionType ? ` · ${escapeHtml(String(u.subscriptionType))} plan` : "";
  html +=
    `<div class="usage-card totals">
      <div class="uc-head"><span class="uc-title">This run${plan}</span></div>
      <div class="uc-big">$${(totals.costUsd || 0).toFixed(4)}</div>
      <div class="uc-sub">${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out · ${nSessions} session${nSessions === 1 ? "" : "s"}</div>
    </div>`;
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
    workingCmdEl.textContent = showCmd && lastTool ? "🔧 " + toolSummary(lastTool) : "";
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
    const w = (latest.usage && latest.usage.windows) || [];
    const fh = w.find((x) => x.type === "five_hour");
    const sd = w.find((x) => x.type === "seven_day");
    const parts = [];
    if (fh && typeof fh.utilization === "number") parts.push(`5h ${fh.utilization}%`);
    if (sd && typeof sd.utilization === "number") parts.push(`wk ${sd.utilization}%`);
    const plan = latest.usage && latest.usage.subscriptionType ? latest.usage.subscriptionType : "";
    sbUsageEl.textContent = parts.length ? (plan ? plan + " · " : "") + parts.join(" · ") : "account usage…";
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
    text = `Claude is working… ${secs(sbBusySince)}` + (lastTool ? `  ·  🔧 ${toolSummary(lastTool)}` : "");
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

const MODE_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan (read-only)" },
  { value: "acceptEdits", label: "Auto-accept edits" },
  { value: "bypassPermissions", label: "Full auto" },
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
  // Stable signature so the <select>s don't reset/close on every poll; covers all three states.
  const sig = s
    ? "live|" + [s.id, s.status, s.permissionMode, s.model, models.length].join("|")
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

  const modeOpts = MODE_OPTIONS.map(
    (m) => `<option value="${m.value}" ${m.value === (s.permissionMode || "default") ? "selected" : ""}>${escapeHtml(m.label)}</option>`
  ).join("");
  let modelOpts = `<option value="" ${!s.model ? "selected" : ""}>Default</option>`;
  for (const m of models) {
    modelOpts += `<option value="${escapeHtml(m.value)}" ${m.value === s.model ? "selected" : ""}>${escapeHtml(m.displayName || m.value)}</option>`;
  }
  rbControlsEl.innerHTML =
    `<div class="rb-section">
       <label class="rb-label">⚙ Permission mode</label>
       <select id="ctl-mode" class="hdr-select">${modeOpts}</select>
       <label class="rb-label">🧠 Model</label>
       <select id="ctl-model" class="hdr-select">${modelOpts}</select>
     </div>
     <div class="rb-actions">
       <button id="ctl-instr">📄 Instructions</button>
       <button id="ctl-stop" class="rb-stop">⏹ Stop current task</button>
       <button id="ctl-continue">▶ Continue</button>
       <button id="ctl-restart">🔄 Restart runner</button>
       <button id="ctl-end" class="rb-end">⏏ End session</button>
     </div>`;
  el("ctl-mode").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-mode`, { mode: e.target.value });
    pollFleet();
  });
  el("ctl-model").addEventListener("change", async (e) => {
    await api(`/api/sessions/${s.id}/set-model`, { model: e.target.value });
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
  } catch {
    /* polling covers it */
  }
}

// Serialize syncs: the 1.5s poll and the SSE event both call syncSession, and renderedCount is
// read before the await and written after — two overlapping calls would append the same new
// messages (the "duplicate response" bug). Run one at a time; coalesce any call made mid-flight.
let syncing = false;
let syncQueued = false;
async function syncSession(id) {
  if (id !== selectedId) return;
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  try {
    const d = await getJson(`/api/sessions/${id}`);
    if (id !== selectedId || !d || !Array.isArray(d.messages)) return;
    if (d.messages.length < renderedCount) {
      messagesEl.innerHTML = "";
      renderedCount = 0;
    }
    for (let i = renderedCount; i < d.messages.length; i++) appendMessage(d.messages[i]);
    renderedCount = d.messages.length;
    for (const a of d.pendingApprovals || []) {
      if (!seenApprovalIds.has(a.id)) {
        seenApprovalIds.add(a.id);
        enqueueApproval(a);
      }
    }
  } finally {
    syncing = false;
    if (syncQueued && selectedId) {
      syncQueued = false;
      syncSession(selectedId);
    }
  }
}

let lastTool = null;

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

function appendMessage(m) {
  const role = m.role || "system";
  // Tool calls aren't shown as chat bubbles — they bury the actual responses. The latest one is
  // surfaced compactly in the working line; the full record stays in History.
  if (role === "tool") {
    lastTool = m;
    updateWorking();
    return;
  }
  const div = document.createElement("div");
  div.className = "msg " + role;
  // Claude's responses are markdown (tables, bold, lists, code) — render them; keep user/system
  // text literal.
  if (role === "assistant" || role === "result") {
    div.classList.add("md");
    div.innerHTML = mdToHtml(m.text || "");
  } else {
    div.textContent = m.text || "";
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
el("f-create").addEventListener("click", async () => {
  const spec = {
    label: el("f-label").value.trim(),
    host: el("f-host").value,
    distro: el("f-distro").value.trim(),
    cwd: el("f-cwd").value.trim(),
    model: el("f-model").value.trim(),
    policy: el("f-policy").value,
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
  el("rb-commands").classList.toggle("hidden", tab !== "commands");
  if (tab === "controls") renderControls(latest && selectedId ? latest.sessions.find((x) => x.id === selectedId) : null);
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
  for (const e of m.interactions || []) {
    const role = e.role || "system";
    if (e.tool) {
      html += `<div class="msg tool">🔧 ${escapeHtml(e.tool)} ${escapeHtml(e.input ? JSON.stringify(e.input).slice(0, 200) : "")}</div>`;
    } else if (role === "assistant" || role === "result") {
      html += `<div class="msg ${escapeHtml(role)} md">${mdToHtml(e.text || "")}</div>`;
    } else {
      html += `<div class="msg ${escapeHtml(role)}">${escapeHtml(e.text || "")}</div>`;
    }
  }
  html += "</div>";
  detail.innerHTML = html;
}

// ---- live connection -------------------------------------------------------

function applyFleet(snapshot) {
  if (!snapshot) return;
  latest = snapshot;
  clockOffset = snapshot.now - Date.now();
  setConnected(true);
  renderFleet();
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

renderStatusBar();
updateComposer();
renderControls(null); // populate the always-visible Controls pane before the first poll
connectFleet();
pollFleet();
renderWslList();
renderHistorySidebar();
setInterval(tick, 1000);
setInterval(pollFleet, 3000);
setInterval(renderWslList, 15000);
setInterval(renderHistorySidebar, 15000);
