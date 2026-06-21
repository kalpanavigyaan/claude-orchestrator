import React, { useState, useEffect } from 'react';
import { apiPost } from '../fleet/api';
import type { Session } from '../fleet/types';

interface Props {
  session: Session | null;
  models: { value: string; displayName?: string }[];
  onHistoryResume?: (id: string) => void;
  viewingHistoryRel?: string | null;
}

const btnStyle: React.CSSProperties = {
  background: 'var(--btn-2nd, rgba(255,255,255,.08))',
  color: 'var(--ed-fg, var(--sb-fg))',
  border: 'none',
  padding: '4px 8px',
  borderRadius: 2,
  cursor: 'pointer',
  fontSize: 12,
  width: '100%',
  textAlign: 'left',
  marginBottom: 2,
};

type Tab = 'config' | 'dirs' | 'actions';

export default function ControlsPane({ session, models, onHistoryResume, viewingHistoryRel }: Props) {
  const [newDir, setNewDir] = useState('');
  const [tab, setTab] = useState<Tab>('config');
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    if (session?.status === 'idle' || session?.status === 'error') setCompacting(false);
  }, [session?.status]);

  async function resumeHistory() {
    if (!viewingHistoryRel) return;
    const r = await apiPost('/api/history/resume', { rel: viewingHistoryRel });
    if (r?.id) onHistoryResume?.(r.id);
    else onHistoryResume?.('');
  }

  if (!session) {
    return (
      <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
        {viewingHistoryRel ? (
          <>
            <div style={{ marginBottom: 8, fontStyle: 'italic' }}>Saved session — resume to continue.</div>
            <button onClick={resumeHistory} style={btnStyle}>▸ Resume Session</button>
          </>
        ) : (
          <div style={{ fontStyle: 'italic' }}>Select a session.</div>
        )}
      </div>
    );
  }

  const id = session.id;
  const s = session;

  async function setMode(e: React.ChangeEvent<HTMLSelectElement>) {
    await apiPost(`/api/sessions/${id}/set-mode`, { mode: e.target.value });
  }
  async function setModel(e: React.ChangeEvent<HTMLSelectElement>) {
    await apiPost(`/api/sessions/${id}/set-model`, { model: e.target.value });
  }
  async function setEffort(e: React.ChangeEvent<HTMLSelectElement>) {
    await apiPost(`/api/sessions/${id}/set-effort`, { effort: e.target.value });
  }
  async function setThinking(e: React.ChangeEvent<HTMLSelectElement>) {
    await apiPost(`/api/sessions/${id}/set-thinking`, { thinking: e.target.value });
  }
  async function toggleBrowser(e: React.ChangeEvent<HTMLInputElement>) {
    await apiPost(`/api/sessions/${id}/set-browser`, { browser: e.target.checked });
  }
  async function toggleAutoContinue(e: React.ChangeEvent<HTMLInputElement>) {
    await apiPost(`/api/sessions/${id}/auto-continue`, { enabled: e.target.checked });
  }
  async function toggleAutoRetryApiError(e: React.ChangeEvent<HTMLInputElement>) {
    await apiPost(`/api/sessions/${id}/auto-retry-api-error`, { enabled: e.target.checked });
  }
  async function toggleAutoCompact(e: React.ChangeEvent<HTMLInputElement>) {
    await apiPost(`/api/sessions/${id}/auto-compact`, { enabled: e.target.checked, threshold: s.autoCompactThreshold ?? 0.65 });
  }
  async function setAutoCompactThreshold(e: React.ChangeEvent<HTMLSelectElement>) {
    await apiPost(`/api/sessions/${id}/auto-compact`, { enabled: s.autoCompact ?? false, threshold: parseFloat(e.target.value) });
  }
  async function compactNow() {
    setCompacting(true);
    await apiPost(`/api/sessions/${id}/compact`, {});
  }
  async function removeDir(dir: string) {
    const dirs = (s.additionalDirectories ?? []).filter(d => d !== dir);
    await apiPost(`/api/sessions/${id}/set-directories`, { directories: dirs });
  }
  async function addDir() {
    if (!newDir.trim()) return;
    const dirs = [...(s.additionalDirectories ?? []), newDir.trim()];
    await apiPost(`/api/sessions/${id}/set-directories`, { directories: dirs });
    setNewDir('');
  }
  async function stopTask() {
    await apiPost(`/api/sessions/${id}/interrupt`, {});
  }
  async function continueSession() {
    await apiPost(`/api/sessions/${id}/continue`, {});
  }
  async function restartRunner() {
    await apiPost(`/api/sessions/${id}/restart`, {});
  }
  async function endSession() {
    if (!window.confirm('End this session?')) return;
    await apiPost(`/api/sessions/${id}/stop`, {});
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'config', label: 'Config' },
    { key: 'dirs', label: 'Dirs' },
    { key: 'actions', label: 'Actions' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: 'var(--sb-fg)', borderTop: '1px solid var(--border)', height: '100%' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.key ? 'var(--accent)' : 'var(--muted)',
              padding: '5px 4px',
              fontSize: 11,
              fontWeight: tab === t.key ? 600 : 400,
              cursor: 'pointer',
              letterSpacing: '.03em',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="fleet-scroll" style={{ flex: 1, overflow: 'auto' }}>

        {tab === 'config' && (
          <div style={{ padding: '8px 8px 12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 8px', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Mode</span>
              <select value={session.mode ?? 'default'} onChange={setMode} className="fleet-control-input">
                <option value="bypassPermissions">Auto full access</option>
                <option value="acceptEdits">Auto-accept edits</option>
                <option value="default">Ask before edits</option>
                <option value="plan">Plan read-only</option>
              </select>

              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Model</span>
              <select value={session.model ?? ''} onChange={setModel} className="fleet-control-input">
                <option value="">Default</option>
                {models.map(m => <option key={m.value} value={m.value}>{m.displayName ?? m.value}</option>)}
              </select>

              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Effort</span>
              <select value={session.effort ?? 'default'} onChange={setEffort} className="fleet-control-input">
                <option value="default">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="max">Max</option>
              </select>

              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Thinking</span>
              <select value={session.thinking ?? 'adaptive'} onChange={setThinking} className="fleet-control-input">
                <option value="adaptive">Adaptive</option>
                <option value="off">Off</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', padding: '4px 0' }}>
                <input type="checkbox" checked={!!session.browser} onChange={toggleBrowser} style={{ accentColor: 'var(--accent)' }} />
                Enable Playwright browser
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', padding: '4px 0' }}>
                <input type="checkbox" checked={!!session.autoContinue} onChange={toggleAutoContinue} style={{ accentColor: 'var(--accent)' }} />
                Auto-continue after 5h reset
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', padding: '4px 0' }}>
                <input type="checkbox" checked={session.autoRetryApiError !== false} onChange={toggleAutoRetryApiError} style={{ accentColor: 'var(--accent)' }} />
                Auto-retry API rate limit errors
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', flex: 1 }}>
                  <input type="checkbox" checked={!!session.autoCompact} onChange={toggleAutoCompact} style={{ accentColor: '#fbbf24' }} />
                  Auto-compact at
                </label>
                <select
                  value={String(session.autoCompactThreshold ?? 0.65)}
                  onChange={setAutoCompactThreshold}
                  disabled={!session.autoCompact}
                  className="fleet-control-input"
                  style={{ width: 60, fontSize: 11, opacity: session.autoCompact ? 1 : 0.4 }}
                >
                  <option value="0.40">40%</option>
                  <option value="0.50">50%</option>
                  <option value="0.60">60%</option>
                  <option value="0.65">65%</option>
                  <option value="0.70">70%</option>
                  <option value="0.75">75%</option>
                  <option value="0.80">80%</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === 'dirs' && (
          <div style={{ padding: '8px 8px 12px' }}>
            {session.cwd && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                <span style={{ fontSize: 9, background: 'rgba(0,122,204,.2)', color: 'var(--cyan)', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>cwd</span>
                <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', color: 'var(--cyan)', opacity: .85 }} title={session.cwd}>{session.cwd}</span>
              </div>
            )}
            {(session.additionalDirectories ?? []).length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 11, fontStyle: 'italic', marginBottom: 8 }}>No additional directories.</div>
            )}
            {(session.additionalDirectories ?? []).map(dir => (
              <div key={dir} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, padding: '2px 0' }}>
                <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', opacity: .75 }} title={dir}>{dir}</span>
                <button onClick={() => removeDir(dir)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 3px', fontSize: 13, lineHeight: 1 }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
              <input
                value={newDir}
                onChange={e => setNewDir(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDir(); } }}
                placeholder="Add directory…"
                className="fleet-control-input"
                style={{ flex: 1, fontSize: 11 }}
              />
              <button onClick={addDir} className="fleet-action-btn primary" style={{ width: 'auto', padding: '4px 10px' }}>Add</button>
            </div>
          </div>
        )}

        {tab === 'actions' && (
          <div style={{ padding: '8px 8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button onClick={compactNow} disabled={compacting} className="fleet-action-btn" style={{ background: 'rgba(251,191,36,.08)', color: '#fbbf24', borderColor: 'rgba(251,191,36,.2)', display: 'flex', alignItems: 'center', gap: 6, opacity: compacting ? 0.8 : 1 }}>
              {compacting
                ? <><span style={{ display: 'inline-block', width: 11, height: 11, border: '2px solid #fbbf2466', borderTopColor: '#fbbf24', borderRadius: '50%', animation: 'fleet-spin 0.7s linear infinite', flexShrink: 0 }} /> Compacting…</>
                : <>🗜 Compact now</>}
            </button>
            <button onClick={continueSession} className="fleet-action-btn primary">▶ Continue</button>
            <button onClick={stopTask} className="fleet-action-btn danger">⏹ Stop task</button>
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <button onClick={() => window.dispatchEvent(new CustomEvent('fleet:open-instructions'))} className="fleet-action-btn">📄 Instructions</button>
            <button onClick={restartRunner} className="fleet-action-btn">🔄 Restart runner</button>
            <button onClick={endSession} className="fleet-action-btn danger">⏏ End session</button>
          </div>
        )}

      </div>
    </div>
  );
}
