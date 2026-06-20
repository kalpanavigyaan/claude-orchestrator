import { X, Play, Square, Terminal } from 'lucide-react';
import { Tab } from '../types';

const EXT_COLORS: Record<string, string> = {
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
};

function getExtColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_COLORS[ext] ?? '#858585';
}

interface EditorTabsProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onToggleRun: () => void;
  isRunning: boolean;
  onToggleTerminal: () => void;
}

export function EditorTabs({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onToggleRun,
  isRunning,
  onToggleTerminal,
}: EditorTabsProps) {
  return (
    <div className="tabstrip">
      {tabs.length === 0 ? (
        <div className="tab-empty">No files open</div>
      ) : (
        tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? ' active' : ''}`}
            onClick={() => onTabClick(tab.id)}
          >
            <span
              className="tab-dot"
              style={{ background: getExtColor(tab.name) }}
            />
            <span className="tab-name">{tab.name}</span>
            {tab.isUnsaved && <span className="tab-dirty">●</span>}
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
            >
              <X size={12} />
            </span>
          </div>
        ))
      )}
      <div className="tab-actions">
        <button
          className="icon-btn"
          onClick={onToggleRun}
          title={isRunning ? 'Stop Preview (F5)' : 'Run Preview (F5)'}
          style={{ color: isRunning ? '#f14c4c' : '#4ec9b0' }}
        >
          {isRunning ? <Square size={14} /> : <Play size={14} />}
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTerminal}
          title="Toggle Terminal (Ctrl+`)"
        >
          <Terminal size={14} />
        </button>
      </div>
    </div>
  );
}
