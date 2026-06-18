#!/usr/bin/env node
/**
 * Session runner — owns exactly one Claude Agent SDK session.
 *
 * Spawned by the orchestrator (one child per session). It runs an interactive `query()` with
 * a pushable async-iterable prompt so the browser can send messages mid-session, surfaces
 * tool-approval requests (in "ask" policy) as events the UI answers, detects the account
 * usage limit, and speaks JSON lines over stdio:
 *
 *   stdout events  → status | assistant | tool_use | approval_request | result | rate_limit | log
 *   stdin commands ← user | approval | continue | shutdown
 *
 * Config is passed as JSON in the FLEET_SESSION environment variable:
 *   { cwd, model, permissionMode, policy, additionalDirectories, initialPrompt,
 *     systemPromptAppend, maxTurns, resume, continueRecent }
 *
 * Auth is the Claude Code subscription via the bundled `claude` binary (no API key).
 */

import readline from "node:readline";
import { createPushableAsyncIterable } from "./asyncQueue.mjs";

/**
 * Load the session config from a base64 `--config` argument (preferred, survives the
 * Windows→WSL boundary) or the FLEET_SESSION environment variable as a fallback.
 */
function loadConfig() {
  const idx = process.argv.indexOf("--config");
  if (idx !== -1 && process.argv[idx + 1]) {
    try {
      return JSON.parse(Buffer.from(process.argv[idx + 1], "base64").toString("utf8"));
    } catch {
      /* fall through to env */
    }
  }
  try {
    return JSON.parse(process.env.FLEET_SESSION || "{}");
  } catch {
    return {};
  }
}

const config = loadConfig();

const prompt = createPushableAsyncIterable();
/** @type {Map<string,(result:any)=>void>} */
const pendingApprovals = new Map();
let approvalCounter = 0;

// The live permission mode (changeable mid-session). canUseTool honors it so switching to
// "Full auto" (bypassPermissions) or "Auto-accept edits" actually stops the prompts — without
// this, a canUseTool callback overrides permissionMode and prompts for every tool.
let currentMode = config.permissionMode || "default"; // for the SDK (plan vs default)

// Per-category auto-approve (derived from the chosen permission mode in the orchestrator). A tool
// whose category is in this set runs without asking; otherwise canUseTool prompts. Reads always run.
let autoApprove = new Set(Array.isArray(config.autoApprove) ? config.autoApprove : []);

// Reasoning effort + extended thinking (live-changeable). effort guides how much the model reasons;
// thinking is adaptive (model decides) or off. Tracked so we can echo current state to the UI.
let currentEffort = config.effort || null; // 'low'|'medium'|'high'|'xhigh'|'max'|null(default)
let currentThinking = config.thinking || "adaptive"; // 'adaptive' | 'off'

/** Map our thinking choice to the SDK's ThinkingConfig for query() options. */
function thinkingConfig(choice) {
  if (choice === "off") return { type: "disabled" };
  return { type: "adaptive" };
}
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Update", "Create", "ApplyPatch"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

/** Category for a tool: read (always allowed), edits, shell (bash/git/…), or other. */
function toolCategory(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edits";
  if (SHELL_TOOLS.has(name)) return "shell";
  return "other";
}

