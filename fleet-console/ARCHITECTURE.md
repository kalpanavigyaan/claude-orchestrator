# Fleet Console — Architecture

Fleet Console is an all-Node web application that **owns** Claude Agent SDK sessions and lets you drive them from any browser. Each session is a direct `query()` against the Agent SDK — no VS Code panels, no CDP hacks, no editor automation of any kind.

---

## System overview

```
         Browser (laptop / iPad Safari / any device)
         ┌───────────────────────────────────────────────────────┐
         │  Header: connection · account reset · 📊 Usage        │
         │  Usage bar: 5h / weekly / daily utilization cards      │
         │  ─────────────────────────────────────────────────     │
         │  Left          │  Center          │  Right             │
         │  ─ WSL distros │  Markdown chat   │  Controls tab      │
         │  ─ Sessions    │  ─ tool calls    │  Intelligence tab  │
         │  ─ Repos       │  Composer        │  Commands tab      │
         │  ─ Past sessions│  Status bar      │                    │
         └───────────────────────────────────────────────────────┘
              │  REST POST (actions)           ▲  SSE (events)
              ▼                                │
         ┌───────────────────────────────────────────────────────┐
         │           ORCHESTRATOR  src/orchestrator.mjs           │
         │  • HTTP server (Node built-ins only, no framework)     │
         │  • Session registry + state + persistence to disk       │
         │  • Spawns one RUNNER child process per session          │
         │  • Routes messages: browser POST → runner stdin         │
         │  •                  runner stdout → session state + SSE │
         │  • 5-hour reset scheduler (auto-continue)              │
         │  • Usage-fetcher (account-wide /usage poll)            │
         │  • Repos scanner (git status, cached 12 s)             │
         │  • /api/usage/history + /api/usage/exchanges           │
         └───────────────────────────────────────────────────────┘
              │  JSON lines over stdio (one child per session)
     ┌────────┼─────────────────────────┐
     ▼        ▼                         ▼
┌─────────┐ ┌─────────┐          ┌──────────────────────────┐
│ RUNNER  │ │ RUNNER  │   ...    │ RUNNER  (inside WSL)     │
│  host   │ │  host   │          │  wsl -d <distro> node …  │
│ query() │ │ query() │          │  query()                 │
└─────────┘ └─────────┘          └──────────────────────────┘
  each runner owns one @anthropic-ai/claude-agent-sdk session
  (authenticated via Claude Code subscription — no API key)
```

---

## Runner — `src/runner.mjs`

One Node child process per session. Owns exactly one Agent SDK session.

**Prompt delivery.** `query({ prompt, options })` where `prompt` is a **pushable async-iterable** ([`asyncQueue.mjs`](src/asyncQueue.mjs)) so the orchestrator can feed user messages mid-session (real multi-turn interactivity).

**SDK options set at startup:**

| Option | Value |
|---|---|
| `cwd` | Working directory |
| `additionalDirectories` | Read scope: repo paths + per-session instructions dir |
| `model` | From session config; null = plan default |
| `maxTurns` | Session max (default unlimited for interactive; configurable for unattended) |
| `permissionMode` | `plan` (read-only) or `default` (execution governed by `canUseTool`) |
| `systemPrompt` | `{ type: "preset", preset: "claude_code", append: autonomyNote + instructionsNote }` |
| `thinking` | `{ type: "disabled" }` (off) or `{ type: "adaptive" }` |
| `includePartialMessages` | `true` for interactive; `false` for unattended (saves IPC) |
| `mcpServers` | Browser (Playwright MCP) and/or tool server (MCP HTTP), when enabled |

**Permissions via `canUseTool`.** The single permission authority for all modes:
1. **Tool-server gate**: any `mcp__toolServer__<name>` tool not in the per-session `selectedTools` set is denied — enforced even in Auto/bypass mode.
2. **Auto-approve by category**: read tools always pass; edits/shell/other pass if in `autoApprove` set (derived from mode).
3. **Ask policy**: everything else blocks and emits `approval_request` to the UI (web modal).

**Live control (stdin commands):**
`user` · `continue` · `approval` · `set_mode` · `set_model` · `set_effort` · `set_thinking` · `set_browser` · `set_tool_server` · `set_tools` · `set_auto_approve` · `interrupt` · `shutdown`

