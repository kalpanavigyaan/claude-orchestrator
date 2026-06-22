import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Session } from '../fleet/types';
import { apiPost } from '../fleet/api';

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDismiss?: (id: string) => void;
  resetAt?: number;
  onRename?: (id: string, newLabel: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  running:  '#4ade80',
  starting: '#fbbf24',
  error:    '#f87171',
  limited:  '#fbbf24',
  idle:     '#6a737d',
  ended:    '#6a737d',
};

const HOST_COLOR: Record<string, string> = {
  local:  '#9cdcfe',
  wsl:    '#4ade80',
  hyperv: '#fbbf24',
};

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

function Countdown({ targetMs }: { targetMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const rem = Math.max(0, targetMs - now);
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  return <span>{pad(h)}:{pad(m)}:{pad(s)}</span>;
}

function ElapsedTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startMs);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startMs), 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return <span>{fmtElapsed(elapsed)}</span>;
}

interface CtxMenu { x: number; y: number; session: Session; }

// Sessions classified as "active" show at the top; "dormant" (idle/error) go below, collapsible.
const ACTIVE_STATUSES = new Set(['running', 'starting', 'limited']);

export default function SessionsPane({ sessions, selectedId, onSelect, onDismiss, resetAt, onRename }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal]   = useState('');
  const [ctxMenu, setCtxMenu]       = useState<CtxMenu | null>(null);
  const [dormantOpen, setDormantOpen] = useState(true);
  const renameRef = useRef<HTMLInputElement>(null);

  // Exclude ended sessions — they live in History pane
  const visible = sessions.filter(s => s.status !== 'ended');
  const active  = visible.filter(s => ACTIVE_STATUSES.has(s.status));
  const dormant = visible.filter(s => !ACTIVE_STATUSES.has(s.status)); // idle + error

  // F2 to rename selected session
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'F2' && selectedId && !renamingId) {
        e.preventDefault();
        const s = sessions.find(x => x.id === selectedId);
        if (s) { setRenamingId(s.id); setRenameVal(s.label); setTimeout(() => renameRef.current?.focus(), 50); }
      }
      if (e.key === 'Escape' && renamingId) { setRenamingId(null); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, renamingId, sessions]);

  // Close ctx menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  const startRename = useCallback((s: Session, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCtxMenu(null);
    setRenamingId(s.id);
    setRenameVal(s.label);
    setTimeout(() => renameRef.current?.focus(), 50);
  }, []);

  async function confirmRename() {
    if (!renamingId || !renameVal.trim()) { setRenamingId(null); return; }
    const newLabel = renameVal.trim();
    onRename?.(renamingId, newLabel);
    await apiPost(`/api/sessions/${renamingId}/rename`, { label: newLabel });
    setRenamingId(null);
  }

  async function dismiss(s: Session, e: React.MouseEvent) {
    e.stopPropagation();
    setCtxMenu(null);
    await apiPost(`/api/sessions/${s.id}/dismiss`, {});
    onDismiss?.(s.id);
  }

  async function dismissAll(list: Session[]) {
    setCtxMenu(null);
    await Promise.all(list.map(s => apiPost(`/api/sessions/${s.id}/dismiss`, {})));
    list.forEach(s => onDismiss?.(s.id));
  }

  function handleContextMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(s.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, session: s });
  }

  function renderRow(s: Session) {
    const isSelected = s.id === selectedId;
    const isDormant  = !ACTIVE_STATUSES.has(s.status);
    const dotColor   = STATUS_COLOR[s.status] ?? '#6a737d';
    const hostColor  = HOST_COLOR[s.host] ?? '#9cdcfe';
    const repo       = s.cwd ? (s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? s.cwd) : '';
    const startMs    = (s as unknown as Record<string, unknown>).startedAt as number | undefined;

    return (
      <div
        key={s.id}
        tabIndex={0}
        onClick={() => onSelect(s.id)}
        onContextMenu={e => handleContextMenu(e, s)}
        className="session-row"
        style={{
          padding: '5px 8px',
          cursor: 'pointer',
          position: 'relative',
          backgroundColor: isSelected ? 'var(--sb-focus)' : 'transparent',
          color: isSelected ? '#fff' : isDormant ? 'var(--muted)' : 'var(--sb-fg)',
          borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
          borderBottom: '1px solid rgba(255,255,255,.04)',
          userSelect: 'none', outline: 'none',
        }}
        onMouseEnter={e => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--sb-hover)';
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.dismiss-btn')!.style.opacity = '1';
        }}
        onMouseLeave={e => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.dismiss-btn')!.style.opacity = '0';
        }}
      >
        {/* Row 1 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            backgroundColor: dotColor, flexShrink: 0,
            boxShadow: s.status === 'running' ? `0 0 5px ${dotColor}88` : 'none',
          }} />

          {renamingId === s.id ? (
            <input
              ref={renameRef}
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={confirmRename}
              onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenamingId(null); }}
              onClick={e => e.stopPropagation()}
              style={{
                flex: 1, height: 20, padding: '0 4px', fontSize: 12,
                background: 'var(--in-bg)', border: '1px solid var(--in-focus)',
                borderRadius: 2, color: 'var(--in-fg)', outline: 'none',
              }}
            />
          ) : (
            <span title={`${s.label} — right-click or F2 to rename`} style={{
              fontSize: 12, fontWeight: 500, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              {s.label || s.id}
            </span>
          )}

          {s.status === 'running' && startMs != null && (
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#4ade80', flexShrink: 0 }}>
              <ElapsedTimer startMs={startMs} />
            </span>
          )}
          {s.status === 'limited' && s.resetAt != null && (
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#fbbf24', flexShrink: 0 }} title="Waiting for account reset">
              ⏸ <Countdown targetMs={s.resetAt} />
            </span>
          )}

          {/* Dismiss button — visible on hover for dormant sessions */}
          <button
            className="dismiss-btn"
            onClick={e => dismiss(s, e)}
            title="Remove from list (session saved to History)"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', padding: '0 2px', fontSize: 12,
              lineHeight: 1, flexShrink: 0, opacity: 0, transition: 'opacity .1s',
            }}
          >✕</button>
        </div>

        {/* Row 2 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1, paddingLeft: 13, fontSize: 10 }}>
          <span style={{ color: hostColor, fontWeight: 600 }}>{s.host}</span>
          {s.distro && <span style={{ color: '#9cdcfe', opacity: 0.8 }}>· {s.distro}</span>}
          {repo && <span style={{ color: 'var(--muted)' }}>· {repo}</span>}
          {s.status !== 'idle' && s.status !== 'limited' && (
            <span style={{
              marginLeft: 'auto', fontSize: 9, padding: '1px 4px', borderRadius: 3, flexShrink: 0,
              background: s.status === 'running' ? 'rgba(74,222,128,.15)'
                       : s.status === 'error'   ? 'rgba(248,113,113,.15)'
                       : 'rgba(251,191,36,.15)',
              color: dotColor,
            }}>
              {s.status}
            </span>
          )}
          {s.status === 'limited' && (
            <span style={{ marginLeft: 'auto', fontSize: 9, padding: '1px 4px', borderRadius: 3, flexShrink: 0, background: 'rgba(251,191,36,.15)', color: '#fbbf24' }}>
              rate limited
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0 }}>
      {/* Header */}
      <div style={{
        padding: '4px 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
        textTransform: 'uppercase', color: '#4ade80',
        borderLeft: '3px solid #4ade80',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>Sessions</span>
        {resetAt != null && resetAt > 0 && (
          <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 400, color: 'var(--cyan)' }}
            title="Account reset countdown">
            <Countdown targetMs={resetAt} />
          </span>
        )}
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {visible.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
            No sessions. Click + to create one.
          </div>
        ) : (
          <>
            {/* ── Active section ──────────────────────────────────── */}
            {active.length > 0 && active.map(renderRow)}

            {/* ── Dormant (idle / error) section ──────────────────── */}
            {dormant.length > 0 && (
              <>
                <div
                  onClick={() => setDormantOpen(o => !o)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '3px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'var(--muted)',
                    background: 'rgba(255,255,255,.03)',
                    borderTop: active.length > 0 ? '1px solid var(--border)' : 'none',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', userSelect: 'none',
                  }}
                >
                  <span>{dormantOpen ? '▾' : '▸'} Idle · {dormant.length}</span>
                  {dormant.length > 0 && (
                    <button
                      onClick={e => { e.stopPropagation(); dismissAll(dormant); }}
                      title="Remove all idle sessions from list"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 10, color: 'var(--muted)', padding: '0 2px',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
                    >
                      Clear all
                    </button>
                  )}
                </div>
                {dormantOpen && dormant.map(renderRow)}
              </>
            )}
          </>
        )}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="ctx-item" onClick={() => startRename(ctxMenu.session)}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M11 2l3 3-9 9H2v-3l9-9z"/>
            </svg>
            Rename
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: .5 }}>F2</span>
          </div>
          {!ACTIVE_STATUSES.has(ctxMenu.session.status) && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item danger" onClick={e => dismiss(ctxMenu.session, e)}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/>
                </svg>
                Remove from list
              </div>
            </>
          )}
          <div className="ctx-sep" />
          <div className="ctx-item" onClick={async () => {
            await navigator.clipboard.writeText(ctxMenu.session.label).catch(() => {});
            setCtxMenu(null);
          }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="4" y="4" width="10" height="10" rx="1"/><path d="M2 2h8v2H4v8H2z"/>
            </svg>
            Copy label
          </div>
          <div className="ctx-item" onClick={async () => {
            await navigator.clipboard.writeText(ctxMenu.session.id).catch(() => {});
            setCtxMenu(null);
          }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="4" y="4" width="10" height="10" rx="1"/><path d="M2 2h8v2H4v8H2z"/>
            </svg>
            Copy session ID
          </div>
        </div>
      )}
    </div>
  );
}