// Browser / UI testing: when enabled, attach Microsoft's Playwright MCP server so Claude gains
// browser tools (mcp__playwright__browser_navigate/click/type/snapshot/screenshot). Toggleable
// mid-session via setMcpServers(). Headed on Windows so you can watch; headless elsewhere (e.g. WSL
// has no display). Loading is non-blocking (SDK default): the first browser use may pause a moment
// while `npx` fetches @playwright/mcp on a cold start; Claude finds the tools via tool search.
let browserEnabled = !!config.browser;
// Central tool server: 26 code-intelligence tools (RTK, Chunkhound, Graphify, Cavemem, SSE, etc.)
// served from Windows host via MCP HTTP. Toggled per-session from the Controls tab.
let toolServerEnabled = !!config.toolServerUrl;
// Per-session selection of WHICH tool-server tools Claude may call. The MCP endpoint may expose
// many tools, but unattended sessions rarely need all of them, so we default to a curated,
// high-leverage subset and deny the rest in canUseTool (works in every mode, including auto).
// The UI changes this live via the `set_tools` command.
const DEFAULT_INTEL_TOOLS = [
  "safr", "chunkhound", "region_extract", "symbol_scope",
  "tds", "noise_filter", "log_dedup", "stack_collapse",
];
// SDK names MCP tools `mcp__<serverName>__<toolName>`; our tool server is registered as "toolServer".
const TOOL_NAME_PREFIX = "mcp__toolServer__";
let selectedTools = new Set(
  Array.isArray(config.tools) ? config.tools : DEFAULT_INTEL_TOOLS,
);
function browserServers() {
  const servers = {};

  // Playwright MCP (browser tools)
  if (browserEnabled) {
    const isWin = process.platform === "win32";
    const args = ["-y", "@playwright/mcp@latest"];
    if (!isWin) args.push("--headless");
    servers.playwright = isWin
      ? { command: "cmd", args: ["/c", "npx", ...args] }
      : { command: "npx", args };
  }

  // Central tool server (RTK, Chunkhound, Graphify, Cavemem, SSE, etc.)
  // Served from Windows host; WSL runners connect via Windows host IP injected into toolServerUrl.
  const toolUrl = config.toolServerUrl;
  if (toolServerEnabled && toolUrl) {
    servers.toolServer = { url: toolUrl };
  }

  return servers;
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// Live in-turn activity: surface what Claude is doing BETWEEN visible messages — thinking, drafting a
// reply, or preparing a tool call — so the UI never shows a bare "Claude is working…" with no detail
// (the model can think for a long stretch before any complete message exists). Driven by the
// includePartialMessages stream_event deltas; throttled so per-token deltas don't flood the pipe.
let activityPhase = null;
let activityPreview = "";
let activityLastEmit = 0;
const ACTIVITY_THROTTLE_MS = 350;

function setActivity(phase, chunk) {
  if (phase !== activityPhase) {
    activityPhase = phase;
    activityPreview = "";
    activityLastEmit = 0; // force an immediate emit when the phase changes
  }
  if (chunk) activityPreview = (activityPreview + chunk).slice(-200); // short rolling tail
  const t = Date.now();
  if (t - activityLastEmit < ACTIVITY_THROTTLE_MS) return;
  activityLastEmit = t;
  emit({ type: "activity", phase: activityPhase, preview: activityPreview.trim() });
}

/** Translate a partial-message stream event into a coarse activity phase (+ rolling text preview). */
function trackActivity(ev) {
  if (!ev) return;
  if (ev.type === "content_block_start") {
    const b = ev.content_block || {};
    if (b.type === "thinking") setActivity("thinking", "");
    else if (b.type === "text") setActivity("responding", "");
    else if (b.type === "tool_use") setActivity("tool", "");
  } else if (ev.type === "content_block_delta") {
    const d = ev.delta || {};
    if (d.type === "thinking_delta") setActivity("thinking", d.thinking || "");
    else if (d.type === "text_delta") setActivity("responding", d.text || "");
    else if (d.type === "input_json_delta") setActivity("tool", "");
  }
}

function toEpochMs(value) {
  if (typeof value === "number" && isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function findReset(object, depth = 0) {
  if (!object || typeof object !== "object" || depth > 5) {
    return null;
  }
  for (const field of ["resets_at", "reset_at", "resetAt", "resetsAt"]) {
    if (field in object) {
      const ms = toEpochMs(object[field]);
      if (ms) {
        return ms;
      }
    }
  }
  for (const field of ["retry_after", "retryAfter"]) {
    if (typeof object[field] === "number") {
      return Date.now() + object[field] * 1000;
    }
  }
  for (const key of Object.keys(object)) {
    if (object[key] && typeof object[key] === "object") {
      const found = findReset(object[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Detect a genuine account usage limit from the SDK's `rate_limit_event` message.
 *
 * The SDK emits `{ type: "rate_limit_event", rate_limit_info: { status, resetsAt,
 * rateLimitType, overageStatus, ... } }` on every status transition. Only
 * `rate_limit_info.status === "rejected"` means usage is actually exhausted —
 * `status: "allowed"`/`"allowed_warning"` are normal, and `overageStatus` (pay-as-you-go)
 * is unrelated to the primary limit. `resetsAt` is epoch seconds.
 */
function detectRateLimit(message) {
  if (!message || message.type !== "rate_limit_event") {
    return;
  }
  const info = message.rate_limit_info || {};
  if (info.status === "rejected") {
    const resetAt = toEpochMs(info.resetsAt) || findReset(info) || Date.now() + 5 * 60 * 60 * 1000;
    emit({ type: "rate_limit", resetAt, rateLimitType: info.rateLimitType || null });
  }
}

/** Permission callback for "ask" policy: auto-allow per the live mode, else prompt the UI. */
async function canUseTool(toolName, input) {
  // Per-session tool-server gate: deny any tool-server tool the user hasn't selected, regardless of
  // mode. This runs before auto-approve so even unattended/auto sessions can't call deselected tools.
  if (toolName.startsWith(TOOL_NAME_PREFIX)) {
    const id = toolName.slice(TOOL_NAME_PREFIX.length);
    if (!selectedTools.has(id)) {
      return { behavior: "deny", message: `Tool '${id}' is disabled for this session.` };
    }
  }
  // Auto-approve read-only tools and any category the user has toggled on; otherwise prompt.
  // `updatedInput` must be echoed — the SDK uses it as the input to actually run the tool.
  const cat = toolCategory(toolName);
  if (cat === "read" || autoApprove.has(cat)) {
    return { behavior: "allow", updatedInput: input };
  }
  const id = `appr_${++approvalCounter}`;
  emit({ type: "approval_request", id, tool: toolName, input });
  return new Promise((resolve) => {
    pendingApprovals.set(id, { resolve, input });
  });
}

// ---- stdin command handling ------------------------------------------------

// The active SDK query object (set once the session starts). Its control methods let us change the
// permission mode / model mid-session, which only works in streaming input mode (what we use).
let sdkSession = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    return;
  }
  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch {
    return;
  }
  switch (cmd.type) {
    case "user":
      prompt.push({ type: "user", message: { role: "user", content: String(cmd.text ?? "") } });
      break;
    case "continue":
      prompt.push({ type: "user", message: { role: "user", content: "continue" } });
      break;
    case "approval": {
      const entry = pendingApprovals.get(cmd.id);
      if (entry) {
        pendingApprovals.delete(cmd.id);
        if (cmd.decision === "allow") {
          entry.resolve({ behavior: "allow", updatedInput: entry.input });
        } else {
          entry.resolve({ behavior: "deny", message: cmd.message || "Denied by user." });
        }
      }
      break;
    }
    case "set_auto_approve":
      // Replace the set of auto-approved categories; future tools in these categories run silently.
      autoApprove = new Set(Array.isArray(cmd.categories) ? cmd.categories : []);
      emit({ type: "auto_approve", categories: [...autoApprove] });
      break;
    case "set_browser":
      // Attach/detach the Playwright browser toolset mid-session via setMcpServers().
      // The central tool server (if configured) stays connected regardless of browser toggle.
      browserEnabled = !!cmd.enabled;
      if (sdkSession && typeof sdkSession.setMcpServers === "function") {
        sdkSession
          .setMcpServers(browserServers())
          .then(() => emit({ type: "browser", enabled: browserEnabled }))
          .catch((e) => emit({ type: "log", level: "warn", message: `set browser failed: ${e}` }));
      } else {
        emit({ type: "browser", enabled: browserEnabled });
      }
      break;
    case "set_tool_server":
      // Attach/detach the central code-intelligence tool server mid-session.
      toolServerEnabled = !!cmd.enabled;
      if (sdkSession && typeof sdkSession.setMcpServers === "function") {
        sdkSession
          .setMcpServers(browserServers())
          .then(() => emit({ type: "tool_server", enabled: toolServerEnabled }))
          .catch((e) => emit({ type: "log", level: "warn", message: `set tool server failed: ${e}` }));
      } else {
        emit({ type: "tool_server", enabled: toolServerEnabled });
      }
      break;
    case "set_tools":
      // Update which tool-server tools Claude may call (enforced in canUseTool). No MCP reattach
      // needed — the gate is checked per invocation, so the change applies to the next tool call.
      selectedTools = new Set(Array.isArray(cmd.tools) ? cmd.tools : []);
      emit({ type: "tools", tools: [...selectedTools] });
      break;
    case "set_mode": {
      const mode = String(cmd.mode || "default");
      currentMode = mode; // SDK plan vs default
      emit({ type: "mode", mode });
      if (sdkSession && typeof sdkSession.setPermissionMode === "function") {
        sdkSession
          .setPermissionMode(mode)
          .catch((e) => emit({ type: "log", level: "warn", message: `set mode failed: ${e}` }));
      }
      break;
    }
    case "set_model":
      if (sdkSession && typeof sdkSession.setModel === "function") {
        const model = cmd.model ? String(cmd.model) : undefined;
        sdkSession
          .setModel(model)
          .then(() => emit({ type: "model", model: model || null }))
          .catch((e) => emit({ type: "log", level: "warn", message: `set model failed: ${e}` }));
      }
      break;
    case "set_effort": {
      // Reasoning effort, applied to subsequent turns via the SDK's flag-settings control request.
      currentEffort = cmd.effort ? String(cmd.effort) : null;
      if (sdkSession && typeof sdkSession.applyFlagSettings === "function") {
        sdkSession
          .applyFlagSettings({ effort: currentEffort })
          .then(() => emit({ type: "effort", effort: currentEffort }))
          .catch((e) => emit({ type: "log", level: "warn", message: `set effort failed: ${e}` }));
      } else {
        emit({ type: "effort", effort: currentEffort });
      }
      break;
    }
    case "set_thinking": {
      // Extended thinking on (adaptive) / off, applied live via setMaxThinkingTokens (0 = off).
      currentThinking = cmd.thinking === "off" ? "off" : "adaptive";
      if (sdkSession && typeof sdkSession.setMaxThinkingTokens === "function") {
        sdkSession
          .setMaxThinkingTokens(currentThinking === "off" ? 0 : null)
          .then(() => emit({ type: "thinking", thinking: currentThinking }))
          .catch((e) => emit({ type: "log", level: "warn", message: `set thinking failed: ${e}` }));
      } else {
        emit({ type: "thinking", thinking: currentThinking });
      }
      break;
    }
    case "interrupt":
      // Stop the current turn but keep the session alive so the user can keep chatting.
      if (sdkSession && typeof sdkSession.interrupt === "function") {
        sdkSession
          .interrupt()
          .then(() => emit({ type: "status", status: "idle" }))
          .catch((e) => emit({ type: "log", level: "warn", message: `interrupt failed: ${e}` }));
      }
      break;
    case "shutdown":
      prompt.end();
      setTimeout(() => process.exit(0), 200);
      break;
  }
});

// ---- main session loop -----------------------------------------------------

async function main() {
  let query;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (error) {
    emit({ type: "status", status: "error", detail: `SDK not installed: ${error}` });
    process.exit(2);
    return;
  }

  /** @type {Record<string, unknown>} */
  const options = {
    cwd: config.cwd || process.cwd(),
    additionalDirectories: config.additionalDirectories || [],
    model: config.model || undefined,
    maxTurns: config.maxTurns || undefined,
    permissionMode: config.permissionMode || "default",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: config.systemPromptAppend || "",
    },
  };
  // Reasoning effort + extended thinking. effort guides reasoning depth on models that support it;
  // thinking is adaptive (model decides) unless turned off.
  if (currentEffort) options.effort = currentEffort;
  options.thinking = thinkingConfig(currentThinking);
  // Stream partial messages so we can surface live "thinking…/responding…" activity (see trackActivity).
  // Without this the model can run silently for a long stretch and the UI shows only a bare "working…".
  // Disabled for unattended/headless sessions (config.partialMessages === false) to save CPU/IPC.
  options.includePartialMessages = config.partialMessages !== false;
  // canUseTool is our single permission authority for every session — it auto-approves the
  // categories the user toggled (and read-only tools) and prompts for the rest. This is what makes
  // "auto-approve shell" actually let Bash/git run (the SDK's permissionMode only covers edits).
  options.canUseTool = canUseTool;
  // Attach MCP servers: browser toolset (if opted in) and/or central tool server.
  // Always call browserServers() — it returns only the enabled entries.
  const mcpServers = browserServers();
  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }
  // Point the SDK at the Linux claude binary inside the distro. Without this, when runner.mjs is
  // loaded from /mnt/ (Windows filesystem), the SDK cannot find its linux-x64 native binary.
  if (config.claudePath) {
    options.pathToClaudeCodeExecutable = config.claudePath;
  }
  // Resume a saved conversation: by session id when known, else continue the most recent
  // conversation in this cwd (mutually exclusive).
  if (config.resume) {
    options.resume = String(config.resume);
  } else if (config.continueRecent) {
    options.continue = true;
  }

  emit({ type: "status", status: "ready" });
  if (config.initialPrompt) {
    prompt.push({ type: "user", message: { role: "user", content: String(config.initialPrompt) } });
  }

  try {
    const session = query({ prompt, options });
    sdkSession = session;
    // Report the available models (best-effort) so the UI can offer an on-the-fly model switch, and
    // echo the current mode/model so the dropdowns start in sync.
    (async () => {
      try {
        if (typeof session.supportedModels === "function") {
          emit({ type: "models", models: await session.supportedModels() });
        }
        if (typeof session.supportedCommands === "function") {
          emit({ type: "commands", commands: await session.supportedCommands() });
        }
      } catch {
        /* control method unavailable — ignore */
      }
    })();
    emit({ type: "mode", mode: config.permissionMode || "default" });
    emit({ type: "model", model: config.model || null });
    emit({ type: "auto_approve", categories: [...autoApprove] });
    emit({ type: "browser", enabled: browserEnabled });  emit({ type: "tool_server", enabled: toolServerEnabled });    emit({ type: "effort", effort: currentEffort });
    emit({ type: "thinking", thinking: currentThinking });
    let lastSessionId = null;
    for await (const message of session) {
      detectRateLimit(message);
      if (message.session_id && message.session_id !== lastSessionId) {
        lastSessionId = message.session_id;
        emit({ type: "session_id", id: message.session_id }); // so the orchestrator can save it for resume
      }
      if (message.type === "stream_event") {
        trackActivity(message.event);
      } else if (message.type === "assistant" && message.message && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text) {
            emit({ type: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            emit({ type: "tool_use", name: block.name, input: block.input, id: block.id });
          }
        }
      } else if (message.type === "result") {
        emit({
          type: "result",
          subtype: message.subtype,
          cost: message.total_cost_usd ?? 0,
          usage: message.usage ?? null,
          turns: message.num_turns ?? 0,
          resultText: message.result ?? null,
        });
        emit({ type: "status", status: "idle" });
      } else if (message.type === "system" || message.type === "status") {
        emit({ type: "log", level: "info", message: message.subtype || message.type });
      }
    }
    emit({ type: "status", status: "ended" });
    process.exit(0);
  } catch (error) {
    emit({ type: "status", status: "error", detail: String(error) });
    process.exit(1);
  }
}

main();
