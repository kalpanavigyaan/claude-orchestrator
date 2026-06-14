# Claude Agent Fleet — Architecture

A system to run many Claude agents (one per VS Code window) across the Windows host, WSL2
distributions, and Hyper-V Windows guests; automatically continue each agent after the
5-hour usage reset; and monitor/steer all of them from a single dashboard (laptop or iPad).

> **Grounding reality (read this first).** Three facts shape every design decision:
>
> 1. **The Claude Code chat panel is a webview with no public input API.** A sibling VS
>    Code extension cannot type into it; a `claude-vscode.sendMessage` command is an open
>    feature request (anthropics/claude-code#27873). So "continue" is delivered through a
>    **layered strategy** (registered command → terminal `sendText` → CDP/Playwright DOM
>    injection), not a single magic call.
> 2. **Usage limits are account-wide on one rolling 5-hour window.** All agents share one
>    quota and reset together. The fleet therefore tracks a single account-level reset time
>    in addition to per-agent state.
> 3. **The exact on-disk "usage limit" marker and the panel's DOM selector are
>    environment-specific.** Both are isolated behind small, configurable modules
>    (`usageWatcher`, the CDP injector) so they can be tuned against your real transcript
>    and your real panel without touching the rest of the system.

---

## High-level system diagram

```
                                  ┌───────────────────────────────────────────┐
   iPad Safari / laptop browser   │            DASHBOARD (static web)         │
        ──────────────────────────▶  GET /api/state  (poll/SSE)              │
        manual continue/pause/...  │  POST /api/agents/:id/{continue,pause,…} │
                                   └───────────────────────────────────────────┘
                                                    │  HTTP (host:4317)
                                                    ▼
                                   ┌───────────────────────────────────────────┐
                                   │        ORCHESTRATOR (Node, host)          │
                                   │  • agent registry + per-agent state       │
                                   │  • account-level 5h reset clock           │
                                   │  • command queue per agent                │
                                   │  • serves dashboard, REST + SSE           │
                                   │  • focus-window (PowerShell)              │
                                   │  • optional CDP injector (Playwright)     │
                                   └───────────────────────────────────────────┘
                          ▲ heartbeat+state (HTTP poll, 3s)   ▲           ▲
          ┌───────────────┘                 │                 │           └─────────────┐
          │                                 │                 │                         │
 ┌─────────────────┐            ┌─────────────────┐  ┌─────────────────┐      ┌─────────────────┐
 │ VS Code window 1│            │ VS Code window 2│  │ VS Code window 3│      │ VS Code window 4│
 │ (Windows host)  │            │ (WSL2: Ubuntu)  │  │ (WSL2: distro)  │      │ (Hyper-V guest) │
 │  EXTENSION      │            │  EXTENSION      │  │  EXTENSION      │      │  EXTENSION      │
 │  • usageWatcher │            │  • usageWatcher │  │  • usageWatcher │      │  • usageWatcher │
 │  • scheduler    │            │  • scheduler    │  │  • scheduler    │      │  • scheduler    │
 │  • continueStrat│            │  • continueStrat│  │  • continueStrat│      │  • continueStrat│
 │  • status bar   │            │  • status bar   │  │  • status bar   │      │  • status bar   │
 │  Claude panel ◀─┘ continue   │  Claude panel   │  │  Claude panel   │      │  Claude panel   │
 └─────────────────┘            └─────────────────┘  └─────────────────┘      └─────────────────┘
     reads ~/.claude/projects/<encoded-cwd>/<session>.jsonl   (transcript = source of truth)
```

Each window runs the **same** extension independently. The extension is the per-window
controller; the orchestrator is a stateless-ish aggregator + command router; the dashboard
is a thin client.

---

## Per-window controller design (the extension)

Each extension instance owns exactly one VS Code window and runs five cooperating parts:

| Part | Responsibility |
|---|---|
| `usageWatcher` | Locate this window's Claude transcript file, tail it, and emit `status` (`active` / `idle` / `limited`) plus a `resetAt` when a usage limit is detected. |
| `scheduler` | When `status === "limited"`, arm a one-shot timer for `resetAt + buffer`; on fire, ask `continueStrategy` to continue (unless paused or recently active). Persists `nextContinueAt` so it survives a window reload. |
| `continueStrategy` | Deliver "continue" via the first mechanism that works: (1) a registered VS Code command, (2) `terminal.sendText` for terminal-hosted sessions, (3) a request to the orchestrator's CDP injector for panel sessions. |
| `statusBar` | Show state at a glance (`▶ active`, `⏸ paused`, `⌛ 4:59:12`), and a click toggles auto-continue for this window. |
| `orchestratorClient` | Heartbeat the window's identity + state to the orchestrator every few seconds over HTTP, and execute any commands the orchestrator returns (continue / pause / resume / reset). |

The window's **agent id** is deterministic: `sha1(host + "|" + workspacePath)` (short).
That keeps the same window mapped to the same dashboard row across reloads.

---

## How the extension detects 100% usage

The extension does **not** scrape the webview. It reads the **session transcript** that
Claude Code writes to disk — the same file the panel is rendering from:

```
<home>/.claude/projects/<encoded-workspace-path>/<session-id>.jsonl
```

1. **Find the file.** Scan `~/.claude/projects/*/`, read the last record of each candidate
   `.jsonl`, and pick the one whose recorded `cwd` matches this window's workspace folder
   and has the newest modification time. (Robust against the exact directory-encoding
   scheme, which is treated as opaque.)
2. **Tail it.** Watch the file; on each appended JSON line, classify it.
3. **Classify.** A line is a **limit** signal if it matches the configured matcher
   (`agentFleet.usage.limitPattern`, default `/(usage limit|rate.?limit|limit reached|out of (usage|tokens))/i`)
   **or** carries a structured `rate_limit`/`usage_limit` object. When matched, extract a
   reset time from a `resets_at` / `reset_at` / `retryAfter` field if present; otherwise set
   `resetAt = now + 5h`. Any non-limit line with a fresh timestamp marks the agent `active`.

> **Why a configurable matcher:** the precise field Claude Code writes when a session hits
> 100% is not part of any documented schema and can change between releases. Isolating it in
> one regex/JSON-path setting means tuning it against one real "limit" transcript line —
> visible in the dashboard's raw-event log — without code changes. A manual
> **"mark limited / set reset time"** control on the dashboard is always available as a
> fallback, and because the limit is account-wide, one correct detection (or one manual
> entry) sets the reset clock for the whole fleet.

---

## How it schedules a 5-hour wait

- On `status → limited` with `resetAt`, the scheduler computes
  `fireAt = resetAt + agentFleet.continue.bufferSeconds` (default 30s past reset) and arms a
  single `setTimeout`. `nextContinueAt` is written to the extension's `globalState`.
- On window reload/activation, the scheduler reads `globalState`; if `nextContinueAt` is in
  the future it re-arms, if in the past it fires immediately (catch-up after a laptop sleep).
- Because timers can drift across host sleep, the scheduler also re-validates against the
  wall clock on every heartbeat tick (every few seconds) and fires if `now >= fireAt`.
- A **dedupe guard** (`agentFleet.continue.minIntervalSeconds`, default 300s) prevents a
  double-continue if both the extension and the orchestrator fire near the same instant.

---

## How it triggers `claude.continue`

`continueStrategy.executeContinue()` tries, in order, and stops at the first success:

1. **Registered command.** `vscode.commands.getCommands(true)` is searched for any id in
   `agentFleet.continue.commandIds` (default candidates include `claude-code.continue`,
   `claude.continue`). If found → `executeCommand(id)`. *(This makes the system forward-
   compatible: the day Anthropic ships a real continue command, set its id here and you get
   native injection for free.)*
2. **Terminal.** If a visible terminal's name matches `agentFleet.continue.terminalPattern`
   (default `/claude/i`), `terminal.sendText("continue")`. *(Works today for any window
   running the `claude` CLI in an integrated terminal.)*
3. **CDP injection.** Otherwise POST `{ id, text:"continue" }` to the orchestrator's
   `/api/agents/:id/cdp-inject`. The orchestrator (or a same-OS injector) drives the webview
   DOM over the Chrome DevTools Protocol. *(The only way to reach the panel today; requires
   launching that VS Code with `--remote-debugging-port` and is validated by the spike
   script.)*

Every attempt and outcome is logged and reported to the orchestrator as an event.

---

## How it logs events

- **In the window:** a dedicated `OutputChannel` ("Claude Agent Fleet") records detection,
  scheduling, continue attempts, and errors with timestamps.
- **To the orchestrator:** each notable event is included in the heartbeat (`events[]`),
  buffered and shown in the dashboard's per-agent log and a global event stream.
- Events are structured `{ ts, level: "info"|"warn"|"error", message }`.

---

## How the orchestrator communicates with each window

**HTTP polling, no WebSocket, no dependencies.** Every `agentFleet.orchestrator.intervalMs`
(default 3000) each extension calls:

```
POST {orchestratorUrl}/api/agents/{id}/heartbeat
  body: { agent:{id,label,host,env,workspace,sessionFile,windowTitle}, state:{…}, events:[…] }
  resp: { commands:[ {command:"continue"|"pause"|"resume"|"reset"|"setReset", payload?} ] }
```

The orchestrator records the state, returns any queued commands (enqueued by the dashboard),
and marks the agent `online`. Missing 3 heartbeats → `offline`. This poll-and-piggyback
model needs only Node's built-in `http` on the server and `fetch` in the extension host —
zero install on both sides. Command latency is one heartbeat (≤3s), which is irrelevant for
a 5-hour cadence.

**Cross-environment reachability:** the orchestrator binds `0.0.0.0:4317` on the Windows
host. Host windows reach it at `127.0.0.1`. WSL2 windows reach the host at the WSL gateway
IP (or `$(hostname).local`). Hyper-V guests reach it at the host's IP on the guest network.
Each window's extension setting `agentFleet.orchestrator.url` points at the right host
address. (CDP injection for a guest session must run *inside* that guest — see README →
Multi-VM.)

---

## How the dashboard queries status

The dashboard is static HTML/JS served by the orchestrator at `/`. It:

- `GET /api/state` every 2s (and/or subscribes to `GET /api/events` via `EventSource`) to
  render the account-level countdown, every agent's status/timer, and recent logs.
- Issues actions as `POST /api/agents/:id/{continue,pause,resume,reset,focus}` and
  `POST /api/account/{continueAll,setReset}`.
- Is plain fetch + DOM (no framework, no build) so it loads on iPad Safari with nothing
  installed.

---

## How the system survives a reset

1. An agent (or the account) hits 100%; `usageWatcher` detects it and sets `resetAt`.
2. The reset time propagates to the orchestrator (account-level clock) and to the dashboard
   countdown.
3. At `resetAt + buffer`, the scheduler fires `continueStrategy` in each enabled window — or
   the orchestrator fires `continueAll` — and each agent resumes its conversation.
4. The dedupe guard prevents double-firing; `lastContinueAt`/`nextContinueAt` are persisted,
   so a window reload or a host sleep/wake re-arms or catches up instead of losing the event.

## How interactive Claude chat is preserved

- The extension **never** holds or blocks the chat input. It acts exactly once per reset and
  only sends the single word "continue".
- An **activity guard** defers auto-continue if the transcript shows user/agent activity
  within `agentFleet.continue.idleGuardSeconds` (default 120s) — so it won't fire while you
  are typing or the agent is mid-turn.
- A per-window **toggle** (status bar click or dashboard) disables auto-continue entirely.
- Because "continue" is delivered through the same input surface a human uses (command,
  terminal, or DOM-into-the-real-input), the panel stays fully interactive the rest of the
  time; you can wake up, read, and steer normally.
```
