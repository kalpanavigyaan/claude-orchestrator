/**
 * QueuePanel — per-session instruction queue with history view.
 *
 * Two tabs:
 *   Current  — manage the live queue for the selected session
 *   History  — browse past session queues (read-only, with copy-to-current)
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from './api';
import type { Session } from './types';

interface HistoryItem { rel: string; label: string; messageQueue: string[] | null; repo?: string; createdAt?: string; }

interface Props {
  session: Session | null;
}

// ── shared styles ────────────────────────────────────────────────────────────
const tabBtn = (active: boolean): React.CSSProperties => ({
  flex: 1, padding: '5px 0', fontSize: 11, fontWeight: active ? 600 : 400,
  background: active ? 'var(--ed-bg)' : 'transparent',
  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  border: 'none', cursor: 'pointer', color: active ? 'var(--ed-fg)' : 'var(--muted)',
});

// ── Current queue tab ────────────────────────────────────────────────────────
function CurrentTab({ session }: { session: Session | null }) {
  const [draft, setDraft]     = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef               = useRef<HTMLInputElement>(null);
  const queue = session?.messageQueue ?? [];
  const id    = session?.id;

  async function addItem(text: string) {
    if (!id || !text.trim()) return;
    setLoading(true);
    await apiPost(`/api/sessions/${id}/queue-add`, { text: text.trim() });
    setLoading(false);
  }
  async function removeItem(index: number) { if (id) await apiPost(`/api/sessions/${id}/queue-remove`, { index }); }
  async function clearAll() {
    if (!id || !queue.length) return;
    if (!window.confirm('Clear all queued instructions?')) return;
    await apiPost(`/api/sessions/${id}/queue-clear`, {});
  }
  async function moveItem(from: number, to: number) { if (id) await apiPost(`/api/sessions/${id}/queue-move`, { from, to }); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    addItem(draft);
    setDraft('');
  }

  function handleFileLoad(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { const t = ev.target?.result as string; if (t?.trim()) addItem(t.trim()); };
    reader.readAsText(file);
    e.target.value = '';
  }

  if (!session) return (
    <div style={{ padding: '12px 10px', color: 'var(--muted)', fontStyle: 'italic', fontSize: 11 }}>
      Select a session to manage its queue.
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Status note */}
      <div style={{ padding: '5px 10px', fontSize: 10, color: 'var(--muted)', background: 'rgba(255,255,255,.03)', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          {queue.length === 0 ? 'No pending instructions.' : `${queue.length} queued — auto-delivered when idle.`}
          {session.status === 'limited' && <span style={{ color: '#fbbf24', marginLeft: 6 }}>⏸ Waiting for reset</span>}
        </span>
        {queue.length > 0 && <button onClick={clearAll} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 10, padding: 0 }}>Clear all</button>}
      </div>

      {/* Queue list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {queue.length === 0 ? (
          <div style={{ padding: '16px 10px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>Queue empty</div>
        ) : queue.map((item, i) => (
          <div key={i} style={{ padding: '7px 10px', borderBottom: '1px solid rgba(255,255,255,.04)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', fontSize: 9, background: i === 0 ? 'var(--accent)' : 'rgba(255,255,255,.1)', color: i === 0 ? '#fff' : 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 11, lineHeight: 1.5, color: i === 0 ? 'var(--ed-fg)' : 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {item.length > 200 ? item.slice(0, 200) + '…' : item}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
              {i > 0 && <button onClick={() => moveItem(i, i - 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px' }}>↑</button>}
              {i < queue.length - 1 && <button onClick={() => moveItem(i, i + 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px' }}>↓</button>}
              <button onClick={() => removeItem(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 12, padding: '0 2px', opacity: .7 }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '.7')}>✕</button>
            </div>
          </div>
        ))}
      </div>

      {/* Add instruction */}
      <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, padding: '8px 10px' }}>
        <form onSubmit={handleSubmit}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(e as unknown as React.FormEvent); } }}
            placeholder="Type an instruction… (Ctrl+Enter to add)" rows={3}
            style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', background: 'var(--in-bg)', border: '1px solid var(--in-border)', color: 'var(--in-fg)', borderRadius: 3, padding: '5px 7px', fontSize: 11, fontFamily: 'inherit', outline: 'none', marginBottom: 6 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" disabled={!draft.trim() || loading}
              style={{ flex: 1, padding: '5px 0', borderRadius: 3, border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 600, opacity: (!draft.trim() || loading) ? .5 : 1 }}>
              + Add to queue
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} title="Load from .md or .txt file"
              style={{ padding: '5px 10px', borderRadius: 3, border: '1px solid var(--border)', background: 'var(--btn-2nd)', color: 'var(--ed-fg)', cursor: 'pointer', fontSize: 11 }}>
              📄 File
            </button>
            <input ref={fileRef} type="file" accept=".md,.txt,.markdown" style={{ display: 'none' }} onChange={handleFileLoad} />
          </div>
        </form>
      </div>
    </div>
  );
}

