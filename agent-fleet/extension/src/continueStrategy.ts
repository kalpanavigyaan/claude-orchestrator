/**
 * The layered "continue" delivery strategy.
 *
 * Because the Claude Code chat panel exposes no input API, continuation is delivered by the
 * first mechanism that works:
 *   1. a registered VS Code command (future-proof: works the day Claude Code ships one),
 *   2. an integrated terminal running the Claude CLI (`terminal.sendText`),
 *   3. the orchestrator's CDP injector, which drives the webview DOM (the only path that
 *      reaches the panel today).
 */

import * as vscode from "vscode";
import { FleetConfig } from "./config";
import { Logger } from "./logger";
import { postJson } from "./http";

export class ContinueStrategy {
  constructor(
    private readonly config: FleetConfig,
    private readonly agentId: string,
    private readonly logger: Logger
  ) {}

  /**
   * Attempt to continue the agent. Returns true on the first mechanism that succeeds.
   *
   * Example:
   *   const ok = await strategy.executeContinue();  // true if any layer delivered "continue"
   */
  async executeContinue(): Promise<boolean> {
    if (await this.tryCommand()) {
      return true;
    }
    if (this.tryTerminal()) {
      return true;
    }
    if (await this.tryCdp()) {
      return true;
    }
    this.logger.error("All continuation mechanisms failed (command, terminal, CDP).");
    return false;
  }

  /** Try any configured VS Code command id that actually exists. */
  private async tryCommand(): Promise<boolean> {
    try {
      const available = new Set(await vscode.commands.getCommands(true));
      for (const id of this.config.commandIds) {
        if (available.has(id)) {
          await vscode.commands.executeCommand(id, this.config.continueText);
          this.logger.info(`Continued via VS Code command '${id}'.`);
          return true;
        }
      }
    } catch (error) {
      this.logger.warn(`Command continuation errored: ${String(error)}`);
    }
    return false;
  }

  /** Try a Claude CLI integrated terminal via sendText. */
  private tryTerminal(): boolean {
    const terminal = vscode.window.terminals.find((t) => this.config.terminalPattern.test(t.name));
    if (terminal) {
      terminal.sendText(this.config.continueText, true);
      this.logger.info(`Continued via terminal '${terminal.name}'.`);
      return true;
    }
    return false;
  }

  /** Ask the orchestrator to inject into the panel webview over CDP. */
  private async tryCdp(): Promise<boolean> {
    const url = `${this.config.orchestratorUrl}/api/agents/${this.agentId}/cdp-inject`;
    const resp = await postJson(url, { text: this.config.continueText });
    if (resp.ok) {
      if (resp.data && resp.data.injected) {
        this.logger.info("Continued via orchestrator CDP injection.");
        return true;
      }
      this.logger.warn(`CDP injection not confirmed: ${JSON.stringify(resp.data)}`);
      return false;
    }
    this.logger.warn(`CDP injection request failed: ${resp.status ? "HTTP " + resp.status : "unreachable"}`);
    return false;
  }
}
