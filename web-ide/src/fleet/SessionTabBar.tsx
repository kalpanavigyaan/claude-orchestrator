/**
 * SessionTabBar — draggable session tabs above the chat area.
 *
 * Each active session gets a tab. Tabs are draggable:
 *   – Drop on the main area centre → switch active session
 *   – Drop on left/right edge → horizontal split
 *   – Drop on top/bottom edge → vertical split
 *
 * The drop zones are rendered on the CHAT AREA (see SplitDropZones), not here.
 */
import React from 'react';
import type { Session } from './types';

const STATUS_DOT: Record<string, string> = {
  running:  '#4ade80',
  idle:     '#60a5fa',
  limited:  '#fbbf24',
  error:    '#f87171',
  starting: '#a78bfa',
  ended:    '#6b7280',
};

// Label suffix for special states
function statusSuffix(s: Session): string {
  if (s.status === 'limited') return ' ⏸';
  if (s.status === 'error') return ' ✕';
  return '';
}

interface Props {
  sessions: Session[];
  tabOrder: string[];
  activePaneId: string | null;   // session shown in the focused pane
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

export default function SessionTabBar({
  sessions, tabOrder, activePaneId,
  onSelect, onClose, onDragStart, onDragEnd,
}: Props) {
  const sessMap = Object.fromEntries(sessions.map(s => [s.id, s]));

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      background: 'var(--tab-strip)',
      borderBottom: '2px solid var(--border)',
      overflowX: 'auto', flexShrink: 0,
      minHeight: 34,
    }}>
      {tabOrder.length === 0 && (
        <div style={{ padding: '0 12px', fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', fontStyle: 'italic' }}>
          No open tabs — select a session or create one
        </div>
      )}
      {tabOrder.map(id => {
        const s = sessMap[id];
        if (!s) return null;
        const isActive = id === activePaneId;
        return (
          <div
            key={id}
            draggable
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(id); }}
            onDragEnd={onDragEnd}
            onClick={() => onSelect(id)}
            title={s.cwd ?? s.label}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 8px 0 10px',
              cursor: 'pointer', userSelect: 'none', flexShrink: 0,
              borderRight: '1px solid var(--border)',
              background: isActive ? 'var(--ed-bg)' : 'transparent',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              color: isActive ? 'var(--ed-fg)' : 'var(--muted)',
              fontSize: 12, minWidth: 0, maxWidth: 200,
            }}
          >
            {/* Status dot */}
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: STATUS_DOT[s.status] ?? '#6b7280',
              boxShadow: s.status === 'running' ? `0 0 5px ${STATUS_DOT.running}` : 'none',
              animation: s.status === 'limited' ? 'fc-dot-pulse 1.5s infinite ease-in-out' : 'none',
            }} />
            {/* Label */}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {s.label}{statusSuffix(s)}
            </span>
            {/* Close */}
            <button
              onClick={e => { e.stopPropagation(); onClose(id); }}
              title="Close tab (session keeps running)"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', padding: '0 2px', fontSize: 13,
                lineHeight: 1, flexShrink: 0, opacity: .6,
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '.6')}
            >✕</button>
          </div>
        );
      })}
    </div>
  );
}

/** Drop-zone overlays rendered on top of a chat pane while dragging. */
export function SplitDropZones({
  paneId,
  onDrop,
}: {
  paneId: 'main' | 'sec';
  onDrop: (paneId: 'main' | 'sec', zone: 'center' | 'left' | 'right' | 'top' | 'bottom') => void;
}) {
  const zone = (z: 'center' | 'left' | 'right' | 'top' | 'bottom', style: React.CSSProperties) => (
    <div
      key={z}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); onDrop(paneId, z); }}
      style={{
        position: 'absolute', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.8)',
        background: 'rgba(0,122,204,.35)',
        border: '2px dashed rgba(0,122,204,.7)',
        borderRadius: 4, backdropFilter: 'blur(2px)',
        pointerEvents: 'all',
        ...style,
      }}
    >
      {z === 'center' ? 'Switch' : z === 'left' ? '◀ Split' : z === 'right' ? 'Split ▶' : z === 'top' ? '▲ Split' : 'Split ▼'}
    </div>
  );

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 99 }}>
      {zone('center', { inset: '30%' })}
      {zone('left',   { top: '20%', bottom: '20%', left: 0, width: '25%' })}
      {zone('right',  { top: '20%', bottom: '20%', right: 0, width: '25%' })}
      {zone('top',    { left: '20%', right: '20%', top: 0, height: '20%' })}
      {zone('bottom', { left: '20%', right: '20%', bottom: 0, height: '20%' })}
    </div>
  );
}