**Stdout events:**
`status` · `assistant` · `tool_use` · `approval_request` · `result` · `rate_limit` · `models` · `commands` · `mode` · `model` · `effort` · `thinking` · `browser` · `tool_server` · `tools` · `session_id` · `activity` · `log`

**Rate-limit detection.** Only `rate_limit_event.rate_limit_info.status === "rejected"` counts as a true limit; other rate events are ignored. This prevents false-positive auto-continues.

---

## Orchestrator — `src/orchestrator.mjs`

**Session registry.** In-memory map of sessions. Each session tracks: id, label, host, distro, cwd, model, mode, policy, permissionMode, effort, thinking, toolServer, tools, status, resetAt, nextContinueAt, lastResult, messages (capped at 500), pendingApprovals.

**Spawning runners.** Host adapters in `src/hosts.mjs`:
- `local` → Node child process via `child_process.spawn`
- `wsl` → `wsl.exe -d <distro> <node> <runner> --config <base64-json>` (runner path translated to `/mnt/<drive>/...`)

A dead runner is respawned on the next message (`ensureRunner`) so nothing is dropped.

**Persistence.** Each session is flushed to `session.json` + `conversation.md` whenever `s.dirty` is set. The flush runs on a scheduler tick so writes are batched.

**Scheduler.** Runs every second. When a session status is `limited` and `nextContinueAt` has passed, sends `continue` to the runner. A `minIntervalSeconds` guard prevents double-fires. Account-level reset (`max(all session resetAt)`) drives the "continue all" path.

**Usage fetcher.** A throwaway SDK session (`src/usage-fetcher.mjs`) that calls the experimental `/usage` endpoint without taking a model turn. Runs at startup and every `usage.pollSeconds` seconds (default 60). The orchestrator caches the result and surfaces it in the fleet snapshot.

**History.** Walks `sessions.dir` and reads `session.json` from every saved session folder. Builds a flat list sorted newest-first. Used by the History panel and `/api/usage/history`.

**Usage history endpoints:**
- `/api/usage/history` — aggregates cost + tokens from `session.json` files (has cost data from SDK) and raw JSONL files. Returns `{ sessions[], byDay{}, byMonth{}, byModel{}, totals{} }`. Cached 30 s.
- `/api/usage/exchanges` — reads ALL assistant events from every JSONL in `~/.claude/projects/`. Returns per-exchange scatter data and `{ byDay{}, byWeek{}, byMonth{}, byModel{} }`. Cached 120 s. Deduplicates by `ev.uuid` to handle streaming re-sends.

---

## Browser UI — `public/app.js`

Plain fetch + `EventSource` + DOM. No framework, no build step. Runs on iPad Safari with nothing installed.

**State sync.** Polls `/api/state` every second and subscribes to `/api/events` SSE for push. Both return the same `fleetSnapshot()` shape. A memoized sig prevents re-rendering unchanged panels.

**Rendering.** All panels render from the latest snapshot. The chat re-renders only changed messages (via a `lastRendered` offset). Tool calls are collapsed to one line; the assistant's markdown is rendered with a custom parser (no dependency).

