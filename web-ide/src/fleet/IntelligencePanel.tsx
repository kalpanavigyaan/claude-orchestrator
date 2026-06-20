import React, { useState } from 'react';
import { apiPost } from './api';
import type { FleetState } from './types';
import ToolAnalytics from './ToolAnalytics';

interface Props {
  fleetState: FleetState | null;
  selectedId: string | null;
}

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

type Category = 'Code Intelligence' | 'Token Efficiency' | 'Memory' | 'Analysis';

interface Tool { id: string; name: string; desc: string; category: Category; }

const TOOLS: Tool[] = [
  // Code Intelligence
  { id: 'safr',           name: 'SAFR',          desc: 'Symbol-aware file reader',        category: 'Code Intelligence' },
  { id: 'chunkhound',     name: 'ChunkHound',     desc: 'Semantic chunk search',           category: 'Code Intelligence' },
  { id: 'region_extract', name: 'RegionExtract',  desc: 'Extract code regions',            category: 'Code Intelligence' },
  { id: 'symbol_scope',   name: 'SymbolScope',    desc: 'Find symbol usages',              category: 'Code Intelligence' },
  // Token Efficiency
  { id: 'tds',            name: 'TDS',            desc: 'Token-diff summariser',           category: 'Token Efficiency' },
  { id: 'noise_filter',   name: 'NoiseFilter',    desc: 'Strips irrelevant lines',         category: 'Token Efficiency' },
  { id: 'log_dedup',      name: 'LogDedup',       desc: 'Deduplicates logs',               category: 'Token Efficiency' },
  { id: 'stack_collapse', name: 'StackCollapse',  desc: 'Collapses stack traces',          category: 'Token Efficiency' },
  // Memory
  { id: 'cavemem_read',   name: 'CavememRead',    desc: 'Read from persistent memory',     category: 'Memory' },
  { id: 'cavemem_write',  name: 'CavememWrite',   desc: 'Write to persistent memory',      category: 'Memory' },
  // Analysis
  { id: 'graphify',       name: 'Graphify',       desc: 'Dependency graph',                category: 'Analysis' },
  { id: 'ast_query',      name: 'ASTQuery',       desc: 'Tree-sitter queries',             category: 'Analysis' },
];

const CATEGORIES: Category[] = ['Code Intelligence', 'Token Efficiency', 'Memory', 'Analysis'];

const DEFAULT_TOOLS = [
  'safr', 'chunkhound', 'region_extract', 'symbol_scope',
  'tds',  'noise_filter', 'log_dedup',    'stack_collapse',
];

const hdrStyle: React.CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  color: 'var(--muted)',
  padding: '8px 10px 3px',
  borderBottom: '1px solid var(--border)',
};

// ---------------------------------------------------------------------------

export default function IntelligencePanel({ fleetState, selectedId }: Props) {
  const session = fleetState?.sessions?.find(s => s.id === selectedId) ?? null;
  const globalTsEnabled = fleetState?.toolServer?.enabled ?? false;

  // Local optimistic state — null means "use server value"
  const [localTools, setLocalTools]       = useState<string[] | null>(null);
  const [localTsOn,  setLocalTsOn]        = useState<boolean | null>(null);
  const [tab, setTab] = useState<'tools' | 'analytics'>('tools');

  const effectiveTools = localTools ?? session?.tools ?? DEFAULT_TOOLS;
  const effectiveTsOn  = localTsOn  ?? session?.toolServer ?? globalTsEnabled;

  async function toggleTool(id: string) {
    const next = effectiveTools.includes(id)
      ? effectiveTools.filter(t => t !== id)
      : [...effectiveTools, id];
    setLocalTools(next);
    if (selectedId) {
      await apiPost(`/api/sessions/${selectedId}/set-tools`, { tools: next });
    }
  }

  async function toggleToolServer() {
    const next = !effectiveTsOn;
    setLocalTsOn(next);
    if (selectedId) {
      await apiPost(`/api/sessions/${selectedId}/set-tool-server`, { enabled: next });
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['tools', 'analytics'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '6px 0', background: 'transparent', border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--ed-fg)' : 'var(--muted)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'uppercase', letterSpacing: '.04em',
            }}
          >
            {t === 'tools' ? 'Tools' : 'Analytics'}
          </button>
        ))}
      </div>

      {tab === 'analytics' ? (
        <ToolAnalytics />
      ) : (
      <>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--sb-hdr-fg)' }}>
          Intelligence Tools
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>Tool Server</span>
          <button
            onClick={toggleToolServer}
            title={effectiveTsOn ? 'Disable tool server' : 'Enable tool server'}
            style={{
              background: effectiveTsOn ? 'var(--accent)' : 'var(--btn-2nd, rgba(255,255,255,.08))',
              color: effectiveTsOn ? '#fff' : 'var(--muted)',
              border: 'none', borderRadius: 10,
              padding: '2px 9px', fontSize: 10, cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {effectiveTsOn ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {!selectedId && (
        <div style={{ padding: '10px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', flexShrink: 0 }}>
          Select a session to manage its intelligence tools.
        </div>
      )}

      {/* Tool list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {CATEGORIES.map(cat => (
          <div key={cat}>
            <div style={hdrStyle}>{cat}</div>
            {TOOLS.filter(t => t.category === cat).map(tool => {
              const active = effectiveTools.includes(tool.id);
              return (
                <label
                  key={tool.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 10px',
                    cursor: selectedId ? 'pointer' : 'default',
                    borderBottom: '1px solid var(--border)',
                    opacity: selectedId ? 1 : 0.5,
                    userSelect: 'none',
                  }}
                  onMouseEnter={e => {
                    if (selectedId) (e.currentTarget as HTMLElement).style.background = 'var(--sb-hover)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = 'none';
                  }}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={!selectedId}
                    onChange={() => toggleTool(tool.id)}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, fontSize: 11 }}>{tool.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tool.desc}
                    </div>
                  </div>
                  {/* Status dot */}
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: active ? 'var(--green)' : 'var(--border)',
                    transition: 'background 0.2s',
                  }} />
                </label>
              );
            })}
          </div>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
