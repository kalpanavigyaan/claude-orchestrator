import React, { useEffect, useState } from 'react';
import { apiGet, fmtTok, fmtCountdown } from './api';
import type { FleetState, UsageHistory, ScatterData, UsageTab } from './types';

// ---------------------------------------------------------------------------
// Live countdown ticker (re-renders every second when resetAt is set)
// ---------------------------------------------------------------------------
function Countdown({ resetAt, alwaysShowDays }: { resetAt: number; alwaysShowDays?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return <span style={{ color: 'var(--green)' }}>resetting…</span>;
  return <span>↺ {fmtCountdown(resetAt, alwaysShowDays)}</span>;
}

// 60-second module-level cache
let _histCache: { data: UsageHistory; ts: number } | null = null;

const WINDOW_ORDER = [
  'five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus',
  'seven_day_oauth_apps', 'day_requests', 'week_requests',
];
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5h session',
  seven_day: 'Weekly · all',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_opus: 'Weekly · Opus',
  day_requests: 'Today · requests',
  week_requests: 'Week · requests',
};

interface Props {
  fleetState: FleetState | null;
  activeTab: UsageTab;
  onTabChange: (t: UsageTab) => void;
}

// ---------------------------------------------------------------------------
// SVG chart primitives
// ---------------------------------------------------------------------------

interface BarEntry { l: string; v: number; }

