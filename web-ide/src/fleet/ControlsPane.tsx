import React, { useState } from 'react';
import { apiPost } from '../fleet/api';
import type { Session } from '../fleet/types';

interface Props {
  session: Session | null;
  models: { value: string; displayName?: string }[];
  onHistoryResume?: (id: string) => void;
  viewingHistoryRel?: string | null;
}

const inputStyle: React.CSSProperties = {
  background: 'var(--in-bg, var(--ed-bg))',
  border: '1px solid var(--in-border, var(--border))',
  color: 'var(--in-fg, var(--sb-fg))',
  borderRadius: 2,
  padding: '3px 6px',
  width: '100%',
  fontSize: 12,
  boxSizing: 'border-box',
};

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

const dangerBtn: React.CSSProperties = { ...btnStyle, color: 'var(--red)' };
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--muted)', marginBottom: 2, display: 'block' };
const rowStyle: React.CSSProperties = { marginBottom: 6 };

export default function ControlsPane({ session, models, onHistoryResume, viewingHistoryRel }: Props) {
  const [newDir, setNewDir] = useState('');

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

  async function removeDir(dir: string) {
    if (!session) return;
    const dirs = (session.additionalDirectories ?? []).filter(d => d !== dir);
    await apiPost(`/api/sessions/${id}/set-directories`, { directories: dirs });
  }

  async function addDir() {
    if (!newDir.trim() || !session) return;
    const dirs = [...(session.additionalDirectories ?? []), newDir.trim()];
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

  return (
    <div className="fleet-scroll" style={{ fontSize: 12, color: 'var(--sb-fg)', borderTop: '1px solid var(--border)' }}>
      {/* Settings section */}
      <div className="fleet-section">
        <div className="fleet-section-title">Configuration</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 8px', alignItems: 'center', marginBottom: 8 }}>
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

        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, cursor: 'pointer', marginBottom: 4, padding: '3px 0' }}>
          <input type="checkbox" checked={!!session.browser} onChange={toggleBrowser} style={{ accentColor: 'var(--accent)' }} />
          Enable Playwright browser
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, cursor: 'pointer', padding: '3px 0' }}>
          <input type="checkbox" checked={!!session.autoContinue} onChange={toggleAutoContinue} style={{ accentColor: 'var(--accent)' }} />
          Auto-continue after 5h reset
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, cursor: 'pointer', padding: '3px 0' }}>
          <input type="checkbox" checked={session.autoRetryApiError !== false} onChange={toggleAutoRetryApiError} style={{ accentColor: 'var(--accent)' }} />
          Auto-retry API rate limit errors
        </label>
      </div>

      {/* Directories */}
      <div className="fleet-section">
        <div className="fleet-section-title">Directories</div>
        {session.cwd && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
            <span style={{ fontSize: 9, background: 'rgba(0,122,204,.2)', color: 'var(--cyan)', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>cwd</span>
            <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', color: 'var(--cyan)', opacity: .8 }} title={session.cwd}>{session.cwd}</span>
          </div>
        )}
        {(session.additionalDirectories ?? []).map(dir => (
          <div key={dir} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, padding: '2px 0' }}>
            <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', opacity: .7 }} title={dir}>{dir}</span>
            <button onClick={() => removeDir(dir)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 2px', fontSize: 12 }}>✕</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
          <input value={newDir} onChange={e => setNewDir(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDir(); } }} placeholder="Add directory…" className="fleet-control-input" style={{ flex: 1, fontSize: 11 }} />
          <button onClick={addDir} className="fleet-action-btn primary" style={{ width: 'auto', padding: '4px 10px' }}>Add</button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="fleet-control-actions">
        <button onClick={() => window.dispatchEvent(new CustomEvent('fleet:open-instructions'))} className="fleet-action-btn">📄 Instructions</button>
        <button onClick={stopTask} className="fleet-action-btn danger">⏹ Stop current task</button>
        <button onClick={continueSession} className="fleet-action-btn primary">▶ Continue</button>
        <button onClick={restartRunner} className="fleet-action-btn">🔄 Restart runner</button>
        <button onClick={endSession} className="fleet-action-btn danger">⏏ End session</button>
      </div>
    </div>
  );
}
