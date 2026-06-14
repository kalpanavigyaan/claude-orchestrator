# Claude Agent Fleet

Monitor and auto-continue many Claude agents — one per VS Code window — across the Windows
host, WSL2 distributions, and Hyper-V Windows guests. When a window hits 100% usage, the
fleet waits for the 5-hour reset and continues the agent automatically; you can wake up
anytime, open a dashboard from your laptop or iPad, watch all agents, and steer any of them.

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