function BarChart({
  entries, width, height, color,
}: {
  entries: BarEntry[]; width: number; height: number; color: string;
}) {
  if (!entries.length) return <svg width={width} height={height} />;
  const maxVal = Math.max(...entries.map(e => e.v), 1);
  const padL = 36, padR = 4, padT = 6, padB = 18;
  const cW = width - padL - padR;
  const cH = height - padT - padB;
  const step = cW / entries.length;
  const barW = Math.max(1, step - 2);

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', display: 'block' }}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      <line x1={padL} y1={padT + cH} x2={padL + cW} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      {([0, 0.5, 1] as const).map(f => {
        const y = padT + cH * (1 - f);
        return (
          <g key={f}>
            <line x1={padL - 3} y1={y} x2={padL} y2={y} stroke="var(--muted)" strokeWidth={1} />
            <text x={padL - 5} y={y + 3} textAnchor="end" fontSize={8} fill="var(--muted)">
              {fmtTok(maxVal * f)}
            </text>
          </g>
        );
      })}
      {entries.map((e, i) => {
        const x = padL + step * i + 1;
        const bh = Math.max(1, (e.v / maxVal) * cH);
        const showLbl = entries.length <= 14 || i % Math.ceil(entries.length / 14) === 0;
        return (
          <g key={i}>
            <rect x={x} y={padT + cH - bh} width={barW} height={bh}
              fill={color} opacity={0.85} rx={1} />
            {showLbl && (
              <text x={x + barW / 2} y={padT + cH + 12} textAnchor="middle" fontSize={7} fill="var(--muted)">
                {e.l.slice(-5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function StackedBarChart({
  entries, colors, width, height,
}: {
  entries: { l: string; values: number[] }[];
  colors: string[];
  width: number;
  height: number;
}) {
  if (!entries.length) return <svg width={width} height={height} />;
  const totals = entries.map(e => e.values.reduce((a, b) => a + b, 0));
  const maxVal = Math.max(...totals, 1);
  const padL = 36, padR = 4, padT = 6, padB = 18;
  const cW = width - padL - padR;
  const cH = height - padT - padB;
  const step = cW / entries.length;
  const barW = Math.max(1, step - 2);

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', display: 'block' }}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      <line x1={padL} y1={padT + cH} x2={padL + cW} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      {([0, 0.5, 1] as const).map(f => {
        const y = padT + cH * (1 - f);
        return (
          <g key={f}>
            <line x1={padL - 3} y1={y} x2={padL} y2={y} stroke="var(--muted)" strokeWidth={1} />
            <text x={padL - 5} y={y + 3} textAnchor="end" fontSize={8} fill="var(--muted)">
              {fmtTok(maxVal * f)}
            </text>
          </g>
        );
      })}
      {entries.map((e, i) => {
        const x = padL + step * i + 1;
        let yOff = padT + cH;
        const showLbl = entries.length <= 14 || i % Math.ceil(entries.length / 14) === 0;
        return (
          <g key={i}>
            {e.values.map((v, vi) => {
              const bh = (v / maxVal) * cH;
              yOff -= bh;
              return (
                <rect key={vi} x={x} y={yOff} width={barW} height={bh}
                  fill={colors[vi % colors.length]} opacity={0.85} />
              );
            })}
            {showLbl && (
              <text x={x + barW / 2} y={padT + cH + 12} textAnchor="middle" fontSize={7} fill="var(--muted)">
                {e.l.slice(-5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function ScatterPlot({
  exchanges, width, height,
}: {
  exchanges: ScatterData['exchanges'];
  width: number;
  height: number;
}) {
  if (!exchanges?.length) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={11} fill="var(--muted)">
          No data
        </text>
      </svg>
    );
  }
  const padL = 40, padR = 8, padT = 6, padB = 18;
  const cW = width - padL - padR;
  const cH = height - padT - padB;
  const tMin = Math.min(...exchanges.map(e => e.tsMs));
  const tMax = Math.max(...exchanges.map(e => e.tsMs));
  const tRange = Math.max(tMax - tMin, 1);
  const maxTok = Math.max(...exchanges.map(e => e.inp + e.out + e.cr + e.cc), 1);

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', display: 'block' }}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      <line x1={padL} y1={padT + cH} x2={padL + cW} y2={padT + cH} stroke="var(--border)" strokeWidth={1} />
      {([0, 0.5, 1] as const).map(f => (
        <text key={f} x={padL - 5} y={padT + cH * (1 - f) + 3}
          textAnchor="end" fontSize={8} fill="var(--muted)">
          {fmtTok(maxTok * f)}
        </text>
      ))}
      {exchanges.map((ex, i) => {
        const total = ex.inp + ex.out + ex.cr + ex.cc;
        const cx = padL + ((ex.tsMs - tMin) / tRange) * cW;
        const cy = padT + cH - (total / maxTok) * cH;
        const r = Math.max(2, Math.min(7, (total / maxTok) * 7));
        return (
          <circle key={i} cx={cx} cy={cy} r={r}
            fill="var(--accent)" opacity={0.55} />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// KPI card + limit bar
// ---------------------------------------------------------------------------

// KPI colour by stat type
const KPI_CLASS: Record<string, string> = {
  'Total Cost': 'cost', 'Input Tokens': 'input', 'Output Tokens': 'output',
  'Cache Reads': 'cache-r', 'Cache Writes': 'cache-w', 'Sessions': 'sessions',
};

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={`fleet-kpi ${KPI_CLASS[label] ?? ''}`}>
      <div className="fleet-kpi-label">{label}</div>
      <div className="fleet-kpi-value">{value}</div>
    </div>
  );
}

function LimitBar({ label, pct, isCount, count, resetAt, alwaysShowDays }: {
  label: string; pct: number; isCount?: boolean; count?: number; resetAt?: number; alwaysShowDays?: boolean;
}) {
  const limitClass = isCount
    ? 'count'
    : pct >= 90 ? 'high' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className="fleet-limit-row">
      <div className="fleet-limit-label-row">
        <span className="fleet-limit-label">{label}</span>
        <div className="fleet-limit-right">
          {resetAt != null && resetAt > 0 && (
            <span className="fleet-limit-cd"><Countdown resetAt={resetAt} alwaysShowDays={alwaysShowDays} /></span>
          )}
          {isCount
            ? <span className={`fleet-limit-pct count`}>{(count ?? 0).toLocaleString()} reqs</span>
            : <span className={`fleet-limit-pct ${limitClass}`}>{pct.toFixed(1)}%</span>
          }
        </div>
      </div>
      <div className="fleet-limit-track">
        <div className={`fleet-limit-fill ${isCount ? '' : limitClass}`}
          style={{ width: isCount ? '0%' : `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable table header
// ---------------------------------------------------------------------------

type SortDir = 'asc' | 'desc';

function SortableTh({ label, col, sortCol, sortDir, onSort }: {
  label: string; col: string;
  sortCol: string; sortDir: SortDir;
  onSort: (c: string) => void;
}) {
  const active = sortCol === col;
  return (
    <th onClick={() => onSort(col)} style={{
      cursor: 'pointer', padding: '3px 5px', fontSize: 10,
      color: active ? 'var(--accent)' : 'var(--muted)',
      borderBottom: '1px solid var(--border)',
      textAlign: 'right', userSelect: 'none', whiteSpace: 'nowrap',
    }}>
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Tab strip definition
// ---------------------------------------------------------------------------

const TABS: { id: UsageTab; label: string }[] = [
  { id: 'overview',      label: 'Overview' },
  { id: 'daily',         label: 'Daily'    },
  { id: 'monthly',       label: 'Monthly'  },
  { id: 'models',        label: 'Models'   },
  { id: 'sessions-hist', label: 'Sessions' },
  { id: 'scatter',       label: 'Scatter'  },
];

const STACK_COLORS = ['var(--accent)', 'var(--cyan)', 'var(--green)', 'var(--amber)'];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UsagePanel({ fleetState, activeTab, onTabChange }: Props) {
  const [usageHist, setUsageHist] = useState<UsageHistory | null>(null);
  const [scatterData, setScatterData] = useState<ScatterData | null>(null);
  const [loading, setLoading]         = useState(false);
  const [sortCol, setSortCol]         = useState('date');
  const [sortDir, setSortDir]         = useState<SortDir>('desc');

  // Load history with 60 s cache
  useEffect(() => {
    const now = Date.now();
    if (_histCache && now - _histCache.ts < 60_000) {
      setUsageHist(_histCache.data);
      return;
    }
    setLoading(true);
    apiGet('/api/usage/history').then(d => {
      if (d) { _histCache = { data: d, ts: Date.now() }; setUsageHist(d); }
      setLoading(false);
    });
  }, []);

  // Load scatter only when that tab is active
  useEffect(() => {
    if (activeTab !== 'scatter' || scatterData) return;
    apiGet('/api/usage/exchanges').then(d => { if (d) setScatterData(d); });
  }, [activeTab, scatterData]);

  function handleSort(col: string) {
    setSortDir(prev => sortCol === col ? (prev === 'asc' ? 'desc' : 'asc') : 'desc');
    setSortCol(col);
  }

  const totals  = fleetState?.usage?.totals;
  const windows = fleetState?.usage?.windows ?? [];

  // ---- tab renderers ----

  const renderOverview = () => (
    <div>
      <div className="fleet-kpi-grid">
        <KpiCard label="Total Cost"    value={`$${(totals?.costUsd ?? 0).toFixed(4)}`} />
        <KpiCard label="Input Tokens"  value={fmtTok(totals?.inputTokens ?? 0)} />
        <KpiCard label="Output Tokens" value={fmtTok(totals?.outputTokens ?? 0)} />
        <KpiCard label="Cache Reads"   value={fmtTok(totals?.cacheReadTokens ?? 0)} />
        <KpiCard label="Cache Writes"  value={fmtTok(totals?.cacheCreationTokens ?? 0)} />
        <KpiCard label="Sessions"      value={String(fleetState?.sessions?.length ?? 0)} />
      </div>

      {windows.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 6 }}>
            Account Limits
          </div>
          {WINDOW_ORDER.map(k => {
            const w = windows.find(w => w.type === k);
            if (!w) return null;
            // Request-count windows: show count, not a percentage
            if (w.utilization == null && w.requestCount != null) {
              return <LimitBar key={k} label={WINDOW_LABELS[k] ?? k} pct={0} isCount count={w.requestCount} resetAt={w.resetAt} alwaysShowDays={k.startsWith('seven_day') || k === 'week_requests'} />;
            }
            // Utilization windows: 0-100 percentage
            const pct = Math.max(0, Math.min(100, w.utilization ?? 0));
            return <LimitBar key={k} label={WINDOW_LABELS[k] ?? k} pct={pct} resetAt={w.resetAt} alwaysShowDays={k.startsWith('seven_day') || k === 'week_requests'} />;
          })}
        </div>
      )}

      {usageHist?.byDay && (() => {
        const days = Object.keys(usageHist.byDay!).sort().slice(-30);
        const entries = days.map(d => ({ l: d, v: usageHist.byDay![d].costUsd * 100 }));
        return (
          <div>
            <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 4 }}>
              Daily Cost — last 30 days (¢)
            </div>
            <BarChart entries={entries} width={250} height={96} color="var(--accent)" />
          </div>
        );
      })()}
      {loading && !usageHist && (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading history…</div>
      )}
    </div>
  );

  const renderDayMonth = (which: 'daily' | 'monthly') => {
    const source = which === 'daily' ? usageHist?.byDay : usageHist?.byMonth;
    if (!source) return <div style={{ fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading…' : 'No data.'}</div>;

    type Row = { date: string; inp: number; out: number; cr: number; cc: number; cost: number; sessions: number };
    const allRows: Row[] = Object.entries(source).map(([date, d]) => ({
      date, inp: d.inputTokens, out: d.outputTokens,
      cr: d.cacheReadTokens, cc: d.cacheCreationTokens,
      cost: d.costUsd, sessions: d.count,
    }));
    const rows = [...allRows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortCol];
      const bv = (b as Record<string, unknown>)[sortCol];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc'
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });

    const chartEntries = rows.slice(-60).map(r => ({
      l: r.date, values: [r.inp, r.out, r.cr, r.cc],
    }));

    const thL: React.CSSProperties = { padding: '3px 5px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)', textAlign: 'left' };
    const td: React.CSSProperties  = { padding: '2px 5px', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };

    return (
      <div>
        <StackedBarChart entries={chartEntries} colors={STACK_COLORS} width={250} height={96} />
        <div style={{ marginTop: 8, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={thL}>Date</th>
                {([['inp','Input'],['out','Output'],['cr','CR'],['cc','CW'],['cost','Cost'],['sessions','Sess']] as [string,string][]).map(([c, l]) => (
                  <SortableTh key={c} col={c} label={l} sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const hitPct = r.inp > 0 ? ((r.cr / r.inp) * 100).toFixed(0) + '%' : '—';
                return (
                  <tr key={r.date} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...td, textAlign: 'left' }}>{r.date}</td>
                    <td style={td}>{fmtTok(r.inp)}</td>
                    <td style={td}>{fmtTok(r.out)}</td>
                    <td style={td}>{fmtTok(r.cr)}</td>
                    <td style={td}>{fmtTok(r.cc)}</td>
                    <td style={{ ...td, fontSize: 9 }}>{hitPct}</td>
                    <td style={td}>{(r.cost * 100).toFixed(1)}¢</td>
                    <td style={td}>{r.sessions}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderModels = () => {
    const byModel = usageHist?.byModel;
    if (!byModel) return <div style={{ fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading…' : 'No data.'}</div>;

    const models = Object.entries(byModel).map(([name, d]) => ({
      name,
      inp: d.inputTokens, out: d.outputTokens,
      cr: d.cacheReadTokens, cc: d.cacheCreationTokens,
      total: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens,
      sessions: d.count,
    })).sort((a, b) => b.total - a.total);

    const maxTotal = Math.max(...models.map(m => m.total), 1);
    const thR: React.CSSProperties = { padding: '3px 5px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)', textAlign: 'right' };
    const td:  React.CSSProperties = { padding: '2px 5px', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };

    return (
      <div>
        {models.map(m => (
          <div key={m.name} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }} title={m.name}>
                {m.name}
              </span>
              <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtTok(m.total)}</span>
            </div>
            <div style={{ background: 'var(--border)', borderRadius: 2, height: 5 }}>
              <div style={{ width: `${(m.total / maxTotal) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
            </div>
          </div>
        ))}
        <div style={{ marginTop: 10, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ ...thR, textAlign: 'left' }}>Model</th>
                {['Input','Output','Cache','Sessions'].map(h => <th key={h} style={thR}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...td, textAlign: 'left', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.name}>{m.name}</td>
                  <td style={td}>{fmtTok(m.inp)}</td>
                  <td style={td}>{fmtTok(m.out)}</td>
                  <td style={td}>{fmtTok(m.cr + m.cc)}</td>
                  <td style={td}>{m.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderSessionsHist = () => {
    const sessions = usageHist?.sessions?.slice(0, 50) ?? [];
    if (!sessions.length) return <div style={{ fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading…' : 'No sessions.'}</div>;
    const thR: React.CSSProperties = { padding: '3px 5px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)', textAlign: 'right' };
    const td:  React.CSSProperties = { padding: '2px 5px', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...thR, textAlign: 'left' }}>Label</th>
              {['Cost','Input','Output','Turns'].map(h => <th key={h} style={thR}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...td, textAlign: 'left', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.label}>{s.label}</td>
                <td style={td}>{(s.costUsd * 100).toFixed(1)}¢</td>
                <td style={td}>{fmtTok(s.inputTokens)}</td>
                <td style={td}>{fmtTok(s.outputTokens)}</td>
                <td style={td}>{s.turns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderScatter = () => {
    if (!scatterData) {
      return <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading exchanges…</div>;
    }
    const exchanges = scatterData.exchanges ?? [];
    if (!exchanges.length) {
      return <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>No exchange data.</div>;
    }

    const byDay: Record<string, number[]> = {};
    for (const ex of exchanges) {
      const d = ex.day ?? new Date(ex.tsMs).toISOString().slice(0, 10);
      if (!byDay[d]) byDay[d] = [0, 0, 0, 0];
      byDay[d][0] += ex.inp;
      byDay[d][1] += ex.out;
      byDay[d][2] += ex.cr;
      byDay[d][3] += ex.cc;
    }
    const dayEntries = Object.keys(byDay).sort().map(d => ({ l: d, values: byDay[d] }));

    return (
      <div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 4 }}>
          Per-exchange scatter ({exchanges.length} points)
        </div>
        <ScatterPlot exchanges={exchanges} width={250} height={120} />
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginTop: 10, marginBottom: 4 }}>
          Daily aggregation
        </div>
        <StackedBarChart entries={dayEntries} colors={STACK_COLORS} width={250} height={90} />
      </div>
    );
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':      return renderOverview();
      case 'daily':         return renderDayMonth('daily');
      case 'monthly':       return renderDayMonth('monthly');
      case 'models':        return renderModels();
      case 'sessions-hist': return renderSessionsHist();
      case 'scatter':       return renderScatter();
      default:              return null;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--sb-bg)' }}>
      {/* Vertical tab strip — 35 px */}
      <div style={{
        width: 35, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--tab-strip, var(--sb-bg))',
        borderRight: '1px solid var(--tab-border, var(--border))',
        paddingTop: 4,
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            title={t.label}
            style={{
              background: 'none',
              border: 'none',
              borderLeft: activeTab === t.id
                ? '2px solid var(--accent)'
                : '2px solid transparent',
              color: activeTab === t.id
                ? 'var(--ed-fg, var(--sb-fg))'
                : 'var(--muted)',
              cursor: 'pointer',
              padding: '8px 0',
              fontSize: 9,
              textAlign: 'center',
              writingMode: 'vertical-rl',
              textOrientation: 'mixed',
              transform: 'rotate(180deg)',
              width: '100%',
              userSelect: 'none',
              letterSpacing: '0.04em',
              fontWeight: activeTab === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', fontSize: 12, color: 'var(--sb-fg)' }}>
        {renderContent()}
      </div>
    </div>
  );
}
