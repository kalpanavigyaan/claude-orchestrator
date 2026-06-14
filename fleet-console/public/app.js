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

function api(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
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

function setConnected(on) {
  connEl.textContent = on ? "live" : "offline";
  connEl.className = "conn " + (on ? "online" : "offline");
}

// ---- fleet rendering -------------------------------------------------------

function renderFleet() {
  if (!latest) return;
  countdownEl.textContent = latest.account.resetAt ? fmtCountdown(latest.account.resetAt) : "—";

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
}

function renderChatHeader(s) {
  chatHeaderEl.innerHTML = `
    <span><strong>${escapeHtml(s.label)}</strong> — ${escapeHtml(s.status)}${s.lastResult ? " · $" + (s.lastResult.cost || 0).toFixed(4) : ""}</span>
    <span class="actions">
      <button id="hdr-continue">Continue</button>
      <button id="hdr-stop">Stop</button>
    </span>`;
  el("hdr-continue").addEventListener("click", () => api(`/api/sessions/${s.id}/continue`));
  el("hdr-stop").addEventListener("click", () => api(`/api/sessions/${s.id}/stop`));
}

// ---- per-session chat ------------------------------------------------------

function selectSession(id) {
  if (sessionES) { sessionES.close(); sessionES = null; }
  selectedId = id;
  messagesEl.innerHTML = "";
  approvalQueue = [];
  renderFleet();

  sessionES = new EventSource(`/api/sessions/${id}/events${tokenQuery}`);
  sessionES.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.kind === "backlog") {
      for (const m of data.messages) appendMessage(m);
      for (const a of data.pendingApprovals || []) enqueueApproval(a);
    } else if (data.kind === "message") {
      appendMessage(data.message);
    } else if (data.kind === "approval") {
      enqueueApproval(data.approval);
    }
  };
}

function appendMessage(m) {
  const div = document.createElement("div");
  const role = m.role || "system";
  div.className = "msg " + role;
  if (role === "tool") {
    div.textContent = `🔧 ${m.name} ${m.input ? JSON.stringify(m.input).slice(0, 200) : ""}`;
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
function sendMessage() {
  const text = input.value.trim();
  if (!text || !selectedId) return;
  api(`/api/sessions/${selectedId}/message`, { text });
  input.value = "";
}

// ---- new session modal -----------------------------------------------------

el("btn-new").addEventListener("click", () => el("new-modal").classList.remove("hidden"));
el("f-cancel").addEventListener("click", () => el("new-modal").classList.add("hidden"));
el("f-host").addEventListener("change", () => {
  el("f-distro-row").classList.toggle("hidden", el("f-host").value !== "wsl");
});
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

// ---- live connection -------------------------------------------------------

function connectFleet() {
  const es = new EventSource(`/api/events${tokenQuery}`);
  es.onmessage = (ev) => {
    try {
      latest = JSON.parse(ev.data);
      clockOffset = latest.now - Date.now();
      setConnected(true);
      renderFleet();
    } catch { /* ignore */ }
  };
  es.onerror = () => setConnected(false);
}

function tick() {
  if (!latest) return;
  countdownEl.textContent = latest.account.resetAt ? fmtCountdown(latest.account.resetAt) : "—";
  for (const node of sessionsEl.children) {
    const s = latest.sessions.find((x) => x.id === node.dataset.id);
    const timerEl = node.querySelector(".timer");
    if (s && s.status === "limited" && s.nextContinueAt && timerEl) {
      timerEl.textContent = "⌛ " + fmtCountdown(s.nextContinueAt);
    }
  }
}

connectFleet();
setInterval(tick, 1000);
