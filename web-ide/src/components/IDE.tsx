import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { TitleBar } from './TitleBar';
import { ActivityBar } from './ActivityBar';
import type { ActivityView } from './ActivityBar';
import { StatusBar } from './StatusBar';
import { FileExplorer } from './FileExplorer';
import { EditorTabs } from './EditorTabs';
import { MonacoEditor } from './MonacoEditor';
import { PreviewPanel } from './PreviewPanel';
import { TerminalPanel } from './TerminalPanel';
import { SettingsPanel } from './SettingsPanel';
import { SearchPanel } from './SearchPanel';
import { GitHubGist } from './GitHubGist';
import { FleetConsole } from '../fleet/FleetConsole';
import { FileNode, Tab, EditorSettings, ConsoleMsg } from '../types';
import {
  generateId,
  createFile,
  createFolder,
  findById,
  addNode,
  deleteNode,
  getPath,
  getLanguage,
  defaultSettings,
  SAMPLE_PROJECT,
} from '../lib/fs';
import { saveWorkspace, loadWorkspace, exportZip } from '../lib/storage';

interface IDEProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function countFiles(nodes: FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file') count++;
    if (node.children) count += countFiles(node.children);
  }
  return count;
}

/** Find a file node by its full path (name-based, not ID-based). */
function findByPath(nodes: FileNode[], path: string, prefix = ''): FileNode | null {
  for (const node of nodes) {
    const current = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'file' && current === path) return node;
    if (node.children) {
      const found = findByPath(node.children, path, current);
      if (found) return found;
    }
  }
  return null;
}

/** Update a file's content and mark it saved/unsaved. */
function patchFileContent(
  nodes: FileNode[],
  path: string,
  content: string,
  isUnsaved: boolean,
  prefix = '',
): FileNode[] {
  return nodes.map((node) => {
    const current = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'file' && current === path) {
      return { ...node, content, isUnsaved };
    }
    if (node.children) {
      return { ...node, children: patchFileContent(node.children, path, content, isUnsaved, current) };
    }
    return node;
  });
}

const SIDEBAR_VIEWS: ActivityView[] = ['explorer', 'search', 'git', 'extensions', 'settings'];

