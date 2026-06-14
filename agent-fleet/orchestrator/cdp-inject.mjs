#!/usr/bin/env node
/**
 * CDP injector — types text into the Claude Code chat panel webview over the Chrome
 * DevTools Protocol. This is the only path that reaches the panel today (the panel is a
 * webview with no public input API).
 *
 * Requires `playwright-core` (an optional dependency) and a VS Code launched with
 * `--remote-debugging-port=<port>`.
 *
 * Usage:
 *   node cdp-inject.mjs --port 9222 --list           # dump frames + candidate inputs (tuning)
 *   node cdp-inject.mjs --port 9222 --text continue   # inject "continue" + Enter
 *   node cdp-inject.mjs --port 9222 --text continue --selector 'div[contenteditable="true"]'
 *
 * Prints "INJECTED" to stdout on success (the orchestrator checks for this token).
 *
 * NOTE: the exact input selector and which frame holds the Claude panel are
 * environment-specific. Run --list once against a window with the panel open to identify
 * the right `--selector` / `--frame-contains`, then set them (and the agent's port) so the
 * orchestrator can drive it automatically.
 */

function parseArgs(argv) {
  const args = { port: 9222, text: "continue", list: false, selector: "", frameContains: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--text") args.text = argv[++i];
    else if (a === "--selector") args.selector = argv[++i];
    else if (a === "--frame-contains") args.frameContains = argv[++i];
    else if (a === "--list") args.list = true;
  }
  return args;
}

const CANDIDATE_SELECTORS = [
  'div[contenteditable="true"]',
  'textarea',
  '[role="textbox"]',
  'input[type="text"]',
];

async function main() {
  const args = parseArgs(process.argv);

  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error(
      "playwright-core is not installed. Run `npm install playwright-core` in the orchestrator folder."
    );
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.port}`);
  } catch (error) {
    console.error(`Could not connect to CDP on port ${args.port}: ${error}`);
    console.error("Did you launch VS Code with --remote-debugging-port=" + args.port + "?");
    process.exit(3);
  }

  try {
    const frames = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          frames.push(frame);
        }
      }
    }

    if (args.list) {
      console.error(`Found ${frames.length} frame(s):`);
      for (const frame of frames) {
        let counts = {};
        for (const sel of CANDIDATE_SELECTORS) {
          try {
            counts[sel] = await frame.locator(sel).count();
          } catch {
            counts[sel] = "?";
          }
        }
        console.error(`  url=${frame.url()}`);
        console.error(`    candidates=${JSON.stringify(counts)}`);
      }
      console.log("LISTED");
      await browser.close().catch(() => {});
      return;
    }

    // Choose frames to try: filter by --frame-contains if given, else all.
    const ordered = frames.filter((f) =>
      args.frameContains ? f.url().includes(args.frameContains) : true
    );

    const selectors = args.selector ? [args.selector] : CANDIDATE_SELECTORS;

    for (const frame of ordered) {
      for (const selector of selectors) {
        let count = 0;
        try {
          count = await frame.locator(selector).count();
        } catch {
          continue;
        }
        if (count < 1) {
          continue;
        }
        try {
          const input = frame.locator(selector).last();
          await input.click({ timeout: 2000 });
          // contenteditable: type; textarea/input: fill then Enter.
          await input.type(args.text, { timeout: 2000 });
          await input.press("Enter", { timeout: 2000 });
          console.error(`Injected into frame ${frame.url()} via ${selector}`);
          console.log("INJECTED");
          await browser.close().catch(() => {});
          return;
        } catch (error) {
          console.error(`Attempt failed (${selector} @ ${frame.url()}): ${error}`);
        }
      }
    }

    console.error("No injectable input found. Run with --list to inspect frames.");
    console.log("NOT_INJECTED");
    await browser.close().catch(() => {});
    process.exit(1);
  } catch (error) {
    console.error(`Injection error: ${error}`);
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

main();
