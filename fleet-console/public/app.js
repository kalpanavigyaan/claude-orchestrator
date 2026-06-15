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
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
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

    const fence = line.match(/^\s*```/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
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

function setConnected(on) {
  connEl.textContent = on ? "live" : "offline";
  connEl.className = "conn " + (on ? "online" : "offline");
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
  workingEl.classList.toggle("err", err);
  workingEl.classList.remove("hidden");
}

function renderChatHeader(s) {
  const cost = s.lastResult ? " · $" + (s.lastResult.cost || 0).toFixed(4) : "";
  chatHeaderEl.innerHTML = `
    <span><strong>${escapeHtml(s.label)}</strong> — <span class="badge ${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>${cost}</span>
    <span class="actions">
      <button id="hdr-instr">Instructions</button>
      <button id="hdr-restart">Restart</button>
      <button id="hdr-continue">Continue</button>
      <button id="hdr-stop">Stop</button>
    </span>`;
  el("hdr-instr").addEventListener("click", () => openInstructions(s.id));
  el("hdr-restart").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/restart`);
    pollFleet();
    syncSession(s.id);
  });
  el("hdr-continue").addEventListener("click", async () => {
    await api(`/api/sessions/${s.id}/continue`);
    pollFleet();
  });
  el("hdr-stop").addEventListener("click", async () => {
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
  messagesEl.innerHTML = "";
  renderedCount = 0;
  approvalQueue = [];
  seenApprovalIds = new Set();
  lastTool = null;
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

async function syncSession(id) {
  if (id !== selectedId) return;
  const d = await getJson(`/api/sessions/${id}`);
  if (!d || !Array.isArray(d.messages)) return;
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
  }
});

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
}

function tick() {
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

connectFleet();
pollFleet();
renderWslList();
setInterval(tick, 1000);
setInterval(pollFleet, 3000);
setInterval(renderWslList, 15000);
