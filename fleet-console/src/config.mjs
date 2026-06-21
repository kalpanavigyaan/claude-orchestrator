/**
 * Fleet Console configuration.
 *
 * Precedence (highest first): environment variable > config/config.yaml > config/config.example.yaml
 * > built-in defaults. config/config.yaml (gitignored) is your editable copy of
 * config/config.example.yaml. A tiny YAML reader is used so the app keeps zero runtime dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULTS = {
  server: { host: "127.0.0.1", port: 4318, token: "" },
  sessions: { dir: "E:/Sessions/Claude" },
  usage: { pollSeconds: 60 },
  continue: { bufferSeconds: 30, minIntervalSeconds: 300 },
  // Global instructions dir: .md files here are read and injected into every session's system prompt.
  // Default is <sessions.dir>/instructions — create it and add .md files; no restart needed.
  instructions: { globalDir: "" },
  // Local roots scanned for the Repositories panel (Windows host); WSL repos come from running distros.
  repos: { localRoots: ["E:/GitHub"], maxDepth: 3 },
  // Browser / UI testing toolset (Playwright MCP). Default for new sessions; toggle per-session in the UI.
  browser: { enabled: false },
  // Centralised tool server (MCP HTTP on the Windows host, served to all distros).
  toolServer: { enabled: false, port: 4319 },
  // Token-saving defaults applied to UNATTENDED (auto / full-access) sessions only. Interactive
  // sessions keep adaptive thinking, partial-message streaming, and the plan default model. Each
  // value is still overridable per session from the Controls tab.
  unattended: {
    thinking: "off",        // off | adaptive — extended thinking for unattended turns (off saves output tokens)
    maxTurns: 0,            // 0 = unlimited; >0 caps turns an unattended session may run
    model: "",              // optional cheaper model for unattended work (e.g. a Haiku id); "" = plan default
    partialMessages: false, // stream per-token deltas for unattended sessions (off saves CPU/IPC, no model tokens)
  },
};

/** Coerce a scalar YAML value to a JS string/number/boolean/null. */
function coerce(v) {
  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Minimal YAML reader: handles nested mappings AND simple block-sequence lists (`- value`). */
function parseYaml(text) {
  const root = {};
  // stack entries: { indent, obj } where obj is a plain Object or an Array
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const noComment = line.replace(/\s+#.*$/, "");
    const indent    = noComment.match(/^ */)[0].length;
    const trimmed   = noComment.trim();

    // ── Block-sequence item: "- value"
    if (trimmed.startsWith("- ")) {
      const itemVal = trimmed.slice(2).trim();
      // Pop stack until we're inside the array that owns this indent
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1].obj;
      // The parent *mapping* key already set its value to an array (see below).
      // If the top of stack is an object (not an array) just skip (shouldn't happen in valid YAML).
      if (Array.isArray(top)) {
        top.push(coerce(itemVal));
      }
      continue;
    }

    // ── Mapping entry: "key: value" or "key:" (block mapping)
    const m = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (Array.isArray(parent)) continue; // guard: mapping key inside sequence = skip

    if (val === "") {
      // Could be a nested mapping OR a block sequence — we won't know until the next line.
      // Use a special sentinel array so that "- …" items can push into it; if the next
      // non-empty line is a key:, deepMerge will handle the plain object case correctly.
      // We peek ahead: if the next data line starts with "- ", create an array; else a plain obj.
      const nextData = text.split(/\r?\n/).find((l, idx) => {
        const already = text.split(/\r?\n/).indexOf(rawLine);
        return idx > already && l.trim() && !l.trim().startsWith("#");
      });
      const isSeq = nextData && nextData.replace(/\t/g, "  ").trimStart().startsWith("- ");
      if (isSeq) {
        const arr = [];
        parent[key] = arr;
        stack.push({ indent, obj: arr });
      } else {
        const child = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
      }
    } else {
      parent[key] = coerce(val);
    }
  }
  return root;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const ov = over[k];
    if (ov && typeof ov === "object" && !Array.isArray(ov) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], ov);
    } else {
      out[k] = ov;
    }
  }
  return out;
}

function loadFile() {
  const candidates = [
    process.env.FLEET_CONFIG,
    path.join(ROOT, "config", "config.yaml"),
    path.join(ROOT, "config", "config.example.yaml"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return { data: parseYaml(fs.readFileSync(file, "utf8")) || {}, source: file };
      }
    } catch (e) {
      console.error(`[fleet-console] could not read config ${file}: ${e}`);
    }
  }
  return { data: {}, source: "built-in defaults" };
}

const envNum = (v) => (v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : undefined);

function applyEnv(cfg) {
  if (process.env.HOST) cfg.server.host = process.env.HOST;
  if (envNum(process.env.PORT) !== undefined) cfg.server.port = envNum(process.env.PORT);
  if (process.env.FLEET_TOKEN) cfg.server.token = process.env.FLEET_TOKEN;
  if (process.env.SESSIONS_DIR) cfg.sessions.dir = process.env.SESSIONS_DIR;
  if (envNum(process.env.USAGE_POLL_SECONDS) !== undefined) cfg.usage.pollSeconds = envNum(process.env.USAGE_POLL_SECONDS);
  if (envNum(process.env.CONTINUE_BUFFER_SECONDS) !== undefined) cfg.continue.bufferSeconds = envNum(process.env.CONTINUE_BUFFER_SECONDS);
  if (envNum(process.env.CONTINUE_MIN_INTERVAL_SECONDS) !== undefined) cfg.continue.minIntervalSeconds = envNum(process.env.CONTINUE_MIN_INTERVAL_SECONDS);
  if (process.env.FLEET_BROWSER) cfg.browser.enabled = /^(1|true|yes|on)$/i.test(process.env.FLEET_BROWSER);
  if (process.env.TOOL_SERVER) cfg.toolServer.enabled = /^(1|true|yes|on)$/i.test(process.env.TOOL_SERVER);
  if (envNum(process.env.TOOL_SERVER_PORT) !== undefined) cfg.toolServer.port = envNum(process.env.TOOL_SERVER_PORT);
  if (!cfg.unattended) cfg.unattended = {};
  if (process.env.UNATTENDED_THINKING) cfg.unattended.thinking = process.env.UNATTENDED_THINKING === "adaptive" ? "adaptive" : "off";
  if (envNum(process.env.UNATTENDED_MAX_TURNS) !== undefined) cfg.unattended.maxTurns = envNum(process.env.UNATTENDED_MAX_TURNS);
  if (process.env.UNATTENDED_MODEL) cfg.unattended.model = process.env.UNATTENDED_MODEL;
  if (process.env.UNATTENDED_PARTIAL_MESSAGES) cfg.unattended.partialMessages = /^(1|true|yes|on)$/i.test(process.env.UNATTENDED_PARTIAL_MESSAGES);
  if (process.env.GLOBAL_INSTRUCTIONS_DIR) {
    if (!cfg.instructions) cfg.instructions = {};
    cfg.instructions.globalDir = process.env.GLOBAL_INSTRUCTIONS_DIR;
  }
  return cfg;
}

const loaded = loadFile();
export const config = applyEnv(deepMerge(DEFAULTS, loaded.data));
export const configSource = loaded.source;
