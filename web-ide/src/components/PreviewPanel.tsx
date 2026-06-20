import { useState, useEffect, useRef } from 'react';
import { Play, Square, RefreshCw } from 'lucide-react';
import { FileNode, ConsoleMsg } from '../types';

interface PreviewPanelProps {
  files: FileNode[];
  isRunning: boolean;
  onToggleRun: () => void;
  onConsoleMessage: (msg: Omit<ConsoleMsg, 'id' | 'ts'>) => void;
}

function buildDoc(files: FileNode[]): string {
  const findFile = (name: string): string => {
    const file = files.find((f) => f.type === 'file' && f.name === name);
    return file?.content ?? '';
  };

  const html = findFile('index.html');
  const css = findFile('styles.css');
  const js = findFile('script.js');

  const consoleScript = `<script>
(function() {
  var levels = ['log', 'warn', 'error', 'info'];
  levels.forEach(function(level) {
    var orig = console[level].bind(console);
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      var text = args.map(function(a) {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch(e) { return String(a); }
      }).join(' ');
      try { parent.postMessage({ type: 'console', level: level, text: text }, '*'); } catch(e) {}
      orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function(e) {
    try { parent.postMessage({ type: 'console', level: 'error', text: e.message }, '*'); } catch(err) {}
  });
})();
</script>`;

  if (!html) {
    return `<!DOCTYPE html><html><head><style>body{font-family:sans-serif;padding:20px;background:#1e1e1e;color:#ccc}</style>${consoleScript}</head><body><p>No index.html found</p></body></html>`;
  }

  let doc = html;
  if (css) {
    doc = doc.replace('</head>', `<style>\n${css}\n</style>\n</head>`);
  }
  doc = doc.replace('</head>', `${consoleScript}\n</head>`);
  if (js) {
    doc = doc.replace('</body>', `<script>\n${js}\n</script>\n</body>`);
  }
  return doc;
}

export function PreviewPanel({
  files,
  isRunning,
  onToggleRun,
  onConsoleMessage,
}: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const onConsoleMessageRef = useRef(onConsoleMessage);

  useEffect(() => {
    onConsoleMessageRef.current = onConsoleMessage;
  }, [onConsoleMessage]);

  useEffect(() => {
    if (isRunning) {
      setSrcDoc(buildDoc(files));
    }
  }, [isRunning, files]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'console') {
        onConsoleMessageRef.current({
          level: e.data.level as ConsoleMsg['level'],
          text: String(e.data.text),
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleRefresh = () => {
    setSrcDoc(buildDoc(files));
    setRefreshKey((k) => k + 1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        className="preview-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          gap: 4,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <button
          className="icon-btn"
          onClick={onToggleRun}
          title={isRunning ? 'Stop' : 'Run'}
          style={{ color: isRunning ? '#f14c4c' : '#4ec9b0' }}
        >
          {isRunning ? <Square size={14} /> : <Play size={14} />}
        </button>
        {isRunning && (
          <button className="icon-btn" onClick={handleRefresh} title="Refresh">
            <RefreshCw size={14} />
          </button>
        )}
        <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 4 }}>
          {isRunning ? 'Live Preview' : 'Preview'}
        </span>
      </div>
      {isRunning ? (
        <iframe
          key={refreshKey}
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin allow-modals allow-forms"
          className="preview-frame"
          style={{ flex: 1, border: 'none', width: '100%', background: 'white' }}
          title="preview"
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 12,
            opacity: 0.4,
          }}
        >
          <Play size={40} />
          <span style={{ fontSize: 14 }}>Click play to preview</span>
        </div>
      )}
    </div>
  );
}
