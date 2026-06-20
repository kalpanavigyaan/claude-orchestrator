import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { ConsoleMsg } from '../types';

interface TerminalPanelProps {
  messages: ConsoleMsg[];
  onClear: () => void;
}

function formatTime(ts: Date): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function levelIcon(level: ConsoleMsg['level']): string {
  switch (level) {
    case 'error': return '✕';
    case 'warn': return '⚠';
    case 'info': return 'ℹ';
    default: return '›';
  }
}

export function TerminalPanel({ messages, onClear }: TerminalPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: 0.6,
          }}
        >
          Console
        </span>
        <button className="icon-btn" onClick={onClear} title="Clear Console">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="panel-body" style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {messages.length === 0 ? (
          <div style={{ padding: '12px 16px', opacity: 0.4, fontSize: 13 }}>
            Console output appears here when you run the preview.
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`term-line ${msg.level}`}
              style={{ display: 'flex', alignItems: 'flex-start', padding: '2px 8px', gap: 4 }}
            >
              <span
                className="term-prefix"
                style={{ opacity: 0.5, fontSize: 11, flexShrink: 0, fontFamily: 'monospace' }}
              >
                {formatTime(msg.ts)}
              </span>
              <span style={{ flexShrink: 0 }}>{levelIcon(msg.level)}</span>
              <span style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>
                {msg.text}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
