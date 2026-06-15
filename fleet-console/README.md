# Fleet Console

Own and **interactively drive multiple Claude agents from a web UI** — laptop or iPad. Each
session is a real Claude Agent SDK query this app spawns and controls, so there is no VS Code
panel to automate and no CDP. You get interactive chats (rendered as markdown with syntax
highlighting), tool‑approval prompts as web modals, live account‑usage, and automatic
continuation after the 5‑hour usage reset for sessions you leave running.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design. Original work; WotchCode was looked at
only for the *idea* of owning sessions — no code or structure was taken from it.

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
```

Env overrides (for scripts/CI): `HOST`, `PORT`, `FLEET_TOKEN`, `SESSIONS_DIR`,
`USAGE_POLL_SECONDS`, `CONTINUE_BUFFER_SECONDS`, `CONTINUE_MIN_INTERVAL_SECONDS`. When a token
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
    selected session's **permission‑mode** and **model** dropdowns and per‑session actions
    (Instructions, Stop, Continue, Restart, End). A past session shows a **Resume** button.
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
- **Policy:** `auto` runs unattended (`acceptEdits`, good for the 5‑hour auto‑continue while you
  sleep) · `ask` pops an **approval modal** for every tool call.
- **Initial prompt** — the task to start with.

Type to steer at any time. You can also start a session by clicking a **WSL distro** or a
**repository** in the left sidebar.

## Switching mode and model on the fly

In the **Controls** tab, the **permission mode** (Default / Plan / Auto‑accept edits / Full auto)
and **model** dropdowns apply to the running session live (via the SDK's `setPermissionMode()` /
`setModel()`) — no restart, conversation context preserved.

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
