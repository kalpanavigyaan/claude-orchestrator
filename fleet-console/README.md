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

## Session folders, history, and instructions

Sessions are organized on disk like an editor's history, under `E:\Sessions\Claude`
(override with `SESSIONS_DIR`):

```
E:\Sessions\Claude\
  <WSL|Windows>\<distro-or-host>\<repo>\<title>\
    session.json        # canonical record: metadata + last result + interactions
    conversation.md     # the same conversation rendered as readable markdown
    instructions\       # markdown instruction files for this session
      001_task.md
```

For example a WSL session named "powder run" in the `powder-flow` repo of `Ubuntu-24-04-DEM`
lands at `E:\Sessions\Claude\WSL\Ubuntu-24-04-DEM\powder-flow\powder-run\`.

**History browser:** click **History** in the header to browse every saved session (grouped
by host / distro / repo), and open any one to read its full conversation — so you can go
back and review past runs exactly as they were.

**Adding instructions and having Claude read them:** open a session → **Instructions**. The
modal shows the folder path, lists the `.md` files, and lets you add one (filename + content)
— or just drop `.md` files into the `instructions\` folder yourself. Click **Have Claude
read** and the agent is sent a message to read every `.md` file in that folder (sorted by
name) and follow it. The instructions folder is also added to the agent's readable
directories, and the system prompt tells it where they live.

**WSL sessions:** the agent runs inside the distro, so the instructions path is automatically
translated to `/mnt/<drive>/Sessions/Claude/...` for the agent (you still manage the files
from Windows at `E:\Sessions\Claude\...`).

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
