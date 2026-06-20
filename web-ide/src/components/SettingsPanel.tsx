import { Sun, Moon } from 'lucide-react';
import { EditorSettings } from '../types';

interface SettingsPanelProps {
  settings: EditorSettings;
  onSettingsChange: (s: Partial<EditorSettings>) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const SHORTCUTS = [
  ['Ctrl+S', 'Save file'],
  ['Ctrl+B', 'Toggle explorer'],
  ['Ctrl+`', 'Toggle terminal'],
  ['F5', 'Toggle preview'],
  ['Ctrl+Shift+F', 'Format document'],
];

export function SettingsPanel({
  settings,
  onSettingsChange,
  theme,
  onToggleTheme,
}: SettingsPanelProps) {
  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 8 }}>
      <div className="settings-group">
        <div className="settings-group-title">Appearance</div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Color Theme</div>
            <div className="settings-desc">Switch between dark and light themes</div>
          </div>
          <button className="btn" onClick={onToggleTheme}>
            {theme === 'dark' ? (
              <>
                <Sun size={12} style={{ marginRight: 4 }} />
                Light
              </>
            ) : (
              <>
                <Moon size={12} style={{ marginRight: 4 }} />
                Dark
              </>
            )}
          </button>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Font Size</div>
            <div className="settings-desc">Editor font size in pixels</div>
          </div>
          <select
            className="fi"
            value={settings.fontSize}
            onChange={(e) => onSettingsChange({ fontSize: Number(e.target.value) })}
          >
            {[12, 13, 14, 15, 16, 18, 20].map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">Editor</div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Tab Size</div>
            <div className="settings-desc">Number of spaces per tab</div>
          </div>
          <select
            className="fi"
            value={settings.tabSize}
            onChange={(e) => onSettingsChange({ tabSize: Number(e.target.value) })}
          >
            {[2, 4, 8].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Word Wrap</div>
            <div className="settings-desc">Wrap long lines in the editor</div>
          </div>
          <input
            type="checkbox"
            checked={settings.wordWrap}
            onChange={(e) => onSettingsChange({ wordWrap: e.target.checked })}
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Minimap</div>
            <div className="settings-desc">Show code overview minimap</div>
          </div>
          <input
            type="checkbox"
            checked={settings.minimap}
            onChange={(e) => onSettingsChange({ minimap: e.target.checked })}
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">Format on Save</div>
            <div className="settings-desc">Auto-format document when saving</div>
          </div>
          <input
            type="checkbox"
            checked={settings.formatOnSave}
            onChange={(e) => onSettingsChange({ formatOnSave: e.target.checked })}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">Keyboard Shortcuts</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {SHORTCUTS.map(([key, desc]) => (
              <tr key={key} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  <kbd
                    style={{
                      background: 'var(--input-bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      padding: '1px 6px',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                  >
                    {key}
                  </kbd>
                </td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
