/**
 * HTTP client that heartbeats this window's identity and state to the orchestrator and
 * returns any commands the orchestrator has queued for it (issued from the dashboard).
 *
 * Uses a tiny Node `http` POST helper — no WebSocket, no dependencies. One heartbeat carries
 * state + buffered events and receives pending commands, so command latency is at most one
 * interval.
 */

import { FleetConfig } from "./config";
import { Logger } from "./logger";
import { postJson } from "./http";
import { AgentIdentity, AgentState, FleetCommand, FleetEvent } from "./types";

export class OrchestratorClient {
  private warnedOffline = false;

  constructor(private readonly config: FleetConfig, private readonly logger: Logger) {}

  /**
   * Send a heartbeat and return queued commands.
   *
   * Example:
   *   const commands = await client.heartbeat(identity, state, events);
   *   // commands: [{ command: "continue" }]
   */
  async heartbeat(
    identity: AgentIdentity,
    state: AgentState,
    events: FleetEvent[]
  ): Promise<FleetCommand[]> {
    const url = `${this.config.orchestratorUrl}/api/agents/${identity.id}/heartbeat`;
    const resp = await postJson(url, { agent: identity, state, events });
    if (!resp.ok) {
      this.noteOffline(resp.status ? `HTTP ${resp.status}` : "unreachable");
      return [];
    }
    this.warnedOffline = false;
    const data = resp.data || {};
    return Array.isArray(data.commands) ? (data.commands as FleetCommand[]) : [];
  }

  private noteOffline(reason: string): void {
    if (!this.warnedOffline) {
      this.logger.warn(`Orchestrator unreachable (${reason}); continuing locally.`);
      this.warnedOffline = true;
    }
  }
}
