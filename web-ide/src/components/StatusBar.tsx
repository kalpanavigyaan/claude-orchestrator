import { GitBranch } from 'lucide-react';
import { Tab } from '../types';

interface StatusBarProps {
  activeTab: Tab | null;
  fileCount: number;
  cursorLine: number;
  cursorCol: number;
  errorCount?: number;
}

export function StatusBar({
  activeTab,
  fileCount,
  cursorLine,
  cursorCol,
  errorCount = 0,
}: StatusBarProps) {
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <div className="statusbar">
      <div className="sb-side">
        <span className="sb-item" title="Current branch">
          <GitBranch size={12} style={{ marginRight: 4 }} />
          main
        </span>
        {errorCount > 0 && (
          <span className="sb-item" title="Errors" style={{ color: '#f14c4c' }}>
            ✕ {errorCount}
          </span>
        )}
        <span className="sb-item" title="Files in workspace">
          {fileCount} file{fileCount !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="sb-side right">
        {activeTab && (
          <>
            <span className="sb-item" title="Cursor position">
              Ln {cursorLine}, Col {cursorCol}
            </span>
            <span className="sb-item" title="Indentation">
              Spaces: 2
            </span>
            <span className="sb-item" title="File encoding">
              UTF-8
            </span>
            <span className="sb-item" title="Language mode">
              {capitalize(activeTab.language)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
