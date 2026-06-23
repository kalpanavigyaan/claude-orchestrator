import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiPost, openSSE, escHtml, mdToHtml } from '../fleet/api';
import { toolStats } from './toolStats';
import type { ChatMessage, Session } from '../fleet/types';

// ── Diff computation ──────────────────────────────────────────────────────────
type DiffLine = { type: 'same' | 'del' | 'add'; text: string };
type CollapsedEntry = DiffLine | { type: 'ellipsis'; count: number };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length + b.length > 600) {
    return [
      ...a.map(line => ({ type: 'del' as const, text: line })),
      ...b.map(line => ({ type: 'add' as const, text: line })),
    ];
  }
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.unshift({ type: 'same', text: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ type: 'add', text: b[j-1] }); j--;
    } else {
      result.unshift({ type: 'del', text: a[i-1] }); i--;
    }
  }
  return result;
}

const CTX = 3;
function collapseContext(lines: DiffLine[]): CollapsedEntry[] {
  const changed = new Set<number>();
  lines.forEach((l, i) => { if (l.type !== 'same') changed.add(i); });
  const visible = new Set<number>();
  changed.forEach(i => {
    for (let k = Math.max(0, i - CTX); k <= Math.min(lines.length - 1, i + CTX); k++)
      visible.add(k);
  });
  const out: CollapsedEntry[] = [];
  let hidden = 0;
  lines.forEach((l, i) => {
    if (visible.has(i)) {
      if (hidden > 0) { out.push({ type: 'ellipsis', count: hidden }); hidden = 0; }
      out.push(l);
    } else { hidden++; }
  });
  if (hidden > 0) out.push({ type: 'ellipsis', count: hidden });
  return out;
}

