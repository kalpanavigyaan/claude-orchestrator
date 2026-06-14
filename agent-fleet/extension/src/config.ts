/**
 * Configuration access and environment detection for the extension.
 *
 * Centralizes reading the `agentFleet.*` settings, computing the stable per-window agent id
 * and identity, and detecting whether the window is running on the Windows host, inside a
 * WSL2 distribution, or inside a Hyper-V guest.
 */

import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";
import { AgentIdentity } from "./types";

export interface FleetConfig {
  enabledByDefault: boolean;
  label: string;
  orchestratorUrl: string;
  intervalMs: number;
  transcriptDir: string;
  limitPattern: RegExp;
  continueText: string;
  commandIds: string[];
  terminalPattern: RegExp;
  bufferSeconds: number;
  minIntervalSeconds: number;
  idleGuardSeconds: number;
}

function safeRegExp(source: string, fallback: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    return new RegExp(fallback, "i");
  }
}

/**
 * Read the current `agentFleet.*` configuration.
 *
 * Example:
 *   const cfg = readConfig();
 *   cfg.orchestratorUrl;  // "http://127.0.0.1:4317"
 */
export function readConfig(): FleetConfig {
  const c = vscode.workspace.getConfiguration("agentFleet");
  return {
    enabledByDefault: c.get<boolean>("enabledByDefault", true),
    label: c.get<string>("label", ""),
    orchestratorUrl: c.get<string>("orchestrator.url", "http://127.0.0.1:4317").replace(/\/+$/, ""),
    intervalMs: c.get<number>("orchestrator.intervalMs", 3000),
    transcriptDir: c.get<string>("usage.transcriptDir", ""),
    limitPattern: safeRegExp(
      c.get<string>("usage.limitPattern", ""),
      "(usage limit|rate.?limit|limit reached)"
    ),
    continueText: c.get<string>("continue.text", "continue"),
    commandIds: c.get<string[]>("continue.commandIds", []),
    terminalPattern: safeRegExp(c.get<string>("continue.terminalPattern", "claude"), "claude"),
    bufferSeconds: c.get<number>("continue.bufferSeconds", 30),
    minIntervalSeconds: c.get<number>("continue.minIntervalSeconds", 300),
    idleGuardSeconds: c.get<number>("continue.idleGuardSeconds", 120),
  };
}

/**
 * Return the directory holding Claude session transcripts for this machine.
 *
 * Example:
 *   transcriptDirectory("");  // "/home/ramanan/.claude/projects" inside WSL
 */
export function transcriptDirectory(override: string): string {
  if (override && override.trim()) {
    return override.trim();
  }
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Detect the environment kind for this window.
 *
 * Returns "wsl" inside a WSL2 distribution, "hyperv" for a Hyper-V Windows guest (best
 * effort), "windows" for the Windows host, otherwise "unknown".
 *
 * Example:
 *   detectEnvironment();  // "wsl"
 */
export function detectEnvironment(): string {
  if (process.platform === "linux") {
    // WSL exposes "microsoft" in the kernel release / /proc/version.
    try {
      const release = os.release().toLowerCase();
      if (release.includes("microsoft") || release.includes("wsl")) {
        return "wsl";
      }
      if (fs.existsSync("/proc/version")) {
        const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
        if (v.includes("microsoft") || v.includes("wsl")) {
          return "wsl";
        }
      }
    } catch {
      /* ignore */
    }
    return "unknown";
  }
  if (process.platform === "win32") {
    // Distinguishing a Hyper-V guest from the host is unreliable from inside; default to
    // "windows" and let the user set agentFleet.label to disambiguate guests.
    return "windows";
  }
  return "unknown";
}

/**
 * Compute the current window's workspace folder path (first folder), or the home dir.
 *
 * Example:
 *   workspacePath();  // "E:\\GitHub\\my-app"
 */
export function workspacePath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

/**
 * Build the stable identity for this window. The id is a short sha1 of host + workspace so
 * the same window maps to the same dashboard row across reloads.
 *
 * Example:
 *   const id = buildIdentity(cfg);  // { id: "9f3a1c2b", env: "wsl", ... }
 */
export function buildIdentity(config: FleetConfig): AgentIdentity {
  const host = os.hostname();
  const workspace = workspacePath();
  const id = crypto
    .createHash("sha1")
    .update(`${host}|${workspace}`)
    .digest("hex")
    .slice(0, 12);
  const label =
    config.label && config.label.trim() ? config.label.trim() : path.basename(workspace) || host;
  return {
    id,
    label,
    host,
    env: detectEnvironment(),
    workspace,
    sessionFile: null,
    windowTitle: label,
  };
}
