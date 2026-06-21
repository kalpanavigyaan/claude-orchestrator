import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiPost, openSSE, escHtml, mdToHtml } from '../fleet/api';
import { toolStats } from './toolStats';
import type { ChatMessage, Session } from '../fleet/types';

interface Props {
  sessionId: string | null;
  session: Session | null;
  isViewingHistory: boolean;
  historyMessages: ChatMessage[];
  historyLabel?: string;
  historyLoading?: boolean;
}

function toolFeedEntry(m: ChatMessage): string {
  const name = escHtml(m.name ?? 'tool');
  const arg  = m.input != null
    ? ' ' + escHtml(typeof m.input === 'string' ? m.input : JSON.stringify(m.input).slice(0, 120))
    : '';
  return `🔧 <strong>${name}</strong>${arg}`;
}

function msgBg(role: ChatMessage['role']): React.CSSProperties {
  switch (role) {
    case 'user':   return { background: 'rgba(0,122,204,.15)' };
    case 'result': return { borderLeft: '3px solid rgba(74,222,128,.4)', background: 'rgba(74,222,128,.04)', paddingLeft: 8 };
    default:       return { background: 'rgba(255,255,255,.04)' };
  }
}

const CONTEXT_WINDOW = 200_000; // tokens — standard for Claude Sonnet/Opus 4.x

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function TurnStats({ m }: { m: ChatMessage }) {
  const u = m.turnUsage;
  if (!u && !m.turnCost) return null;

  const inp   = u?.input_tokens ?? 0;
  const out   = u?.output_tokens ?? 0;
  const cr    = u?.cache_read_input_tokens ?? 0;
  const cc    = u?.cache_creation_input_tokens ?? 0;
  const total = inp + cr;
  const cacheHitPct = total > 0 ? Math.round((cr / total) * 100) : 0;
  const ctxPct = total > 0 ? Math.round((total / CONTEXT_WINDOW) * 100) : 0;
  const ctxColor = ctxPct > 75 ? '#f87171' : ctxPct > 40 ? '#fbbf24' : 'var(--muted)';

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '0 10px', alignItems: 'center',
      padding: '3px 10px 4px', fontSize: 10.5, color: 'var(--muted)',
      borderTop: '1px solid rgba(74,222,128,.1)', marginTop: 2,
      fontFamily: 'monospace', letterSpacing: '0.02em',
    }}>
      {u && <>
        <span title="Input tokens this turn">↑{fmt(inp)} in</span>
        <span title="Output tokens this turn">↓{fmt(out)} out</span>
        {cr > 0 && (
          <span title="Cache-read tokens (already cached, cheaper)" style={{ color: '#4ade80' }}>
            ↩{fmt(cr)} cached
          </span>
        )}
        {cc > 0 && (
          <span title="Cache-creation tokens (written to cache for future turns)" style={{ color: '#a3e635' }}>
            ✎{fmt(cc)} cache-write
          </span>
        )}
        {cacheHitPct > 0 && (
          <span title="Percentage of input tokens served from cache" style={{ color: '#4ade80', fontWeight: 600 }}>
            {cacheHitPct}% cached
          </span>
        )}
        <span title={`Context window used (${total.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} tokens)`} style={{ color: ctxColor }}>
          {ctxPct}% ctx
        </span>
      </>}
      {m.turnCost != null && m.turnCost > 0 && (
        <span title="Cost for this turn" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
          ${m.turnCost.toFixed(4)}
        </span>
      )}
      {m.turns != null && m.turns > 0 && (
        <span title="API turns (tool-call loops) in this exchange">
          {m.turns} turn{m.turns !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

// ── Context status bar ────────────────────────────────────────────────────────
// Shows at the top of the chat panel: how much of the 200k context window is used,
// with colour-coded advice on when to /compact or start a new session.
function ContextBar({ messages, session }: { messages: ChatMessage[]; session: Session | null }) {
  const lastResult = [...messages].reverse().find(m => m.role === 'result' && m.turnUsage);
  if (!lastResult?.turnUsage) return null;

  const u = lastResult.turnUsage;
  const ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const pct = Math.round((ctxTokens / CONTEXT_WINDOW) * 100);
  const turns = messages.filter(m => m.role === 'assistant').length;
  const cost  = session?.lastResult?.cost ?? 0;

  const barColor  = pct >= 80 ? '#f87171' : pct >= 55 ? '#fbbf24' : '#4ade80';
  const advice    = pct >= 90 ? '⚠ Context nearly full — start a new session'
                  : pct >= 80 ? 'Start a new session to avoid context cutoff'
                  : pct >= 55 ? '/compact recommended to reduce context'
                  : null;

  return (
    <div style={{
      flexShrink: 0, borderBottom: '1px solid var(--border)',
      background: 'rgba(255,255,255,.02)', padding: '4px 10px',
    }}>
      {/* Bar + stats row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: advice ? 3 : 0 }}>
        {/* Progress bar */}
        <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,.08)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width .3s' }} />
        </div>
        <span style={{ fontSize: 10, color: barColor, fontFamily: 'monospace', flexShrink: 0 }}>
          {pct}%
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
          {fmt(ctxTokens)} / {fmt(CONTEXT_WINDOW)} ctx
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
          {turns} turn{turns !== 1 ? 's' : ''}
        </span>
        {cost > 0 && (
          <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
            ${cost.toFixed(3)}
          </span>
        )}
      </div>
      {/* Advice */}
      {advice && (
        <div style={{ fontSize: 10, color: barColor, fontWeight: 500 }}>{advice}</div>
      )}
    </div>
  );
}

export default function ChatView({ sessionId, session, isViewingHistory, historyMessages, historyLabel, historyLoading }: Props) {
  const [messages, setMessages]       = useState<ChatMessage[]>([]);
  const [workingState, setWorkingState] = useState<{ text: string; running: boolean } | null>(null);
  const [toolFeed, setToolFeed]       = useState<string[]>([]);
  const [composerText, setComposerText] = useState('');
  // ── New: search + filter ──
  const [searchText, setSearchText]   = useState('');
  const [roleFilter, setRoleFilter]   = useState<'all' | 'user' | 'assistant' | 'result' | 'tool'>('all');
  const [showSearch, setShowSearch]   = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const esRef          = useRef<EventSource | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  useEffect(() => {
    if (isViewingHistory) return;
    if (!sessionId) {
      setMessages([]);
      setWorkingState(null);
      setToolFeed([]);
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    esRef.current?.close();
    setMessages([]);
    setToolFeed([]);
    setWorkingState(null);

    const es = openSSE(`/api/sessions/${sessionId}/events`, (raw) => {
      const ev = raw as { kind: string; messages?: ChatMessage[]; message?: ChatMessage; text?: string; running?: boolean };
      if (ev.kind === 'backlog') {
        const msgs = ev.messages ?? [];
        setMessages(msgs);
        // dispatch approval events for pending approvals
        for (const m of msgs) {
          if (m.role === 'tool' && (m as unknown as { approval?: unknown }).approval) {
            window.dispatchEvent(new CustomEvent('fleet:approval', {
              detail: (m as unknown as { approval: unknown }).approval,
            }));
          }
        }
      } else if (ev.kind === 'message' && ev.message) {
        const m = ev.message;
        if (m.role === 'tool') {
          if (m.name) toolStats.record(m.name);
          setToolFeed(prev => [...prev.slice(-49), toolFeedEntry(m)]);
        } else {
          setMessages(prev => [...prev, m]);
        }
      } else if (ev.kind === 'activity') {
        setWorkingState({ text: ev.text ?? '', running: ev.running !== false });
      } else if (ev.kind === 'approval') {
        window.dispatchEvent(new CustomEvent('fleet:approval', { detail: ev }));
      }
    });

    esRef.current = es;
    return () => { es.close(); };
  }, [sessionId, isViewingHistory]);

  useEffect(() => { scrollToBottom(); }, [messages, historyMessages, scrollToBottom]);

  async function sendMessage() {
    if (!sessionId || !composerText.trim()) return;
    const text = composerText.trim();
    setComposerText('');
    setWorkingState(null);
    await apiPost(`/api/sessions/${sessionId}/message`, { text });
  }

  const displayMessages = isViewingHistory ? historyMessages : messages;
  const isRunning = session?.status === 'running' || (toolFeed.length > 0 && workingState?.running);

  // Filter by role + search text
  const filteredMessages = displayMessages.filter(m => {
    if (roleFilter === 'user' && m.role !== 'user') return false;
    if (roleFilter === 'assistant' && m.role !== 'assistant') return false;
    if (roleFilter === 'result' && m.role !== 'result') return false;
    if (roleFilter === 'tool' && m.role !== 'tool') return false;
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      const text = (m.text ?? '') + (m.name ?? '') + (typeof m.input === 'string' ? m.input : JSON.stringify(m.input ?? ''));
      if (!text.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Highlight search matches in text
  function highlight(html: string): string {
    if (!searchText.trim()) return html;
    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  const ROLE_TABS: { id: typeof roleFilter; label: string; color: string }[] = [
    { id: 'all',       label: 'All',       color: '#cccccc' },
    { id: 'user',      label: 'Me',        color: '#61afef' },
    { id: 'assistant', label: 'AI',        color: '#98c379' },
    { id: 'result',    label: 'Results',   color: '#4ade80' },
    { id: 'tool',      label: 'Tools',     color: '#e5c07b' },
  ];

  const roleCounts = displayMessages.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Show "select session" only when there's nothing to display at all
  if (!sessionId && !isViewingHistory) {
    return (
      <div className="fleet-chat-empty">
        <div className="fleet-chat-empty-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#61afef" strokeWidth="1.5" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <path d="M8 10h8M8 14h5" opacity=".6"/>
          </svg>
        </div>
        <h2 className="fleet-chat-empty-title">No session selected</h2>
        <p className="fleet-chat-empty-sub">
          Select an active session from the left panel, or create a new one to start chatting with Claude.
        </p>
        <div className="fleet-chat-empty-actions">
          <button className="fleet-chat-empty-btn primary" onClick={() => document.dispatchEvent(new CustomEvent('fleet:new-session'))}>
            + New Session
          </button>
          <button className="fleet-chat-empty-btn secondary" onClick={() => document.dispatchEvent(new CustomEvent('fleet:open-history'))}>
            View History
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--ed-bg)' }}>
      {/* History label */}
      {isViewingHistory && historyLabel && (
        <div style={{
          padding: '4px 12px', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(255,255,255,.03)', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ color: 'var(--muted)' }}>📁 {historyLabel}</span>
          {historyLoading && (
            <span style={{ display: 'inline-flex', gap: 3, marginLeft: 4 }}>
              {[0,1,2].map(j => (
                <span key={j} style={{
                  width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)',
                  opacity: 0.7, animation: `fc-dot-pulse 1.2s ${j * 0.2}s infinite ease-in-out`,
                }} />
              ))}
              <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--muted)' }}>Loading transcript…</span>
            </span>
          )}
        </div>
      )}

      {/* Full-screen loading state while history transcript loads */}
      {isViewingHistory && historyLoading && historyMessages.length === 0 && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 12, color: 'var(--muted)',
        }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {[0,1,2].map(j => (
              <span key={j} style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)',
                animation: `fc-dot-pulse 1.2s ${j * 0.2}s infinite ease-in-out`,
              }} />
            ))}
          </div>
          <span style={{ fontSize: 13 }}>Loading transcript…</span>
        </div>
      )}

      {/* Context window status bar — live sessions only */}
      {!isViewingHistory && <ContextBar messages={messages} session={session} />}

      {/* Role filter tabs + search toggle */}
      <div className="fleet-filter-tabs" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 3 }}>
          {ROLE_TABS.map(tab => {
            const count = tab.id === 'all'
              ? displayMessages.length
              : roleCounts[tab.id] ?? 0;
            return (
              <button
                key={tab.id}
                className={`fleet-filter-tab${roleFilter === tab.id ? ' active' : ''}`}
                onClick={() => setRoleFilter(tab.id)}
                style={roleFilter === tab.id ? { background: tab.color, borderColor: tab.color, color: tab.id === 'all' ? '#1e1e1e' : '#1e1e1e' } : {}}
              >
                {tab.label}{count > 0 ? ` · ${count}` : ''}
              </button>
            );
          })}
        </div>
        <button
          className="icon-btn"
          onClick={() => setShowSearch(s => !s)}
          title="Search messages (Ctrl+F)"
          style={{ color: showSearch ? 'var(--accent)' : undefined }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5"/>
            <line x1="11" y1="11" x2="15" y2="15"/>
          </svg>
        </button>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="fleet-chat-search">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, color: 'var(--muted)' }}>
            <circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="15" y2="15"/>
          </svg>
          <input
            autoFocus
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search messages…"
            onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchText(''); } }}
          />
          {searchText && (
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
              {filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}
            </span>
          )}
          <button className="icon-btn" onClick={() => { setShowSearch(false); setSearchText(''); }}>✕</button>
        </div>
      )}

      {/* Messages — hidden while loading history */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '6px 10px',
        userSelect: 'text',
        display: (isViewingHistory && historyLoading && historyMessages.length === 0) ? 'none' : undefined,
      }}>
        {filteredMessages.length === 0 && displayMessages.length > 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
            No messages match the current filter.
          </div>
        )}
        {filteredMessages.map((m, i) => {
          if (m.role === 'system') {
            return (
              <div key={i} style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', padding: '4px 0', opacity: 0.7 }}>
                {m.text}
              </div>
            );
          }

          const roleColors: Record<string, string> = {
            user: '#61afef', assistant: '#98c379', result: '#4ade80',
            tool: '#e5c07b', system: '#6a737d',
          };
          const roleColor = roleColors[m.role] ?? '#cccccc';

          return (
            <div key={i} style={{
              marginBottom: 6, borderRadius: 6, overflow: 'hidden',
              border: `1px solid ${roleColor}18`,
              background: m.role === 'user' ? 'rgba(97,175,239,.08)'
                       : m.role === 'result' ? 'rgba(74,222,128,.05)'
                       : m.role === 'tool' ? 'rgba(229,192,123,.05)'
                       : 'rgba(255,255,255,.03)',
            }}>
              {/* Message header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px 3px', borderBottom: `1px solid ${roleColor}15`,
                background: `${roleColor}08`,
              }}>
                <span className={`fleet-role-badge ${m.role}`}>{m.role}</span>
                {m.ts ? (
                  <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' }}>
                    {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
              </div>

              {/* Message body */}
              {m.role === 'tool' ? (
                <div style={{ padding: '5px 10px', fontSize: 12, fontFamily: 'monospace', color: '#e5c07b' }}>
                  🔧 <strong>{m.name}</strong>
                  {m.input != null && (
                    <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>
                      {typeof m.input === 'string' ? m.input : JSON.stringify(m.input).slice(0, 200)}
                    </span>
                  )}
                </div>
              ) : (
                <>
                  {(m.text || m.role !== 'result') && (
                    <div
                      className="fc-msg-body"
                      dangerouslySetInnerHTML={{ __html: highlight(mdToHtml(m.text ?? '')) }}
                      style={{ padding: '6px 10px', fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word' }}
                    />
                  )}
                  {m.role === 'result' && <TurnStats m={m} />}
                </>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Working indicator */}
      {!isViewingHistory && (isRunning || toolFeed.length > 0) && (
        <div style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(255,255,255,.02)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {/* Animated dots */}
            <span className="fc-spinner" style={{ display: 'inline-flex', gap: 3 }}>
              {[0, 1, 2].map(j => (
                <span key={j} style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--accent)',
                  animation: `fc-dot-pulse 1.2s ${j * 0.2}s infinite ease-in-out`,
                }} />
              ))}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {workingState?.text ?? 'Working…'}
            </span>
            <button
              onClick={() => sessionId && apiPost(`/api/sessions/${sessionId}/interrupt`, {})}
              style={{
                background: 'none', border: '1px solid var(--red)',
                color: 'var(--red)', padding: '2px 6px', borderRadius: 2,
                cursor: 'pointer', fontSize: 11,
              }}
            >
              Stop
            </button>
          </div>
          {toolFeed.length > 0 && (
            <div style={{
              maxHeight: 72, overflowY: 'auto',
              fontSize: 11, color: 'var(--muted)',
              lineHeight: 1.4,
            }}>
              {toolFeed.slice(-8).map((t, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: t }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Composer */}
      {session && !isViewingHistory && (
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border)',
          background: 'var(--sb-bg)',
          flexShrink: 0,
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
        }}>
          <textarea
            value={composerText}
            onChange={e => setComposerText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            rows={3}
            placeholder="Send a message… (Enter to send, Shift+Enter for newline)"
            style={{
              flex: 1,
              resize: 'vertical',
              minHeight: 56,
              background: 'var(--in-bg, var(--ed-bg))',
              border: '1px solid var(--in-border, var(--border))',
              color: 'var(--in-fg, var(--sb-fg))',
              borderRadius: 3,
              padding: '6px 8px',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!composerText.trim()}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 3,
              cursor: composerText.trim() ? 'pointer' : 'default',
              opacity: composerText.trim() ? 1 : 0.4,
              fontSize: 13,
              alignSelf: 'flex-end',
            }}
          >
            Send
          </button>
        </div>
      )}

      {/* Keyframes injected once */}
      <style>{`
        @keyframes fc-dot-pulse {
          0%, 80%, 100% { transform: scale(.6); opacity: .4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
