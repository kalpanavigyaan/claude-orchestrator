# claude-orchestrator

A toolkit for running, managing, and optimizing **Claude Code agents on the Max plan**. No `ANTHROPIC_API_KEY`, no separate API billing — all tools authenticate with your existing Claude Code subscription via the bundled `claude` binary.

```
fleet-console/    Web app — own and drive multiple Claude Agent SDK sessions from any browser
agent-fleet/      VS Code extension fleet — monitor and auto-continue Claude across windows
tool-server/      MCP server — 26 code-intelligence tools that cut Claude's token usage
scripts/          PowerShell launchers for Windows / WSL
docs/             Architecture notes, token-efficiency review, tool savings proof
```

---

## Components

### fleet-console — the primary tool

A zero-build web application that **owns** multiple Claude Agent SDK sessions and lets you drive them from a laptop or iPad. Each session is a direct SDK `query()` — no VS Code panels, no CDP hacks. You get:

- Multi-session markdown chat with syntax highlighting
- Live account usage bar with per-window utilization and reset countdowns
- Auto-continuation after the 5-hour reset for unattended sessions
- Mode / model / effort / thinking switchable live without restarting
- WSL2 session support (runner staged inside the distro, no UNC issues)
- Session history saved as `session.json` + `conversation.md`
- Per-session instruction files (`.md`) the agent reads and follows
- Tool-server integration: 26 code-intelligence MCP tools attached per session
- **Usage Statistics tab**: daily/weekly/monthly charts and scatter subplots from all `~/.claude/projects/` JSONL data (your full Claude Code account history)

→ **[fleet-console/README.md](fleet-console/README.md)**

### agent-fleet — VS Code window fleet

