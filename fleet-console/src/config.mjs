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
  usage: { pollSeconds: 5 },
  continue: { bufferSeconds: 30, minIntervalSeconds: 300 },
  // Local roots scanned for the Repositories panel (Windows host); WSL repos come from running distros.
  repos: { localRoots: ["E:/GitHub"], maxDepth: 3 },
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

/** Minimal YAML reader: nested key/value mappings only (no lists, anchors, or multiline scalars). */
function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const noComment = line.replace(/\s+#.*$/, ""); // strip a trailing " # comment"
    const indent = noComment.match(/^ */)[0].length;
    const m = noComment.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const key = m[1].trim();
    const val = m[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;
    if (val === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
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
  return cfg;
}

const loaded = loadFile();
export const config = applyEnv(deepMerge(DEFAULTS, loaded.data));
export const configSource = loaded.source;
