/**
 * Usage detection by tailing the Claude session transcript.
 *
 * The extension never scrapes the webview. It locates the transcript file Claude Code
 * writes for this window's workspace (under <home>/.claude/projects/<encoded>/<session>.jsonl),
 * tails the appended lines, and classifies each one as ordinary activity or a usage-limit
 * signal. Because the extension host runs in the same OS as the window (host, WSL distro, or
 * Hyper-V guest), this is always a local file read.
 *
 * The exact field Claude writes on a 100% limit is not a documented schema, so the matcher
 * is deliberately permissive and configurable (a regex plus a few common JSON field names),
 * and a manual override is available from the dashboard.
 */

import * as fs from "fs";
import * as path from "path";
import { FleetConfig, transcriptDirectory } from "./config";
import { Logger } from "./logger";

export interface UsageUpdate {
  sessionFile?: string | null;
  /** True when a usage-limit signal was seen on this poll. */
  limited?: boolean;
  /** Reset time in epoch ms when one could be derived. */
  resetAt?: number | null;
  /** Epoch ms of the most recent transcript activity. */
  lastActivityAt?: number;
  /** Short summary of the latest line. */
  lastMessage?: string;
}

const RESET_FIELDS = ["resets_at", "reset_at", "resetAt", "resetsAt"];
const RETRY_FIELDS = ["retry_after", "retryAfter", "retry_after_seconds"];

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) {
    // Heuristic: 10-digit values are epoch seconds, 13-digit are ms.
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

function deepFindReset(object: any, depth = 0): number | null {
  if (!object || typeof object !== "object" || depth > 4) {
    return null;
  }
  for (const field of RESET_FIELDS) {
    if (field in object) {
      const ms = toEpochMs(object[field]);
      if (ms) {
        return ms;
      }
    }
  }
  for (const field of RETRY_FIELDS) {
    if (field in object && typeof object[field] === "number") {
      return Date.now() + object[field] * 1000;
    }
  }
  for (const key of Object.keys(object)) {
    const child = object[key];
    if (child && typeof child === "object") {
      const found = deepFindReset(child, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export class UsageWatcher {
  private timer: NodeJS.Timeout | undefined;
  private resolveTimer: NodeJS.Timeout | undefined;
  private file: string | null = null;
  private offset = 0;
  private remainder = "";

  constructor(
    private readonly config: FleetConfig,
    private readonly workspace: string,
    private readonly logger: Logger,
    private readonly onUpdate: (update: UsageUpdate) => void
  ) {}

  /**
   * Begin watching: resolve the transcript file, then poll for appended lines.
   *
   * Example:
   *   watcher.start();  // emits UsageUpdate callbacks as the transcript grows
   */
  start(): void {
    this.resolve();
    this.resolveTimer = setInterval(() => {
      // Re-resolve periodically in case a new session file was created for this window.
      if (!this.file || !fs.existsSync(this.file)) {
        this.resolve();
      }
    }, 30000);
    this.timer = setInterval(() => this.poll(), 2000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.resolveTimer) {
      clearInterval(this.resolveTimer);
    }
  }

  /** Locate the most-likely transcript file for this window's workspace. */
  private resolve(): void {
    const dir = transcriptDirectory(this.config.transcriptDir);
    let projectDirs: string[];
    try {
      projectDirs = fs
        .readdirSync(dir)
        .map((name) => path.join(dir, name))
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return; // transcript dir not present yet
    }

    const encoded = this.workspace.replace(/[:\\/]/g, "-");
    const candidates: { file: string; mtime: number; matchesCwd: boolean; matchesDir: boolean }[] = [];

    for (const projectDir of projectDirs) {
      let jsonlFiles: string[];
      try {
        jsonlFiles = fs
          .readdirSync(projectDir)
          .filter((n) => n.endsWith(".jsonl"))
          .map((n) => path.join(projectDir, n));
      } catch {
        continue;
      }
      const dirMatches = path.basename(projectDir).toLowerCase().includes(encoded.toLowerCase());
      for (const file of jsonlFiles) {
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        candidates.push({
          file,
          mtime,
          matchesCwd: this.fileCwdMatches(file),
          matchesDir: dirMatches,
        });
      }
    }

    if (candidates.length === 0) {
      return;
    }
    // Prefer an internal cwd match, then a directory-name match, then newest overall.
    candidates.sort((a, b) => {
      const score = (c: typeof a) => (c.matchesCwd ? 2 : 0) + (c.matchesDir ? 1 : 0);
      const diff = score(b) - score(a);
      return diff !== 0 ? diff : b.mtime - a.mtime;
    });

    const chosen = candidates[0].file;
    if (chosen !== this.file) {
      this.file = chosen;
      this.offset = 0;
      this.remainder = "";
      this.logger.info(`Watching transcript: ${chosen}`);
      this.onUpdate({ sessionFile: chosen });
    }
  }

  /** Read up to ~64KB of a transcript and check whether its recorded cwd matches. */
  private fileCwdMatches(file: string): boolean {
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(65536);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const text = buf.toString("utf8", 0, bytes);
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const obj = JSON.parse(line);
          const cwd = obj && (obj.cwd || (obj.session && obj.session.cwd));
          if (typeof cwd === "string" && path.resolve(cwd) === path.resolve(this.workspace)) {
            return true;
          }
        } catch {
          /* partial/invalid line */
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Read newly appended bytes and classify each complete line. */
  private poll(): void {
    if (!this.file) {
      return;
    }
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      this.file = null;
      return;
    }
    if (size < this.offset) {
      // File rotated or truncated.
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) {
      return;
    }
    let chunk = "";
    try {
      const fd = fs.openSync(this.file, "r");
      const length = size - this.offset;
      const buf = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buf, 0, length, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString("utf8", 0, bytes);
      this.offset = size;
    } catch {
      return;
    }

    const text = this.remainder + chunk;
    const lines = text.split("\n");
    this.remainder = lines.pop() ?? ""; // keep trailing partial line

    for (const line of lines) {
      if (line.trim()) {
        this.classify(line);
      }
    }
  }

  /** Classify one transcript line and emit an update. */
  private classify(line: string): void {
    let summary = line.length > 160 ? line.slice(0, 157) + "…" : line;
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      /* keep raw */
    }

    const matchedText = this.config.limitPattern.test(line);
    let resetAt: number | null = null;
    let structuredLimit = false;

    if (obj) {
      const flat = JSON.stringify(obj).toLowerCase();
      structuredLimit =
        flat.includes("rate_limit") ||
        flat.includes("usage_limit") ||
        flat.includes('"rejected"') ||
        flat.includes("limit_reached");
      resetAt = deepFindReset(obj);
      // Build a friendlier summary from common message shapes.
      const msgText =
        (obj.message && obj.message.content && typeof obj.message.content === "string"
          ? obj.message.content
          : null) ||
        (typeof obj.text === "string" ? obj.text : null) ||
        (typeof obj.type === "string" ? obj.type : null);
      if (msgText) {
        summary = String(msgText).slice(0, 160);
      }
    }

    const isLimit = matchedText || structuredLimit;
    if (isLimit) {
      const reset = resetAt ?? Date.now() + 5 * 60 * 60 * 1000;
      this.logger.warn(
        `Usage-limit signal detected; reset at ${new Date(reset).toLocaleString()}.`
      );
      this.onUpdate({ limited: true, resetAt: reset, lastActivityAt: Date.now(), lastMessage: summary });
    } else {
      this.onUpdate({ lastActivityAt: Date.now(), lastMessage: summary });
    }
  }
}
