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
 *     systemPromptAppend, limitPattern, maxTurns }
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

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// The SDK's structured /usage data (session cost + claude.ai plan rate-limit windows: 5-hour,
// 7-day, per-model). This is a pull, always available — unlike rate_limit_event which only fires
// on a status transition. The method name is intentionally scary because the API is experimental.
const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
let sdkSession = null;

/** Pull the structured /usage data and forward it to the orchestrator. Best-effort. */
async function reportUsage() {
  const session = sdkSession;
  if (!session || typeof session[USAGE_METHOD] !== "function") {
    return;
  }
  try {
    const u = await session[USAGE_METHOD]();
    emit({
      type: "usage_report",
      report: {
        subscriptionType: u.subscription_type ?? null,
        available: !!u.rate_limits_available,
        rateLimits: u.rate_limits || null,
        sessionCost: u.session ? u.session.total_cost_usd : null,
      },
    });
  } catch {
    /* experimental endpoint; ignore failures */
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

/** Permission callback for "ask" policy: surface a request and wait for the UI's decision. */
async function canUseTool(toolName, input) {
  const id = `appr_${++approvalCounter}`;
  emit({ type: "approval_request", id, tool: toolName, input });
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
  });
}

// ---- stdin command handling ------------------------------------------------

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
    case "get_usage":
      reportUsage();
      break;
    case "approval": {
      const resolve = pendingApprovals.get(cmd.id);
      if (resolve) {
        pendingApprovals.delete(cmd.id);
        if (cmd.decision === "allow") {
          resolve({ behavior: "allow" });
        } else {
          resolve({ behavior: "deny", message: cmd.message || "Denied by user." });
        }
      }
      break;
    }
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
  // "ask" policy → interactive approvals; "auto" → rely on permissionMode (walk-away).
  if (config.policy === "ask") {
    options.canUseTool = canUseTool;
  }

  emit({ type: "status", status: "ready" });
  if (config.initialPrompt) {
    prompt.push({ type: "user", message: { role: "user", content: String(config.initialPrompt) } });
  }

  try {
    const session = query({ prompt, options });
    sdkSession = session;
    // Report usage once shortly after startup (fast first paint) and after every turn. The
    // orchestrator drives the steady polling cadence via "get_usage" (configurable in config.yaml).
    setTimeout(reportUsage, 8000);
    for await (const message of session) {
      detectRateLimit(message);
      if (message.type === "assistant" && message.message && Array.isArray(message.message.content)) {
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
        reportUsage(); // refresh usage windows after each completed turn
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
