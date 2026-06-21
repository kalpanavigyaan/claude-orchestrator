import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, RefreshCw, Edit3 } from 'lucide-react';
import { apiGet, apiPost } from '../fleet/api';
import type { HistorySession } from '../fleet/types';

interface Props {
  onSelectHistory: (rel: string, sessions: HistorySession[]) => void;
  onResume: (id: string) => void;
  onRename?: (rel: string, newLabel: string) => void;
  onCopySession?: (s: HistorySession) => void;
}

const STATUS_COLOR: Record<string, string> = {
  idle: '#6a737d', done: '#6a737d', running: '#4ade80',
  started: '#6a737d', ended: '#6a737d', error: '#f87171',
};

const GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Older'];

function dateGroup(ts: number | string | null | undefined): string {
  if (!ts) return 'Older';
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!ms) return 'Older';
  const diff = Date.now() - ms;
  const DAY = 86400000;
  if (diff < DAY) return 'Today';
  if (diff < 2 * DAY) return 'Yesterday';
  if (diff < 7 * DAY) return 'This Week';
  if (diff < 14 * DAY) return 'Last Week';
  if (diff < 31 * DAY) return 'This Month';
  return 'Older';
}

function historyDisplayStatus(s: HistorySession): string {
  const st = s.status ?? '';
  if (st === 'started' || st === 'running') return 'idle';
  if (st === 'ended') return 'done';
  return st || 'idle';
}

function repoName(s: HistorySession): string {
  if (s.repo) return s.repo.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? s.repo;
  return '';
}

interface CtxMenu { x: number; y: number; session: HistorySession; }

