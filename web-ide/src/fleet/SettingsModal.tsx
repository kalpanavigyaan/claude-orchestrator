import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { loadSettingsText, saveSettingsText, DEFAULT_SETTINGS_TEXT } from './settings';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: Props) {
  const [text, setText]     = useState('');
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setText(loadSettingsText());
      setStatus(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function save() {
    const res = saveSettingsText(text);
    if (res.ok) {
      setStatus({ msg: 'Saved. Colour/font changes apply live; sizes on reload.', error: false });
      setTimeout(onClose, 900);
    } else {
      setStatus({ msg: 'Invalid JSON — not saved: ' + res.error, error: true });
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box"
        style={{ width: 720, maxWidth: '92vw' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-hdr">
          <span>Settings</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Edit <code style={{ background: 'rgba(255,255,255,.1)', padding: '1px 5px', borderRadius: 3 }}>settings.json</code> directly
            — same schema as the electron app. Theme colours under{' '}
            <code style={{ background: 'rgba(255,255,255,.1)', padding: '1px 5px', borderRadius: 3 }}>theme.colors</code>{' '}
            apply live. Comments and trailing commas are allowed; invalid JSON won't be saved.
          </div>

          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', height: 380,
              background: '#1e1e1e', border: '1px solid var(--border)',
              borderRadius: 4, color: '#d4d4d4', padding: 12,
              fontFamily: "'Cascadia Code','Consolas',monospace", fontSize: 12,
              lineHeight: 1.5, resize: 'vertical', outline: 'none',
            }}
          />

          {status && (
            <div style={{ fontSize: 12, color: status.error ? 'var(--red)' : 'var(--green)' }}>
              {status.msg}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn secondary"
            onClick={() => { setText(DEFAULT_SETTINGS_TEXT); setStatus(null); }}
          >
            Reset to defaults
          </button>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
