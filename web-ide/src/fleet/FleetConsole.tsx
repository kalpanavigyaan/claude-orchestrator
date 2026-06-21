/**
 * FleetConsole — full VS Code-like layout wiring together all fleet panels.
 *
 * Layout (exact match to fleet-console-electron):
 *   TitleBar (handled by outer shell)
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ActBar │ Left Sidebar (3 panes) │ Chat │ Right │ RightAB │
 *   └──────────────────────────────────────────────────────────┘
 *   StatusBar
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Clock, Settings } from 'lucide-react';

import { openSSE, apiGet, fmtCountdown } from './api';
import type { FleetState, ChatMessage, HistorySession, RightPanel, UsageTab } from './types';

import SessionsPane   from './SessionsPane';
import HistoryPane    from './HistoryPane';
import ControlsPane   from './ControlsPane';
import ChatView       from './ChatView';
import { FleetStatusBar } from './StatusBar';
import UsagePanel       from './UsagePanel';
import IntelligencePanel from './IntelligencePanel';
import CommandsPanel    from './CommandsPanel';
import ReposPanel       from './ReposPanel';
import DirectoriesPanel from './DirectoriesPanel';
import QueuePanel       from './QueuePanel';
import VMsPanel         from './VMsPanel';
import RightActivityBar     from './RightActivityBar';
import SkillsPanel          from './SkillsPanel';
import InstructionsLibPanel from './InstructionsLibPanel';
import type { SessionPrefill } from './NewSessionModal';
import NewSessionModal   from './NewSessionModal';
import { ApprovalModal }     from './ApprovalModal';
import InstructionsModal from './InstructionsModal';
import SetResetModal     from './SetResetModal';
import SettingsModal     from './SettingsModal';
import { applySettingsOnLoad } from './settings';
import SessionTabBar, { SplitDropZones } from './SessionTabBar';

// Default dimensions from settings.json (fleet-console-electron)
const DEFAULTS = {
  sidebarW:  260,   // sidebar.width
  rSidebarW: 300,   // sidebar.right.width
  sessH:     180,   // sidebar.sessions.height
  ctrlH:     230,   // sidebar.controls.height
  rightPanel: 'usage' as RightPanel,        // sidebar.right.defaultPanel
  usageTab:   'overview' as UsageTab,       // sidebar.right.usage.defaultTab
};

// Per-panel accent colours for varied sidebar headers
const PANEL_ACCENT: Record<RightPanel, string> = {
  usage:        '#4ade80',  // green
  vms:          '#fbbf24',  // amber
  intelligence: '#c678dd',  // purple
  commands:     '#61afef',  // blue
  repos:        '#e5c07b',  // gold
  directories:  '#56b6c2',  // cyan
  queue:        '#f97316',  // orange
  skills:       '#38bdf8',  // sky blue
  instructions: '#a78bfa',  // violet
};

const LS_SIDEBAR_W   = 'fleet-sidebar-w';
const LS_RSIDEBAR_W  = 'fleet-rsidebar-w';
const LS_SESS_H      = 'fleet-sess-h';
const LS_CTRL_H      = 'fleet-ctrl-h';

export function FleetConsole({ onSwitchToEditor }: { onSwitchToEditor?: () => void }) {
  // ── Fleet state (SSE) ────────────────────────────────────────────────────
  const [fleetState, setFleetState]       = useState<FleetState | null>(null);
  const [connected, setConnected]         = useState(false);
  const clockOffsetRef                    = useRef(0);

  // ── Selection ────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [viewingHistRel, setViewingHistRel] = useState<string | null>(null);
  const [histMessages, setHistMessages]   = useState<ChatMessage[]>([]);
  const [histLoading, setHistLoading]     = useState(false);
  const [histLabel, setHistLabel]         = useState('');
  // Optimistic label overrides: updated immediately on rename, cleared when SSE confirms new label
  const [labelOverrides, setLabelOverrides] = useState<Map<string, string>>(new Map());

  // ── Right sidebar ─────────────────────────────────────────────────────────
  const [rightPanel, setRightPanel]       = useState<RightPanel>(DEFAULTS.rightPanel);
  const [usageTab, setUsageTab]           = useState<UsageTab>(DEFAULTS.usageTab);

  // ── Modal states ──────────────────────────────────────────────────────────
  const [showNewSession, setShowNewSession]   = useState(false);
  const [sessionPrefill, setSessionPrefill]   = useState<SessionPrefill | undefined>();
  const [showReset, setShowReset]             = useState(false);
  const [showSettings, setShowSettings]       = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [approvalData, setApprovalData]       = useState<{id:string;tool?:string;input?:unknown;description?:string}|null>(null);

  // ── Resize state — initialised from localStorage, fallback to settings.json defaults ──
  const [sidebarW, setSidebarW] = useState(() => parseInt(localStorage.getItem(LS_SIDEBAR_W)  || '') || DEFAULTS.sidebarW);
  const [rSidebarW, setRSidebarW] = useState(() => parseInt(localStorage.getItem(LS_RSIDEBAR_W) || '') || DEFAULTS.rSidebarW);
  const [sessH, setSessH] = useState(() => parseInt(localStorage.getItem(LS_SESS_H) || '') || DEFAULTS.sessH);
  const [ctrlH, setCtrlH] = useState(() => parseInt(localStorage.getItem(LS_CTRL_H) || '') || DEFAULTS.ctrlH);

  const resizing = useRef<{type:string; startX:number; startY:number; startVal:number} | null>(null);

  // ── Tab / split-pane state ────────────────────────────────────────────────
  // tabOrder: session IDs with an open tab (auto-added on session create, closed by X)
  const [tabOrder, setTabOrder]           = useState<string[]>([]);
  // Split layout: 'single' | 'h-split' (side by side) | 'v-split' (top/bottom)
  const [splitLayout, setSplitLayout]     = useState<'single' | 'h-split' | 'v-split'>('single');
  // Which session each pane shows (main = primary, sec = secondary)
  const [mainSession, setMainSession]     = useState<string | null>(null);
  const [secSession, setSecSession]       = useState<string | null>(null);
  // Split ratio (0–1 = how much space main pane gets)
  const [splitRatio, setSplitRatio]       = useState(0.5);
  const splitResizing                     = useRef<{ startX: number; startY: number; startRatio: number } | null>(null);
  // Which pane is "focused" (receives new tab clicks)
  const [focusedPane, setFocusedPane]     = useState<'main' | 'sec'>('main');
  // Drag state for tab drag-and-drop
  const [draggingTab, setDraggingTab]     = useState<string | null>(null);

  // ── Connect to orchestrator SSE ───────────────────────────────────────────
  useEffect(() => {
    applySettingsOnLoad();
    let es: EventSource;
    function connect() {
      es = openSSE('/api/events', (data: unknown) => {
        const d = data as FleetState & { now?: number };
        if (d.now) clockOffsetRef.current = d.now - Date.now();
        // Clear label overrides for sessions whose label now matches the server value
        setLabelOverrides(prev => {
          if (prev.size === 0) return prev;
          const next = new Map(prev);
          for (const s of (d.sessions ?? [])) {
            if (next.get(s.id) === s.label) next.delete(s.id);
          }
          return next.size === prev.size ? prev : next;
        });
        setFleetState(d);
        setConnected(true);
        // Auto-add new sessions to tab bar; only remove tabs for sessions fully gone from orchestrator.
        // Keep ended sessions in tabs so user can see the result — closed by X or by session disappearing.
        setTabOrder(prev => {
          const allIds = new Set((d.sessions ?? []).map(s => s.id));
          const kept = prev.filter(id => allIds.has(id)); // keep tabs for sessions still in orchestrator
          const newIds = (d.sessions ?? [])
            .filter(s => s.status !== 'ended' && !prev.includes(s.id))
            .map(s => s.id);
          return newIds.length || kept.length !== prev.length ? [...kept, ...newIds] : prev;
        });
      }, () => {
        setConnected(false);
        setTimeout(connect, 3000);
      });
    }
    connect();
    return () => es?.close();
  }, []);

  // ── Custom events from child components ──────────────────────────────────
  useEffect(() => {
    const onInstr = () => setShowInstructions(true);
    const onApproval = (e: Event) => setApprovalData((e as CustomEvent).detail);
    const onInsertCmd = (e: Event) => {
      document.dispatchEvent(new CustomEvent('fleet:composer-insert', { detail: (e as CustomEvent).detail }));
    };
    const onNewSession = () => setShowNewSession(true);
    document.addEventListener('fleet:open-instructions', onInstr);
    document.addEventListener('fleet:approval', onApproval);
    document.addEventListener('fleet:insert-command', onInsertCmd);
    document.addEventListener('fleet:new-session', onNewSession);
    return () => {
      document.removeEventListener('fleet:open-instructions', onInstr);
      document.removeEventListener('fleet:approval', onApproval);
      document.removeEventListener('fleet:insert-command', onInsertCmd);
      document.removeEventListener('fleet:new-session', onNewSession);
    };
  }, []);

  // When sidebar session selection changes → show in the focused pane
  useEffect(() => {
    if (!selectedId) return;
    if (focusedPane === 'sec' && splitLayout !== 'single') {
      setSecSession(selectedId);
    } else {
      setMainSession(selectedId);
      setFocusedPane('main');
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tab click
  function handleTabSelect(id: string) {
    setSelectedId(id);
    setViewingHistRel(null);
    // Ensure tab exists (e.g. selected from sidebar)
    setTabOrder(prev => prev.includes(id) ? prev : [...prev, id]);
    if (focusedPane === 'sec' && splitLayout !== 'single') {
      setSecSession(id);
    } else {
      setMainSession(id);
    }
  }

  // Tab close (remove from tab bar, don't end session)
  function handleTabClose(id: string) {
    setTabOrder(prev => prev.filter(t => t !== id));
    if (mainSession === id) setMainSession(tabOrder.find(t => t !== id) ?? null);
    if (secSession === id) { setSecSession(null); if (splitLayout !== 'single') setSplitLayout('single'); }
    if (selectedId === id) setSelectedId(null);
  }

  // Drop zone handler (from drag-and-drop)
  function handleDrop(paneId: 'main' | 'sec', zone: 'center' | 'left' | 'right' | 'top' | 'bottom') {
    if (!draggingTab) return;
    if (zone === 'center') {
      if (paneId === 'main') { setMainSession(draggingTab); setFocusedPane('main'); }
      else { setSecSession(draggingTab); setFocusedPane('sec'); }
    } else if (zone === 'left' || zone === 'right') {
      setSplitLayout('h-split');
      if (zone === 'left') { setSecSession(mainSession); setMainSession(draggingTab); setFocusedPane('main'); }
      else { setSecSession(draggingTab); setFocusedPane('sec'); }
    } else {
      setSplitLayout('v-split');
      if (zone === 'top') { setSecSession(mainSession); setMainSession(draggingTab); setFocusedPane('main'); }
      else { setSecSession(draggingTab); setFocusedPane('sec'); }
    }
    setSelectedId(draggingTab);
    setViewingHistRel(null);
    setDraggingTab(null);
  }

  // Close secondary pane
  function closeSecPane() {
    setSplitLayout('single');
    setSecSession(null);
    setFocusedPane('main');
  }

  const handleSelectHistory = useCallback(async (rel: string, sessions: HistorySession[]) => {
    setSelectedId(null);
    setViewingHistRel(rel);
    setHistMessages([]);        // clear stale messages immediately
    setHistLoading(true);       // show loading indicator
    const found = sessions.find(s => s.rel === rel);
    setHistLabel(found?.label || rel);
    // Load transcript via the correct endpoint (mirrors electron viewHistoryItem)
    const data = await apiGet(`/api/history/item?path=${encodeURIComponent(rel)}`);
    setHistLoading(false);
    const interactions = data?.meta?.interactions ?? data?.interactions ?? [];
    if (interactions.length > 0) {
      // Map session.json field names to ChatMessage interface
      const msgs = interactions.map((m: Record<string, unknown>) => ({
        role:  (m.role as string) || 'system',
        text:  (m.text as string) ?? (m.tool as string) ?? '',
        ts:    typeof m.ts === 'number' ? m.ts : (m.ts ? Date.parse(String(m.ts)) : 0),
        name:  (m.tool as string) ?? null,
        input: m.input ?? null,
      }));
      setHistMessages(msgs);
    } else if (data?.markdown) {
      setHistMessages([{ role: 'assistant', text: data.markdown, ts: 0 }]);
    } else if (data === null) {
      setHistMessages([{ role: 'system', text: 'Failed to load transcript — the orchestrator may need restarting.', ts: 0 }]);
    } else {
      setHistMessages([{ role: 'system', text: 'No conversation content found in this session.', ts: 0 }]);
    }
  }, []);

  const handleResumeHistory = useCallback(async (id: string) => {
    setSelectedId(id);
    setViewingHistRel(null);
    setHistMessages([]);
  }, []);

  // ── Optimistic rename callback (live sessions) ────────────────────────────
  const handleRenameSession = useCallback((id: string, newLabel: string) => {
    setLabelOverrides(prev => new Map(prev).set(id, newLabel));
  }, []);

  // ── Optimistic rename callback (history sessions) ─────────────────────────
  const handleRenameHistory = useCallback((rel: string, newLabel: string) => {
    // If we're currently viewing this history item, update its label too
    if (viewingHistRel === rel) setHistLabel(newLabel);
  }, [viewingHistRel]);

  // ── Copy history session → open NewSessionModal pre-filled ───────────────
  const handleCopyHistory = useCallback(async (s: import('./types').HistorySession) => {
    const data = await apiGet(`/api/history/item?path=${encodeURIComponent(s.rel)}`);
    const meta = data?.meta ?? {};
    // Default label: YYYY-MM-DD: <repo-name>
    const today = new Date().toISOString().slice(0, 10);
    const repoName = (meta.cwd as string | undefined)
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() ?? s.repo ?? s.label ?? 'session';
    setSessionPrefill({
      label:                `${today}: ${repoName}`,
      cwd:                  meta.cwd        ?? undefined,
      host:                 meta.host       ?? 'local',
      distro:               meta.distro     ?? undefined,
      model:                meta.model      ?? undefined,
      mode:                 meta.mode       ?? undefined,
      effort:               meta.effort     ?? undefined,
      thinking:             meta.thinking   ?? undefined,
      browser:              meta.browser    ?? undefined,
      autoContinue:         meta.autoContinue ?? true,
      additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : undefined,
    });
    setShowNewSession(true);
  }, []);

  // ── Resize logic ──────────────────────────────────────────────────────────
  const startResize = (type: string, x: number, y: number, val: number) => {
    resizing.current = { type, startX: x, startY: y, startVal: val };
    document.body.style.cursor = type.includes('col') ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      // Split pane resize
      const sr = splitResizing.current;
      if (sr) {
        if (splitLayout === 'h-split') {
          const chatEl = document.getElementById('fleet-chat-area');
          if (chatEl) {
            const rect = chatEl.getBoundingClientRect();
            const ratio = Math.max(0.2, Math.min(0.8, (e.clientX - rect.left) / rect.width));
            setSplitRatio(ratio);
          }
        } else if (splitLayout === 'v-split') {
          const chatEl = document.getElementById('fleet-chat-area');
          if (chatEl) {
            const rect = chatEl.getBoundingClientRect();
            const ratio = Math.max(0.2, Math.min(0.8, (e.clientY - rect.top) / rect.height));
            setSplitRatio(ratio);
          }
        }
        return;
      }
      const r = resizing.current;
      if (!r) return;
      if (r.type === 'col-left') {
        const w = Math.max(180, Math.min(500, r.startVal + e.clientX - r.startX));
        setSidebarW(w); localStorage.setItem(LS_SIDEBAR_W, String(w));
      } else if (r.type === 'col-right') {
        const w = Math.max(200, Math.min(600, r.startVal + r.startX - e.clientX));
        setRSidebarW(w); localStorage.setItem(LS_RSIDEBAR_W, String(w));
      } else if (r.type === 'row-sess') {
        const h = Math.max(80, Math.min(400, r.startVal + e.clientY - r.startY));
        setSessH(h); localStorage.setItem(LS_SESS_H, String(h));
      } else if (r.type === 'row-ctrl') {
        const h = Math.max(80, Math.min(400, r.startVal + r.startY - e.clientY));
        setCtrlH(h); localStorage.setItem(LS_CTRL_H, String(h));
      }
    };
    const up = () => {
      resizing.current = null;
      splitResizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // Apply label overrides to session objects before passing to children
  const sessionsWithOverrides = (fleetState?.sessions ?? []).map(s =>
    labelOverrides.has(s.id) ? { ...s, label: labelOverrides.get(s.id)! } : s
  );
  const selectedSession = sessionsWithOverrides.find(s => s.id === selectedId) ?? null;
  const countdown = fleetState?.account?.resetAt ? fmtCountdown(fleetState.account.resetAt) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* ── Fleet Activity Bar (slim, matches electron app) ─────────────── */}
        <nav style={{
          width: 40, flexShrink: 0,
          background: 'var(--ab-bg)', borderRight: '1px solid var(--ab-border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '4px 0', zIndex: 10,
        }}>
          {/* Switch back to editor (code icon) */}
          {onSwitchToEditor && (
            <button
              className="ab-btn" title="Back to Editor"
              onClick={onSwitchToEditor}
              style={{ width: 40, height: 40, borderBottom: '1px solid var(--ab-border)', marginBottom: 4 }}
            >
              <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M4 8h8M10 5l3 3-3 3"/>
                <rect x="1" y="3" width="6" height="10" rx="1"/>
              </svg>
              <span className="ab-tip">Back to Editor</span>
            </button>
          )}
          {/* New Session */}
          <button className="ab-btn" title="New Session (Ctrl+N)" onClick={() => setShowNewSession(true)} style={{ width: 40, height: 40 }}>
            <Plus size={20} strokeWidth={1.5} />
            <span className="ab-tip">New Session</span>
          </button>
          {/* Set Account Reset Time */}
          <button className="ab-btn" title="Set Account Reset Time" onClick={() => setShowReset(true)} style={{ width: 40, height: 40 }}>
            <Clock size={18} strokeWidth={1.5} />
            <span className="ab-tip">Set Reset Time</span>
          </button>
          {/* Spacer */}
          <div style={{ flex: 1 }} />
          {/* Countdown */}
          {countdown !== '—' && (
            <div style={{
              fontSize: 9, color: 'var(--muted)', textAlign: 'center',
              padding: '2px', lineHeight: 1.2, width: 38, wordBreak: 'break-all',
            }} title="Account reset countdown">
              {countdown}
            </div>
          )}
          {/* Settings */}
          <button className="ab-btn" title="Settings" style={{ width: 40, height: 40 }} onClick={() => setShowSettings(true)}>
            <Settings size={18} strokeWidth={1.5} />
            <span className="ab-tip">Settings</span>
          </button>
        </nav>

        {/* ── Left Sidebar (3 panes, each resizable) ────────────────────── */}
        <div style={{
          width: sidebarW, flexShrink: 0, background: 'var(--sb-bg)',
          borderRight: '1px solid var(--sb-border)', display: 'flex',
          flexDirection: 'column', overflow: 'hidden', position: 'relative',
        }}>
          {/* Active Sessions pane */}
          <div style={{ height: sessH, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="sb-header" style={{ padding: '6px 8px 4px 12px', borderLeft: '3px solid #4ade80', color: '#4ade80' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Active Sessions
                {(fleetState?.sessions?.length ?? 0) > 0 && (
                  <span className="badge">{fleetState!.sessions.length}</span>
                )}
              </span>
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <SessionsPane
                sessions={sessionsWithOverrides}
                selectedId={selectedId}
                onSelect={(id) => { handleTabSelect(id); }}
                resetAt={fleetState?.account?.resetAt}
                onRename={handleRenameSession}
              />
            </div>
          </div>

          {/* Resize bar (sessions / history) */}
          <div
            style={{ height: 4, cursor: 'row-resize', flexShrink: 0, background: 'var(--border)' }}
            onMouseDown={e => startResize('row-sess', e.clientX, e.clientY, sessH)}
          />

          {/* Session History pane (grows) */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 60 }}>
            <HistoryPane
              onSelectHistory={handleSelectHistory}
              onResume={handleResumeHistory}
              onRename={handleRenameHistory}
              onCopySession={handleCopyHistory}
            />
          </div>

          {/* Resize bar (history / controls) */}
          <div
            style={{ height: 4, cursor: 'row-resize', flexShrink: 0, background: 'var(--border)' }}
            onMouseDown={e => startResize('row-ctrl', e.clientX, e.clientY, ctrlH)}
          />

          {/* Controls pane */}
          <div style={{ height: ctrlH, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="sb-header" style={{ padding: '6px 8px 4px 12px', borderLeft: '3px solid #e5c07b', color: '#e5c07b' }}>
              Controls
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <ControlsPane
                session={selectedSession}
                models={fleetState?.models ?? []}
                viewingHistoryRel={viewingHistRel}
                onHistoryResume={handleResumeHistory}
              />
            </div>
          </div>

          {/* Sidebar resize handle (right edge) */}
          <div
            className="sb-resize"
            onMouseDown={e => startResize('col-left', e.clientX, e.clientY, sidebarW)}
          />
        </div>

        {/* ── Chat / Editor Area ─────────────────────────────────────────── */}
        <div id="fleet-chat-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Session tab bar — all open sessions */}
          <SessionTabBar
            sessions={sessionsWithOverrides}
            tabOrder={tabOrder}
            activePaneId={focusedPane === 'main' ? mainSession : secSession}
            onSelect={handleTabSelect}
            onClose={handleTabClose}
            onDragStart={id => setDraggingTab(id)}
            onDragEnd={() => setDraggingTab(null)}
          />

          {/* Split pane area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: splitLayout === 'v-split' ? 'column' : 'row', overflow: 'hidden', minHeight: 0 }}>

            {/* Main pane */}
            <div
              style={{ position: 'relative', display: 'flex', flexDirection: 'column',
                flex: splitLayout === 'single' ? 1 : undefined,
                flexBasis: splitLayout !== 'single' ? `${splitRatio * 100}%` : undefined,
                overflow: 'hidden', minWidth: 0, minHeight: 0,
                outline: focusedPane === 'main' && splitLayout !== 'single' ? '1px solid var(--accent)' : 'none',
              }}
              onClick={() => setFocusedPane('main')}
            >
              <ChatView
                sessionId={mainSession}
                session={sessionsWithOverrides.find(s => s.id === mainSession) ?? null}
                isViewingHistory={viewingHistRel !== null && selectedId === mainSession}
                historyMessages={mainSession === selectedId ? histMessages : []}
                historyLabel={histLabel}
                historyLoading={mainSession === selectedId ? histLoading : false}
              />
              {draggingTab && <SplitDropZones paneId="main" onDrop={handleDrop} />}
            </div>

            {/* Split resize handle */}
            {splitLayout !== 'single' && (
              <div
                style={{
                  background: 'var(--border)', flexShrink: 0,
                  width: splitLayout === 'h-split' ? 4 : '100%',
                  height: splitLayout === 'v-split' ? 4 : '100%',
                  cursor: splitLayout === 'h-split' ? 'col-resize' : 'row-resize',
                }}
                onMouseDown={() => {
                  splitResizing.current = { startX: 0, startY: 0, startRatio: splitRatio };
                  document.body.style.cursor = splitLayout === 'h-split' ? 'col-resize' : 'row-resize';
                  document.body.style.userSelect = 'none';
                }}
              />
            )}

            {/* Secondary pane */}
            {splitLayout !== 'single' && (
              <div
                style={{ position: 'relative', display: 'flex', flexDirection: 'column',
                  flex: 1, overflow: 'hidden', minWidth: 0, minHeight: 0,
                  outline: focusedPane === 'sec' ? '1px solid var(--accent)' : 'none',
                  borderTop: splitLayout === 'v-split' ? '1px solid var(--border)' : 'none',
                  borderLeft: splitLayout === 'h-split' ? '1px solid var(--border)' : 'none',
                }}
                onClick={() => setFocusedPane('sec')}
              >
                {/* Close secondary pane button */}
                <button
                  onClick={e => { e.stopPropagation(); closeSecPane(); }}
                  title="Close split"
                  style={{ position: 'absolute', top: 4, right: 6, zIndex: 10,
                    background: 'rgba(0,0,0,.4)', border: 'none', color: 'var(--muted)',
                    cursor: 'pointer', borderRadius: 3, padding: '1px 5px', fontSize: 11 }}
                >✕</button>
                <ChatView
                  sessionId={secSession}
                  session={sessionsWithOverrides.find(s => s.id === secSession) ?? null}
                  isViewingHistory={viewingHistRel !== null && selectedId === secSession}
                  historyMessages={secSession === selectedId ? histMessages : []}
                  historyLabel={histLabel}
                  historyLoading={secSession === selectedId ? histLoading : false}
                />
                {draggingTab && <SplitDropZones paneId="sec" onDrop={handleDrop} />}
              </div>
            )}
          </div>
        </div>

        {/* ── Right Sidebar ──────────────────────────────────────────────── */}
        <div style={{
          width: rSidebarW, flexShrink: 0, background: 'var(--sb-bg)',
          borderLeft: '1px solid var(--sb-border)', display: 'flex',
          flexDirection: 'column', overflow: 'hidden', position: 'relative',
        }}>
          <div className="sb-header" style={{
            padding: '6px 8px 4px 12px', textTransform: 'uppercase', letterSpacing: '.05em',
            borderLeft: `3px solid ${PANEL_ACCENT[rightPanel]}`,
            color: PANEL_ACCENT[rightPanel],
          }}>
            {rightPanel === 'usage' && 'Usage Statistics'}
            {rightPanel === 'vms' && 'Virtual Machines'}
            {rightPanel === 'intelligence' && 'Intelligence'}
            {rightPanel === 'commands' && 'Commands'}
            {rightPanel === 'repos' && 'Repositories'}
            {rightPanel === 'directories' && 'Directories'}
            {rightPanel === 'queue' && 'Instruction Queue'}
            {rightPanel === 'skills' && 'Skills Library'}
            {rightPanel === 'instructions' && 'Instructions'}
          </div>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {rightPanel === 'usage' && (
              <UsagePanel fleetState={fleetState} activeTab={usageTab} onTabChange={setUsageTab} />
            )}
            {rightPanel === 'intelligence' && (
              <IntelligencePanel fleetState={fleetState} selectedId={selectedId} />
            )}
            {rightPanel === 'commands' && (
              <CommandsPanel selectedId={selectedId} />
            )}
            {rightPanel === 'repos' && (
              <ReposPanel
                selectedId={selectedId}
                session={selectedSession}
                onStartSession={(cwd, host, distro) => {
                  setSessionPrefill({ cwd, host, distro });
                  setShowNewSession(true);
                }}
              />
            )}
            {rightPanel === 'directories' && (
              <DirectoriesPanel session={selectedSession} />
            )}
            {rightPanel === 'queue' && (
              <QueuePanel session={selectedSession} />
            )}
            {rightPanel === 'vms' && <VMsPanel />}
            {rightPanel === 'skills' && (
              <SkillsPanel selectedId={selectedId} />
            )}
            {rightPanel === 'instructions' && (
              <InstructionsLibPanel selectedId={selectedId} session={selectedSession} />
            )}
          </div>

          {/* Right sidebar resize (left edge) */}
          <div
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 5 }}
            onMouseDown={e => startResize('col-right', e.clientX, e.clientY, rSidebarW)}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--accent)')}
            onMouseOut={e => (e.currentTarget.style.background = '')}
          />
        </div>

        {/* ── Right Activity Bar ─────────────────────────────────────────── */}
        <RightActivityBar activePanel={rightPanel} onPanelChange={setRightPanel} />
      </div>

      {/* ── Status Bar ────────────────────────────────────────────────────── */}
      <FleetStatusBar
        connected={connected}
        fleetState={fleetState}
        selectedId={selectedId}
      />

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <NewSessionModal
        isOpen={showNewSession}
        onClose={() => { setShowNewSession(false); setSessionPrefill(undefined); }}
        onCreated={(id) => { setSelectedId(id); setShowNewSession(false); setSessionPrefill(undefined); }}
        prefill={sessionPrefill}
      />

      <SetResetModal
        isOpen={showReset}
        onClose={() => setShowReset(false)}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />

      <InstructionsModal
        sessionId={selectedId}
        isOpen={showInstructions}
        onClose={() => setShowInstructions(false)}
      />

      <ApprovalModal
        approval={approvalData}
        sessionId={selectedId}
        onResolved={() => setApprovalData(null)}
      />
    </div>
  );
}