**Usage overlay.** Full-screen panel opened by the **📊 Usage** header button. Fetches `/api/usage/history` for the Overview/Daily/Monthly/Models/Sessions tabs. Fetches `/api/usage/exchanges` (once per overlay open, cached in JS) for the Scatter tab. Uses [Chart.js 4](https://www.chartjs.org/) loaded from CDN.

---

## Session folder layout

```
<sessions.dir>/
  <Windows|WSL>/<distro-or-hostname>/<repo>/<label>/
    session.json      canonical record (id, model, mode, interactions, lastResult, ...)
    conversation.md   human-readable markdown transcript
    instructions/     .md files the agent reads and follows
```

`lastResult` in `session.json` carries `{ cost, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }, turns }` from the SDK's final result event.

---

## Token optimization design

The orchestrator applies token-saving defaults for **unattended sessions** (policy `auto`) at `createSession()`:
- `thinking` defaults to `off` (configurable via `unattended.thinking`)
- `partialMessages` defaults to `false` (configurable via `unattended.partialMessages`)
- `model` defaults to `unattended.model` if set (cheaper model for background work)
- `maxTurns` from `unattended.maxTurns` (default 0 = unlimited)

Interactive sessions keep `adaptive` thinking and full streaming regardless of these settings. All values are overridable per-session.

The tool server's MCP adapter ([`tool-server/mcp-adapter/src/index.ts`](../tool-server/mcp-adapter/src/index.ts)) only registers the curated default tools by default (controlled by `TOOL_SERVER_TOOLS` env). The per-session tool selection is enforced in the runner's `canUseTool` callback.

---

## Why this shape (design rationale)

**Why own sessions instead of automating an editor:** the Claude Code chat panel has no public input API. A VS Code extension can only poke a webview via CDP — fragile and unofficial. Owning sessions via the Agent SDK gives first-class interactivity (push user messages, resolve tool approvals, interrupt, resume) through supported APIs.

**Why Node / web (not Electron):** the goal is "monitor from my iPad or laptop". A host-resident HTTP server reachable from any browser on the LAN is simpler, cheaper, and more portable than an Electron app. It also lets unattended sessions run on the host while the user is away.

**Why zero-build UI:** the UI is served as plain ESM. No bundler, no build step, no `node_modules` in `public/`. A change to `app.js` is immediately visible on the next browser reload — important for rapid iteration on a tool you're also using.


## Why this shape

We spent real effort discovering that the Claude Code chat **panel** has no input API. The
way out is not to control an editor at all — it is to **own the sessions** ourselves through
the Agent SDK and render our own UI. The SDK authenticates via the Claude Code subscription
(the bundled `claude` binary), so this runs on your Max plan with no API key.

Web (not Electron) because the explicit goal is "monitor and steer from my iPad or laptop":
a host-resident server with a browser UI is reachable from any device for free, matches the
"walk away, come back, steer remotely" workflow, and runs the always-on sessions on the host.

## Components

```
                 Browser (laptop / iPad Safari)
                 ┌───────────────────────────────────────────┐
                 │  Left: distros · sessions · repos · history │
                 │  Center: markdown chat + status bar         │
                 │  Right: Controls + Commands · usage bar     │
                 └───────────────────────────────────────────┘
                   │  REST (POST actions)      ▲  SSE (stream)
                   ▼                           │
                 ┌───────────────────────────────────────────┐
                 │      ORCHESTRATOR (Node, host:4318)        │
                 │  • session registry + state + persistence   │
                 │  • spawns one RUNNER per session            │
                 │  • routes messages browser ⇄ runner         │
                 │  • 5-hour reset scheduler (auto-continue)   │
                 │  • usage-fetcher · repos scan · config/auth │
                 └───────────────────────────────────────────┘
                   │ JSON-lines over stdio (one child per session)
        ┌──────────┼───────────────────────────┐
        ▼          ▼                            ▼
   ┌─────────┐ ┌─────────┐                ┌─────────────────┐
   │ RUNNER  │ │ RUNNER  │   ...          │ RUNNER (in WSL) │
   │ host    │ │ host    │                │ wsl -d <distro> │
   │ query() │ │ query() │                │ query()         │
   └─────────┘ └─────────┘                └─────────────────┘
   each owns one @anthropic-ai/claude-agent-sdk session (subscription auth)
```

## Runner (one per session)

A small Node process that owns exactly one Agent SDK session:

- Calls `query({ prompt, options })` where `prompt` is a **pushable async iterable** so we can
  feed user messages mid-session (interactive, multi-turn).
- `options`: `cwd`, `additionalDirectories` (read scope), `model`, `maxTurns`, `systemPrompt`
  (the `claude_code` preset), `permissionMode`, and — in **ask** policy — a `canUseTool`
  callback.
- **Approval policy:**
  - `auto` (walk-away): no `canUseTool`; `permissionMode` (`acceptEdits` or `bypassPermissions`)
    lets it run unattended so the 5-hour auto-continue is useful.
  - `ask` (hands-on): `canUseTool` emits an `approval_request` and **blocks** until the
    orchestrator returns `{behavior:"allow"|"deny"}` — surfaced as a web modal.
- On startup it reports `supportedModels()` and `supportedCommands()` (for the model switcher and
  the Commands panel) and can change the mode/model mid‑session via the SDK control methods
  `setPermissionMode()` / `setModel()`, and stop the current turn via `interrupt()`.
- Can **resume** a saved conversation: `options.resume = <sessionId>`, or `options.continue` to
  continue the most recent conversation in the cwd.
- Speaks **JSON lines** over stdio: emits events on stdout, reads commands on stdin.
  - stdout events: `status`, `assistant` (text), `tool_use`, `approval_request`, `result`
    (cost/usage/turns), `rate_limit` (with `resetAt`), `models`, `commands`, `mode`, `model`,
    `session_id`, `log`.
  - stdin commands: `user` (send text), `continue`, `approval` (resolve a request),
    `set_mode`, `set_model`, `interrupt`, `shutdown`.
- **Rate-limit detection:** the SDK's `rate_limit_event` with `status: "rejected"` means the
  account limit is hit; the runner emits `rate_limit` with a `resetAt` (the platform value if
  present, else `now + 5h`).

## Orchestrator (host service)

- **Registry** of sessions: id, label, host (`local`/`wsl`), cwd, model, permissionMode, policy,
  status, `resetAt`, `nextContinueAt`, `sdkSessionId` (for resume), recent messages, approvals.
- **Spawns** a runner per session via host adapters (`local` = node child; `wsl` =
  `wsl.exe -d <distro> <node> <runner>` with the runner path translated to `/mnt/...` and the
  cwd a native Linux path — no UNC working-directory problem). A dead runner is respawned on the
  next message (`ensureRunner`) so messages aren't dropped.
- **Routes**: browser POST → runner stdin; runner stdout events → session state + SSE to the
  browser. Persists each session to `session.json` + `conversation.md`.
- **Scheduler**: when a session reports `rate_limit` (status `limited`), schedule a `continue`
  for `resetAt + buffer` for each live runner; account-wide, so one reset clock drives a
  "continue all". Dedupe/interval guard prevents doubles.
- **Account usage**: a one‑shot `usage-fetcher` (a throwaway SDK session that reads `/usage`
  without taking a turn) runs at startup and on the `usage.pollSeconds` timer, so account‑wide
  utilization stays fresh independent of chat sessions.
- **Repositories**: scans `repos.localRoots` (host) and each running WSL distro for git repos +
  `status --porcelain` counts, cached ~12s and refreshed in the background.
- **Resume**: rebuilds a saved session in place (`resume`/`continue`) so you can keep chatting.
- **Config + auth**: `config/config.yaml` (env overrides); optional bearer token; serves the UI.

## Browser UI

- **Left sidebar**: WSL distros, live Sessions, a **Repositories** panel (repos + change badges),
  and **Past sessions** as a tree (react‑arborist via CDN, with a plain‑tree fallback).
- **Center**: the conversation rendered as markdown (syntax‑highlighted code; tool calls collapsed
  to a one‑line working indicator with a **Stop**/interrupt button), the composer, and a bottom
  **status bar** (connection + activity with a live elapsed timer).
- **Top bar**: connection, account‑reset countdown, and the account‑usage bar.
- **Right sidebar** (always visible): a **Controls** tab (global actions + the session's
  mode/model dropdowns and per‑session actions, or **Resume** for a past session) and a
  **Commands** tab (slash commands → insert into the chat). Approvals appear as a modal.
- Plain fetch + `EventSource` + DOM — runs on iPad Safari with nothing installed. To avoid a
  duplicate‑render race, per‑session syncs are serialized; the redundant `result` echo of the
  final assistant text is suppressed.

## How it survives the reset

Runner detects the account limit → emits `resetAt` → orchestrator shows the countdown and
schedules `continue` at `resetAt + buffer` for each enabled session (or you press "Continue
all"). Sessions you left in `auto` policy resume unattended; `ask` sessions wait for you.

## How interactive steering works (without any editor automation)

Because the orchestrator **owns** each session's query, "send a message" is just pushing a
user message into that session's async-iterable prompt, and "approve a tool" is resolving the
`canUseTool` promise. No webview, no CDP, no keystroke injection — the interactivity is
first-class because we hold the session, not because we are poking someone else's UI.
