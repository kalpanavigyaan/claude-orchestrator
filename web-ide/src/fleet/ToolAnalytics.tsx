import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toolStats, TOOL_EFFICIENCY } from './toolStats';
import { fmtTok } from './api';

// Display names for the tool ids
const TOOL_NAMES: Record<string, string> = {
  region_extract: 'RegionExtract',
  tds: 'TDS',
  log_dedup: 'LogDedup',
  safr: 'SAFR',
  chunkhound: 'ChunkHound',
  symbol_scope: 'SymbolScope',
  stack_collapse: 'StackCollapse',
  noise_filter: 'NoiseFilter',
  graphify: 'Graphify',
  ast_query: 'ASTQuery',
  cavemem_read: 'CavememRead',
  cavemem_write: 'CavememWrite',
};

function effColor(pct: number): string {
  if (pct >= 70) return '#4ade80';
  if (pct >= 40) return '#fbbf24';
  if (pct >= 10) return '#fb923c';
  return '#f87171';
}

export default function ToolAnalytics() {
  const [, force] = useState(0);

  useEffect(() => toolStats.subscribe(() => force(n => n + 1)), []);

  const stats = toolStats.get();
  const rows = Object.keys(TOOL_EFFICIENCY)
    .map(id => ({ id, eff: TOOL_EFFICIENCY[id], stat: stats.get(id) }))
    .sort((a, b) => (b.stat?.estSaved ?? 0) - (a.stat?.estSaved ?? 0) || b.eff.savedPct - a.eff.savedPct);

  const totalCalls = [...stats.values()].reduce((t, s) => t + s.calls, 0);
  const totalSaved = toolStats.totalSaved();
  const totalBefore = [...stats.values()].reduce((t, s) => t + s.estBefore, 0);
  const overallPct = totalBefore > 0 ? (totalSaved / totalBefore * 100) : 0;
  // Rough cost saving — Sonnet input ~$3/M tokens
  const costSaved = totalSaved / 1_000_000 * 3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontSize: 12, color: 'var(--sb-fg)' }}>
      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 8 }}>
        <div style={{ background: 'rgba(74,222,128,.08)', border: '1px solid rgba(74,222,128,.25)', borderRadius: 5, padding: 8 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>Tokens Saved</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#4ade80' }}>{fmtTok(totalSaved)}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>~${costSaved.toFixed(2)} saved</div>
        </div>
        <div style={{ background: 'rgba(0,122,204,.08)', border: '1px solid rgba(0,122,204,.25)', borderRadius: 5, padding: 8 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>Tool Calls</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--cyan)' }}>{totalCalls}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{overallPct.toFixed(0)}% avg reduction</div>
        </div>
      </div>

      {/* Reset */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 10px 6px' }}>
        <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>
          Per-tool efficiency
        </span>
        <button
          className="icon-btn"
          onClick={() => toolStats.reset()}
          title="Reset analytics"
          style={{ fontSize: 10, gap: 4, display: 'flex', alignItems: 'center' }}
        >
          <RotateCcw size={11} /> Reset
        </button>
      </div>

      {/* Per-tool rows */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {totalCalls === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
            No tool calls observed yet. Efficiency shown is the measured baseline; live savings
            accumulate as the agent uses tools in the active session.
          </div>
        )}

        {rows.map(({ id, eff, stat }) => {
          const calls = stat?.calls ?? 0;
          const saved = stat?.estSaved ?? 0;
          const color = effColor(eff.savedPct);
          const used = calls > 0;
          return (
            <div
              key={id}
              style={{
                padding: '7px 10px',
                borderBottom: '1px solid rgba(255,255,255,.04)',
                opacity: used ? 1 : 0.65,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{TOOL_NAMES[id] ?? id}</span>
                {used && (
                  <span style={{ fontSize: 10, color: 'var(--cyan)', flexShrink: 0 }}>
                    {calls}× · {fmtTok(saved)} saved
                  </span>
                )}
              </div>
              {/* Efficiency bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,.08)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(eff.savedPct, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 10, color, fontWeight: 600, minWidth: 38, textAlign: 'right' }}>
                  {eff.savedPct.toFixed(0)}%
                </span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{eff.note}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
