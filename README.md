# claude-orchestrator

A Windows command-line application that drives **autonomous Claude Code agents** from
markdown task files. You point it at a folder of instruction markdowns; for each one it
runs the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/python) against a
target git repository (on the Windows host or inside a WSL2 distribution), inside a fixed
time window and a fixed folder scope, with no human in the loop.

It is built for the **Claude Max plan**: the Agent SDK drives the local `claude`
command-line tool, which authenticates with your existing Claude Code subscription login —
no `ANTHROPIC_API_KEY` and no separate API billing.

## What's in this repo

This repo grew into three related tools, all on the Max-plan subscription (no API key):

| Tool | What it is | Docs |
|------|-----------|------|
| **claude-orchestrator** (this CLI — `src/`, `scripts/`) | A Windows CLI that runs **autonomous, unattended** agents from markdown task files against scoped repos within a time window. | below |
| **fleet-console** (`fleet-console/`) | A zero-build **web app** that owns multiple Claude Agent SDK sessions and lets you **interactively drive** them from a browser (laptop/iPad): markdown chat, mode/model switching, account usage, resume, repositories, and auto-continue after the 5-hour reset. **The actively developed tool.** | [fleet-console/README.md](fleet-console/README.md) |
| **agent-fleet** (`agent-fleet/`) | Monitors and auto-continues many Claude agents (one per VS Code window) across host/WSL/guests, with a dashboard. | [agent-fleet/README.md](agent-fleet/README.md) |

The rest of this document covers the **claude-orchestrator CLI**.

## What it does

- Reads instruction markdown files; each names a target repository and the work to do.
- Runs each task autonomously: edit, test, document, commit, and push.
- Enforces scope **in code**: the agent may read everything in the configured scope but
  may only write to the repository a task explicitly names.
- Runs only inside a scheduled start/end window, and hard-stops at the end time.
- Tracks token usage and cost; when the plan's tokens are exhausted, it waits for the
  **5-hour usage reset** and resumes (if still inside the window).
- Writes a `REPORT_YYYYMMDD.md` per repository summarizing the work and commit history.

## Prerequisites

1. **Node.js and the `claude` CLI**, logged in on your Max plan:
   ```
   npm install -g @anthropic-ai/claude-code
   claude            # then run /login once to authenticate
   ```
2. **uv** and **Python 3.13** — installed automatically by the setup script below.

## Setup (uv only)

From the repository root, in PowerShell:

```powershell
.\scripts\_setup_python.ps1
```

This script is the single source of truth for the environment. It installs `uv` if
missing, installs Python 3.13 through `uv`, removes any existing `.venv` / `pyproject.toml`
/ `uv.lock`, then recreates everything and adds all packages with `uv add`. If you delete
`pyproject.toml`, re-running this script fully restores Python and every package.

## Usage

```powershell
# Validate the configuration (and optionally an instructions folder)
.\scripts\orchestrator.ps1 validate --instructions-subfolder instructions/example

# Preview the plan and the scope decisions without spawning any agents
.\scripts\orchestrator.ps1 run instructions/example --dry-run

# Run now (skip the start wait; the end deadline still applies)
.\scripts\orchestrator.ps1 run instructions/example --now

# Run on schedule (waits until schedule.start, stops at schedule.end)
.\scripts\orchestrator.ps1 run instructions/example
```

Equivalently, without the wrapper: `uv run python scripts/orchestrator.py <command>`.

## Configuration

Copy `config/orchestrator.example.yaml` to `config/orchestrator.yaml` and edit it:

- `schedule.start` / `schedule.end` — the time window (the end time is a hard stop).
- `scope.read` — folders the agent may read (Windows paths and WSL `//wsl$/...` paths).
  Write access is **not** configured here.
- `defaults` — model, per-task turn cap, commit cadence, push, usage checkpoint cadence.
- `limits` — optional cumulative cost / turn caps.

## Instruction files

Each task is one markdown file with YAML front matter. The `repo:` key names the target
repository and is what grants write access for that single task:

```markdown
---
repo: "E:/GitHub/my-existing-app"
mode: "refactor"          # "refactor" (existing repo) or "new" (new repo)
branch: "orchestrator/refactor-auth"   # optional
push: true                # optional per-task override
---

# Task: Refactor the auth module
...free-form instructions the agent reads and executes...
```

See `instructions/example/001_task.md` for a complete example.

## How scoping is enforced

The runner sets the agent's working directory to the task repository and adds the readable
roots as additional readable directories. A permission callback (see
`src/orchestrator/permissions.py`) evaluates every tool call: reads and searches are
allowed anywhere in scope, writes are allowed only inside the named repository, and bash
commands referencing absolute paths outside the scope are denied. This is enforced in code,
not merely requested in the prompt.

## Project layout

```
config/                      Example YAML configuration (CLI)
instructions/                Where you drop task markdown files (CLI)
scripts/                     uv bootstrap, the CLI entry point, and fleet-console launchers
src/orchestrator/            The CLI application package (one module per responsibility)
tests/                       Unit tests (scope and permissions are safety-critical)
fleet-console/               The web app — see fleet-console/README.md
agent-fleet/                 VS Code-window fleet monitor + dashboard — see agent-fleet/README.md
```

## Tests

```powershell
uv run pytest
```
