import React from 'react';
import { apiPost } from './api';
import type { Session } from './types';

interface Props {
  session: Session | null;
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '5px 10px',
  borderBottom: '1px solid var(--border)',
};

const tagStyle: React.CSSProperties = {
  fontSize: 9, padding: '1px 5px', borderRadius: 2,
  border: '1px solid var(--border)', color: 'var(--muted)',
  flexShrink: 0, fontFamily: 'monospace',
};

const pathStyle: React.CSSProperties = {
  flex: 1, fontSize: 10,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'monospace',
};

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none',
  color: 'var(--muted)', cursor: 'pointer',
  padding: '1px 5px', borderRadius: 2,
  fontSize: 10, flexShrink: 0,
};

export default function DirectoriesPanel({ session }: Props) {
  if (!session) {
    return (
      <div style={{
        padding: '12px 10px', fontSize: 11,
        color: 'var(--muted)', fontStyle: 'italic',
        background: 'var(--sb-bg)', height: '100%',
      }}>
        Select a session to manage its directories.
      </div>
    );
  }

  const id             = session.id;
  const additionalDirs = session.additionalDirectories ?? [];

  async function removeDir(path: string) {
    const next = additionalDirs.filter(d => d !== path);
    await apiPost(`/api/sessions/${id}/set-directories`, { directories: next });
  }

  async function grantWrite(path: string) {
    await apiPost(`/api/sessions/${id}/grant-write`, { path });
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '4px 10px',
        fontSize: 9, textTransform: 'uppercase',
        letterSpacing: '0.07em', color: 'var(--sb-hdr-fg)', fontWeight: 600,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        Directories
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {/* CWD */}
        {session.cwd && (
          <div>
            <div style={{
              padding: '4px 10px 2px',
              fontSize: 9, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: 'var(--muted)',
            }}>
              Working Directory
            </div>
            <div style={rowStyle}>
              <span style={{ ...tagStyle, color: 'var(--cyan)', borderColor: 'var(--cyan)' }}>rw</span>
              <span style={pathStyle} title={session.cwd}>{session.cwd}</span>
            </div>
          </div>
        )}

        {/* Additional dirs */}
        <div style={{
          padding: '6px 10px 2px',
          fontSize: 9, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: 'var(--muted)',
        }}>
          Additional Directories
        </div>

        {additionalDirs.length === 0 ? (
          <div style={{ padding: '5px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
            No additional directories.
          </div>
        ) : additionalDirs.map(dir => (
          <div key={dir} style={rowStyle}>
            <span style={tagStyle}>ro</span>
            <span style={pathStyle} title={dir}>{dir}</span>
            <button
              onClick={() => grantWrite(dir)}
              title="Grant write access"
              style={{ ...iconBtn, color: 'var(--amber)' }}
            >
              +rw
            </button>
            <button
              onClick={() => removeDir(dir)}
              title="Remove directory"
              style={iconBtn}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
