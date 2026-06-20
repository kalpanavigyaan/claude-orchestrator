import { Sun, Moon } from 'lucide-react';

interface TitleBarProps {
  title: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function TitleBar({ title, theme, onToggleTheme }: TitleBarProps) {
  const handleMinimize = () => {
    document.dispatchEvent(new CustomEvent('ide:minimize'));
  };

  const handleMaximize = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  };

  const handleClose = () => {
    window.close();
  };

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <polygon
            points="10,2 17.32,6 17.32,14 10,18 2.68,14 2.68,6"
            stroke="#007acc"
            strokeWidth="1.5"
            fill="none"
          />
          <polygon
            points="10,5 14.66,7.5 14.66,12.5 10,15 5.34,12.5 5.34,7.5"
            stroke="#007acc"
            strokeWidth="1"
            fill="#007acc"
            fillOpacity="0.2"
          />
        </svg>
      </div>
      <div className="titlebar-center">{title}</div>
      <div className="titlebar-right">
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button className="wc" onClick={handleMinimize} title="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button className="wc" onClick={handleMaximize} title="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect
              x="1"
              y="1"
              width="8"
              height="8"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        </button>
        <button className="wc danger" onClick={handleClose} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line
              x1="1"
              y1="1"
              x2="9"
              y2="9"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <line
              x1="9"
              y1="1"
              x2="1"
              y2="9"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
