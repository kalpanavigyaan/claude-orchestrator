# Agent Fleet

Monitor and auto-continue many Claude Code **chat-panel** sessions — one per VS Code window — across the Windows host, WSL2 distros, and Hyper-V guests. When a window hits the usage limit, the fleet waits for the 5-hour reset and automatically continues the agent. A lightweight dashboard lets you watch all agents and steer any of them from a laptop or iPad.

> **Looking for a better Claude workflow?** Consider [fleet-console](../fleet-console/README.md) instead — it **owns** SDK sessions directly, which gives real interactivity, proper tool approval, and reliable auto-continue without CDP or panel automation.

Agent Fleet is the right choice when you need to manage existing **Claude Code chat-panel** sessions in VS Code windows (e.g. long-running tasks in the standard VS Code UX across multiple distros or VMs).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | On the Windows host (for the orchestrator) |
| **VS Code 1.85+** | In each window |
| **Playwright Core** *(optional)* | Only for CDP panel injection — see [Continue delivery](#continue-delivery) |

---

## Components

```
agent-fleet/
  ARCHITECTURE.md                 Design, diagrams, and grounding realities
  extension/                      VS Code extension (TypeScript) — one instance per window
    src/
      extension.ts                Controller: tick loop, scheduler, status bar
      usageWatcher.ts             Tail the Claude transcript; detect usage limits
      continueStrategy.ts         Layered continue: command → terminal → CDP
      orchestratorClient.ts       Heartbeat to the orchestrator over HTTP
      config.ts                   Extension settings
      logger.ts                   Ring-buffer event log (piggybacked on heartbeats)
      types.ts                    Shared types
  orchestrator/                   Zero-dependency Node service (Windows host)
    server.mjs                    HTTP API + SSE + static dashboard + focus + CDP trigger
    cdp-inject.mjs                Playwright CDP injector (panel webview)
    public/
      index.html  app.js  styles.css    Dashboard (iPad Safari compatible)
```

---

## Setup

### 1 — Start the orchestrator (Windows host)

```powershell
cd agent-fleet/orchestrator
node server.mjs
# → [agent-fleet] orchestrator on http://0.0.0.0:4317
```

Open the dashboard at `http://<host-ip>:4317` from your laptop or iPad. Allow the port through Windows Firewall for LAN access.

### 2 — Build and load the extension

```bash
cd agent-fleet/extension
npm install
npm run compile      # produces out/extension.js
```

**Development (one window):** open `agent-fleet/extension` in VS Code → press **F5** (Extension Development Host).

**Production (all windows):** copy the `extension/` folder to:
- Windows host: `%USERPROFILE%\.vscode\extensions\claude-agent-fleet\`
- WSL: `~/.vscode-server/extensions/claude-agent-fleet/`
- Hyper-V guest: same as WSL inside the guest

Reload VS Code in each window after copying.

### 3 — Configure each window

In each window's VS Code settings (`settings.json`):

```json
{
  "agentFleet.orchestrator.url": "http://127.0.0.1:4317",
  "agentFleet.label": "my-task-label"
}
```

| Window type | URL value |
|---|---|
| Windows host | `http://127.0.0.1:4317` |
| WSL2 | `http://<windows-host-ip>:4317` (WSL gateway, or `$(hostname).local`) |
| Hyper-V guest | `http://<host-ip-on-guest-network>:4317` |

Each window appears on the dashboard within a few seconds of loading.

---

## Continue delivery

The extension tries the following in order and stops at the first success. Choose based on how Claude runs in each window.

### Option A — Terminal (recommended, works today)

If Claude Code is running as `claude` CLI in an integrated terminal, the extension uses `terminal.sendText("continue")`. No extra setup.

Ensure the terminal name matches `agentFleet.continue.terminalPattern` (default `/claude/i`).

### Option B — Registered VS Code command

If Anthropic ships a `claude-code.continue` (or similar) command, add its id to `agentFleet.continue.commandIds`. The extension will use it automatically — making the system forward-compatible.

### Option C — CDP panel injection (chat panel only)

For the Claude Code **chat panel** (not terminal), injection requires CDP (Chrome DevTools Protocol):

1. Launch that VS Code with `--remote-debugging-port=9222` (use a different port per instance).
2. Install Playwright Core in the orchestrator:
   ```bash
   cd agent-fleet/orchestrator && npm install playwright-core
   ```
3. Discover the input selector (with the panel open):
   ```bash
   node cdp-inject.mjs --port 9222 --list
   node cdp-inject.mjs --port 9222 --text continue
   # prints INJECTED on success
   ```
4. Map the agent to its port in `orchestrator/agent-cdp.json`:
   ```json
   { "<agentId>": 9222 }
   ```
   The agent id is shown on the dashboard card and in the extension's Output Channel log.

> CDP injection is the only path for the chat panel today. It is unofficial and may break between VS Code releases. For a stable, dependency-free workflow, run Claude in a terminal (Option A) or switch to [fleet-console](../fleet-console/README.md).

---

## Dashboard

Open `http://<host-ip>:4317` from any browser. The dashboard shows:

- **Account-level** reset countdown and fleet controls (Continue all, Set reset)
- **Per-agent cards:** status (`active` / `idle` / `limited` / `offline`), reset countdown, last event, pause/resume/continue/focus buttons
- **Event log:** timestamped events from all windows
- **SSE:** updates every second via `EventSource`

---

## How it detects the usage limit

The extension reads the Claude Code session transcript from disk — the same `.jsonl` file Claude writes as it runs:

```
~/.claude/projects/<encoded-workspace-path>/<session-id>.jsonl
```

A line is classified as a **limit signal** if it:
- Matches the pattern `agentFleet.usage.limitPattern` (default `/(usage limit|rate.?limit|limit reached|out of (usage|tokens))/i`), **or**
- Contains a structured `rate_limit` / `usage_limit` object

When matched, the reset time is extracted from `resets_at` / `reset_at` / `retryAfter` (if present) or defaulted to `now + 5h`.

The pattern is intentionally configurable: the exact on-disk schema is undocumented and may change between Claude Code releases. Watch the **Event log** on the dashboard for the real line your sessions emit at 100% and adjust `limitPattern` if needed. The **Set reset** button is always available as a manual fallback.

---

## Tuning settings

```jsonc
// VS Code settings.json
{
  // URL of the orchestrator (see window-type table above)
  "agentFleet.orchestrator.url": "http://127.0.0.1:4317",

  // Friendly name shown on the dashboard card
  "agentFleet.label": "my-distro",

  // Regex that flags a transcript line as a usage limit
  "agentFleet.usage.limitPattern": "/(usage limit|rate.?limit|limit reached|out of (usage|tokens))/i",

  // Seconds to wait after reset before continuing
  "agentFleet.continue.bufferSeconds": 30,

  // Minimum gap between auto-continues (dedupe guard)
  "agentFleet.continue.minIntervalSeconds": 300,

  // Seconds of inactivity required before auto-continue fires
  "agentFleet.continue.idleGuardSeconds": 120,

  // VS Code command ids to try for continue (before terminal/CDP)
  "agentFleet.continue.commandIds": ["claude-code.continue", "claude.continue"],

  // Terminal name pattern to match for terminal sendText
  "agentFleet.continue.terminalPattern": "/claude/i"
}
```

---

## Multi-VM notes

- **Reachability:** the orchestrator binds `0.0.0.0:4317`. WSL2 and Hyper-V windows reach it at the host IP.
- **Focus window:** works for host and WSL-remote windows. Hyper-V guests have their own window server and cannot be raised from the host.
- **CDP for Hyper-V guests:** the webview renders inside the guest VM, so CDP must run inside the guest. Either run a second `cdp-inject.mjs` inside the guest, or run Claude CLI in a terminal (Option A) to avoid CDP entirely.

---

## Limitations

- Driving the **chat panel** requires CDP — an unofficial API that may break between VS Code or Claude Code releases. The terminal (`sendText`) and command paths are robust alternatives.
- The transcript "limit" line format is undocumented and may change. It is isolated behind one configurable regex.
- Everything else (detection, dashboard, heartbeats, focus, reset survival) is standard and dependency-free.


> Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and the three grounding
> realities (panel has no input API → layered continue; usage is account-wide; the usage
> marker and panel selector are environment-specific and isolated behind config).

## Components

```
agent-fleet/
  ARCHITECTURE.md          design + diagrams
  extension/               VS Code extension (TypeScript) — one per window
    package.json  tsconfig.json
    src/{extension,config,usageWatcher,continueStrategy,orchestratorClient,logger,types}.ts
  orchestrator/            zero-dependency Node service (Windows host)
    server.mjs             HTTP API + SSE + static dashboard + focus + CDP trigger
    cdp-inject.mjs         optional Playwright CDP injector (panel webview)
    public/{index.html,app.js,styles.css}   dashboard (iPad-Safari friendly)
    agent-cdp.json         (optional) { "<agentId>": <debugPort> } map for CDP
```

## Prerequisites

- **Node.js 18+** on the Windows host (for the orchestrator). Nothing else to install — the
  orchestrator and dashboard use only built-in modules.
- **VS Code 1.85+** in each window.
- *Optional, only for panel injection:* `playwright-core` in `orchestrator/`, and each VS
  Code launched with `--remote-debugging-port`.

## 1) Run the orchestrator (Windows host)

```powershell
cd agent-fleet/orchestrator
node server.mjs
# → [agent-fleet] orchestrator on http://0.0.0.0:4317  (dashboard at /)
```

Open the dashboard at `http://<host-ip>:4317` from your laptop or **iPad Safari**
(`127.0.0.1` from the host itself). Allow the port through Windows Firewall for LAN/iPad
access.

## 2) Build & load the extension (each window)

```bash
cd agent-fleet/extension
npm install
npm run compile      # produces out/extension.js
```

Then either:
- **Dev:** open `agent-fleet/extension` in VS Code and press **F5** (Extension Development
  Host), or
- **Install:** copy the `extension/` folder to your VS Code extensions dir
  (`%USERPROFILE%\.vscode\extensions\claude-agent-fleet\` on the host, `~/.vscode-server/extensions/`
  inside WSL) and reload.

Do this in **every** window you want managed (host, each WSL distro, each Hyper-V guest).

## 3) Point each window at the orchestrator

In each window's settings (`agentFleet.orchestrator.url`):
- **Host window:** `http://127.0.0.1:4317`
- **WSL2 window:** `http://<windows-host-ip>:4317` (the WSL gateway IP, or `$(hostname).local`)
- **Hyper-V guest:** `http://<host-ip-on-guest-network>:4317`

Optionally set `agentFleet.label` to a friendly name (especially to tell Hyper-V guests
apart). Each window now appears on the dashboard within a few seconds.

## How "continue" is delivered (pick what fits your sessions)

The extension tries, in order, the first mechanism that works (see
`continueStrategy.ts`). You choose by how you run Claude in each window:

1. **A VS Code command** — if Claude Code ever exposes a continue command, set its id in
   `agentFleet.continue.commandIds` and you get native injection for free.
2. **Terminal** — if you run the `claude` CLI in an integrated terminal, this works **today**
   with no extra setup (`agentFleet.continue.terminalPattern` matches the terminal name).
3. **CDP into the panel webview** — for the **chat panel**, the only path today. Set it up:
   - Launch that VS Code with `--remote-debugging-port=9222` (different port per instance).
   - `cd agent-fleet/orchestrator && npm install playwright-core`
   - Discover the input selector once (panel open):
     `node cdp-inject.mjs --port 9222 --list`
     then `node cdp-inject.mjs --port 9222 --text continue` to confirm injection prints
     `INJECTED`.
   - Map the agent to its port in `orchestrator/agent-cdp.json`:
     `{ "<agentId>": 9222 }` (the agent id is shown on the dashboard card / extension log).

> If you only need monitoring + the terminal/command continue, you can ignore CDP entirely.

## Multi-VM notes

- **Reachability:** the orchestrator binds `0.0.0.0`; WSL/Hyper-V windows reach it at the
  host IP. Set each window's `agentFleet.orchestrator.url` accordingly.
- **Focus window:** works for host and WSL-remote windows (they are host windows). Hyper-V
  guest windows live inside the VM and can't be raised from the host.
- **CDP for guests:** a guest's webview renders inside the guest, so CDP injection must run
  **inside that guest**. Run a second `node cdp-inject.mjs` there, or run the orchestrator in
  the guest in injector-only mode. The terminal/command paths run locally in the guest and
  need nothing extra.

## How the system survives a reset

An agent (or the account) hits 100% → `usageWatcher` detects it and sets `resetAt` → the
reset time shows as a countdown on the dashboard and is shared account-wide → at
`resetAt + buffer` each enabled window continues (or you press **Continue all**) → a dedupe
guard prevents doubles, and `nextContinueAt`/`lastContinueAt` persist so a window reload or a
host sleep re-arms or catches up.

## How interactive chat is preserved

The extension never holds the chat input. It acts once per reset, sends only "continue", and
**defers** if there was activity in the last `idleGuardSeconds` (so it won't fire while you
type or the agent is mid-turn). A per-window toggle (status bar click, or dashboard
pause/resume) disables it entirely. The rest of the time the panel is exactly as interactive
as always.

## Tuning (the two environment-specific spots)

- **Usage marker:** `agentFleet.usage.limitPattern` is the regex that flags a transcript line
  as a usage limit. Watch the dashboard event log for the real line your sessions emit at
  100% and adjust if needed. As a fallback, the dashboard **Set reset…** button (or the
  per-window `agentFleet.setResetTime` command) sets the reset clock manually — and because
  the limit is account-wide, one correct reset time drives the whole fleet.
- **Panel selector:** discovered via `cdp-inject.mjs --list` as above.

## Honest limitations

- Driving the **chat panel** relies on CDP (unofficial) until Claude Code ships a
  `sendMessage` command (anthropics/claude-code#27873). Terminal/command modes are robust.
- The transcript "limit" schema and the panel DOM can change between releases; both are
  isolated behind config so you re-tune one setting, not the code.
- Everything else — detection scheduling, the dashboard, heartbeats, focus, reset survival —
  is standard and dependency-free.
