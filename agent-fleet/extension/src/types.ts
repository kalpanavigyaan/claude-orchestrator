/**
 * Shared types for the Claude Agent Fleet extension.
 *
 * These shapes are also the wire format sent to the orchestrator in each heartbeat, so the
 * orchestrator and dashboard mirror them. Timestamps are epoch milliseconds.
 */

export type AgentStatus = "active" | "idle" | "limited" | "paused" | "unknown";

export interface AgentIdentity {
  /** Stable per-window id: short sha1 of host + workspace path. */
  id: string;
  /** Friendly name shown in the dashboard. */
  label: string;
  /** Machine host name. */
  host: string;
  /** Environment kind: "windows" | "wsl" | "hyperv" | "unknown". */
  env: string;
  /** Absolute workspace folder path for this window. */
  workspace: string;
  /** Resolved transcript file being watched, or null if not yet found. */
  sessionFile: string | null;
  /** VS Code window title (best effort). */
  windowTitle: string;
}

export interface AgentState {
  status: AgentStatus;
  /** Whether auto-continue is enabled for this window. */
  enabled: boolean;
  /** Detected usage-window reset time, or null. */
  resetAt: number | null;
  /** When the next automatic continuation is scheduled to fire, or null. */
  nextContinueAt: number | null;
  /** When the last continuation actually fired, or null. */
  lastContinueAt: number | null;
  /** Last time transcript activity was observed, or null. */
  lastActivityAt: number | null;
  /** Last short message/line summary observed, for the dashboard. */
  lastMessage: string | null;
}

export interface FleetEvent {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
}

/** Commands the orchestrator can return for this window to execute. */
export interface FleetCommand {
  command: "continue" | "pause" | "resume" | "reset" | "setReset";
  payload?: { resetAt?: number };
}

export interface HeartbeatResponse {
  commands?: FleetCommand[];
}
