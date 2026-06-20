import React, { useMemo, useState } from 'react';

interface Props {
  selectedId: string | null;
}

const COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/help',              desc: 'Show available commands and usage' },
  { cmd: '/clear',             desc: 'Clear conversation history' },
  { cmd: '/compact',           desc: 'Compact conversation to save context' },
  { cmd: '/memory',            desc: 'Manage persistent memory (add · view · sync)' },
  { cmd: '/memory add',        desc: 'Add a new memory entry' },
  { cmd: '/memory view',       desc: 'View stored memories' },
  { cmd: '/memory sync',       desc: 'Sync memory to disk' },
  { cmd: '/model',             desc: 'Switch model  (e.g. /model opus)' },
  { cmd: '/mode',              desc: 'Switch mode: auto · plan · code · ask' },
  { cmd: '/review',            desc: 'Review current changes or diff' },
  { cmd: '/status',            desc: 'Show current session status' },
  { cmd: '/tools',             desc: 'List available tools and their status' },
  { cmd: '/permissions',       desc: 'Manage file and tool permissions' },
  { cmd: '/doctor',            desc: 'Diagnose environment issues' },
  { cmd: '/reset',             desc: 'Reset session state and context' },
  { cmd: '/init',              desc: 'Initialise project with CLAUDE.md' },
];

export default function CommandsPanel({ selectedId }: Props) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(c =>
      c.cmd.includes(q) || c.desc.toLowerCase().includes(q),
    );
  }, [filter]);

  function insertCommand(cmd: string) {
    window.dispatchEvent(new CustomEvent('fleet:insert-command', { detail: cmd }));
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Filter input */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter commands…"
          style={{
            background: 'var(--in-bg, var(--ed-bg))',
            border: '1px solid var(--in-border, var(--border))',
            color: 'var(--in-fg, var(--sb-fg))',
            borderRadius: 2,
            padding: '4px 7px',
            width: '100%',
            fontSize: 11,
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
      </div>

      {/* Command list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
            No commands match.
          </div>
        ) : filtered.map(c => (
          <button
            key={c.cmd}
            onClick={() => insertCommand(c.cmd)}
            title={`Insert "${c.cmd}"`}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
              width: '100%', background: 'none', border: 'none',
              borderBottom: '1px solid var(--border)',
              padding: '6px 10px', cursor: 'pointer',
              color: 'inherit', textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--sb-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{
              fontFamily: 'monospace', fontSize: 11,
              color: 'var(--accent)', fontWeight: 600,
            }}>
              {c.cmd}
            </span>
            <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
              {c.desc}
            </span>
          </button>
        ))}
      </div>

      {/* Status footer */}
      {!selectedId && (
        <div style={{
          padding: '5px 10px',
          fontSize: 10, color: 'var(--muted)',
          borderTop: '1px solid var(--border)',
          fontStyle: 'italic', flexShrink: 0,
        }}>
          Select a session to send commands.
        </div>
      )}
    </div>
  );
}
