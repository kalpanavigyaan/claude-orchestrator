/**
 * Claude Agent Fleet dashboard client.
 *
 * Subscribes to the orchestrator's SSE stream for live snapshots (with a polling fallback),
 * renders the account-level countdown and every agent's state, ticks countdowns locally each
 * second, and issues actions (continue/pause/resume/reset/focus, continue-all, set-reset).
 * Plain fetch + DOM so it runs on iPad Safari with nothing installed.
 */

"use strict";

/** Most recent snapshot from the server. */
let latest = null;
/** Estimated (serverNow - clientNow) so local countdowns match the server clock. */
let clockOffset = 0;

const agentsEl = document.getElementById("agents");
const logEl = document.getElementById("log");
const countdownEl = document.getElementById("account-countdown");
const connEl = document.getElementById("conn");
const cardTemplate = document.getElementById("agent-card");

function api(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).catch((e) => console.error("api error", path, e));
}

function serverNow() {
  return Date.now() + clockOffset;
}

function fmtCountdown(target) {
  if (!target) {
    return "—";
  }
  let s = Math.max(0, Math.floor((target - serverNow()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function setConnected(online) {
  connEl.textContent = online ? "live" : "offline";
  connEl.className = "conn " + (online ? "online" : "offline");
}

function renderAccount() {
  if (!latest) {
    return;
  }
  countdownEl.textContent = latest.account.resetAt ? fmtCountdown(latest.account.resetAt) : "—";
}

function renderAgents() {
  if (!latest) {
    return;
  }
  const existing = new Map();
  for (const node of agentsEl.children) {
    existing.set(node.dataset.id, node);
  }

  const seen = new Set();
  for (const agent of latest.agents) {
    seen.add(agent.id);
    let node = existing.get(agent.id);
    if (!node) {
      node = cardTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = agent.id;
      node.querySelectorAll("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => onAction(agent.id, btn.dataset.act));
      });
      agentsEl.appendChild(node);
    }
    paintCard(node, agent);
  }
  for (const [id, node] of existing) {
    if (!seen.has(id)) {
      node.remove();
    }
  }
}

function paintCard(node, agent) {
  node.querySelector(".dot").className = "dot " + (agent.online ? "online" : "offline");
  node.querySelector(".name").textContent = agent.label || agent.id;
  node.querySelector(".env").textContent = agent.env || "";
  const status = agent.status || "unknown";
  const statusEl = node.querySelector(".status");
  statusEl.textContent = status;
  statusEl.className = "status " + status;

  const timerEl = node.querySelector(".timer");
  timerEl.dataset.target = agent.status === "limited" && agent.nextContinueAt ? agent.nextContinueAt : "";
  timerEl.textContent = timerEl.dataset.target ? fmtCountdown(Number(timerEl.dataset.target)) : "";

  const meta = [];
  if (agent.host) meta.push(agent.host);
  if (agent.lastContinueAt) meta.push("last continue " + new Date(agent.lastContinueAt).toLocaleTimeString());
  node.querySelector(".meta").textContent = meta.join(" · ");
  node.querySelector(".msg").textContent = agent.lastMessage || "";
}

function renderLog() {
  if (!latest) {
    return;
  }
  const lines = latest.log.slice(-200).map((e) => {
    const t = new Date(e.ts).toLocaleTimeString();
    const who = e.agentId ? ` [${e.agentId.slice(0, 6)}]` : "";
    return `<span class="lvl-${e.level}">${t}${who} ${escapeHtml(e.message)}</span>`;
  });
  logEl.innerHTML = lines.join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function tickCountdowns() {
  renderAccount();
  for (const node of agentsEl.children) {
    const timerEl = node.querySelector(".timer");
    if (timerEl && timerEl.dataset.target) {
      timerEl.textContent = fmtCountdown(Number(timerEl.dataset.target));
    }
  }
}

function applySnapshot(snap) {
  latest = snap;
  clockOffset = snap.now - Date.now();
  renderAccount();
  renderAgents();
  renderLog();
}

function onAction(id, act) {
  if (act === "continue") api(`/api/agents/${id}/continue`);
  else if (act === "pause") api(`/api/agents/${id}/pause`);
  else if (act === "resume") api(`/api/agents/${id}/resume`);
  else if (act === "reset") api(`/api/agents/${id}/reset`);
  else if (act === "focus") api(`/api/agents/${id}/focus`);
}

document.getElementById("btn-continue-all").addEventListener("click", () => {
  api("/api/account/continue-all");
});

document.getElementById("btn-set-reset").addEventListener("click", () => {
  const v = prompt("Account reset time (e.g. 2026-06-14 03:11, or +5h):", "+5h");
  if (!v) {
    return;
  }
  const resetAt = parseResetInput(v.trim());
  if (resetAt) {
    api("/api/account/set-reset", { resetAt });
  } else {
    alert("Could not parse: " + v);
  }
});

function parseResetInput(text) {
  const rel = text.match(/^\+\s*(\d+(?:\.\d+)?)\s*([hm])$/i);
  if (rel) {
    const amount = parseFloat(rel[1]);
    const unitMs = rel[2].toLowerCase() === "h" ? 3600000 : 60000;
    return serverNow() + amount * unitMs;
  }
  const parsed = Date.parse(text.replace(" ", "T"));
  return isNaN(parsed) ? null : parsed;
}

// ---- live connection: SSE with polling fallback ----------------------------

function connectSse() {
  try {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        applySnapshot(JSON.parse(ev.data));
        setConnected(true);
      } catch (e) {
        /* ignore */
      }
    };
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; the poller keeps data fresh meanwhile.
    };
  } catch {
    setConnected(false);
  }
}

async function poll() {
  try {
    const resp = await fetch("/api/state");
    if (resp.ok) {
      applySnapshot(await resp.json());
      setConnected(true);
    }
  } catch {
    setConnected(false);
  }
}

connectSse();
poll();
setInterval(poll, 4000);
setInterval(tickCountdowns, 1000);