export function IDE({ theme, onToggleTheme }: IDEProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settings, setSettings] = useState<EditorSettings>(defaultSettings);
  const [activeView, setActiveView] = useState<ActivityView | null>('explorer');
  const [isRunning, setIsRunning] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [rightPanelMode, setRightPanelMode] = useState<'preview' | 'settings'>('preview');
  const [showGist, setShowGist] = useState(false);
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMsg[]>([]);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [panelHeight, setPanelHeight] = useState(220);
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: string } | null>(null);

  // Refs for keyboard handler to always have current state
  const activeTabIdRef = useRef(activeTabId);
  const tabsRef = useRef(tabs);
  const filesRef = useRef(files);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { filesRef.current = files; }, [files]);

  // Load workspace on mount
  useEffect(() => {
    const saved = loadWorkspace();
    if (saved) {
      setFiles(saved.files?.length ? saved.files : SAMPLE_PROJECT);
      setTabs(saved.tabs ?? []);
      setActiveTabId(saved.activeTabId ?? null);
      setSettings({ ...defaultSettings, ...(saved.settings ?? {}) });
    } else {
      setFiles(SAMPLE_PROJECT);
    }
    const sw = localStorage.getItem('vsc-ide-sidebar-width');
    if (sw) setSidebarWidth(Number(sw));
    const ph = localStorage.getItem('vsc-ide-panel-height');
    if (ph) setPanelHeight(Number(ph));
  }, []);

  // Auto-save workspace whenever state changes
  useEffect(() => {
    if (files.length > 0) {
      saveWorkspace({ files, tabs, activeTabId, settings });
    }
  }, [files, tabs, activeTabId, settings]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ── File operations ────────────────────────────────────────────────────────

  const handleFileClick = useCallback(
    (id: string) => {
      const node = findById(filesRef.current, id);
      if (!node || node.type !== 'file') return;
      const filePath = getPath(filesRef.current, id);
      const existing = tabsRef.current.find((t) => t.filePath === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const newTab: Tab = {
        id: generateId(),
        name: node.name,
        content: node.content ?? '',
        language: getLanguage(node.name),
        isUnsaved: false,
        filePath,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    },
    [],
  );

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabIdRef.current === tabId) {
        const nextTab = next[idx] ?? next[idx - 1] ?? null;
        setActiveTabId(nextTab?.id ?? null);
      }
      return next;
    });
    setCloseConfirm(null);
  }, []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.isUnsaved) {
        setCloseConfirm({ tabId });
        return;
      }
      closeTab(tabId);
    },
    [closeTab],
  );

  const handleSave = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, isUnsaved: false } : t)));
    setFiles((prev) => patchFileContent(prev, tab.filePath, tab.content, false));
  }, []);

  const handleEditorChange = useCallback((value: string) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, content: value, isUnsaved: true } : t)),
    );
    setFiles((prev) => patchFileContent(prev, tab.filePath, value, true));
  }, []);

  const handleCreateFile = useCallback((name: string, parentId: string | null) => {
    setFiles((prev) => addNode(prev, parentId, createFile(name)));
  }, []);

  const handleCreateFolder = useCallback((name: string, parentId: string | null) => {
    setFiles((prev) => addNode(prev, parentId, createFolder(name)));
  }, []);

  const handleDeleteNode = useCallback((id: string) => {
    const node = findById(filesRef.current, id);
    if (node) {
      const path = getPath(filesRef.current, id);
      setTabs((prev) => {
        const filtered = prev.filter(
          (t) => t.filePath !== path && !t.filePath.startsWith(`${node.name}/`),
        );
        if (filtered.length !== prev.length) {
          setActiveTabId((aid) => (filtered.find((t) => t.id === aid) ? aid : filtered[0]?.id ?? null));
        }
        return filtered;
      });
    }
    setFiles((prev) => deleteNode(prev, id));
  }, []);

  const handleRenameNode = useCallback((id: string, newName: string) => {
    setFiles((prev) => {
      function rename(nodes: FileNode[]): FileNode[] {
        return nodes.map((n) => {
          if (n.id === id) return { ...n, name: newName };
          if (n.children) return { ...n, children: rename(n.children) };
          return n;
        });
      }
      return rename(prev);
    });
  }, []);

  // ── Run / preview ──────────────────────────────────────────────────────────

  const handleToggleRun = useCallback(() => {
    setIsRunning((prev) => !prev);
    setShowRightPanel(true);
    setRightPanelMode('preview');
  }, []);

  const handleConsoleMessage = useCallback((msg: Omit<ConsoleMsg, 'id' | 'ts'>) => {
    setConsoleMessages((prev) => [
      ...prev,
      { ...msg, id: generateId(), ts: new Date() },
    ]);
    // Auto-open terminal when console messages arrive
    setShowTerminal(true);
  }, []);

  // ── Activity bar ───────────────────────────────────────────────────────────

  const handleViewChange = useCallback(
    (view: ActivityView) => {
      if (view === 'fleet') {
        setActiveView((prev) => (prev === 'fleet' ? 'explorer' : 'fleet'));
        return;
      }
      if (view === 'run') {
        handleToggleRun();
        return;
      }
      if (view === 'settings') {
        if (activeView === 'settings') {
          setActiveView(null);
        } else {
          setActiveView('settings');
        }
        return;
      }
      if (SIDEBAR_VIEWS.includes(view)) {
        setActiveView((prev) => (prev === view ? null : view));
      }
    },
    [activeView, handleToggleRun],
  );

  // ── Export ─────────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    await exportZip(filesRef.current);
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        const tabId = activeTabIdRef.current;
        if (tabId) handleSave(tabId);
        return;
      }
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        setActiveView((prev) => (prev === 'explorer' ? null : 'explorer'));
        return;
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setShowTerminal((prev) => !prev);
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        handleToggleRun();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleToggleRun]);

  // ── Sidebar resize ─────────────────────────────────────────────────────────

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(120, Math.min(600, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
      localStorage.setItem('vsc-ide-sidebar-width', String(newWidth));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Panel resize ───────────────────────────────────────────────────────────

  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeight;
    const onMove = (ev: MouseEvent) => {
      // Dragging up increases panel height (inverted delta)
      const newHeight = Math.max(80, Math.min(500, startHeight + (startY - ev.clientY)));
      setPanelHeight(newHeight);
      localStorage.setItem('vsc-ide-panel-height', String(newHeight));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Derived values ─────────────────────────────────────────────────────────

  const breadcrumbs = activeTab ? activeTab.filePath.split('/') : [];

  const activeFileId = activeTab
    ? (findByPath(files, activeTab.filePath)?.id ?? null)
    : null;

  const viewTitle: Record<string, string> = {
    explorer: 'EXPLORER',
    search: 'SEARCH',
    git: 'SOURCE CONTROL',
    extensions: 'EXTENSIONS',
    settings: 'SETTINGS',
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <TitleBar
        title={
          activeView === 'fleet'
            ? 'Fleet Console — AI Agent Manager'
            : activeTab
            ? `${activeTab.name} — Web IDE`
            : 'Web IDE'
        }
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

      {/* Fleet Console mode — full-width, no IDE activity bar */}
      {activeView === 'fleet' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <FleetConsole onSwitchToEditor={() => handleViewChange('explorer')} />
        </div>
      )}

      {/* Code Editor mode */}
      {activeView !== 'fleet' && (
        <>
        <div className="workbench">
        <ActivityBar
          activeView={activeView}
          onViewChange={handleViewChange}
          onGitHub={() => setShowGist(true)}
          onExport={handleExport}
          isRunning={isRunning}
        />

        {activeView && (
          <div className="sidebar" style={{ width: sidebarWidth }}>
            <div className="sb-header">
              {viewTitle[activeView] ?? activeView.toUpperCase()}
            </div>
            <div className="sb-body">
              {activeView === 'explorer' && (
                <FileExplorer
                  files={files}
                  onFileClick={handleFileClick}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                  onDelete={handleDeleteNode}
                  onRename={handleRenameNode}
                  activeFileId={activeFileId}
                />
              )}
              {activeView === 'search' && (
                <SearchPanel files={files} onFileClick={handleFileClick} />
              )}
              {activeView === 'git' && (
                <div className="p16">
                  <p style={{ marginBottom: 12, opacity: 0.7, fontSize: 13, lineHeight: 1.5 }}>
                    Use GitHub Gist to sync your workspace to the cloud.
                  </p>
                  <button className="btn" onClick={() => setShowGist(true)}>
                    Open GitHub Gist
                  </button>
                </div>
              )}
              {activeView === 'extensions' && (
                <div className="p16">
                  <div className="settings-group">
                    <div className="settings-group-title">Built-in Capabilities</div>
                    {[
                      'Monaco Code Editor',
                      'Syntax Highlighting (30+ languages)',
                      'IntelliSense & Autocomplete',
                      'Code Folding & Minimap',
                      'Multi-cursor Editing',
                      'Live HTML Preview',
                      'Console Output Panel',
                      'File Tree Explorer',
                      'Global Text Search',
                      'GitHub Gist Sync',
                      'ZIP Export',
                      'Dark / Light Theme',
                      'Persistent Workspace (localStorage)',
                    ].map((cap) => (
                      <div
                        key={cap}
                        style={{
                          padding: '5px 0',
                          fontSize: 13,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ color: '#4ec9b0', fontSize: 10, flexShrink: 0 }}>●</span>
                        {cap}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {activeView === 'settings' && (
                <SettingsPanel
                  settings={settings}
                  onSettingsChange={(partial) =>
                    setSettings((prev) => ({ ...prev, ...partial }))
                  }
                  theme={theme}
                  onToggleTheme={onToggleTheme}
                />
              )}
            </div>
            <div className="sb-resize" onMouseDown={startSidebarResize} />
          </div>
        )}

        <div className="editor-area">
          <EditorTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={setActiveTabId}
            onTabClose={handleTabClose}
            onToggleRun={handleToggleRun}
            isRunning={isRunning}
            onToggleTerminal={() => setShowTerminal((p) => !p)}
          />

          {activeTab && (
            <div className="breadcrumb">
              {breadcrumbs.map((part, i) => (
                <span key={i}>
                  {i > 0 && <span className="bc-sep">/</span>}
                  <span
                    className={
                      i === breadcrumbs.length - 1 ? 'bc-item bc-active' : 'bc-item'
                    }
                  >
                    {part}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="editor-content">
            <div className="editor-main">
              {activeTab ? (
                <MonacoEditor
                  value={activeTab.content}
                  language={activeTab.language}
                  onChange={handleEditorChange}
                  onSave={() => handleSave(activeTabId!)}
                  onCursorChange={(line, col) => {
                    setCursorLine(line);
                    setCursorCol(col);
                  }}
                  fontSize={settings.fontSize}
                  tabSize={settings.tabSize}
                  wordWrap={settings.wordWrap}
                  minimap={settings.minimap}
                  theme={theme}
                />
              ) : (
                <div className="welcome">
                  <div className="welcome-title">Web IDE</div>
                  <div className="welcome-sub">
                    A VS Code-like editor in your browser
                  </div>
                  <div className="welcome-keys">
                    <div>Ctrl+B — Toggle Explorer</div>
                    <div>Ctrl+` — Toggle Terminal</div>
                    <div>F5 — Toggle Preview</div>
                    <div>Ctrl+S — Save File</div>
                    <div>Ctrl+Shift+F — Format Document</div>
                  </div>
                </div>
              )}
            </div>

            {showRightPanel && (
              <div className="right-panel" style={{ width: 420 }}>
                <div className="right-panel-hdr">
                  <span>{rightPanelMode === 'preview' ? 'Preview' : 'Settings'}</span>
                  <button
                    className="icon-btn"
                    onClick={() => setShowRightPanel(false)}
                    style={{ marginLeft: 'auto' }}
                  >
                    <X size={14} />
                  </button>
                </div>
                {rightPanelMode === 'preview' ? (
                  <PreviewPanel
                    files={files}
                    isRunning={isRunning}
                    onToggleRun={handleToggleRun}
                    onConsoleMessage={handleConsoleMessage}
                  />
                ) : (
                  <SettingsPanel
                    settings={settings}
                    onSettingsChange={(partial) =>
                      setSettings((prev) => ({ ...prev, ...partial }))
                    }
                    theme={theme}
                    onToggleTheme={onToggleTheme}
                  />
                )}
              </div>
            )}
          </div>

          {showTerminal && (
            <>
              <div className="hresize" onMouseDown={startPanelResize} />
              <div className="panel" style={{ height: panelHeight }}>
                <div className="panel-tabs">
                  <div className="panel-tab active">Console</div>
                  <button
                    className="panel-close icon-btn"
                    onClick={() => setShowTerminal(false)}
                    title="Close Terminal"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="panel-body" style={{ height: panelHeight - 32 }}>
                  <TerminalPanel
                    messages={consoleMessages}
                    onClear={() => setConsoleMessages([])}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <StatusBar
        activeTab={activeTab}
        fileCount={countFiles(files)}
        cursorLine={cursorLine}
        cursorCol={cursorCol}
      />
        </> )} {/* end editor-only section */}

      <GitHubGist
        isOpen={showGist}
        onClose={() => setShowGist(false)}
        files={files}
        onLoadFiles={(loadedFiles) => {
          setFiles(loadedFiles);
          setShowGist(false);
        }}
      />

      {/* Unsaved-changes close confirmation */}
      {closeConfirm && (
        <div className="modal-overlay">
          <div
            className="modal-box"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 360 }}
          >
            <div className="modal-hdr">Unsaved Changes</div>
            <div className="modal-body">
              <p style={{ fontSize: 13 }}>
                This file has unsaved changes. Close without saving?
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn secondary"
                onClick={() => setCloseConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => closeTab(closeConfirm.tabId)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
