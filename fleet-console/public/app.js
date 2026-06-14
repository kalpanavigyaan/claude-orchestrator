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
      <button id="hdr-instr">Instructions</button>
      <button id="hdr-continue">Continue</button>
      <button id="hdr-stop">Stop</button>
    </span>`;
  el("hdr-instr").addEventListener("click", () => openInstructions(s.id));
  el("hdr-continue").addEventListener("click", () => api(`/api/sessions/${s.id}/continue`));
  el("hdr-stop").addEventListener("click", () => api(`/api/sessions/${s.id}/stop`));
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
  await api(`/api/sessions/${currentInstrSession}/read-instructions`);
  el("instr-modal").classList.add("hidden");
});

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
renderWslList();
setInterval(tick, 1000);
setInterval(renderWslList, 15000);
