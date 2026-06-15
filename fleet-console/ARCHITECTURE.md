# Fleet Console — Architecture

An all-Node web application that **owns** multiple Claude agent sessions and lets you drive
them interactively from any device (laptop or iPad). Each session is a real Claude Agent SDK
query that this app spawns and controls — so there is no VS Code panel to puppet and no CDP
hacks. You get tabbed interactive chats, approval prompts surfaced as web modals, and
automatic continuation after the 5-hour usage reset for sessions you leave running.

> This is original work. WotchCode was looked at only for inspiration on the *idea* of
> owning sessions instead of automating an editor; no code, naming, or structure is taken
> from it.

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
