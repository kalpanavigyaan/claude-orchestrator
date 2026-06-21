// Fleet Console — shared TypeScript types

export interface Session {
  id: string;
  label: string;
  status: 'idle' | 'starting' | 'running' | 'error' | 'ended' | 'limited';
  host: string;
  distro?: string;
  cwd?: string;
  model?: string;
  mode?: string;
  effort?: string;
  thinking?: string;
  browser?: boolean;
  autoContinue?: boolean;
  autoRetryApiError?: boolean;
  autoCompact?: boolean;
  autoCompactThreshold?: number;
  toolServer?: boolean;
  tools?: string[];
  additionalDirectories?: string[];
  resetAt?: number;
  nextContinueAt?: number;
  messageQueue?: string[];
  queueMode?: 'same' | 'fresh';
  completedCount?: number;
  lastResult?: {
    cost?: number;
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
}

export interface UsageWindow {
  type: string;
  utilization?: number;
  requestCount?: number;
  resetAt?: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface FleetState {
  sessions: Session[];
  usage?: {
    totals: UsageTotals;
    windows: UsageWindow[];
    subscriptionType?: string;
  };
  account?: { resetAt?: number };
  toolServer?: { enabled: boolean };
  models?: { value: string; displayName?: string }[];
  build?: string;
  now?: number;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'result' | 'system';
  text?: string;
  name?: string;
  input?: unknown;
  ts?: number;
  turnUsage?: TurnUsage;
  turnCost?: number;
  turns?: number;
}

export interface CompletedInstruction {
  text: string;
  deliveredAt?: number;
}

export interface HistorySession {
  rel: string;
  label: string;
  status?: string;
  date?: string;
  repo?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  messages?: number | ChatMessage[];
  createdAt?: string | null;
  mtime?: number;
  messageQueue?: string[] | null;
  completedInstructions?: CompletedInstruction[] | null;
}

export interface UsageHistory {
  byDay?: Record<string, {
    costUsd: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number; count: number;
  }>;
  byMonth?: Record<string, {
    costUsd: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number; count: number;
  }>;
  byModel?: Record<string, {
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number; count: number;
  }>;
  sessions?: Array<{
    label: string; costUsd: number;
    inputTokens: number; outputTokens: number; turns: number;
  }>;
}

export interface ScatterData {
  exchanges?: Array<{ tsMs: number; inp: number; out: number; cr: number; cc: number; day?: string }>;
  totals?: { inputTokens: number; outputTokens: number };
}

export interface RepoGroup {
  host: string;
  distro?: string;
  repos?: string[];
}

export interface VM {
  name: string;
  type: 'wsl' | 'hyperv' | 'vmware' | 'virtualbox';
  state?: string;
  distro?: string;
}

export type RightPanel = 'usage' | 'vms' | 'intelligence' | 'commands' | 'repos' | 'directories' | 'queue' | 'skills' | 'instructions';

export interface MdFile {
  name: string;
  content: string;
}
export type UsageTab = 'overview' | 'daily' | 'monthly' | 'models' | 'sessions-hist' | 'scatter';
