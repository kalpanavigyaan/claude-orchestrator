import React, { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../fleet/api';

interface InstructionFile {
  name: string;
  content: string;
}

interface Props {
  sessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  background: 'var(--in-bg, var(--ed-bg))',
  border: '1px solid var(--in-border, var(--border))',
  color: 'var(--in-fg, #ccc)',
  borderRadius: 3,
  padding: '5px 8px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

export default function InstructionsModal({ sessionId, isOpen, onClose }: Props) {
  const [files, setFiles]               = useState<InstructionFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [nameInput, setNameInput]       = useState('');
  const [contentInput, setContentInput] = useState('');
  const [saving, setSaving]             = useState(false);

  useEffect(() => {
    if (!isOpen || !sessionId) return;
    loadFiles();
  }, [isOpen, sessionId]);

  async function loadFiles() {
    const data = await apiGet(`/api/sessions/${sessionId}/instructions`);
    if (data && Array.isArray(data.files)) {
      setFiles(data.files as InstructionFile[]);
      if (data.files.length > 0 && !selectedFile) {
        const first = (data.files as InstructionFile[])[0];
        setSelectedFile(first.name);
        setNameInput(first.name);
        setContentInput(first.content);
      }
    }
  }

  function selectFile(f: InstructionFile) {
    setSelectedFile(f.name);
    setNameInput(f.name);
    setContentInput(f.content);
  }

  function newFile() {
    setSelectedFile(null);
    setNameInput('');
    setContentInput('');
  }

  async function save() {
    if (!sessionId || !nameInput.trim()) return;
    setSaving(true);
    await apiPost(`/api/sessions/${sessionId}/instructions/save`, {
      name: nameInput.trim(),
      content: contentInput,
    });
    setSaving(false);
    await loadFiles();
    setSelectedFile(nameInput.trim());
  }

  async function readInstructions() {
    if (!sessionId) return;
    await apiPost(`/api/sessions/${sessionId}/message`, { text: '/instructions' });
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--sb-bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        width: 700,
        maxWidth: '95vw',
        height: 480,
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
          fontWeight: 600,
          fontSize: 14,
          color: 'var(--sb-fg)',
        }}>
          <span>Instructions — {sessionId}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* File list */}
          <div style={{
            width: 180,
            borderRight: '1px solid var(--border)',
            overflowY: 'auto',
            padding: 6,
            flexShrink: 0,
          }}>
            <button
              onClick={newFile}
              style={{
                width: '100%', textAlign: 'left', background: 'none',
                border: '1px dashed var(--border)', color: 'var(--muted)',
                padding: '4px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 12,
                marginBottom: 6,
              }}
            >
              + New file
            </button>
            {files.map(f => (
              <div
                key={f.name}
                onClick={() => selectFile(f)}
                style={{
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: 3,
                  fontSize: 12,
                  color: 'var(--sb-fg)',
                  background: selectedFile === f.name ? 'var(--sb-focus)' : 'transparent',
                  marginBottom: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={f.name}
              >
                {f.name}
              </div>
            ))}
          </div>

          {/* Editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12, gap: 8, overflow: 'hidden' }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>File name</label>
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                placeholder="e.g. CLAUDE.md"
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Content</label>
              <textarea
                value={contentInput}
                onChange={e => setContentInput(e.target.value)}
                style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={readInstructions}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  color: 'var(--sb-fg)',
                  padding: '5px 12px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Read Instructions
              </button>
              <button
                onClick={save}
                disabled={saving || !nameInput.trim()}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  color: '#fff',
                  padding: '5px 14px',
                  borderRadius: 3,
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: 12,
                  opacity: saving || !nameInput.trim() ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
