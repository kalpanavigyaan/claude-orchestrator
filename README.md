# claude-orchestrator

Tools for owning and driving **Claude agents on the Max plan** — no `ANTHROPIC_API_KEY`, no
separate API billing. The Agent SDK / `claude` CLI authenticate with your existing Claude Code
subscription login.

## What's in this repo

| Tool | What it is | Docs |
|------|-----------|------|
| **fleet-console** (`fleet-console/`) | A zero‑build **web app** that owns multiple Claude Agent SDK sessions and lets you **interactively drive** them from a browser (laptop/iPad): markdown chat with syntax highlighting, on‑the‑fly mode/model switching, live account usage, a repositories tree, session resume, and automatic continuation after the 5‑hour reset. **The primary tool.** | [fleet-console/README.md](fleet-console/README.md) |
| **agent-fleet** (`agent-fleet/`) | Monitors and auto‑continues many Claude agents (one per VS Code window) across the host, WSL2, and Hyper‑V guests, with a dashboard you can open from any device. | [agent-fleet/README.md](agent-fleet/README.md) |

> A legacy autonomous Python CLI used to live here; it has been retired in favor of fleet-console.

## Quick start (fleet-console)

On the Windows host, with Node 18+ and `claude` logged in:

```powershell
.\scripts\start-fleet-console.ps1
# → http://127.0.0.1:4318   (open from the host, or http://<host-ip>:4318 on the LAN)
```

This installs deps on first run, seeds `fleet-console/config/config.yaml`, re‑stages the runner
into any registered WSL distros, and launches the orchestrator. See
[fleet-console/README.md](fleet-console/README.md) for configuration, WSL setup
(`scripts/setup-wsl-distro.ps1`), and the full feature tour.

## Project layout

```
fleet-console/     The web app (orchestrator + per-session runners + browser UI)
agent-fleet/       VS Code-window fleet monitor + dashboard
scripts/           Windows launchers: start-fleet-console.ps1, fleet-console.ps1, setup-wsl-distro.ps1
```

## License

See [LICENSE](LICENSE).