// ── History queue tab ────────────────────────────────────────────────────────
function HistoryTab({ session }: { session: Session | null }) {
  const [items, setItems]         = useState<HistoryItem[]>([]);
  const [loading, setLoading]     = useState(false);
  const [expanded, setExpanded]   = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet('/api/history').then(d => {
      const list: HistoryItem[] = (d?.sessions ?? [])
        .filter((s: HistoryItem) => s.messageQueue && s.messageQueue.length > 0)
        .slice(0, 100);
      setItems(list);
      setLoading(false);
    });
  }, []);

  async function copyToCurrentQueue(text: string) {
    if (!session?.id) return;
    await apiPost(`/api/sessions/${session.id}/queue-add`, { text });
  }

  async function copyAllToQueue(queue: string[]) {
    if (!session?.id) return;
    for (const item of queue) {
      await apiPost(`/api/sessions/${session.id}/queue-add`, { text: item });
    }
  }

  if (loading) return <div style={{ padding: '12px 10px', color: 'var(--muted)', fontSize: 11 }}>Loading…</div>;

  if (items.length === 0) return (
    <div style={{ padding: '16px 10px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>
      No past sessions with saved queues.
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {items.map(item => {
        const isOpen = expanded === item.rel;
        const q = item.messageQueue ?? [];
        return (
          <div key={item.rel} style={{ borderBottom: '1px solid var(--border)' }}>
            {/* Session header */}
            <div onClick={() => setExpanded(isOpen ? null : item.rel)}
              style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
              <span style={{ fontSize: 9, color: 'var(--muted)', transition: 'transform .12s', transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▼</span>
              <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
              <span style={{ fontSize: 9, background: 'rgba(249,115,22,.2)', color: '#f97316', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>{q.length}</span>
              {session && (
                <button onClick={e => { e.stopPropagation(); copyAllToQueue(q); }} title="Copy all to current queue"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cyan)', fontSize: 10, padding: '0 2px', flexShrink: 0 }}>
                  ⊕ all
                </button>
              )}
            </div>

            {/* Queue items */}
            {isOpen && (
              <div style={{ paddingBottom: 4 }}>
                {q.map((text, i) => (
                  <div key={i} style={{ padding: '4px 10px 4px 26px', display: 'flex', gap: 6, alignItems: 'flex-start', borderTop: '1px solid rgba(255,255,255,.03)' }}>
                    <span style={{ width: 16, height: 16, borderRadius: '50%', fontSize: 8, background: 'rgba(255,255,255,.08)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 10, color: 'var(--muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {text.length > 150 ? text.slice(0, 150) + '…' : text}
                    </span>
                    {session && (
                      <button onClick={() => copyToCurrentQueue(text)} title="Copy to current queue"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cyan)', fontSize: 11, padding: '0 2px', flexShrink: 0, opacity: .7 }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '.7')}>⊕</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function QueuePanel({ session }: Props) {
  const [tab, setTab] = useState<'current' | 'history'>('current');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)' }}>
      {/* Panel header */}
      <div style={{ padding: '4px 10px', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--sb-hdr-fg)', fontWeight: 600, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        Instruction Queue
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--tab-strip)' }}>
        <button style={tabBtn(tab === 'current')} onClick={() => setTab('current')}>
          Current{session?.messageQueue?.length ? ` (${session.messageQueue.length})` : ''}
        </button>
        <button style={tabBtn(tab === 'history')} onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {tab === 'current' ? <CurrentTab session={session} /> : <HistoryTab session={session} />}
    </div>
  );
}

import React, { useRef, useState } from 'react';
import { apiPost } from './api';
import type { Session } from './types';

interface Props {
  session: Session | null;
}

export default function QueuePanel({ session }: Props) {
  const [draft, setDraft]       = useState('');
  const [loading, setLoading]   = useState(false);
  const fileRef                 = useRef<HTMLInputElement>(null);

  const queue = session?.messageQueue ?? [];
  const id    = session?.id;

  async function addItem(text: string) {
    if (!id || !text.trim()) return;
    setLoading(true);
    await apiPost(`/api/sessions/${id}/queue-add`, { text: text.trim() });
    setLoading(false);
  }

  async function removeItem(index: number) {
    if (!id) return;
    await apiPost(`/api/sessions/${id}/queue-remove`, { index });
  }

  async function clearAll() {
    if (!id || !queue.length) return;
    if (!window.confirm('Clear all queued instructions?')) return;
    await apiPost(`/api/sessions/${id}/queue-clear`, {});
  }

  async function moveItem(from: number, to: number) {
    if (!id) return;
    await apiPost(`/api/sessions/${id}/queue-move`, { from, to });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    addItem(draft);
    setDraft('');
  }

  function handleFileLoad(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      if (text?.trim()) addItem(text.trim());
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '4px 10px', fontSize: 9, textTransform: 'uppercase',
        letterSpacing: '0.07em', color: 'var(--sb-hdr-fg)', fontWeight: 600,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>Instruction Queue</span>
        {queue.length > 0 && (
          <button onClick={clearAll} title="Clear all"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 10, padding: 0 }}>
            Clear all
          </button>
        )}
      </div>

      {!session ? (
        <div style={{ padding: '12px 10px', color: 'var(--muted)', fontStyle: 'italic', fontSize: 11 }}>
          Select a session to manage its queue.
        </div>
      ) : (
        <>
          {/* Status note */}
          <div style={{ padding: '5px 10px', fontSize: 10, color: 'var(--muted)', background: 'rgba(255,255,255,.03)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {queue.length === 0
              ? 'No pending instructions. Add one below.'
              : `${queue.length} instruction${queue.length > 1 ? 's' : ''} queued — delivered automatically when session goes idle.`}
            {session.status === 'limited' && (
              <span style={{ color: '#fbbf24', marginLeft: 6 }}>⏸ Waiting for reset</span>
            )}
          </div>

          {/* Queue list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {queue.length === 0 ? (
              <div style={{ padding: '16px 10px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>
                Queue empty
              </div>
            ) : (
              queue.map((item, i) => (
                <div key={i} style={{
                  padding: '7px 10px', borderBottom: '1px solid rgba(255,255,255,.04)',
                  display: 'flex', gap: 6, alignItems: 'flex-start',
                }}>
                  {/* Position badge */}
                  <span style={{
                    flexShrink: 0, width: 18, height: 18, borderRadius: '50%', fontSize: 9,
                    background: i === 0 ? 'var(--accent)' : 'rgba(255,255,255,.1)',
                    color: i === 0 ? '#fff' : 'var(--muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600,
                  }}>{i + 1}</span>

                  {/* Text */}
                  <span style={{
                    flex: 1, fontSize: 11, lineHeight: 1.5, color: i === 0 ? 'var(--ed-fg)' : 'var(--muted)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: i > 0 ? 'inherit' : 'inherit',
                  }}>
                    {item.length > 200 ? item.slice(0, 200) + '…' : item}
                  </span>

                  {/* Controls */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                    {i > 0 && (
                      <button onClick={() => moveItem(i, i - 1)} title="Move up"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px', lineHeight: 1 }}>↑</button>
                    )}
                    {i < queue.length - 1 && (
                      <button onClick={() => moveItem(i, i + 1)} title="Move down"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px', lineHeight: 1 }}>↓</button>
                    )}
                    <button onClick={() => removeItem(i)} title="Remove"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 12, padding: '0 2px', lineHeight: 1, opacity: .7 }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '.7')}>✕</button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Add instruction */}
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, padding: '8px 10px' }}>
            <form onSubmit={handleSubmit}>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(e as unknown as React.FormEvent); }
                }}
                placeholder="Type an instruction… (Ctrl+Enter to add)"
                rows={3}
                style={{
                  width: '100%', resize: 'vertical', boxSizing: 'border-box',
                  background: 'var(--in-bg)', border: '1px solid var(--in-border)',
                  color: 'var(--in-fg)', borderRadius: 3, padding: '5px 7px',
                  fontSize: 11, fontFamily: 'inherit', outline: 'none',
                  marginBottom: 6,
                }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="submit" disabled={!draft.trim() || loading}
                  style={{
                    flex: 1, padding: '5px 0', borderRadius: 3, border: 'none', cursor: 'pointer',
                    background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 600,
                    opacity: (!draft.trim() || loading) ? .5 : 1,
                  }}>
                  + Add to queue
                </button>
                <button type="button" onClick={() => fileRef.current?.click()} title="Load from .md or .txt file"
                  style={{
                    padding: '5px 10px', borderRadius: 3, border: '1px solid var(--border)',
                    background: 'var(--btn-2nd)', color: 'var(--ed-fg)', cursor: 'pointer', fontSize: 11,
                  }}>
                  📄 File
                </button>
                <input ref={fileRef} type="file" accept=".md,.txt,.markdown" style={{ display: 'none' }} onChange={handleFileLoad} />
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
