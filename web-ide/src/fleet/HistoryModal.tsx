import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, mdToHtml } from '../fleet/api';
import type { ChatMessage } from '../fleet/types';

interface Props {
  rel: string | null;
  isOpen: boolean;
  onClose: () => void;
  onResume: (id: string) => void;
}

function msgBg(role: ChatMessage['role']): React.CSSProperties {
  switch (role) {
    case 'user':   return { background: 'rgba(0,122,204,.15)' };
    case 'result': return { borderLeft: '3px solid rgba(74,222,128,.4)', background: 'rgba(74,222,128,.04)', paddingLeft: 8 };
    default:       return { background: 'rgba(255,255,255,.04)' };
  }
}

export default function HistoryModal({ rel, isOpen, onClose, onResume }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [label, setLabel]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (!isOpen || !rel) return;
    setLoading(true);
    setMessages([]);
    apiGet(`/api/history/item?path=${encodeURIComponent(rel)}`).then(data => {
      setLoading(false);
      if (data) {
        setMessages((data.messages ?? data) as ChatMessage[]);
        setLabel(data.label ?? rel);
      }
    });
  }, [isOpen, rel]);

  async function resume() {
    if (!rel) return;
    setResuming(true);
    const data = await apiPost('/api/history/resume', { rel });
    setResuming(false);
    if (data?.id) {
      onResume(data.id as string);
      onClose();
    }
  }

  if (!isOpen) return null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--sb-bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        width: 720,
        maxWidth: '95vw',
        height: 560,
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600, fontSize: 14, color: 'var(--sb-fg)', flexShrink: 0,
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || rel || 'History'}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={resume}
              disabled={resuming || !rel}
              style={{
                background: 'var(--accent)', border: 'none', color: '#fff',
                padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 12,
                opacity: resuming ? 0.5 : 1,
              }}
            >
              {resuming ? 'Resuming…' : 'Resume Session'}
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18 }}>×</button>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', background: 'var(--ed-bg)' }}>
          {loading && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 20 }}>Loading…</div>
          )}
          {!loading && messages.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 20 }}>No messages.</div>
          )}
          {messages.map((m, i) => {
            if (m.role === 'tool') return null;
            if (m.role === 'system') {
              return (
                <div key={i} style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', padding: '3px 0', opacity: 0.7 }}>
                  {m.text}
                </div>
              );
            }
            return (
              <div key={i} style={{
                marginBottom: 8, borderRadius: 4, padding: '6px 10px',
                ...msgBg(m.role),
              }}>
                <div
                  className="fc-msg-body"
                  dangerouslySetInnerHTML={{ __html: mdToHtml(m.text ?? '') }}
                  style={{ fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
