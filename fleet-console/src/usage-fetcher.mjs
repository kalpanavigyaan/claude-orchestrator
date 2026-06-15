#!/usr/bin/env node
/**
 * One-shot account-usage fetcher.
 *
 * Starts a throwaway Agent SDK session, reads the structured /usage data WITHOUT doing a turn (so it
 * consumes no usage), prints one JSON line, and exits. The orchestrator runs this on a timer because
 * the SDK caches /usage per session — a long-lived chat session reports the value from when it last
 * did a turn and goes stale — so fresh account-wide numbers need a fresh session each poll.
 *
 *   stdout: { "type": "usage_report", "report": { subscriptionType, available, rateLimits } }
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createPushableAsyncIterable } from "./asyncQueue.mjs";

const METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

// Hard timeout so a hung control request can't leave a zombie process behind.
const killer = setTimeout(() => process.exit(0), 15000);

async function main() {
  const prompt = createPushableAsyncIterable(); // never pushed → no turn → no usage consumed
  let session;
  try {
    session = query({ prompt, options: { permissionMode: "bypassPermissions" } });
  } catch {
    clearTimeout(killer);
    process.exit(0);
    return;
  }
  try {
    if (typeof session[METHOD] === "function") {
      const u = await session[METHOD]();
      process.stdout.write(
        JSON.stringify({
          type: "usage_report",
          report: {
            subscriptionType: u.subscription_type ?? null,
            available: !!u.rate_limits_available,
            rateLimits: u.rate_limits || null,
          },
        }) + "\n"
      );
    }
  } catch {
    /* experimental endpoint — ignore failures */
  } finally {
    try {
      prompt.end();
    } catch {
      /* ignore */
    }
    clearTimeout(killer);
    process.exit(0);
  }
}

main();
