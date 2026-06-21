import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from './api';
import type { MdFile, Session } from './types';

interface Props {
  selectedId: string | null;
  session: Session | null;
}

interface FileEntry extends MdFile {
  source: 'global' | 'session';
  injected: boolean; // global files are already in system prompt for new sessions
}

export default function InstructionsLibPanel({ selectedId, session }: Props) {
  const [globalFiles,  setGlobalFiles]  = useState<MdFile[]>([]);
  const [sessionFiles, setSessionFiles] = useState<MdFile[]>([]);
  const [globalDir,    setGlobalDir]    = useState('');
  const [sessionDir,   setSessionDir]   = useState('');
  const [loading,      setLoading]      = useState(true);
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [sent,         setSent]         = useState<Set<string>>(new Set());
  const [sending,      setSending]      = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const p1 = apiGet('/api/instructions/global')
      .then((d: any) => { setGlobalFiles(d.files ?? []); setGlobalDir(d.dir ?? ''); })
      .catch(() => {});
    const p2 = selectedId
      ? apiGet(`/api/sessions/${selectedId}/instructions`)
          .then((d: any) => { setSessionFiles(d.files ?? []); setSessionDir(d.instructionsDir ?? ''); })
          .catch(() => {})
      : Promise.resolve();
    Promise.all([p1, p2]).finally(() => setLoading(false));
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  // Reset sent state when session changes
  useEffect(() => { setSent(new Set()); }, [selectedId]);

  const sendToSession = useCallback(async (file: MdFile, source: 'global' | 'session') => {
    if (!selectedId || sending) return;
    const key = `${source}:${file.name}`;
    setSending(key);
    try {
      const prefix = `Apply the following instructions for this session:\n\n---\n${file.content}\n---`;
      await apiPost(`/api/sessions/${selectedId}/message`, { text: prefix });
      setSent(prev => new Set([...prev, key]));
    } catch {
      /* ignore */
    } finally {
      setSending(null);
    }
  }, [selectedId, sending]);

  const toggle = (key: string) => setExpanded(e => e === key ? null : key);

  function FileList({ files, source, title, dir, accentColor }: {
    files: MdFile[]; source: 'global' | 'session'; title: string; dir: string; accentColor: string;
  }) {
    const isGlobal = source === 'global';
    return (
      <div>
        {/* Section header */}
        <div style={{
          padding: '5px 10px 4px',
          fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.07em',
          color: accentColor, borderBottom: `1px solid ${accentColor}30`,
          background: `${accentColor}08`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{title}</span>
          {isGlobal && (
            <span style={{ fontSize: 8.5, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0 }}>
              (injected into every new session's system prompt)
            </span>
          )}
        </div>

        {files.length === 0 ? (
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--muted)' }}>
            No files found in <code style={{ fontSize: 10, color: accentColor }}>{dir}</code>
          </div>
        ) : files.map(file => {
          const key       = `${source}:${file.name}`;
          const isSent    = sent.has(key);
          const isSending = sending === key;
          const isOpen    = expanded === key;
          const label     = file.name.replace(/^\d+-/, '').replace(/\.md$/i, '').replace(/-/g, ' ');
          const excerpt   = file.content.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '';

          return (
            <div key={key} style={{
              borderBottom: '1px solid var(--border)',
              background: isSent ? `${accentColor}08` : 'transparent',
            }}>
              {/* Row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                {/* Checkbox — checking sends content to session */}
                <input
                  type="checkbox"
                  checked={isSent}
                  disabled={!selectedId || !!sending}
                  onChange={() => !isSent && sendToSession(file, source)}
                  style={{ accentColor, flexShrink: 0, cursor: selectedId ? 'pointer' : 'not-allowed' }}
                  title={
                    isGlobal && !isSent ? 'Already in system prompt — check to also send as a chat message to reinforce it'
                    : isSent ? 'Sent to session'
                    : selectedId ? 'Send to current session'
                    : 'No session selected'
                  }
                />

                {/* Label */}
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => toggle(key)}>
                  <div style={{
                    fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    color: isSent ? accentColor : 'var(--fg)',
                    textTransform: 'capitalize',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {label}
                    {isSending && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--muted)' }}>sending…</span>}
                    {isSent    && <span style={{ marginLeft: 6, fontSize: 10, color: accentColor }}>✓ sent</span>}
                    {isGlobal && !isSent && (
                      <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}>auto</span>
                    )}
                  </div>
                  {!isOpen && excerpt && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1, cursor: 'pointer' }}>
                      {excerpt.slice(0, 80)}
                    </div>
                  )}
                </div>

                <span
                  onClick={() => toggle(key)}
                  style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0, userSelect: 'none', cursor: 'pointer' }}
                >
                  {isOpen ? '▲' : '▼'}
                </span>
              </div>

              {/* Expanded */}
              {isOpen && (
                <pre style={{
                  margin: 0, padding: '0 10px 10px 30px',
                  fontSize: 11, lineHeight: 1.55, color: 'var(--fg)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  borderTop: '1px solid var(--border)',
                  background: 'rgba(0,0,0,.15)',
                }}>
                  {file.content}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>Loading instructions…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '5px 10px 4px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
        Check an instruction file to send it to the current session
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <FileList
          files={globalFiles}
          source="global"
          title="Global Instructions"
          dir={globalDir}
          accentColor="#a78bfa"
        />
        <FileList
          files={sessionFiles}
          source="session"
          title="Session Instructions"
          dir={sessionDir}
          accentColor="#60a5fa"
        />
      </div>

      <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
        <button
          onClick={load}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 10, padding: 0 }}
        >
          ↺ refresh
        </button>
      </div>
    </div>
  );
}
