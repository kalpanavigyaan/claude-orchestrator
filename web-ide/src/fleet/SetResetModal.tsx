import React, { useState } from 'react';
import { apiPost } from '../fleet/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function SetResetModal({ isOpen, onClose }: Props) {
  const [value, setValue]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  async function save() {
    if (!value) { setError('Please select a date and time.'); return; }
    setError('');
    setSaving(true);
    const resetAt = new Date(value).toISOString();
    const data = await apiPost('/api/account/reset-time', { resetAt });
    setSaving(false);
    if (data && data.ok !== false) {
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 800);
    } else {
      setError('Failed to save reset time.');
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
        width: 340,
        maxWidth: '95vw',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600, fontSize: 14, color: 'var(--sb-fg)',
        }}>
          <span>Set Account Reset Time</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px' }}>
          <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>
            Reset date &amp; time
          </label>
          <input
            type="datetime-local"
            value={value}
            onChange={e => setValue(e.target.value)}
            style={{
              background: 'var(--in-bg, var(--ed-bg))',
              border: '1px solid var(--in-border, var(--border))',
              color: 'var(--in-fg, #ccc)',
              borderRadius: 3,
              padding: '5px 8px',
              fontSize: 13,
              width: '100%',
              boxSizing: 'border-box',
            }}
          />

          {error && (
            <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}
          {success && (
            <div style={{ color: 'var(--green, #4ade80)', fontSize: 12, marginTop: 8 }}>Saved!</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid var(--border)', color: 'var(--sb-fg)',
              padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !value}
            style={{
              background: 'var(--accent)', border: 'none', color: '#fff',
              padding: '5px 16px', borderRadius: 3, cursor: saving ? 'default' : 'pointer',
              fontSize: 13, opacity: saving || !value ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
