/**
 * Logging for the Claude Agent Fleet extension.
 *
 * Writes human-readable lines to a dedicated VS Code OutputChannel and keeps a small ring
 * buffer of recent structured events so they can be piggybacked on the next heartbeat to
 * the orchestrator (and shown in the dashboard's per-agent log).
 */

import * as vscode from "vscode";
import { FleetEvent } from "./types";

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly buffer: FleetEvent[] = [];
  private readonly maxBuffer = 200;

  constructor(name = "Claude Agent Fleet") {
    this.channel = vscode.window.createOutputChannel(name);
  }

  /**
   * Record an event at the given level. Appends to the OutputChannel and the ring buffer.
   *
   * Example:
   *   logger.log("info", "Detected usage limit; reset at 03:11.");
   */
  log(level: FleetEvent["level"], message: string): void {
    const event: FleetEvent = { ts: Date.now(), level, message };
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }
    const stamp = new Date(event.ts).toISOString();
    this.channel.appendLine(`${stamp} [${level.toUpperCase()}] ${message}`);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  /**
   * Remove and return the buffered events for sending in a heartbeat.
   *
   * Example:
   *   const pending = logger.drain();  // [] after a quiet interval
   */
  drain(): FleetEvent[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
