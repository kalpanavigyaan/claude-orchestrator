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
                 │  Fleet view: all sessions + status         │
                 │  Session tab: streaming chat + input       │
                 │  Approval modal: allow / deny a tool        │
                 └───────────────────────────────────────────┘
                   │  REST (POST actions)      ▲  SSE (stream)
                   ▼                           │
                 ┌───────────────────────────────────────────┐
                 │      ORCHESTRATOR (Node, host:4318)        │
                 │  • session registry + state                │
                 │  • spawns one RUNNER per session            │
                 │  • routes messages browser ⇄ runner         │
                 │  • 5-hour reset scheduler (auto-continue)   │
                 │  • token auth, serves the web UI            │
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
- Speaks **JSON lines** over stdio: emits events on stdout, reads commands on stdin.
  - stdout events: `status`, `assistant` (text), `tool_use`, `approval_request`, `result`
    (cost/usage/turns), `rate_limit` (with `resetAt`), `log`.
  - stdin commands: `user` (send text), `approval` (resolve a request), `continue`,
    `shutdown`.
- **Rate-limit detection:** scans messages for an account-limit marker (regex + structured
  fields) and emits `rate_limit` with a `resetAt` (the platform value if present, else
  `now + 5h`). Isolated/configurable, like the rest of the system.

## Orchestrator (host service)

- **Registry** of sessions: id, label, host (`local`/`wsl`), cwd, model, policy, status,
  `resetAt`, `nextContinueAt`, a ring buffer of recent messages, and pending approvals.
- **Spawns** a runner per session via host adapters (`local` = node child; `wsl` =
  `wsl.exe -d <distro> node <runner>` with the runner path translated to `/mnt/...` and the
  cwd a native Linux path — no UNC working-directory problem).
- **Routes**: browser POST → runner stdin; runner stdout events → session state + SSE to the
  browser.
- **Scheduler**: when a session reports `rate_limit` (status `limited`), schedule a
  `continue` for `resetAt + buffer`; because the limit is account-wide, a single reset clock
  also drives a "continue all". Dedupe guard prevents doubles.
- **Auth**: optional bearer token (`FLEET_TOKEN`); bind to a chosen host/interface. Serves the
  static web UI.

## Browser UI

- **Fleet view**: every session with status, model, host, account reset countdown; buttons to
  create a session and continue/stop.
- **Session tab**: the streaming conversation (assistant text + tool calls), an input box to
  steer, and an **approval modal** when an `ask` session requests a tool.
- Plain fetch + `EventSource` + DOM — runs on iPad Safari with nothing installed.

## How it survives the reset

Runner detects the account limit → emits `resetAt` → orchestrator shows the countdown and
schedules `continue` at `resetAt + buffer` for each enabled session (or you press "Continue
all"). Sessions you left in `auto` policy resume unattended; `ask` sessions wait for you.

## How interactive steering works (without any editor automation)

Because the orchestrator **owns** each session's query, "send a message" is just pushing a
user message into that session's async-iterable prompt, and "approve a tool" is resolving the
`canUseTool` promise. No webview, no CDP, no keystroke injection — the interactivity is
first-class because we hold the session, not because we are poking someone else's UI.
```
