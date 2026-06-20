import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Session } from '../fleet/types';
import { apiPost } from '../fleet/api';

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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

export default function SessionsPane({ sessions, selectedId, onSelect, resetAt, onRename }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal]   = useState('');
  const [ctxMenu, setCtxMenu]       = useState<CtxMenu | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // ── F2 key to start rename on the selected session ─────────────────────
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

  // ── Close context menu on outside click ────────────────────────────────
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
    // Optimistic update immediately — don't wait for SSE
    onRename?.(renamingId, newLabel);
    await apiPost(`/api/sessions/${renamingId}/rename`, { label: newLabel });
    setRenamingId(null);
  }

  function handleContextMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(s.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, session: s });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0 }}>
      {/* Header with countdown */}
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
        {sessions.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
            No active sessions. Click + to create one.
          </div>
        ) : (
          sessions.map((s, idx) => {
            const isSelected = s.id === selectedId;
            const dotColor   = STATUS_COLOR[s.status] ?? '#6a737d';
            const hostColor  = HOST_COLOR[s.host] ?? '#9cdcfe';
            const repo = s.cwd
              ? (s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? s.cwd)
              : '';
            const startMs = (s as unknown as Record<string, unknown>).startedAt as number | undefined;
            const rowTint = idx % 2 === 0 ? 'rgba(255,255,255,.02)' : 'transparent';

            return (
              <div
                key={s.id}
                tabIndex={0}
                onClick={() => onSelect(s.id)}
                onContextMenu={e => handleContextMenu(e, s)}
                style={{
                  padding: '6px 8px',
                  cursor: 'pointer',
                  backgroundColor: isSelected ? 'var(--sb-focus)' : rowTint,
                  color: isSelected ? '#fff' : 'var(--sb-fg)',
                  borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                  borderBottom: '1px solid rgba(255,255,255,.04)',
                  userSelect: 'none',
                  outline: 'none',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--sb-hover)'; }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = rowTint; }}
              >
                {/* Row 1: status dot + label + elapsed */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    backgroundColor: dotColor, flexShrink: 0,
                    boxShadow: s.status === 'running' ? `0 0 5px ${dotColor}88` : 'none',
                  }} />

                  {renamingId === s.id ? (
                    <input
                      ref={renameRef}
                      value={renameVal}
                      onChange={e => setRenameVal(e.target.value)}
                      onBlur={confirmRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') confirmRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        flex: 1, height: 20, padding: '0 4px', fontSize: 12,
                        background: 'var(--in-bg)', border: '1px solid var(--in-focus)',
                        borderRadius: 2, color: 'var(--in-fg)', outline: 'none',
                      }}
                    />
                  ) : (
                    <span
                      title={`${s.label} — right-click or F2 to rename`}
                      style={{
                        fontSize: 13, fontWeight: 500, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                      }}
                    >
                      {s.label || s.id}
                    </span>
                  )}

                  {/* Elapsed timer for running sessions */}
                  {s.status === 'running' && startMs != null && (
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#4ade80', flexShrink: 0 }}>
                      <ElapsedTimer startMs={startMs} />
                    </span>
                  )}
                  {/* Waiting-for-reset countdown */}
                  {s.status === 'limited' && s.resetAt != null && (
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#fbbf24', flexShrink: 0 }} title="Waiting for account reset">
                      ⏸ <Countdown targetMs={s.resetAt} />
                    </span>
                  )}
                </div>

                {/* Row 2: host · distro · repo · status badge */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  marginTop: 2, paddingLeft: 14, fontSize: 11,
                }}>
                  <span style={{ color: hostColor, fontWeight: 600 }}>{s.host}</span>
                  {s.distro && <span style={{ color: '#9cdcfe', opacity: 0.8 }}>· {s.distro}</span>}
                  {repo && <span style={{ color: 'var(--muted)' }}>· {repo}</span>}
                  {s.status !== 'idle' && s.status !== 'ended' && s.status !== 'limited' && (
                    <span style={{
                      marginLeft: 'auto', fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                      background: s.status === 'running' ? 'rgba(74,222,128,.15)'
                               : s.status === 'error'   ? 'rgba(248,113,113,.15)'
                               : 'rgba(251,191,36,.15)',
                      color: dotColor,
                    }}>
                      {s.status}
                    </span>
                  )}
                  {s.status === 'limited' && (
                    <span style={{ marginLeft: 'auto', fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0, background: 'rgba(251,191,36,.15)', color: '#fbbf24' }}>
                      waiting for reset
                    </span>
                  )}
                </div>
              </div>
            );
          })
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
