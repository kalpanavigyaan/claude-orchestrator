# Fleet Console

Own and drive **multiple Claude Agent SDK sessions from any browser** — laptop or iPad. Each session is a direct `query()` against the Claude Agent SDK (authenticated via your Claude Code subscription — no API key). You get interactive markdown chats, live account usage, and automatic continuation after the 5-hour reset.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | On the Windows host |
| **Claude Code logged in** | `claude /login` on the host. The SDK authenticates via your Max-plan subscription through the bundled `claude` binary — no `ANTHROPIC_API_KEY` needed. |
| **WSL sessions** *(optional)* | Each distro needs one-time setup — see [WSL sessions](#wsl-sessions). |
| **git** *(optional)* | Needed for change-count badges in the Repositories panel. |

---

## Quick start

```powershell
# From the repo root (Windows PowerShell):
.\scripts\start-fleet-console.ps1
# → http://127.0.0.1:4318
```

This script (re)starts fleet-console fresh: kills any running instance on the port, installs npm deps on first run, seeds `config/config.yaml` from the example, re-stages the runner into registered WSL distros, and launches the orchestrator. Use it after pulling changes or if something gets stuck.

```powershell
# Options:
.\scripts\start-fleet-console.ps1 -BindHost 0.0.0.0 -Token "my-secret" -Port 4318 -NoRestage
```

Or start directly without the script:

```bash
cd fleet-console
npm install
node src/orchestrator.mjs
```

When a token is set, open the UI as `http://<host>:4318/?token=<token>` — it is sent on every API call.

> **Server restarts:** the orchestrator holds sessions in memory. Server-side changes (`.mjs` files) require a restart. Browser-asset changes (`app.js`, `styles.css`) only need a browser reload.

---

## Configuration

Copy and edit `config/config.example.yaml` → `config/config.yaml` (gitignored). The start script creates it on first run. Precedence (highest first): **environment variable → `config/config.yaml` → `config/config.example.yaml` → built-in defaults**.

```yaml
server:
  host: "127.0.0.1"   # bind interface — use 0.0.0.0 for LAN/iPad access
  port: 4318
  token: ""           # bearer token; empty = no auth. Set for LAN access.

sessions:
  dir: "E:/Sessions/Claude"   # where session folders (json + markdown + instructions) live

usage:
  pollSeconds: 60     # how often to refresh account-wide usage (spawns a small SDK process)

continue:
  bufferSeconds: 30          # wait this long after a reset before auto-continuing
  minIntervalSeconds: 300    # minimum gap between auto-continues for a session

repos:
  localRoots: ["E:/GitHub"]  # Windows folders scanned for the Repositories panel
  maxDepth: 3

browser:
  enabled: false      # default: attach Playwright MCP browser tools for new sessions

toolServer:
  enabled: false      # default: attach the tool-server MCP for new sessions
  port: 4319
  # defaultTools:     # optional: override the curated 8-tool default for new sessions
  #   - safr
  #   - chunkhound
  #   - ...

# Token-saving defaults applied to UNATTENDED ("Auto") sessions only.
# Interactive sessions keep adaptive thinking, streaming, and the plan default model.
unattended:
  thinking: "off"         # off | adaptive — extended thinking for auto-continue turns
  maxTurns: 0             # 0 = unlimited; >0 caps turns per auto-continue
  model: ""               # "" = plan default; set to a cheaper model id (e.g. Haiku)
  partialMessages: false  # stream per-token deltas even for headless sessions
```

**Environment variable overrides** (useful in scripts/CI): `HOST`, `PORT`, `FLEET_TOKEN`, `SESSIONS_DIR`, `USAGE_POLL_SECONDS`, `CONTINUE_BUFFER_SECONDS`, `CONTINUE_MIN_INTERVAL_SECONDS`, `FLEET_BROWSER`, `TOOL_SERVER`, `TOOL_SERVER_PORT`, `UNATTENDED_THINKING`, `UNATTENDED_MAX_TURNS`, `UNATTENDED_MODEL`, `UNATTENDED_PARTIAL_MESSAGES`.

---

## The UI

### Header and usage bar

The header shows connection state and the account-reset countdown. Below it, the **usage bar** shows:
- **Current session · 5h** — utilization of the current 5-hour billing window
- **Weekly** — weekly utilization for all models and for Sonnet specifically
- **Today / This week** — request and session counts (Max plan)
- **This run** — cost, input/output tokens, and session count for this orchestrator run

### Left sidebar

- **WSL distros** — running/stopped state; click a distro to start a session there
- **Sessions** — live in-memory sessions with status and message count
- **Past sessions** — saved sessions as a collapsible `host / distro / repo` tree (click to view or resume)
- **Repositories** — git repos for the host and each running WSL distro with branch and uncommitted-change count; click a repo to start a session in it

### Center — chat

The conversation rendered as markdown (tables, syntax-highlighted code blocks, emoji). Tool calls are collapsed to a one-line "working…" indicator. The bottom status bar shows connection state, what the agent is doing, and a live elapsed timer.

### Right sidebar — Controls, Intelligence, Commands

**Controls tab:**
- **Global:** ＋ New session, History, Continue all, Set reset
- **Session:** Mode, Model, Reasoning effort, Extended thinking (all switchable live), Browser toggle, Stop/Continue/Restart/End/Resume, Instructions

**Intelligence tab:**
- Enable the tool server for the session
- Per-tool checkboxes — the 8 default tools are pre-selected and tagged `default`; blocked tools are denied even in Auto mode (enforced in `canUseTool`)
- **Defaults / All / None** quick-pick buttons
- See [Token efficiency](#token-efficiency) below

**Commands tab:** slash commands the SDK reports; click to insert into the composer.

### Usage statistics

Click **📊 Usage** in the header to open the full-screen usage overlay. Five sub-tabs:

| Tab | Contents |
|---|---|
| **Overview** | 6 KPI cards + 4 charts: daily cost bar, stacked token types, cost by model pie, cache hit rate line |
| **Daily** | Stacked token bar + full daily table (input / output / cache read / cache write / hit% / cost / sessions) |
| **Monthly** | Monthly cost bar + token bar + table |
| **Models** | Doughnut charts + per-model token/cache/cost breakdown |
| **Sessions** | Table of up to 250 sessions sorted by date (label / date / model / tokens / cache hit% / cost / turns / repo) |
| **Scatter** | 6 scatter subplots from raw JSONL data in `~/.claude/projects/` — your **full Claude Code account history**, not just fleet-console sessions. Subplots: daily input tokens, daily output tokens, daily cache reads, daily cache hit %, weekly totals, monthly totals |

Data sources:
- `fleet-console/` `session.json` files — cost and token totals per session
- `~/.claude/projects/` JSONL files — every assistant exchange from all Claude Code projects

---

## Creating a session

Click **＋ New session**:

| Field | Description |
|---|---|
| **Label** | Name in the sidebar |
| **Host** | `local` (Windows host) or `wsl`. Choosing `wsl` shows a distro dropdown and a repo dropdown (pre-fills the working directory) |
| **Working directory** | Windows path for local (`E:/GitHub/app`), native Linux path for WSL (`/home/you/app`) |
| **Model** | Blank = plan default. Switchable live from Controls |
| **Mode** | See [Permission modes](#permission-modes) |
| **Reasoning effort** | Default / Low / Medium / High / Extra high / Max |
| **Extended thinking** | Auto (off for unattended, adaptive for interactive) / Adaptive (always on) / Off |
| **Enable browser tools** | Attach Playwright MCP for UI testing |
| **Auto-continue** | Auto-send "continue" after the 5-hour reset |
| **Initial prompt** | Task to start with |

You can also start a session by clicking a **WSL distro** or a **repository** in the left sidebar.

### Permission modes

| Mode | Behaviour |
|---|---|
| **Auto (full access)** | Runs everything unattended — edits, shell commands, tools. Good for overnight tasks with auto-continue. |
| **Auto-accept edits** | Auto-approves file edits; asks before shell commands |
| **Ask before edits** | Prompts you (web modal) before every tool use |
| **Plan (read-only)** | Reads and plans; makes no changes |

Read-only tools (`Read`, `Grep`, `Glob`, `LS`) always run without prompting. Mode is switchable live from Controls.

---

## Switching settings on the fly

From the **Controls** tab, the following apply immediately to the running session — no restart, conversation context preserved:

- **Mode** → `setPermissionMode()`
- **Model** → `setModel()`
- **Reasoning effort** → `applyFlagSettings({ effort })`
- **Extended thinking** → `setMaxThinkingTokens()`
- **Browser tools** / **Tool server** → `setMcpServers()`

---

## Browser / UI testing (Playwright MCP)

Toggle **🌐 Browser** in Controls to attach [Microsoft's Playwright MCP](https://github.com/microsoft/playwright-mcp). Claude gains `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`.

- **One-time setup:** `npx playwright install chromium` (run inside the WSL distro for WSL sessions)
- Runs **headed on Windows** (you can watch); **headless elsewhere** (e.g. WSL)
- Toggle is live — no restart needed

---

## Token efficiency

The **Intelligence tab** in the right sidebar controls which tool-server tools Claude may call. The 8 default tools are pre-selected — these are the ones with the highest measured token savings on real repo data:

| Tool | What it does | Measured saving |
|---|---|---|
| `safr` | Detects file language and recommends the right tool chain | Routes Claude away from reading whole files |
| `chunkhound` | Splits a file into function/class chunk boundaries | — |
| `region_extract` | Returns just the AST node enclosing a symbol | **88.4%** fewer tokens vs reading the whole file |
| `symbol_scope` | Returns a symbol's definition + all usages | Replaces grepping every candidate file |
| `tds` | Extracts unified-diff hunks ± context | **87.2%** fewer tokens vs reading all changed files |
| `noise_filter` | Strips shebangs, auto-gen headers, blank lines | Removes boilerplate before it reaches the prompt |
| `log_dedup` | Templatizes UUIDs/timestamps/numbers; groups identical lines | **63.0%** fewer tokens on real log data |
| `stack_collapse` | Keeps app frames; drops stdlib/vendor frames | Compresses 200-frame traces to what matters |

Use **Defaults / All / None** to quickly change the selection. Unchecked tools are blocked in `canUseTool` even in Auto (full access) mode.

Full tool documentation: [docs/default-tools-token-savings.md](../docs/default-tools-token-savings.md)

---

## Stop vs End

- **⏹ Stop** — interrupts the current task via `session.interrupt()` but keeps the session alive. Send a new message immediately.
- **End session** — terminates the runner process.

---

## Session history and resume

Sessions are saved to disk as:

```
<sessions.dir>/
  <Windows|WSL>/<distro-or-hostname>/<repo>/<label>/
    session.json          metadata + interactions + last result
    conversation.md       human-readable markdown transcript
    instructions/         .md files the agent reads and follows
      001_task.md
```

**History** (Controls) browses every saved session; open one to read its full transcript.

**Resume** (Controls or past-session view) reopens the conversation: the SDK resumes by stored session id, or continues the most recent conversation in the cwd for older sessions.

---

## Session instructions

Open a session → **Instructions** (Controls). The modal lets you:
- See the instructions folder path
- List and delete existing `.md` files
- Add a new file inline
- Click **Have Claude read** — the agent is told to read every `.md` in the folder (sorted by name) and follow them

The folder is added to the agent's `additionalDirectories` (readable scope). For WSL sessions the path is translated to `/mnt/<drive>/...`.

---

## Auto-continue and account resets

When a runner hits the account limit it reports a `resetAt`. The orchestrator:
1. Shows the countdown in the usage bar
2. At `resetAt + bufferSeconds` sends `continue` to every session with **Auto-continue** on
3. A dedupe guard (minIntervalSeconds) prevents double-fires

Because the limit is account-wide, one reset drives the whole fleet. Press **Continue all** at any time to continue all sessions immediately. **Set reset** lets you override the reset time manually.

---

## WSL sessions

### One-time setup per distro

```powershell
# From the repo root, Windows PowerShell:
.\scripts\setup-wsl-distro.ps1 -Distro Ubuntu-24-04-Dev
```

This installs Node (via nvm) if needed, stages the runner and Linux SDK at `~/.fleet-console-runner` inside the distro, and records the paths in `fleet-console/wsl-runners.json`.

Then log in once inside the distro:

```bash
wsl -d Ubuntu-24-04-Dev
claude /login
```

The distro now appears in the **WSL distros** sidebar and the **Host** dropdown when creating a session.

### How WSL sessions work

The orchestrator spawns the runner with:
```
wsl.exe -d <distro> <node> <runner.mjs> --config <base64-json>
```

The runner runs natively inside the distro. The cwd is a native Linux path (`/home/you/app`). The SDK uses the Linux `claude` binary staged inside the distro — no UNC working-directory problems, no path translation for the agent.

The tool server (if enabled) is served from the Windows host; WSL runners connect to it over the Windows host IP injected at startup.

---

## Notes and limitations

- **Zero build.** `app.js` is plain ESM served directly — no bundler, no transpiler. Changes to UI files only require a browser reload.
- **Session state in memory.** Restarting the orchestrator clears live sessions (saved sessions on disk are unaffected; resume them from History).
- **`/usage` API.** The usage-fetcher uses an experimental SDK method (`/usage`). It degrades gracefully if unavailable — the usage bar shows "—" instead of numbers.
- **Mid-session control methods** (`setModel`, `setPermissionMode`, `interrupt`, `setMaxThinkingTokens`) are experimental SDK APIs. They degrade gracefully.
- **react-arborist** (past-sessions tree) is loaded from `esm.sh` CDN. If it fails to load (offline), the past-sessions panel falls back to a plain collapsible tree.
- **`auto` mode** uses `bypassPermissions` at the SDK level and approves all tool categories in `canUseTool`. For a hard sandbox, use WSL sessions or a VM.


## Prerequisites

- **Node.js 18+** on the machine running the orchestrator (your Windows host).
- **Claude Code logged in** on that machine (the SDK authenticates via your subscription
  through the bundled `claude` binary — no API key).
- For **WSL sessions:** each distro must be set up once (Node + the Linux SDK staged, and
  `claude` logged in inside it) — see [WSL sessions](#wsl-sessions--one-time-setup).
- `git` on PATH (optional) so the **Repositories** panel can show change counts for local repos.

## Run

The easiest way (Windows PowerShell), which also installs deps on first run and seeds the
config file:

```powershell
.\scripts\start-fleet-console.ps1
# → http://127.0.0.1:4318
```

Or directly:

```bash
cd fleet-console
npm install            # pulls @anthropic-ai/claude-agent-sdk (+ its bundled claude binary)
node src/orchestrator.mjs
```

Open `http://127.0.0.1:4318` on the host, or `http://<host-ip>:4318` from your laptop/iPad
(bind to the LAN with `server.host: 0.0.0.0`, and set a token).

### Start fresh

`scripts/start-fleet-console.ps1` starts the app **fresh**: it stops any instance on the port,
re‑stages the latest runner into every registered WSL distro (the staged runners are copies),
seeds `config/config.yaml` from the example on first run, then launches a clean orchestrator.
Use it after pulling changes or if something gets stuck. Options: `-Token`, `-BindHost`,
`-Port`, `-NoRestage`.

> The orchestrator keeps sessions **in memory**, so server‑side changes need a restart (the
> browser assets are served fresh, so a reload is enough for UI‑only changes).

## Configuration

Configuration lives in **`config/config.yaml`** (gitignored). Copy/edit from
[`config/config.example.yaml`](config/config.example.yaml); the start script creates it for you.
Precedence (highest first): **environment variable → `config/config.yaml` →
`config/config.example.yaml` → built‑in defaults**.

```yaml
server:   { host: "127.0.0.1", port: 4318, token: "" }   # token = bearer auth; 0.0.0.0 for LAN
sessions: { dir: "E:/Sessions/Claude" }                   # where session folders live
usage:    { pollSeconds: 5 }                              # how often account usage is refreshed
continue: { bufferSeconds: 30, minIntervalSeconds: 300 } # 5-hour auto-continue timing
repos:    { localRoots: ["E:/GitHub"], maxDepth: 3 }     # scanned for the Repositories panel
browser:  { enabled: false }                             # default Playwright browser toolset on/off
```

Env overrides (for scripts/CI): `HOST`, `PORT`, `FLEET_TOKEN`, `SESSIONS_DIR`,
`USAGE_POLL_SECONDS`, `CONTINUE_BUFFER_SECONDS`, `CONTINUE_MIN_INTERVAL_SECONDS`, `FLEET_BROWSER`.
When a token
is set, open the UI as `/?token=<token>` — it is sent on every API/SSE call.

## The UI

- **Top bar** — connection state, the **account‑reset countdown** (falls back to the 5‑hour
  window's reset), and an **account‑usage bar**: per‑window utilization (current‑session/5‑hour,
  weekly, per‑model) with live reset countdowns, plus a "this run" cost/token card.
- **Left sidebar** —
  - **WSL distros** with running/stopped state (click to start a session there);
  - **Sessions** — your live in‑memory sessions;
  - **Repositories** — git repos for the local host and each *running* WSL distro, each with its
    branch and a VS Code‑style uncommitted‑change badge (click to start a session in that repo);
  - **Past sessions** — saved sessions as a collapsible host/distro/repo tree (react‑arborist).
- **Center** — the conversation (markdown: tables, code with syntax highlighting, etc.; tool
  calls are collapsed to a one‑line "working" indicator), a composer, and a **bottom status bar**
  showing connection + what the agent is doing with a live elapsed timer.
- **Right sidebar** (always visible, two tabs) —
  - **Controls** — global actions (New session, History, Continue all, Set reset) plus the
    selected session's **Mode**, **Model**, **Reasoning effort**, **Extended thinking**, and a
    **Browser (Playwright)** toggle for UI testing, then per‑session actions (Instructions, Stop,
    Continue, Restart, End). A past session shows a **Resume** button.
  - **Commands** — the slash commands the SDK reports; click one to insert it into the chat.

## Create a session

Click **＋ New session**:

- **Label** — name in the sidebar.
- **Host** — `local` (Windows host) or `wsl`. For `wsl`, **distro** is a dropdown of detected
  distributions and **Repository** is a dropdown of the git repos found in that distro
  (selecting one fills the working directory).
- **Working directory** — Windows path for local (`E:/GitHub/app`), or a native Linux path for
  WSL (`/home/you/app`). WSL cwd is native inside the distro, so there is no UNC‑path problem.
- **Model** — blank uses your plan default (switchable later from Controls).
- **Mode** — Claude's permission modes: **Auto (full access)** runs everything unattended (good for
  the 5‑hour auto‑continue while you sleep) · **Auto‑accept edits** runs edits but asks before
  commands · **Ask before edits** prompts you to approve each tool · **Plan (read‑only)** plans
  without changing anything. Read‑only tools always run.
- **Reasoning effort** — Default / Low / Medium / High / Extra high / Max (on models that support
  it, e.g. Opus 4.x). Higher = more thinking, slower.
- **Extended thinking** — Adaptive (Claude decides how much to think) or Off.
- **Initial prompt** — the task to start with.

Type to steer at any time. You can also start a session by clicking a **WSL distro** or a
**repository** in the left sidebar.

## Switching mode, model, effort and thinking on the fly

In the **Controls** tab, the **Mode**, **Model**, **Reasoning effort** and **Extended thinking**
dropdowns apply to the running session live — no restart, conversation context preserved (via the
SDK's `setPermissionMode()` / `setModel()` / `applyFlagSettings()` / `setMaxThinkingTokens()`).
The Mode is the single permission control: it sets both the SDK permission mode and which tool
categories run without asking. **Plan** is read‑only; **Ask before edits** prompts via an approval
modal; **Auto‑accept edits** runs edits but asks for commands; **Auto** runs everything.

## Browser / UI testing

Toggle **🌐 Browser (UI testing)** in Controls (or tick **Enable browser tools** when creating a
session) to attach Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp)
server. Claude gains `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, and
`browser_take_screenshot`, so it can drive a real browser to test any web UI — including this app.
The toggle attaches/detaches the toolset live (`setMcpServers()`), no restart needed.

- **One‑time prereq:** install the browser binary where the runner runs —
  `npx playwright install chromium` (run it inside the WSL distro for WSL sessions).
- It runs **headed on Windows** (you can watch Claude click around) and **headless elsewhere**
  (e.g. WSL has no display). First use after enabling may take a few seconds while `npx` fetches
  `@playwright/mcp`. Browser tools fall in the **Other** auto‑approve category (on by default).
- Default for new sessions is set by `browser.enabled` in the config (or the `FLEET_BROWSER` env).

## Stop vs End

- **⏹ Stop** (in the working indicator and Controls) **interrupts** the current task but keeps the
  session alive, so you can immediately send a new message.
- **End session** terminates the runner.

## Resuming past sessions

Past sessions are read‑only until you click **Resume** (Controls tab, or the past‑session view).
Resuming reuses the saved folder/transcript and asks the SDK to resume the conversation — by the
stored session id, or by continuing the most recent conversation in that cwd for sessions saved
before ids were captured — so the agent keeps full context and you continue chatting.

## WSL sessions — one‑time setup

Because the SDK ships a platform‑specific `claude` binary, each WSL distro needs the SDK staged
inside it. Run the turnkey setup once per distro from the host:

```powershell
.\scripts\setup-wsl-distro.ps1 -Distro Ubuntu-24-04-DEM
```

It installs Node (nvm) if needed, stages the runner + Linux SDK at `~/.fleet-console-runner`,
and records the distro's node/runner paths in `fleet-console/wsl-runners.json`. Then log in once
inside the distro:

```bash
wsl -d Ubuntu-24-04-DEM
claude            # then /login
```

Now create a `wsl` session for that distro. The orchestrator launches the runner with
`wsl -d <distro> <node> <runner> --config …`.

> **Hyper‑V guests:** run a second copy of this orchestrator (or just the runner) *inside the
> guest* and point your browser at it, or extend `hosts.mjs` with an SSH/remote adapter.

## Account usage and the 5‑hour reset

The usage bar's numbers come from the SDK's structured `/usage` data (the same source as Claude
Code's `/usage`). The orchestrator fetches it with a tiny throwaway SDK session — once at startup
and every `usage.pollSeconds` — so it reflects live account‑wide usage even with no chat session
open and never goes stale. (The `/usage` API is experimental; the card degrades gracefully if
unavailable.)

When a runner hits the account limit it reports a `resetAt`; the dashboard shows the countdown.
At `resetAt + buffer`, every session with **auto‑continue** on (and a live runner) is sent
`continue` automatically — or press **Continue all**. **Set reset** is a manual fallback. A
dedupe/interval guard prevents double‑fires; since the limit is account‑wide, one reset drives
the whole fleet.

## Session folders, history, and instructions

Sessions are organized on disk like an editor's history, under `sessions.dir`
(`E:\Sessions\Claude` by default):

```
E:\Sessions\Claude\
  <WSL|Windows>\<distro-or-host>\<repo>\<title>\
    session.json        # canonical record: metadata + sdk session id + interactions
    conversation.md     # the same conversation rendered as readable markdown
    instructions\       # markdown instruction files for this session
      001_task.md
```

**History** (Controls tab) browses every saved session grouped by host/distro/repo; open any
one to read its full conversation.

**Instructions:** open a session → **Instructions**. The modal shows the folder, lists the `.md`
files, and lets you add one. Click **Have Claude read** and the agent is told to read every `.md`
in that folder (sorted by name) and follow it. The folder is added to the agent's readable
directories; for WSL the path is translated to `/mnt/<drive>/...` for the in‑distro agent.

## Notes / limitations

- Plain Node ESM (zero build): it runs immediately with `node`. The only browser dependency is
  react‑arborist for the past‑sessions tree, loaded from a CDN (esm.sh) with a graceful fallback
  to a plain tree if it can't load.
- `auto` policy uses `acceptEdits` so unattended runs proceed; for a hard sandbox, run those
  sessions inside a WSL distro or a guest.
- The `/usage` and the mid‑session `setModel`/`setPermissionMode`/`interrupt` controls use
  experimental SDK methods; they degrade gracefully if a method is unavailable.
