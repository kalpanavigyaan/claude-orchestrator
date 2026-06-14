# Fleet Console

Own and **interactively drive multiple Claude agents from a web UI** — laptop or iPad. Each
session is a real Claude Agent SDK query this app spawns and controls, so there is no VS Code
panel to automate and no CDP. You get tabbed interactive chats, tool-approval prompts as web
modals, and automatic continuation after the 5-hour usage reset for sessions you leave
running.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design. Original work; WotchCode was looked at
only for the *idea* of owning sessions — no code or structure was taken from it.

## Prerequisites

- **Node.js 18+** on the machine running the orchestrator (your Windows host).
- **Claude Code logged in** on that machine (the SDK authenticates via your subscription
  through the bundled `claude` binary — no API key).
- For **WSL sessions:** Node 18+ **and** the SDK installed *inside that distro* (the bundled
  `claude` binary is platform-specific), plus `claude` logged in there.

## Install & run

```bash
cd fleet-console
npm install            # pulls @anthropic-ai/claude-agent-sdk (+ its bundled claude binary)
node src/orchestrator.mjs
# → [fleet-console] http://127.0.0.1:4318 (no token — set FLEET_TOKEN to lock down)
```

Open `http://127.0.0.1:4318` on the host, or `http://<host-ip>:4318` from your laptop/iPad.

**Lock it down (recommended on a LAN):**

```bash
# PowerShell
$env:FLEET_TOKEN="some-long-secret"; $env:HOST="0.0.0.0"; node src/orchestrator.mjs
```

Then open `http://<host-ip>:4318/?token=some-long-secret`. The UI passes the token on every
API/SSE call.

Other env: `PORT` (4318), `HOST` (127.0.0.1), `CONTINUE_BUFFER_SECONDS` (30),
`CONTINUE_MIN_INTERVAL_SECONDS` (300).

## Create a session

Click **New session**:

- **Label** — name in the sidebar.
- **Host** — `local` (Windows host) or `wsl`. For `wsl`, the **distro** is a dropdown of the
  distributions detected on the machine, and **Repository** is a dropdown of the git repos
  found in that distro (selecting one fills the working directory). The **sidebar** also
  lists every WSL distro with its running/stopped state — click one to start a session there.
- **Working directory** — Windows path for local (`E:/GitHub/app`), or (for WSL) auto-filled
  from the repository dropdown / a native Linux path (`/home/you/app`). WSL cwd is native
  inside the distro, so there is no UNC-path problem.
- **Model** — blank uses your plan default.
- **Policy:**
  - **auto** — runs unattended (`acceptEdits`), so the 5-hour auto-continue is useful while
    you sleep.
  - **ask** — every tool call pops an **approval modal** you allow/deny. Best when you want to
    supervise closely.
- **Initial prompt** — the task to start with.

The session appears in the sidebar; click it to open its chat. Type to steer at any time;
approvals (in `ask` mode) appear as modals.

## WSL sessions — one-time setup

Because the SDK ships a platform-specific `claude` binary, a WSL session needs the SDK inside
the distro:

```bash
# inside the distro
cd /mnt/e/GitHub/kalpana-vigyaan/claude-orchestrator/fleet-console
npm install                 # installs the linux claude binary
claude            # /login once
```

Then create a `wsl` session with that distro and a Linux working directory. The orchestrator
launches the runner with `wsl -d <distro> node <runner> --config …`.

> **Hyper-V guests:** run a second copy of this orchestrator (or just the runner) *inside the
> guest* and point your browser at it, or extend `hosts.mjs` with an SSH/remote adapter. The
> guest's sessions render inside the guest OS, so the runner must execute there.

## How it survives the 5-hour reset

A runner detects the account limit and reports a `resetAt`; the dashboard shows the countdown
(account-wide). At `resetAt + buffer`, every session with **auto-continue** on is sent
`continue` automatically — or press **Continue all**. A dedupe guard prevents double-fires.
`ask` sessions also continue but then wait at the next approval modal for you.

## Session logs (YAML)

Every session's interactions are written to `sessions/<label>_<id>.yaml` (override the folder
with `SESSIONS_DIR`). Each file holds the session metadata, the last result (cost/usage), and
an `interactions:` list of user/assistant/tool/result entries with timestamps — a durable,
greppable record of what each agent did. The folder is gitignored.

## How interactive steering works

The orchestrator owns each session's query, so "send a message" pushes a user message into
that session's prompt stream and "approve a tool" resolves its `canUseTool` promise. No
editor automation, no webview, no CDP — interactivity is first-class because we hold the
session.

## Notes / limitations

- This was written as plain Node ESM (zero build) so it runs immediately with `node`; it is
  not TypeScript-compiled (it is straightforward to port to TS if you want types).
- The rate-limit marker is detected heuristically (regex + structured fields) and is
  configurable per session (`limitPattern`); **Set reset** is the manual fallback, and since
  the limit is account-wide one reset drives the whole fleet.
- `auto` policy uses `acceptEdits` so unattended runs proceed; if you need a hard sandbox,
  run those sessions inside a WSL distro or a guest.
