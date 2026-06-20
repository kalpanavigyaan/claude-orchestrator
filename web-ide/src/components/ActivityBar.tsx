import {
  Files,
  Search,
  GitBranch,
  Package,
  Play,
  Square,
  Github,
  Download,
  Settings,
  MessageSquare,
} from 'lucide-react';

export type ActivityView =
  | 'explorer'
  | 'search'
  | 'git'
  | 'extensions'
  | 'run'
  | 'settings'
  | 'fleet';

interface ActivityBarProps {
  activeView: ActivityView | null;
  onViewChange: (view: ActivityView) => void;
  onGitHub: () => void;
  onExport: () => void;
  isRunning: boolean;
}

export function ActivityBar({
  activeView,
  onViewChange,
  onGitHub,
  onExport,
  isRunning,
}: ActivityBarProps) {
  const topItems: { id: ActivityView; icon: React.ReactNode; tip: string }[] = [
    { id: 'fleet', icon: <MessageSquare size={22} />, tip: 'Fleet Console (AI Agent Manager)' },
    { id: 'explorer', icon: <Files size={22} />, tip: 'Explorer (Ctrl+B)' },
    { id: 'search', icon: <Search size={22} />, tip: 'Search' },
    { id: 'git', icon: <GitBranch size={22} />, tip: 'Source Control' },
    { id: 'extensions', icon: <Package size={22} />, tip: 'Extensions' },
    {
      id: 'run',
      icon: isRunning ? (
        <Square size={22} style={{ color: '#f14c4c' }} />
      ) : (
        <Play size={22} style={{ color: '#4ec9b0' }} />
      ),
      tip: isRunning ? 'Stop Preview (F5)' : 'Run Preview (F5)',
    },
  ];

  const handleTopClick = (id: ActivityView) => {
    onViewChange(id);
  };

  return (
    <div className="activitybar">
      <div className="ab-group">
        {topItems.map((item) => (
          <button
            key={item.id}
            className={`ab-btn${activeView === item.id ? ' on' : ''}`}
            onClick={() => handleTopClick(item.id)}
            title={item.tip}
          >
            {item.icon}
            <span className="ab-tip">{item.tip}</span>
          </button>
        ))}
      </div>
      <div className="ab-spacer" />
      <div className="ab-group">
        <button className="ab-btn" onClick={onGitHub} title="GitHub Gist">
          <Github size={22} />
          <span className="ab-tip">GitHub Gist</span>
        </button>
        <button className="ab-btn" onClick={onExport} title="Export as ZIP">
          <Download size={22} />
          <span className="ab-tip">Export as ZIP</span>
        </button>
        <button
          className={`ab-btn${activeView === 'settings' ? ' on' : ''}`}
          onClick={() => onViewChange('settings')}
          title="Settings"
        >
          <Settings size={22} />
          <span className="ab-tip">Settings</span>
        </button>
      </div>
    </div>
  );
}