function FileDiffViewer({ name, input }: { name: string; input: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const inp = (typeof input === 'object' && input !== null) ? input as Record<string, string> : null;
  if (!inp) {
    return (
      <div style={{ padding: '5px 10px', fontSize: 12, fontFamily: 'monospace', color: '#e5c07b' }}>
        🔧 <strong>{name}</strong>
        <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>
          {typeof input === 'string' ? input : JSON.stringify(input ?? '').slice(0, 200)}
        </span>
      </div>
    );
  }
  const cmd = inp.command ?? 'str_replace';
  const path = inp.path ?? '';

  if (cmd === 'view') {
    return (
      <div style={{ padding: '3px 10px', fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
        👁 <span style={{ color: '#e5c07b' }}>{path}</span>
        {inp.view_range ? <span style={{ marginLeft: 6 }}>lines {inp.view_range}</span> : null}
      </div>
    );
  }

  if (cmd === 'create') {
    const text = inp.file_text ?? '';
    const lines = text.split('\n');
    return (
      <div style={{ fontFamily: 'monospace' }}>
        <button onClick={() => setExpanded(e => !e)} style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#4ade80',
          fontSize: 11, padding: '3px 10px', display: 'flex', alignItems: 'center',
          gap: 5, width: '100%', textAlign: 'left',
        }}>
          <span>{expanded ? '▼' : '▶'}</span>
          <span>✨ create <strong>{path}</strong></span>
          <span style={{ color: 'var(--muted)' }}>({lines.length} lines)</span>
        </button>
        {expanded && (
          <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', background: 'rgba(0,0,0,.3)', margin: '0 10px 6px', borderRadius: 3, fontSize: 11 }}>
            {lines.map((line, li) => (
              <div key={li} style={{ display: 'flex', padding: '0 6px', background: 'rgba(74,222,128,.05)' }}>
                <span style={{ color: 'var(--muted)', minWidth: 32, userSelect: 'none', textAlign: 'right', paddingRight: 8, flexShrink: 0 }}>{li + 1}</span>
                <span style={{ color: '#4ade80', flexShrink: 0 }}>+</span>
                <span style={{ color: '#d4d4d4', paddingLeft: 6, whiteSpace: 'pre' }}>{line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // str_replace
  const oldStr = inp.old_string ?? '';
  const newStr = inp.new_string ?? '';
  if (!oldStr && !newStr) {
    return (
      <div style={{ padding: '5px 10px', fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
        🔧 <strong>{name}</strong> {path}
      </div>
    );
  }
  const diffLines = computeDiff(oldStr, newStr);
  const collapsed = collapseContext(diffLines);
  const adds = diffLines.filter(l => l.type === 'add').length;
  const dels = diffLines.filter(l => l.type === 'del').length;

  return (
    <div style={{ fontFamily: 'monospace' }}>
      <button onClick={() => setExpanded(e => !e)} style={{
        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)',
        fontSize: 11, padding: '3px 10px', display: 'flex', alignItems: 'center',
        gap: 5, width: '100%', textAlign: 'left',
      }}>
        <span>{expanded ? '▼' : '▶'}</span>
        <span>✏ <strong style={{ color: '#e5c07b' }}>{path}</strong></span>
        <span style={{ color: '#f87171' }}>−{dels}</span>
        <span style={{ color: '#4ade80' }}>+{adds}</span>
      </button>
      {expanded && (
        <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto', background: 'rgba(0,0,0,.3)', margin: '0 10px 6px', borderRadius: 3, fontSize: 11 }}>
          {collapsed.map((entry, ei) => {
            if (entry.type === 'ellipsis') {
              return (
                <div key={ei} style={{ padding: '1px 6px', color: 'var(--muted)', fontStyle: 'italic', background: 'rgba(255,255,255,.02)' }}>
                  ··· {entry.count} unchanged lines
                </div>
              );
            }
            const dl = entry as DiffLine;
            const bg = dl.type === 'del' ? 'rgba(248,113,113,.08)' : dl.type === 'add' ? 'rgba(74,222,128,.08)' : 'transparent';
            const col = dl.type === 'del' ? '#f87171' : dl.type === 'add' ? '#4ade80' : '#d4d4d4';
            const prefix = dl.type === 'del' ? '−' : dl.type === 'add' ? '+' : ' ';
            return (
              <div key={ei} style={{ display: 'flex', padding: '0 6px', background: bg }}>
                <span style={{ color: col, minWidth: 14, userSelect: 'none', flexShrink: 0 }}>{prefix}</span>
                <span style={{ color: col, paddingLeft: 6, whiteSpace: 'pre' }}>{dl.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
function codeStats(messages: ChatMessage[]) {
  let linesAdded = 0, linesRemoved = 0, filesEdited = 0, filesCreated = 0;
  const touchedPaths = new Set<string>();

  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const inp = m.input as Record<string, unknown> | undefined;
    if (!inp) continue;
    const cmd  = inp.command as string | undefined;
    const path = inp.path as string | undefined;

    if (cmd === 'str_replace') {
      const added   = String(inp.new_string ?? '').split('\n').length;
      const removed = String(inp.old_string ?? '').split('\n').length;
      linesAdded   += added;
      linesRemoved += removed;
      if (path && !touchedPaths.has(path)) { touchedPaths.add(path); filesEdited++; }
    } else if (cmd === 'create') {
      const lines = String(inp.file_text ?? '').split('\n').length;
      linesAdded += lines;
      if (path && !touchedPaths.has(path)) { touchedPaths.add(path); filesCreated++; }
    }
  }
  return { linesAdded, linesRemoved, filesEdited, filesCreated, filesTotal: touchedPaths.size };
}

function ContextBar({ messages, session }: { messages: ChatMessage[]; session: Session | null }) {
  const lastResult = [...messages].reverse().find(m => m.role === 'result' && m.turnUsage);
  if (!lastResult?.turnUsage) return null;

  const u = lastResult.turnUsage;
  const ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const pct = Math.round((ctxTokens / CONTEXT_WINDOW) * 100);
  const turns = messages.filter(m => m.role === 'assistant').length;
  const cost  = messages.reduce((sum, m) => sum + (m.turnCost ?? 0), 0);
  const code  = codeStats(messages);

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
      {/* Row 1: context bar + token stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
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
          <span title={`Cumulative session cost: $${cost.toFixed(5)}`} style={{ fontSize: 10, color: '#fbbf24', flexShrink: 0, fontWeight: 600 }}>
            💰 ${cost.toFixed(3)}
          </span>
        )}
      </div>

      {/* Row 2: code stats */}
      {(code.linesAdded > 0 || code.filesTotal > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: advice ? 3 : 0 }}>
          {code.linesAdded > 0 && (
            <span title="Lines of code written (str_replace new_string + file creates)" style={{ fontSize: 10, color: '#4ade80', fontFamily: 'monospace' }}>
              +{code.linesAdded.toLocaleString()} lines
            </span>
          )}
          {code.linesRemoved > 0 && (
            <span title="Lines of code removed (str_replace old_string)" style={{ fontSize: 10, color: '#f87171', fontFamily: 'monospace' }}>
              −{code.linesRemoved.toLocaleString()}
            </span>
          )}
          {code.filesTotal > 0 && (
            <span title={`${code.filesCreated} file${code.filesCreated !== 1 ? 's' : ''} created, ${code.filesEdited} edited`} style={{ fontSize: 10, color: '#7dd3fc', fontFamily: 'monospace' }}>
              {code.filesTotal} file{code.filesTotal !== 1 ? 's' : ''}
              {code.filesCreated > 0 && <span style={{ opacity: 0.7 }}> ({code.filesCreated} new)</span>}
            </span>
          )}
        </div>
      )}

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
  const messagesEndRef      = useRef<HTMLDivElement>(null);
  const messagesScrollRef   = useRef<HTMLDivElement>(null);
  const esRef               = useRef<EventSource | null>(null);
  // When true, the next render with content jumps straight to the latest message (no animation).
  // Set whenever a different session/transcript is opened.
  const pinToBottomRef      = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    setShowScrollBtn(false);
  }, []);

  // Opening a different session (or history transcript) should show its latest messages, not the top.
  useEffect(() => { pinToBottomRef.current = true; }, [sessionId, isViewingHistory]);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 120);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
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
      const ev = raw as { kind: string; messages?: ChatMessage[]; message?: ChatMessage; text?: string; running?: boolean; activity?: { phase?: string; preview?: string } | null };
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
        // Backend sends { activity: { phase, preview } } while a turn is in flight, or
        // { activity: null } when the turn ends (idle/ended). A null activity means "not working".
        const a = ev.activity;
        if (a && a.phase) {
          setWorkingState({ text: a.preview ? `${a.phase} · ${a.preview}` : a.phase, running: true });
        } else {
          setWorkingState(null);
        }
      } else if (ev.kind === 'approval') {
        window.dispatchEvent(new CustomEvent('fleet:approval', { detail: ev }));
      }
    });

    esRef.current = es;
    return () => { es.close(); };
  }, [sessionId, isViewingHistory]);

  useEffect(() => {
    const count = isViewingHistory ? historyMessages.length : messages.length;
    // Just opened this session/transcript — once its messages are in, snap to the latest instantly.
    if (pinToBottomRef.current) {
      if (count > 0) { pinToBottomRef.current = false; scrollToBottom(); }
      return;
    }
    const el = messagesScrollRef.current;
    if (!el) { scrollToBottom(); return; }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 120) scrollToBottom();
  }, [messages, historyMessages, isViewingHistory, scrollToBottom]);

  async function sendMessage() {
    if (!sessionId || !composerText.trim()) return;
    const text = composerText.trim();
    setComposerText('');
    setWorkingState(null);
    await apiPost(`/api/sessions/${sessionId}/message`, { text });
  }

  const displayMessages = isViewingHistory ? historyMessages : messages;
  // Authoritative: a session is only "working" while the backend reports running/starting.
  // idle/ended/error/limited all mean the turn is over — never show the working animation then,
  // even if toolFeed still holds entries from the just-finished turn.
  const idleStatus = !session?.status
    || session.status === 'idle' || session.status === 'ended'
    || session.status === 'error' || session.status === 'limited';
  const isRunning = !idleStatus && (
    session?.status === 'running' || session?.status === 'starting' || workingState?.running === true
  );

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
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: (isViewingHistory && historyLoading && historyMessages.length === 0) ? 'none' : 'block' }}>
        {displayMessages.length > 0 && (
          <button
            onClick={scrollToBottom}
            title="Jump to latest message"
            style={{
              position: 'absolute', bottom: 12, right: 16, zIndex: 10,
              width: 30, height: 30, borderRadius: '50%',
              background: 'var(--accent)', color: '#fff',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, lineHeight: 1, boxShadow: '0 2px 8px rgba(0,0,0,.4)',
              opacity: showScrollBtn ? 0.95 : 0.45,
              transition: 'opacity .15s',
            }}
          >↓</button>
        )}
      <div ref={messagesScrollRef} style={{
        position: 'absolute', inset: 0, overflowY: 'auto', padding: '6px 10px',
        userSelect: 'text',
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
                <div style={{ fontSize: 12, color: '#e5c07b' }}>
                  <FileDiffViewer name={m.name ?? 'tool'} input={m.input} />
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
      </div>

      {/* Working indicator — only while the session is actually running, not after it goes idle. */}
      {!isViewingHistory && isRunning && (
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
