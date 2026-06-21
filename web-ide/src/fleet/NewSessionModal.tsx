import React, { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost } from '../fleet/api';

export interface SessionPrefill {
  cwd?: string;
  host?: string;
  distro?: string;
  label?: string;
  model?: string;
  mode?: string;
  effort?: string;
  thinking?: string;
  browser?: boolean;
  autoContinue?: boolean;
  additionalDirectories?: string[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  prefill?: SessionPrefill;
}

interface Distro { name: string; state: string; default?: boolean; }
interface RepoItem { path: string; name: string; branch?: string | null; changes?: number | null; _host?: string; _distro?: string; }
interface RepoGroup { host: string; distro?: string | null; label?: string; repos: RepoItem[]; stopped?: boolean; }
interface LocalRoot { root: string; repos: { name: string; path: string }[]; }
interface DirEntry { name: string; path: string; isDir: boolean; }
interface BrowseResult { path: string; parent: string | null; entries: DirEntry[]; error?: string; }

const inp: React.CSSProperties = {
  background: 'var(--in-bg)', border: '1px solid var(--in-border)',
  color: 'var(--in-fg)', borderRadius: 3, padding: '5px 8px',
  fontSize: 13, width: '100%', boxSizing: 'border-box', outline: 'none',
  fontFamily: 'inherit',
};
const lbl: React.CSSProperties = {
  fontSize: 10, color: 'var(--muted)', display: 'block',
  marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.05em',
};

// ── Inline repo picker shared by cwd and extra repos ────────────────────────
interface RepoPickerProps {
  groups: RepoGroup[];
  loading: boolean;
  filter: string;
  onFilter: (v: string) => void;
  onPick: (path: string, host: string, distro?: string) => void;
  selectedPaths: string[];
  mode: 'single' | 'multi';
  browserState: {
    show: boolean; path: string; entries: DirEntry[]; parent: string | null;
    loading: boolean; error: string;
  };
  onBrowse: (dir: string) => void;
  onOpenBrowser: (startPath: string, host: string, distro: string) => void;
  onCloseBrowser: () => void;
  browseHost: string;
  browseDistro: string;
}

function RepoPicker({
  groups, loading, filter, onFilter, onPick,
  selectedPaths, mode,
  browserState, onBrowse, onOpenBrowser, onCloseBrowser,
  browseHost, browseDistro,
}: RepoPickerProps) {
  const q = filter.toLowerCase();
  const filtered = groups.map(g => ({
    ...g,
    repos: g.repos.filter(r =>
      !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
    ),
  })).filter(g => g.repos.length > 0 || !q);

  return (
    <div>
      {/* Filter + browse toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          value={filter}
          onChange={e => onFilter(e.target.value)}
          placeholder="Search repos…"
          style={{ ...inp, flex: 1, fontSize: 12 }}
        />
        {!browserState.show && (
          <button type="button"
            onClick={() => {
              const g = groups[0];
              const host = g?.host ?? 'local';
              const distro = g?.distro ?? '';
              const start = host === 'wsl' ? '/home' : (g?.label ?? 'C:/');
              onOpenBrowser(start, host, distro);
            }}
            style={{ background: 'var(--btn-2nd)', border: '1px solid var(--border)', color: 'var(--ed-fg)', borderRadius: 3, padding: '0 10px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>
            Browse…
          </button>
        )}
      </div>

      {/* Directory browser */}
      {browserState.show && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
          <div style={{ background: 'var(--tab-strip)', borderBottom: '1px solid var(--border)', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" disabled={!browserState.parent}
              onClick={() => browserState.parent && onBrowse(browserState.parent)}
              style={{ background: 'none', border: 'none', cursor: browserState.parent ? 'pointer' : 'default', color: browserState.parent ? 'var(--ed-fg)' : 'var(--muted)', fontSize: 14, padding: '0 4px', lineHeight: 1 }}>↑</button>
            <code style={{ flex: 1, fontSize: 10, color: 'var(--cyan)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{browserState.path}</code>
            <button type="button" onClick={() => onPick(browserState.path, browseHost, browseDistro || undefined)}
              style={{ background: 'var(--btn-bg)', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
              {mode === 'multi' ? 'Add this folder' : 'Use this folder'}
            </button>
            <button type="button" onClick={onCloseBrowser} className="icon-btn" style={{ padding: '0 4px' }}>✕</button>
          </div>
          <div style={{ maxHeight: 150, overflowY: 'auto', background: 'var(--ed-bg)' }}>
            {browserState.loading && <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Loading…</div>}
            {browserState.error && <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--red)' }}>{browserState.error}</div>}
            {!browserState.loading && !browserState.error && browserState.entries.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Empty</div>
            )}
            {browserState.entries.map(e => (
              <div key={e.path} onClick={() => onBrowse(e.path)}
                style={{ padding: '4px 12px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(255,255,255,.03)' }}
                onMouseEnter={ev => (ev.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'}
                onMouseLeave={ev => (ev.currentTarget as HTMLElement).style.background = ''}>
                <span style={{ opacity: .5 }}>📁</span>
                <span style={{ flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                {mode === 'multi' ? (
                  <button type="button" onClick={ev => { ev.stopPropagation(); onPick(e.path, browseHost, browseDistro || undefined); }}
                    style={{ fontSize: 10, background: 'rgba(0,122,204,.2)', border: '1px solid rgba(0,122,204,.3)', color: 'var(--cyan)', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', flexShrink: 0 }}>
                    + Add
                  </button>
                ) : (
                  <span style={{ fontSize: 10, opacity: .4 }}>→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Repo groups */}
      {loading && <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0', textAlign: 'center' }}>Scanning repos…</div>}
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--ed-bg)' }}>
        {filtered.map(g => (
          <div key={`${g.host}-${g.distro}`}>
            {/* Group header */}
            <div style={{ padding: '4px 10px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', background: 'var(--tab-strip)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, position: 'sticky', top: 0 }}>
              <span style={{ color: g.host === 'recent' ? 'var(--amber)' : g.host === 'wsl' ? 'var(--green)' : 'var(--cyan)' }}>
                {g.host === 'recent' ? (g.label ?? 'Recent') : g.host}
              </span>
              {g.host !== 'recent' && g.distro && <span style={{ color: 'var(--muted)' }}>· {g.distro}</span>}
              {g.stopped && <span style={{ color: 'var(--amber)', fontSize: 8 }}>stopped</span>}
              {/* Browse button — not shown for recent group */}
              {g.host !== 'recent' && (
                <button type="button"
                  onClick={() => {
                    const start = g.host === 'wsl' ? '/home' : (g.label ?? 'C:/');
                    onOpenBrowser(start, g.host, g.distro ?? '');
                  }}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 10, padding: '1px 4px' }}>
                  Browse…
                </button>
              )}
            </div>
            {/* Repos */}
            {g.stopped ? (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                Distro stopped — start it to see repos
              </div>
            ) : g.repos.length === 0 ? (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                No repos found
              </div>
            ) : (
              g.repos.map(r => {
                const isSelected = selectedPaths.includes(r.path);
                return (
                  <div key={r.path}
                    onClick={() => !isSelected && onPick(r.path, r._host ?? g.host, r._distro ?? g.distro ?? undefined)}
                    style={{
                      padding: '5px 12px', cursor: isSelected ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 8,
                      borderBottom: '1px solid rgba(255,255,255,.03)',
                      background: isSelected ? 'rgba(0,122,204,.12)' : 'transparent',
                      opacity: isSelected && mode === 'single' ? 0.6 : 1,
                    }}
                    onMouseEnter={ev => { if (!isSelected) (ev.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'; }}
                    onMouseLeave={ev => { if (!isSelected) (ev.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                    <span style={{ fontSize: 10, opacity: .5 }}>📁</span>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    {r.branch && <span style={{ fontSize: 10, color: 'var(--cyan)', fontFamily: 'monospace', flexShrink: 0 }}>{r.branch}</span>}
                    {(r.changes ?? 0) > 0 && <span style={{ fontSize: 10, color: 'var(--amber)', flexShrink: 0 }}>{r.changes}±</span>}
                    {isSelected
                      ? <span style={{ fontSize: 10, color: 'var(--green)', flexShrink: 0 }}>✓</span>
                      : <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>→</span>
                    }
                  </div>
                );
              })
            )}
          </div>
        ))}
        {filtered.length === 0 && !loading && (
          <div style={{ padding: '16px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
            No repos match "{filter}"
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main modal ───────────────────────────────────────────────────────────────

export default function NewSessionModal({ isOpen, onClose, onCreated, prefill }: Props) {
  const [label, setLabel]               = useState('');
  const [cwd, setCwd]                   = useState('');
  const [cwdHost, setCwdHost]           = useState('local');
  const [cwdDistro, setCwdDistro]       = useState('');
  const [extraRepos, setExtraRepos]     = useState<string[]>([]);
  const [model, setModel]               = useState('');
  const [mode, setMode]                 = useState('bypassPermissions');
  const [effort, setEffort]             = useState('');
  const [thinking, setThinking]         = useState('adaptive');
  const [browser, setBrowser]           = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [prompt, setPrompt]             = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState('');

  // Repos + distros
  const [repoGroups, setRepoGroups]     = useState<RepoGroup[]>([]);
  const [localRoots, setLocalRoots]     = useState<LocalRoot[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [distros, setDistros]           = useState<{ name: string; state: string }[]>([]);

  // Which picker is active: 'cwd' | 'repos' | null
  const [activePicker, setActivePicker] = useState<'cwd' | 'repos'>('cwd');
  const [cwdFilter, setCwdFilter]       = useState('');
  const [reposFilter, setReposFilter]   = useState('');

  // Browser state (shared for both pickers)
  const [browser2, setBrowser2] = useState({
    show: false, path: '', entries: [] as DirEntry[],
    parent: null as string | null, loading: false, error: '', host: 'local', distro: '',
  });

  // Reset form to defaults then apply prefill on every open
  useEffect(() => {
    if (!isOpen) return;
    // Reset defaults first so a re-open never carries over state from a prior session
    const today = new Date().toISOString().slice(0, 10);
    setLabel(`${today}: `);
    setCwd('');
    setCwdHost('local');
    setCwdDistro('');
    setExtraRepos([]);
    setModel('');
    setMode('bypassPermissions');
    setEffort('');
    setThinking('adaptive');
    setBrowser(false);
    setAutoContinue(true);
    setPrompt('');
    setError('');
    setCwdFilter('');
    setReposFilter('');
    if (prefill) {
      if (prefill.label)                          setLabel(prefill.label);
      if (prefill.cwd)                            setCwd(prefill.cwd);
      if (prefill.host)                           setCwdHost(prefill.host);
      if (prefill.distro !== undefined)           setCwdDistro(prefill.distro ?? '');
      if (prefill.model !== undefined)            setModel(prefill.model ?? '');
      if (prefill.mode)                           setMode(prefill.mode);
      if (prefill.effort !== undefined)           setEffort(prefill.effort ?? '');
      if (prefill.thinking)                       setThinking(prefill.thinking);
      if (prefill.browser !== undefined)          setBrowser(prefill.browser);
      if (prefill.autoContinue !== undefined)     setAutoContinue(prefill.autoContinue);
      if (prefill.additionalDirectories?.length)  setExtraRepos(prefill.additionalDirectories);
    }
    setRepoGroups([]);
    setReposLoading(true);
    Promise.all([
      // Recent folders from history — shown first as quick-picks
      apiGet('/api/history').then(d => {
        if (!d?.sessions) return;
        const seen = new Set<string>();
        const items: RepoItem[] = [];
        for (const s of d.sessions as Array<{ repo?: string; host?: string; distro?: string }>) {
          const p = s.repo;
          if (!p || seen.has(p)) continue;
          seen.add(p);
          items.push({
            path: p,
            name: p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p,
            _host:  s.host   ?? 'local',
            _distro: s.distro ?? undefined,
          });
          if (items.length >= 8) break;
        }
        if (items.length > 0) {
          setRepoGroups(prev => [
            { host: 'recent', label: 'Recent', repos: items },
            ...prev.filter(g => g.host !== 'recent'),
          ]);
        }
      }),
      // Fast local repos from config roots (instant — no git)
      apiGet('/api/config/repos').then(d => {
        if (d?.localGroups) {
          setLocalRoots(d.localGroups as LocalRoot[]);
          const localGroups: RepoGroup[] = (d.localGroups as LocalRoot[]).map((lg: LocalRoot) => ({
            host: 'local',
            distro: lg.root.split('/').pop() ?? lg.root,
            label: lg.root,
            repos: lg.repos.map(r => ({ path: r.path, name: r.name })),
          }));
          setRepoGroups(prev => [...localGroups, ...prev.filter(g => g.host !== 'local')]);
          setReposLoading(false);
        }
      }),
      // WSL repos (may be slower)
      apiGet('/api/repos').then(d => {
        if (d?.groups) {
          const wslGroups = (d.groups as RepoGroup[]).filter(g => g.host === 'wsl');
          setRepoGroups(prev => [...prev.filter(g => g.host !== 'wsl'), ...wslGroups]);
        }
        setReposLoading(false);
      }),
      apiGet('/api/wsl/distros').then(d => {
        if (d?.distros) setDistros(d.distros);
      }),
    ]);
  }, [isOpen]);

  const loadBrowser = useCallback(async (dir: string, host: string, distro: string) => {
    setBrowser2(prev => ({ ...prev, loading: true, error: '' }));
    const params = new URLSearchParams({ host, path: dir });
    if (host === 'wsl' && distro) params.set('distro', distro);
    const data = await apiGet(`/api/browse?${params}`) as BrowseResult | null;
    setBrowser2(prev => ({
      ...prev,
      loading: false,
      path: data?.path ?? dir,
      parent: data?.parent ?? null,
      entries: data?.entries ?? [],
      error: data?.error ?? (data ? '' : 'Failed to load'),
    }));
  }, []);

  function openBrowser(startPath: string, host: string, distro: string) {
    setBrowser2({ show: true, path: startPath, entries: [], parent: null, loading: false, error: '', host, distro });
    loadBrowser(startPath, host, distro);
  }

  function closeBrowser() {
    setBrowser2(prev => ({ ...prev, show: false }));
  }

  function pickCwd(path: string, host: string, distro?: string) {
    setCwd(path);
    setCwdHost(host);
    setCwdDistro(distro ?? '');
    closeBrowser();
    // Auto-complete label if it still looks like the empty date prefix (YYYY-MM-DD: )
    const repoName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    if (repoName) {
      setLabel(prev => /^\d{4}-\d{2}-\d{2}: ?$/.test(prev) ? prev.replace(/: ?$/, ': ') + repoName : prev);
    }
  }

  function addRepo(path: string) {
    if (!extraRepos.includes(path)) setExtraRepos(prev => [...prev, path]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) { setError('Label is required.'); return; }
    if (!cwd.trim()) { setError('Working directory is required.'); return; }
    setError(''); setSubmitting(true);
    const body: Record<string, unknown> = {
      label: label.trim(), host: cwdHost, cwd: cwd.trim(),
      mode, effort: effort || undefined, thinking,
      browser, autoContinue,
      model: model.trim() || undefined,
      initialPrompt: prompt.trim() || undefined,
    };
    if (cwdHost === 'wsl' && cwdDistro) body.distro = cwdDistro;
    if (extraRepos.length > 0) body.additionalDirectories = extraRepos;
    const data = await apiPost('/api/sessions', body);
    setSubmitting(false);
    if (data?.id) {
      onCreated(data.id as string);
      onClose();
      setLabel(''); setCwd(''); setModel(''); setExtraRepos([]); setPrompt(''); setError('');
      setCwdFilter(''); setReposFilter('');
    } else {
      setError(data?.reason ?? 'Failed to create session.');
    }
  }

  if (!isOpen) return null;

  const runningDistros = distros.filter(d => /running/i.test(d.state));
  const stoppedDistros = distros.filter(d => !/running/i.test(d.state));

  // Enrich repoGroups with distro running state
  const enrichedGroups = repoGroups.map(g => {
    if (g.host !== 'wsl') return g;
    const d = distros.find(x => x.name === g.distro);
    return { ...g, stopped: d ? !/running/i.test(d.state) : (g.stopped ?? false) };
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--sb-bg)', border: '1px solid var(--border)', borderRadius: 8, width: 620, maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,.6)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
          <span>New Session</span>
          <button onClick={onClose} className="icon-btn" style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

          {/* Left nav tabs */}
          <div style={{ width: 120, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,.15)' }}>
            {(['cwd', 'repos', 'config'] as const).map(tab => (
              <button key={tab} type="button"
                onClick={() => setActivePicker(tab as any)}
                style={{
                  background: activePicker === tab ? 'var(--sb-focus)' : 'transparent',
                  border: 'none', borderLeft: activePicker === tab ? '3px solid var(--accent)' : '3px solid transparent',
                  color: activePicker === tab ? '#fff' : 'var(--muted)',
                  padding: '10px 14px', textAlign: 'left', cursor: 'pointer',
                  fontSize: 12, fontFamily: 'inherit', fontWeight: activePicker === tab ? 600 : 400,
                }}>
                {tab === 'cwd' ? '📂 Working Dir' : tab === 'repos' ? '➕ Extra Repos' : '⚙ Settings'}
              </button>
            ))}

            {/* Selected cwd preview */}
            {cwd && (
              <div style={{ marginTop: 'auto', padding: '10px 10px', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>CWD</div>
                <code style={{ fontSize: 10, color: 'var(--cyan)', wordBreak: 'break-all', lineHeight: 1.4 }}>{cwd}</code>
              </div>
            )}
          </div>

          {/* Right content */}
          <form onSubmit={submit} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>

              {/* Always-visible label */}
              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Label *</label>
                <input value={label} onChange={e => setLabel(e.target.value)} style={inp} autoFocus placeholder="my-task" />
              </div>

              {/* CWD tab */}
              {activePicker === 'cwd' && (
                <div>
                  <label style={{ ...lbl, marginBottom: 8 }}>
                    Select working directory — click a repo to use it, or Browse to pick any folder
                  </label>
                  {cwd && (
                    <div style={{ padding: '6px 10px', background: 'rgba(0,122,204,.1)', border: '1px solid rgba(0,122,204,.3)', borderRadius: 4, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Selected:</span>
                      <code style={{ fontSize: 11, color: 'var(--cyan)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cwd}</code>
                      <button type="button" onClick={() => setCwd('')} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>✕</button>
                    </div>
                  )}
                  <RepoPicker
                    groups={enrichedGroups}
                    loading={reposLoading}
                    filter={cwdFilter}
                    onFilter={setCwdFilter}
                    onPick={pickCwd}
                    selectedPaths={cwd ? [cwd] : []}
                    mode="single"
                    browserState={{ ...browser2, show: browser2.show }}
                    onBrowse={dir => loadBrowser(dir, browser2.host, browser2.distro).then(() => setBrowser2(prev => ({ ...prev, show: true })))}
                    onOpenBrowser={openBrowser}
                    onCloseBrowser={closeBrowser}
                    browseHost={browser2.host}
                    browseDistro={browser2.distro}
                  />
                </div>
              )}

              {/* Extra Repos tab */}
              {activePicker === 'repos' && (
                <div>
                  <label style={{ ...lbl, marginBottom: 8 }}>
                    Add extra repositories Claude can access — click + Add or browse
                  </label>
                  {extraRepos.length > 0 && (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 4, marginBottom: 8, overflow: 'hidden' }}>
                      {extraRepos.map(p => (
                        <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'rgba(74,222,128,.06)', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontSize: 10, opacity: .5 }}>📁</span>
                          <code style={{ flex: 1, fontSize: 11, color: 'var(--cyan)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</code>
                          <button type="button" onClick={() => setExtraRepos(prev => prev.filter(x => x !== p))}
                            style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <RepoPicker
                    groups={enrichedGroups}
                    loading={reposLoading}
                    filter={reposFilter}
                    onFilter={setReposFilter}
                    onPick={(path) => addRepo(path)}
                    selectedPaths={extraRepos}
                    mode="multi"
                    browserState={{ ...browser2, show: browser2.show }}
                    onBrowse={dir => loadBrowser(dir, browser2.host, browser2.distro).then(() => setBrowser2(prev => ({ ...prev, show: true })))}
                    onOpenBrowser={openBrowser}
                    onCloseBrowser={closeBrowser}
                    browseHost={browser2.host}
                    browseDistro={browser2.distro}
                  />
                </div>
              )}

              {/* Config tab */}
              {(activePicker as string) === 'config' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Model */}
                  <div>
                    <label style={lbl}>Model (blank = plan default)</label>
                    <input value={model} onChange={e => setModel(e.target.value)} placeholder="claude-opus-4-5" style={inp} />
                  </div>

                  {/* Mode + Effort */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={lbl}>Mode</label>
                      <select value={mode} onChange={e => setMode(e.target.value)} style={inp}>
                        <option value="bypassPermissions">Auto full access</option>
                        <option value="acceptEdits">Auto-accept edits</option>
                        <option value="default">Ask before edits</option>
                        <option value="plan">Plan read-only</option>
                      </select>
                    </div>
                    <div>
                      <label style={lbl}>Reasoning effort</label>
                      <select value={effort} onChange={e => setEffort(e.target.value)} style={inp}>
                        <option value="">Default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra high</option>
                        <option value="max">Max</option>
                      </select>
                    </div>
                  </div>

                  {/* Thinking */}
                  <div>
                    <label style={lbl}>Extended thinking</label>
                    <select value={thinking} onChange={e => setThinking(e.target.value)} style={{ ...inp, width: 'auto' }}>
                      <option value="adaptive">Adaptive (recommended)</option>
                      <option value="off">Off</option>
                    </select>
                  </div>

                  {/* WSL distro override */}
                  <div>
                    <label style={lbl}>WSL distro override (if different from CWD host)</label>
                    <select value={cwdHost !== 'wsl' ? '' : cwdDistro} onChange={e => {
                      if (e.target.value) { setCwdHost('wsl'); setCwdDistro(e.target.value); }
                      else { setCwdHost('local'); setCwdDistro(''); }
                    }} style={inp}>
                      <option value="">local (Windows)</option>
                      {runningDistros.map(d => <option key={d.name} value={d.name}>WSL: {d.name}</option>)}
                      {stoppedDistros.map(d => <option key={d.name} value={d.name}>WSL: {d.name} (stopped)</option>)}
                    </select>
                  </div>

                  {/* Checkboxes */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={browser} onChange={e => setBrowser(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                      Enable browser tools (Playwright)
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={autoContinue} onChange={e => setAutoContinue(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                      Auto-continue after 5h reset
                    </label>
                  </div>

                  {/* Initial prompt */}
                  <div>
                    <label style={lbl}>Initial prompt (optional)</label>
                    <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
                      style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}
                      placeholder="What should this agent do?" />
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {error && <span style={{ color: 'var(--red)', fontSize: 12, flex: 1 }}>{error}</span>}
              {!error && (
                <span style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>
                  {cwd ? `CWD: ${cwd.split(/[/\\]/).pop()}` : 'Select a working directory'}
                  {extraRepos.length > 0 ? ` · ${extraRepos.length} extra repo${extraRepos.length > 1 ? 's' : ''}` : ''}
                </span>
              )}
              <button type="button" onClick={onClose} className="btn secondary">Cancel</button>
              <button type="submit" disabled={submitting} className="btn" style={{ minWidth: 130 }}>
                {submitting ? 'Creating…' : 'Create Session'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
