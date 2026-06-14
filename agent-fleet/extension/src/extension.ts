/**
 * Claude Agent Fleet — VS Code extension entry point.
 *
 * Runs independently in each VS Code window. Detects usage limits from the transcript,
 * schedules a continuation for the 5-hour reset, delivers "continue" through the layered
 * strategy, shows a status-bar control, and heartbeats state to the orchestrator while
 * executing any commands the dashboard issues. It never blocks the chat input and only acts
 * once per reset, so the panel stays fully interactive.
 */

import * as vscode from "vscode";
import { FleetConfig, buildIdentity, readConfig } from "./config";
import { Logger } from "./logger";
import { UsageWatcher, UsageUpdate } from "./usageWatcher";
import { ContinueStrategy } from "./continueStrategy";
import { OrchestratorClient } from "./orchestratorClient";
import { AgentIdentity, AgentState, FleetCommand } from "./types";

class Controller {
  private config: FleetConfig;
  private readonly identity: AgentIdentity;
  private readonly state: AgentState;
  private readonly logger: Logger;
  private watcher: UsageWatcher;
  private strategy: ContinueStrategy;
  private readonly client: OrchestratorClient;
  private readonly statusBar: vscode.StatusBarItem;
  private tickTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.config = readConfig();
    this.logger = new Logger();
    this.identity = buildIdentity(this.config);
    this.state = {
      status: "unknown",
      enabled: this.config.enabledByDefault,
      resetAt: null,
      nextContinueAt: this.restore("nextContinueAt"),
      lastContinueAt: this.restore("lastContinueAt"),
      lastActivityAt: null,
      lastMessage: null,
    };
    this.client = new OrchestratorClient(this.config, this.logger);
    this.strategy = new ContinueStrategy(this.config, this.identity.id, this.logger);
    this.watcher = new UsageWatcher(
      this.config,
      this.identity.workspace,
      this.logger,
      (u) => this.onUsageUpdate(u)
    );
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "agentFleet.toggle";
  }

  activate(): void {
    this.logger.info(
      `Activated for ${this.identity.label} (${this.identity.env}) id=${this.identity.id}`
    );
    this.registerCommands();
    this.watcher.start();
    this.statusBar.show();
    this.render();
    this.tickTimer = setInterval(() => this.tick(), Math.max(1000, this.config.intervalMs));

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agentFleet")) {
          this.reloadConfig();
        }
      })
    );
  }

  // ---- persistence -------------------------------------------------------

  private key(name: string): string {
    return `fleet.${this.identity.id}.${name}`;
  }

  private restore(name: "nextContinueAt" | "lastContinueAt"): number | null {
    return this.context.globalState.get<number | null>(this.key(name), null);
  }

  private persist(): void {
    void this.context.globalState.update(this.key("nextContinueAt"), this.state.nextContinueAt);
    void this.context.globalState.update(this.key("lastContinueAt"), this.state.lastContinueAt);
  }

  // ---- usage updates -----------------------------------------------------

  private onUsageUpdate(update: UsageUpdate): void {
    if (update.sessionFile !== undefined) {
      this.identity.sessionFile = update.sessionFile;
    }
    if (typeof update.lastActivityAt === "number") {
      this.state.lastActivityAt = update.lastActivityAt;
    }
    if (typeof update.lastMessage === "string") {
      this.state.lastMessage = update.lastMessage;
    }
    if (update.limited) {
      this.state.resetAt = update.resetAt ?? Date.now() + 5 * 60 * 60 * 1000;
      this.armSchedule(this.state.resetAt);
    }
    this.render();
  }

  private armSchedule(resetAt: number): void {
    const fireAt = resetAt + this.config.bufferSeconds * 1000;
    this.state.nextContinueAt = fireAt;
    this.persist();
    this.logger.info(`Scheduled continuation for ${new Date(fireAt).toLocaleString()}.`);
  }

  // ---- the tick: status, scheduler, heartbeat ----------------------------

  private tick(): void {
    this.state.status = this.computeStatus();
    this.schedulerCheck();
    void this.heartbeat();
    this.render();
  }

  private computeStatus(): AgentState["status"] {
    if (!this.state.enabled) {
      return "paused";
    }
    const now = Date.now();
    if (this.state.resetAt && now < this.state.resetAt) {
      return "limited";
    }
    if (this.state.lastActivityAt && now - this.state.lastActivityAt < 60000) {
      return "active";
    }
    return "idle";
  }

  private schedulerCheck(): void {
    if (!this.state.enabled || !this.state.nextContinueAt) {
      return;
    }
    const now = Date.now();
    if (now < this.state.nextContinueAt) {
      return;
    }
    // Dedupe: don't continue twice within the minimum interval.
    if (
      this.state.lastContinueAt &&
      now - this.state.lastContinueAt < this.config.minIntervalSeconds * 1000
    ) {
      this.state.nextContinueAt = null;
      this.persist();
      return;
    }
    // Idle guard: defer if there was recent activity (avoid interrupting active work).
    if (
      this.state.lastActivityAt &&
      now - this.state.lastActivityAt < this.config.idleGuardSeconds * 1000
    ) {
      this.state.nextContinueAt = now + this.config.idleGuardSeconds * 1000;
      return;
    }
    void this.fireContinue("schedule");
  }

  private async fireContinue(reason: string): Promise<void> {
    this.logger.info(`Firing continuation (${reason}).`);
    this.state.lastContinueAt = Date.now();
    this.state.nextContinueAt = null;
    this.persist();
    const ok = await this.strategy.executeContinue();
    if (ok) {
      this.state.resetAt = null;
      this.state.status = "active";
    } else {
      // Retry shortly so a transient failure doesn't strand the agent until the next reset.
      this.state.nextContinueAt = Date.now() + 60000;
      this.persist();
      this.logger.warn("Continuation failed; will retry in 60s.");
    }
    this.render();
  }

  // ---- orchestrator heartbeat & commands ---------------------------------

  private async heartbeat(): Promise<void> {
    const events = this.logger.drain();
    const commands = await this.client.heartbeat(this.identity, this.state, events);
    for (const command of commands) {
      this.applyCommand(command);
    }
  }

  private applyCommand(command: FleetCommand): void {
    switch (command.command) {
      case "continue":
        void this.fireContinue("manual");
        break;
      case "pause":
        this.state.enabled = false;
        this.logger.info("Auto-continue paused (dashboard).");
        break;
      case "resume":
        this.state.enabled = true;
        this.logger.info("Auto-continue resumed (dashboard).");
        break;
      case "reset":
        this.state.resetAt = null;
        this.state.nextContinueAt = null;
        this.persist();
        this.logger.info("State reset (dashboard).");
        break;
      case "setReset":
        if (command.payload && typeof command.payload.resetAt === "number") {
          this.state.resetAt = command.payload.resetAt;
          this.armSchedule(command.payload.resetAt);
        }
        break;
    }
    this.render();
  }

  // ---- commands ----------------------------------------------------------

  private registerCommands(): void {
    const sub = this.context.subscriptions;
    sub.push(
      vscode.commands.registerCommand("agentFleet.toggle", () => {
        this.state.enabled = !this.state.enabled;
        this.logger.info(`Auto-continue ${this.state.enabled ? "enabled" : "disabled"}.`);
        this.render();
      }),
      vscode.commands.registerCommand("agentFleet.continueNow", () => this.fireContinue("manual")),
      vscode.commands.registerCommand("agentFleet.pause", () => {
        this.state.enabled = false;
        this.render();
      }),
      vscode.commands.registerCommand("agentFleet.resume", () => {
        this.state.enabled = true;
        this.render();
      }),
      vscode.commands.registerCommand("agentFleet.setResetTime", async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Reset time (e.g. 2026-06-14 03:11, or +5h)",
          placeHolder: "+5h",
        });
        if (!input) {
          return;
        }
        const resetAt = this.parseResetInput(input.trim());
        if (resetAt) {
          this.state.resetAt = resetAt;
          this.armSchedule(resetAt);
          this.render();
        } else {
          void vscode.window.showWarningMessage(`Could not parse reset time: ${input}`);
        }
      }),
      vscode.commands.registerCommand("agentFleet.showLog", () => this.logger.show())
    );
  }

  private parseResetInput(text: string): number | null {
    const rel = text.match(/^\+\s*(\d+(?:\.\d+)?)\s*([hm])$/i);
    if (rel) {
      const amount = parseFloat(rel[1]);
      const unitMs = rel[2].toLowerCase() === "h" ? 3600000 : 60000;
      return Date.now() + amount * unitMs;
    }
    const parsed = Date.parse(text.replace(" ", "T"));
    return isNaN(parsed) ? null : parsed;
  }

  // ---- status bar --------------------------------------------------------

  private render(): void {
    const icons: Record<string, string> = {
      active: "$(play)",
      idle: "$(clock)",
      limited: "$(history)",
      paused: "$(debug-pause)",
      unknown: "$(question)",
    };
    let text = `${icons[this.state.status] ?? "$(question)"} Claude`;
    if (this.state.status === "limited" && this.state.nextContinueAt) {
      text += ` ⌛ ${this.countdown(this.state.nextContinueAt)}`;
    } else if (this.state.status === "paused") {
      text += " (paused)";
    }
    this.statusBar.text = text;
    this.statusBar.tooltip = this.tooltip();
  }

  private countdown(target: number): string {
    let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  private tooltip(): string {
    const lines = [
      `Claude Agent Fleet — ${this.identity.label} (${this.identity.env})`,
      `Status: ${this.state.status}`,
      `Auto-continue: ${this.state.enabled ? "on" : "off"} (click to toggle)`,
    ];
    if (this.state.resetAt) {
      lines.push(`Reset: ${new Date(this.state.resetAt).toLocaleString()}`);
    }
    if (this.state.nextContinueAt) {
      lines.push(`Next continue: ${new Date(this.state.nextContinueAt).toLocaleString()}`);
    }
    if (this.state.lastContinueAt) {
      lines.push(`Last continue: ${new Date(this.state.lastContinueAt).toLocaleString()}`);
    }
    return lines.join("\n");
  }

  private reloadConfig(): void {
    this.config = readConfig();
    this.strategy = new ContinueStrategy(this.config, this.identity.id, this.logger);
    this.watcher.stop();
    this.watcher = new UsageWatcher(
      this.config,
      this.identity.workspace,
      this.logger,
      (u) => this.onUsageUpdate(u)
    );
    this.watcher.start();
    this.logger.info("Configuration reloaded.");
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    this.watcher.stop();
    this.statusBar.dispose();
    this.logger.dispose();
  }
}

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new Controller(context);
  controller.activate();
  context.subscriptions.push({ dispose: () => controller?.dispose() });
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
