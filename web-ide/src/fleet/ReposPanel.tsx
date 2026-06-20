import React, { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost } from './api';
import type { Session } from './types';

interface RepoItem {
  path: string;
  name: string;
  branch?: string | null;
  changes?: number | null;
}

interface RepoGroup {
  host: string;
  distro?: string | null;
  label?: string;
  repos: RepoItem[];
  stopped?: boolean;
}

interface Props {
  selectedId: string | null;
  session: Session | null;
  onStartSession?: (cwd: string, host: string, distro?: string) => void;
}

interface CtxMenu { x: number; y: number; repo: RepoItem; group: RepoGroup; }

export default function ReposPanel({ selectedId, session, onStartSession }: Props) {
  const [groups,   setGroups]  = useState<RepoGroup[]>([]);
  const [loading,  setLoading] = useState(false);
  const [error,    setError]   = useState<string | null>(null);
  const [ctx,      setCtx]     = useState<CtxMenu | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  function toggleCollapse(gi: number) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(gi) ? next.delete(gi) : next.add(gi);
      return next;
    });
  }

  // Dismiss context menu on outside click
  const dismiss = useCallback(() => setCtx(null), []);
  useEffect(() => {
    if (!ctx) return;
    window.addEventListener('click', dismiss);
    window.addEventListener('contextmenu', dismiss);
    return () => { window.removeEventListener('click', dismiss); window.removeEventListener('contextmenu', dismiss); };
  }, [ctx, dismiss]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiGet('/api/repos').then(d => {
      if (d?.groups) {
        setGroups(d.groups as RepoGroup[]);
      } else if (d === null) {
        setError('Failed to load repositories.');
      }
      setLoading(false);
    });
  }, []);

  const additionalDirs = session?.additionalDirectories ?? [];

  async function toggleRepo(repoPath: string) {
    if (!selectedId) return;
    const next = additionalDirs.includes(repoPath)
      ? additionalDirs.filter(d => d !== repoPath)
      : [...additionalDirs, repoPath];
    await apiPost(`/api/sessions/${selectedId}/set-directories`, { directories: next });
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '4px 10px',
        fontSize: 9, textTransform: 'uppercase',
        letterSpacing: '0.07em', color: 'var(--sb-hdr-fg)', fontWeight: 600,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        Repositories
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--muted)' }}>Loading…</div>
        )}
        {error && !loading && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--red)' }}>{error}</div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
            No repositories found.
          </div>
        )}

        {groups.map((g, gi) => {
          const isCollapsed = collapsed.has(gi);
          return (
          <div key={gi}>
            {/* Group header — click to collapse */}
            <div
              onClick={() => toggleCollapse(gi)}
              style={{
                padding: '4px 10px',
                fontSize: 9, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'var(--muted)',
                background: 'var(--tab-strip, rgba(0,0,0,.15))',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: 8, opacity: .6, transition: 'transform .15s', transform: isCollapsed ? 'rotate(-90deg)' : 'none', display: 'inline-block' }}>▼</span>
              {g.host}{g.distro ? ` · ${g.distro}` : ''}
              <span style={{ marginLeft: 'auto', opacity: .5 }}>{g.repos?.length ?? 0}</span>
            </div>

            {!isCollapsed && g.repos?.map(repo => {
              const checked = additionalDirs.includes(repo.path);
              return (
                <label
                  key={repo.path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 10px 5px 18px',
                    cursor: selectedId ? 'pointer' : 'default',
                    borderBottom: '1px solid var(--border)',
                    opacity: selectedId ? 1 : 0.5,
                    userSelect: 'none',
                  }}
                  onContextMenu={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtx({ x: e.clientX, y: e.clientY, repo, group: g });
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
                    checked={checked}
                    disabled={!selectedId}
                    onChange={() => toggleRepo(repo.path)}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <span style={{
                    flex: 1, fontSize: 12, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={repo.path}>
                    {repo.name}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {repo.branch && (
                      <span style={{ fontSize: 10, color: 'var(--cyan)', fontFamily: 'monospace' }}>
                        {repo.branch}
                      </span>
                    )}
                    {(repo.changes ?? 0) > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--amber)' }}>{repo.changes}±</span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        );
        })}
      </div>

      {/* Footer hint */}
      {!selectedId && (
        <div style={{
          padding: '5px 10px',
          fontSize: 10, color: 'var(--muted)',
          borderTop: '1px solid var(--border)',
          fontStyle: 'italic', flexShrink: 0,
        }}>
          Select a session to add repositories.
        </div>
      )}

      {/* Context menu */}
      {ctx && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', zIndex: 9999,
            top: ctx.y, left: ctx.x,
            background: 'var(--sb-bg)', border: '1px solid var(--border)',
            borderRadius: 4, boxShadow: '0 4px 16px rgba(0,0,0,.5)',
            minWidth: 200, padding: '4px 0', fontSize: 12,
          }}
        >
          <div style={{ padding: '3px 10px 5px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)', marginBottom: 3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
            {ctx.repo.name}
          </div>
          <div
            onClick={() => { onStartSession?.(ctx.repo.path, ctx.group.host, ctx.group.distro ?? undefined); setCtx(null); }}
            style={{ padding: '5px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--accent)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}
          >
            ▶ Start session here
          </div>
          {selectedId && (
            <div
              onClick={() => { toggleRepo(ctx.repo.path); setCtx(null); }}
              style={{ padding: '5px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}
            >
              {additionalDirs.includes(ctx.repo.path) ? '✕ Remove from session' : '＋ Add to current session'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