export default function HistoryPane({ onSelectHistory, onResume, onRename, onCopySession }: Props) {
  const [sessions, setSessions]     = useState<HistorySession[]>([]);
  const [filter, setFilter]         = useState('');
  // Expand all groups by default so sessions are visible regardless of age
  const [expanded, setExpanded]     = useState<Set<string>>(new Set(GROUP_ORDER));
  const [loading, setLoading]       = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [selectedRel, setSelectedRel] = useState<string | null>(null);
  const [renamingRel, setRenamingRel] = useState<string | null>(null);
  const [renameVal, setRenameVal]     = useState('');
  const [ctxMenu, setCtxMenu]         = useState<CtxMenu | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const retryRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    const data = await apiGet('/api/history', 8000);
    setLoading(false);
    if (data && Array.isArray(data.sessions)) {
      setSessions(data.sessions as HistorySession[]);
      setFetchError(false);
      if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    } else {
      // Fleet-console not ready yet (just restarted) — retry automatically
      setFetchError(true);
      retryRef.current = setTimeout(loadHistory, 3000);
    }
  }, []);

  useEffect(() => {
    loadHistory();
    return () => { if (retryRef.current) clearTimeout(retryRef.current); };
  }, [loadHistory]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  // F2 to rename selected history item
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F2' && selectedRel && !renamingRel) {
        const s = sessions.find(x => x.rel === selectedRel);
        if (s) startRename(s);
      }
      if (e.key === 'Escape' && renamingRel) setRenamingRel(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedRel, renamingRel, sessions]);

  function startRename(s: HistorySession) {
    setCtxMenu(null);
    setRenamingRel(s.rel);
    setRenameVal(s.label || '');
    setTimeout(() => renameRef.current?.focus(), 50);
  }

  async function confirmRename() {
    if (!renamingRel || !renameVal.trim()) { setRenamingRel(null); return; }
    const newLabel = renameVal.trim();
    // Optimistic update immediately
    setSessions(prev => prev.map(s => s.rel === renamingRel ? { ...s, label: newLabel } : s));
    onRename?.(renamingRel, newLabel);
    await apiPost('/api/history/rename', { rel: renamingRel, label: newLabel });
    setRenamingRel(null);
  }

  const filtered = sessions.filter(s =>
    !filter ||
    (s.label ?? '').toLowerCase().includes(filter.toLowerCase()) ||
    (s.repo ?? '').toLowerCase().includes(filter.toLowerCase())
  );

  const dateMap = new Map<string, HistorySession[]>();
  for (const s of filtered) {
    const ts = s.createdAt ?? s.mtime ?? null;
    const d = dateGroup(ts);
    if (!dateMap.has(d)) dateMap.set(d, []);
    dateMap.get(d)!.push(s);
  }
  const sortedDates = GROUP_ORDER.filter(g => dateMap.has(g));

  function toggleDate(d: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  }

  function handleContextMenu(e: React.MouseEvent, s: HistorySession) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedRel(s.rel);
    setCtxMenu({ x: e.clientX, y: e.clientY, session: s });
  }

  const GROUP_DATE_COLORS: Record<string, string> = {
    Today: '#4ade80', Yesterday: '#61afef', 'This Week': '#fbbf24',
    'Last Week': '#fb923c', 'This Month': '#c678dd', Older: '#6a737d',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)' }}>
      {/* Header */}
      <div className="fleet-pane-hdr blue">
        <span>History</span>
        <button
          onClick={loadHistory} disabled={loading}
          title="Refresh history"
          className="icon-btn" style={{ padding: 2 }}
        >
          <RefreshCw size={12} style={{ opacity: loading ? 0.4 : 1 }} />
        </button>
      </div>

      {/* Filter input */}
      <div style={{ padding: '4px 6px', flexShrink: 0 }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          className="fleet-input"
          style={{ fontSize: 12, padding: '4px 8px' }}
        />
      </div>

      {/* Tree */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading && sessions.length === 0 && (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
            Loading…
          </div>
        )}
        {!loading && fetchError && (
          <div style={{ padding: '12px 10px', fontSize: 12, color: '#fbbf24' }}>
            Fleet-console not reachable — retrying…
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Make sure fleet-console is running at port 4318.
            </div>
          </div>
        )}
        {!loading && !fetchError && sortedDates.length === 0 && (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
            No history found.
          </div>
        )}

        {sortedDates.map(date => {
          const isOpen = expanded.has(date);
          const items  = dateMap.get(date)!;
          const dateColor = GROUP_DATE_COLORS[date] ?? '#6a737d';

          return (
            <div key={date}>
              {/* Date group header */}
              <div
                onClick={() => toggleDate(date)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px 3px', cursor: 'pointer',
                  fontSize: 10, fontWeight: 700, color: dateColor,
                  textTransform: 'uppercase', letterSpacing: '.06em',
                  borderBottom: `1px solid ${dateColor}22`,
                  background: `${dateColor}08`,
                  userSelect: 'none',
                }}
              >
                {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {date}
                <span style={{ marginLeft: 'auto', fontSize: 9, opacity: .6, fontWeight: 400 }}>{items.length}</span>
              </div>

              {/* Sessions under date */}
              {isOpen && items.map(s => {
                const dispStatus = historyDisplayStatus(s);
                const dotColor   = STATUS_COLOR[dispStatus] ?? '#6a737d';
                const repo       = repoName(s);
                const isSel      = s.rel === selectedRel;
                const isRenaming = s.rel === renamingRel;

                return (
                  <div
                    key={s.rel}
                    tabIndex={0}
                    onClick={() => { setSelectedRel(s.rel); onSelectHistory(s.rel, sessions); }}
                    onContextMenu={e => handleContextMenu(e, s)}
                    style={{
                      padding: '5px 10px 5px 20px',
                      cursor: 'pointer', fontSize: 12,
                      color: isSel ? '#fff' : 'var(--sb-fg)',
                      background: isSel ? 'var(--sb-focus)' : 'transparent',
                      borderLeft: isSel ? '3px solid var(--accent)' : '3px solid transparent',
                      borderBottom: '1px solid rgba(255,255,255,.03)',
                      outline: 'none',
                    }}
                    onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'; }}
                    onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: dotColor, flexShrink: 0 }} />

                      {isRenaming ? (
                        <input
                          ref={renameRef}
                          value={renameVal}
                          onChange={e => setRenameVal(e.target.value)}
                          onBlur={confirmRename}
                          onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenamingRel(null); }}
                          onClick={e => e.stopPropagation()}
                          style={{
                            flex: 1, height: 20, padding: '0 4px', fontSize: 12,
                            background: 'var(--in-bg)', border: '1px solid var(--in-focus)',
                            borderRadius: 2, color: 'var(--in-fg)', outline: 'none',
                          }}
                        />
                      ) : (
                        <span
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                          title={`${s.label || s.rel} — right-click or F2 to rename`}
                        >
                          {s.label || s.rel}
                        </span>
                      )}

                      {(s.costUsd ?? 0) > 0 && (
                        <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>
                          ${s.costUsd!.toFixed(2)}
                        </span>
                      )}
                    </div>

                    {repo && (
                      <div style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 13, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📁 {repo}
                        {typeof s.messages === 'number' && s.messages > 0 && (
                          <span style={{ marginLeft: 6, color: 'var(--cyan)' }}>{s.messages} msgs</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fleet-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="fleet-ctx-item" onClick={() => startRename(ctxMenu.session)}>
            <Edit3 size={13} />
            Rename
            <span className="fleet-ctx-shortcut">F2</span>
          </div>
          <div className="fleet-ctx-sep" />
          <div className="fleet-ctx-item" onClick={() => { onSelectHistory(ctxMenu.session.rel, sessions); setCtxMenu(null); }}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 2h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H2a1 1 0 01-1-1V3a1 1 0 011-1z"/>
            </svg>
            View Transcript
          </div>
          <div className="fleet-ctx-item" onClick={async () => {
            const res = await apiPost('/api/history/resume', { rel: ctxMenu.session.rel });
            if (res?.id) onResume(res.id);
            setCtxMenu(null);
          }}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M4 3l9 5-9 5V3z"/>
            </svg>
            Resume Session
          </div>
          {onCopySession && (
            <>
              <div className="fleet-ctx-sep" />
              <div className="fleet-ctx-item" onClick={() => { onCopySession(ctxMenu.session); setCtxMenu(null); }}>
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="5" y="5" width="9" height="9" rx="1"/>
                  <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2"/>
                </svg>
                Copy Session
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
