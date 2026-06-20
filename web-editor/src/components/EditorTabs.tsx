import React from 'react';
import { Play, Square, Terminal } from 'lucide-react';
import { Tab } from '../types';

// File extension → icon colour mapping (VS Code-like)
const FILE_ICON_COLORS: Record<string, string> = {
  html: '#e34f26',
  css: '#264de4',
  js: '#f0db4f',
  jsx: '#61dafb',
  ts: '#007acc',
  tsx: '#61dafb',
  py: '#3572a5',
  json: '#cbcb41',
  md: '#083fa1',
  rs: '#dea584',
  go: '#00add8',
  java: '#b07219',
  rb: '#701516',
};

function fileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return FILE_ICON_COLORS[ext] ?? '#858585';
}

interface EditorTabsProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onToggleRun?: () => void;
  isRunning?: boolean;
  onToggleTerminal?: () => void;
}

export const EditorTabs: React.FC<EditorTabsProps> = ({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onToggleRun,
  isRunning,
  onToggleTerminal,
}) => {
  return (
    <div className="vsc-tabs" style={{ position: 'relative' }}>
      {/* Tabs */}
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`vsc-tab${isActive ? ' active' : ''}`}
            onClick={() => onTabClick(tab.id)}
            title={tab.filePath}
          >
            {/* File type indicator dot */}
            <span
              style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: fileIconColor(tab.name),
              }}
            />
            <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tab.name}
            </span>
            {tab.isUnsaved && (
              <span className="vsc-tab-dirty" title="Unsaved changes">●</span>
            )}
            <button
              className="vsc-tab-close"
              onClick={e => { e.stopPropagation(); onTabClose(tab.id); }}
              title="Close"
            >
              <svg viewBox="0 0 10 10" width="10" height="10">
                <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        );
      })}

      {tabs.length === 0 && (
        <div className="vsc-tab-empty">Open a file to start editing</div>
      )}

      {/* Toolbar actions on right */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: '0 8px', gap: 2, flexShrink: 0 }}>
        {onToggleRun && (
          <button
            className="vsc-icon-btn"
            onClick={onToggleRun}
            title={isRunning ? 'Stop Preview (F5)' : 'Start Preview (F5)'}
            style={{ color: isRunning ? 'var(--vsc-red)' : 'var(--vsc-green)' }}
          >
            {isRunning ? <Square size={14} /> : <Play size={14} />}
          </button>
        )}
        {onToggleTerminal && (
          <button
            className="vsc-icon-btn"
            onClick={onToggleTerminal}
            title="Toggle Terminal (Ctrl+`)"
          >
            <Terminal size={14} />
          </button>
        )}
      </div>
    </div>
  );
};