A VS Code extension + orchestrator that monitors many Claude Code windows simultaneously and auto-continues each one after the 5-hour reset. Works across the Windows host, WSL2 distros, and Hyper-V guests. Useful for the **chat panel** workflow (as opposed to fleet-console's SDK sessions).

→ **[agent-fleet/README.md](agent-fleet/README.md)**

### tool-server — code-intelligence MCP server

A Rust gRPC service exposing 26 code-intelligence tools over MCP HTTP. Attached to fleet-console sessions to let Claude work with **slices** of files and logs instead of whole files — reducing input tokens by up to 88% on typical operations.

→ **[tool-server/README.md](tool-server/README.md)**

---

## Quick start

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | On the Windows host |
| Claude Code logged in | `claude` CLI authenticated on the host (`claude /login`) |
| npm | Bundled with Node |
| PowerShell 5+ | For the launch scripts |
| git (optional) | For the Repositories panel change-count badges |

### 1 — Clone and configure

```powershell
git clone https://github.com/kalpana-vigyaan/claude-orchestrator.git
cd claude-orchestrator
```

### 2 — Start fleet-console

```powershell
.\scripts\start-fleet-console.ps1
```

This installs dependencies (once), creates `fleet-console/config/config.yaml` from the example, and starts the orchestrator. Open the UI at **http://127.0.0.1:4318**.

For LAN/iPad access, bind to the network interface:

```powershell
.\scripts\start-fleet-console.ps1 -BindHost 0.0.0.0 -Token "your-secret-token"
# → http://<host-ip>:4318/?token=your-secret-token
```

### 3 — (Optional) Start the tool server

The tool server gives Claude structured access to your code (AST chunking, diff slicing, log deduplication, etc.) and is started separately:

```powershell
.\scripts\start-tool-server.ps1
# Starts Rust gRPC core (:50051) + Node MCP adapter (:4319)
```

Then enable it in `fleet-console/config/config.yaml`:

```yaml
toolServer:
  enabled: true
  port: 4319
```

See [tool-server/README.md](tool-server/README.md) for the full tool list.

### 4 — (Optional) WSL sessions

Run once per distro to stage the runner inside it:

```powershell
.\scripts\setup-wsl-distro.ps1 -Distro Ubuntu-24-04-Dev
```

Then log in inside the distro:

```bash
wsl -d Ubuntu-24-04-Dev -- claude /login
```

WSL sessions appear in the **Host** dropdown when creating a new session.

---

## Token efficiency

Several features work together to reduce Claude's token consumption on the Max plan:

| Feature | How it saves tokens |
|---|---|
| **Curated tool default set** (8 of 26) | Removes ~18 tool schemas from every request; schemas are input tokens even when tools aren't called |
| **Per-session tool selection** (Intelligence tab) | Block tools Claude can't call — enforced in `canUseTool` even in unattended mode |
| **`region_extract` / `chunkhound`** | Read one function instead of the whole file — measured **88% fewer tokens** on real repo data |
| **`tds` (diff slicer)** | Send changed hunks instead of full files — measured **87% fewer tokens** on real git diffs |
| **`log_dedup`** | Collapse repeated log lines into templates — measured **63% fewer tokens** on real npm logs |
| **Extended thinking `off` for unattended sessions** | Thinking tokens add up on every auto-continue turn where no human reads the reasoning |
| **Usage poll raised to 60 s** | The 5-second default spawned a full SDK process every 5 s; 60 s reduces CPU/process churn by 12× |
| **Partial message streaming disabled for unattended sessions** | No live-typing indicator needed when nobody is watching |

Full analysis, measurements on real data, and all implementation references: **[docs/reviews/2026-06-16-token-efficiency-review.md](docs/reviews/2026-06-16-token-efficiency-review.md)**

Reproducible token-savings proof (runs on your data): **[tool-server/proof/prove-token-savings.mjs](tool-server/proof/prove-token-savings.mjs)**

---

## Configuration reference

`fleet-console/config/config.yaml` (copy from `config.example.yaml`):

```yaml
server:
  host: "127.0.0.1"   # 0.0.0.0 for LAN/iPad access
  port: 4318
  token: ""           # bearer auth; open UI as /?token=<token>

sessions:
  dir: "E:/Sessions/Claude"   # where session folders are stored

usage:
  pollSeconds: 60     # how often to refresh account usage (spawns a tiny SDK process)

continue:
  bufferSeconds: 30          # wait after reset before auto-continuing
  minIntervalSeconds: 300    # minimum gap between auto-continues

repos:
  localRoots: ["E:/GitHub"]  # scanned for the Repositories panel
  maxDepth: 3

browser:
  enabled: false      # attach Playwright MCP by default for new sessions

toolServer:
  enabled: false      # attach tool-server MCP by default for new sessions
  port: 4319

# Token-saving defaults for UNATTENDED ("Auto") sessions only.
# Interactive sessions keep adaptive thinking, full streaming, and the plan default model.
unattended:
  thinking: "off"         # off | adaptive
  maxTurns: 0             # 0 = unlimited; >0 caps turns after each auto-continue
  model: ""               # "" = plan default; set to a cheaper model id for unattended work
  partialMessages: false  # true to stream per-token deltas even for headless sessions
```

---

## Repository layout

```
claude-orchestrator/
├── fleet-console/           Primary web app
│   ├── src/
│   │   ├── orchestrator.mjs     HTTP server, session registry, scheduler, usage
│   │   ├── runner.mjs           One per session — owns the Agent SDK query()
│   │   ├── config.mjs           Configuration loader (YAML + env overrides)
│   │   ├── hosts.mjs            Host adapters: local child process / WSL
│   │   ├── asyncQueue.mjs       Pushable async-iterable for mid-session messages
│   │   └── usage-fetcher.mjs    Throwaway SDK session that reads /usage
│   ├── public/
│   │   ├── index.html           Single-page app shell
│   │   ├── app.js               All UI logic (zero build, plain ESM)
│   │   └── styles.css           Dark-theme CSS
│   └── config/
│       ├── config.example.yaml  Annotated default configuration
│       └── config.yaml          Your config (gitignored)
│
├── agent-fleet/             VS Code extension fleet
│   ├── extension/src/       TypeScript extension (one per window)
│   └── orchestrator/        Zero-dep Node dashboard server
│
├── tool-server/             MCP code-intelligence server
│   ├── core/                Rust gRPC service (21 tools)
│   ├── mcp-adapter/         TypeScript MCP HTTP adapter
│   ├── embeddings/          Python FAISS embeddings service (optional)
│   └── proof/               Reproducible token-savings measurements
│
├── scripts/
│   ├── start-fleet-console.ps1   Start (or restart) fleet-console
│   ├── fleet-console.ps1         Lightweight alias
│   ├── start-tool-server.ps1     Build + start the tool server
│   └── setup-wsl-distro.ps1      One-time WSL distro setup
│
└── docs/
    ├── reviews/                   Architecture and optimization reviews
    └── default-tools-token-savings.md   Tool-selection guide
```

---

## License

[MIT](LICENSE)

