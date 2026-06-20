import React from 'react';
import { fmtTok, fmtCountdown } from '../fleet/api';
import type { FleetState } from '../fleet/types';

interface Props {
  connected: boolean;
  fleetState: FleetState | null;
  selectedId: string | null;
}

const WINDOW_SHORT: Record<string, string> = {
  five_hour:            '5h',
  seven_day:            'wk',
  seven_day_sonnet:     'wk-s',
  seven_day_opus:       'wk-o',
  seven_day_oauth_apps: 'wk-apps',
  day_requests:         'today',
  week_requests:        'wk-req',
};

const WINDOW_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_oauth_apps',
  'day_requests',
  'week_requests',
];

const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  height: 22,
  fontSize: 12,
  cursor: 'default',
  borderRadius: 2,
  whiteSpace: 'nowrap',
};

function windowUtilStyle(pct: number): React.CSSProperties {
  if (pct >= 90) return { color: 'var(--red)',   background: 'rgba(248,113,113,.15)' };
  if (pct >= 75) return { color: 'var(--amber)', background: 'rgba(251,191,36,.15)' };
  return { color: 'inherit', background: 'transparent' };
}

export function FleetStatusBar({ connected, fleetState, selectedId }: Props) {
  const usage   = fleetState?.usage;
  const totals  = usage?.totals;
  const windows = usage?.windows ?? [];
  const sessions = fleetState?.sessions ?? [];

  const selectedSession = selectedId ? sessions.find(s => s.id === selectedId) : null;
  const sessionCost = selectedSession?.lastResult?.cost;
  const nowMs = fleetState?.now ?? Date.now();

  const orderedWindows = WINDOW_ORDER
    .map(k => windows.find(w => w.type === k))
    .filter(Boolean) as NonNullable<(typeof windows)[number]>[];

  return (
    <div style={{
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: 'var(--status-bg)',
      color: 'var(--status-fg)',
      fontSize: 12,
      paddingLeft: 8,
      paddingRight: 4,
      borderTop: '1px solid var(--border)',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Left: connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          backgroundColor: connected ? 'var(--green, #4ade80)' : 'var(--red, #f87171)',
          display: 'inline-block',
          flexShrink: 0,
        }} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      {/* Right: stats chips */}
      {connected && totals && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto' }}>
          {/* Tokens */}
          {totals.inputTokens > 0 && (
            <span style={chipBase} title="Input tokens">
              ↑{fmtTok(totals.inputTokens)}
            </span>
          )}
          {totals.outputTokens > 0 && (
            <span style={chipBase} title="Output tokens">
              ↓{fmtTok(totals.outputTokens)}
            </span>
          )}
          {(totals.cacheReadTokens > 0 || totals.cacheCreationTokens > 0) && (
            <span style={chipBase} title="Cache tokens">
              ⟳{fmtTok(totals.cacheReadTokens + totals.cacheCreationTokens)}
            </span>
          )}

          {/* Total cost */}
          {totals.costUsd > 0 && (
            <span style={{ ...chipBase, color: 'var(--cyan, #67e8f9)' }} title="Total cost">
              ${totals.costUsd.toFixed(4)}
            </span>
          )}

          {/* Session cost */}
          {sessionCost != null && sessionCost > 0 && (
            <span
              style={{ ...chipBase, background: 'rgba(103,232,249,.1)', color: 'var(--cyan, #67e8f9)' }}
              title="Session cost"
            >
              sess ${sessionCost.toFixed(4)}
            </span>
          )}

          {/* Rate limit windows */}
          {orderedWindows.map(w => {
            const label    = WINDOW_SHORT[w.type] ?? w.type;
            const isWeekly = w.type.startsWith('seven_day') || w.type === 'week_requests';
            const countdown = w.resetAt ? fmtCountdown(w.resetAt, isWeekly) : null;
            const cd = countdown ? ` ↺${countdown}` : '';

            // Request-count windows: show raw count, not a percentage
            if (w.requestCount != null && w.utilization == null) {
              return (
                <span key={w.type} style={chipBase} title={`${w.type}: ${w.requestCount.toLocaleString()} requests`}>
                  {label}:{w.requestCount.toLocaleString()}{cd}
                </span>
              );
            }

            // Utilization windows: 0–100 percentage
            const pct   = Math.max(0, Math.min(100, Math.round(w.utilization ?? 0)));
            const wStyle = windowUtilStyle(pct);
            return (
              <span key={w.type} style={{ ...chipBase, ...wStyle }} title={`${w.type}: ${pct}% used`}>
                {label}:{pct}%{cd}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
