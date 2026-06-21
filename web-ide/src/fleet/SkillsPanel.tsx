import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from './api';
import type { MdFile } from './types';

interface Props {
  selectedId: string | null;
}

export default function SkillsPanel({ selectedId }: Props) {
  const [files, setFiles]           = useState<MdFile[]>([]);
  const [dir, setDir]               = useState('');
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [applied, setApplied]       = useState<Set<string>>(new Set());
  const [applying, setApplying]     = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet('/api/skills')
      .then((d: any) => { setFiles(d.files ?? []); setDir(d.dir ?? ''); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Reset applied state when session changes
  useEffect(() => { setApplied(new Set()); }, [selectedId]);

  const applySkill = useCallback(async (file: MdFile) => {
    if (!selectedId || applying) return;
    setApplying(file.name);
    try {
      const prefix = `Apply the following skill for this session:\n\n---\n${file.content}\n---`;
      await apiPost(`/api/sessions/${selectedId}/message`, { text: prefix });
      setApplied(prev => new Set([...prev, file.name]));
    } catch {
      /* ignore */
    } finally {
      setApplying(null);
    }
  }, [selectedId, applying]);

  const toggle = (name: string) => setExpanded(e => e === name ? null : name);

  if (loading) {
    return <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>Loading skills…</div>;
  }

  if (!files.length) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 8px', color: 'var(--fg)' }}>No skill files found.</p>
        <p style={{ margin: 0 }}>
          Add <code style={{ fontSize: 11, color: '#38bdf8' }}>.md</code> files to:
        </p>
        <code style={{ display: 'block', marginTop: 6, fontSize: 10, color: '#38bdf8', wordBreak: 'break-all' }}>
          {dir}
        </code>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header hint */}
      <div style={{ padding: '6px 10px 4px', fontSize: 10, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
        Check a skill to apply it to the current session
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {files.map(file => {
          const isApplied  = applied.has(file.name);
          const isApplying = applying === file.name;
          const isOpen     = expanded === file.name;
          const label      = file.name.replace(/^\d+-/, '').replace(/\.md$/i, '').replace(/-/g, ' ');
          const excerpt    = file.content.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '';

          return (
            <div key={file.name} style={{
              borderBottom: '1px solid var(--border)',
              background: isApplied ? 'rgba(56,189,248,.06)' : 'transparent',
            }}>
              {/* Row */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', cursor: 'pointer',
              }}>
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={isApplied}
                  disabled={!selectedId || isApplying}
                  onChange={() => !isApplied && applySkill(file)}
                  style={{ accentColor: '#38bdf8', flexShrink: 0, cursor: selectedId ? 'pointer' : 'not-allowed' }}
                  title={isApplied ? 'Applied this session' : selectedId ? 'Apply to current session' : 'No session selected'}
                />

                {/* Label + excerpt — click to expand */}
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => toggle(file.name)}>
                  <div style={{
                    fontSize: 12, fontWeight: 500,
                    color: isApplied ? '#38bdf8' : 'var(--fg)',
                    textTransform: 'capitalize',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {label}
                    {isApplying && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--muted)' }}>applying…</span>}
                    {isApplied  && <span style={{ marginLeft: 6, fontSize: 10, color: '#38bdf8' }}>✓ applied</span>}
                  </div>
                  {!isOpen && excerpt && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                      {excerpt.slice(0, 80)}
                    </div>
                  )}
                </div>

                {/* Expand toggle */}
                <span
                  onClick={() => toggle(file.name)}
                  style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0, userSelect: 'none', cursor: 'pointer' }}
                >
                  {isOpen ? '▲' : '▼'}
                </span>
              </div>

              {/* Expanded content */}
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

      {/* Footer — dir path */}
      <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--muted)', borderTop: '1px solid var(--border)', wordBreak: 'break-all' }}>
        {dir}
      </div>
    </div>
  );
}
