/**
 * Fleet Console settings — web edition.
 *
 * Mirrors the schema used by fleet-console-electron/settings.json so the two
 * apps share the same configuration keys. The web app persists settings to
 * localStorage (the electron app uses a real settings.json on disk).
 *
 * Theme colour overrides (`theme.colors`) are applied as CSS custom properties,
 * exactly like the electron renderer's applySettings().
 */

export interface FleetSettings {
  // Left sidebar
  'sidebar.width': number;
  'sidebar.sessions.height': number;
  'sidebar.controls.height': number;
  // Right sidebar
  'sidebar.right.width': number;
  'sidebar.right.defaultPanel': string;
  'sidebar.right.usage.defaultTab': string;
  // Session defaults
  'session.defaultHost': string;
  'session.defaultMode': string;
  'session.defaultEffort': string;
  'session.defaultThinking': string;
  'session.autoContinue': boolean;
  'session.autoLoadHistory': boolean;
  // Chat
  'chat.fontSize': number;
  'chat.lineHeight': number;
  'chat.fontFamily': string;
  'chat.codeFontFamily': string;
  // Orchestrator
  'orchestrator.port': number;
  'orchestrator.token': string;
  // Theme overrides — CSS custom properties
  'theme.colors': Record<string, string>;
  // Status bar
  'statusBar.showTokens': boolean;
}

export const DEFAULT_SETTINGS: FleetSettings = {
  'sidebar.width': 260,
  'sidebar.sessions.height': 180,
  'sidebar.controls.height': 230,
  'sidebar.right.width': 300,
  'sidebar.right.defaultPanel': 'usage',
  'sidebar.right.usage.defaultTab': 'overview',
  'session.defaultHost': 'local',
  'session.defaultMode': 'bypassPermissions',
  'session.defaultEffort': '',
  'session.defaultThinking': 'adaptive',
  'session.autoContinue': true,
  'session.autoLoadHistory': true,
  'chat.fontSize': 13,
  'chat.lineHeight': 1.6,
  'chat.fontFamily': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  'chat.codeFontFamily': "'Cascadia Code', 'Fira Mono', Consolas, monospace",
  'orchestrator.port': 4318,
  'orchestrator.token': '',
  'theme.colors': {},
  'statusBar.showTokens': true,
};

const LS_KEY = 'fleet-settings-json';

/** The default settings.json text shown in the editor (with helpful comments). */
export const DEFAULT_SETTINGS_TEXT = `{
  // Fleet Console — User Settings (web).
  // Same schema as the electron app's settings.json. Saved to localStorage.

  // ── Left sidebar ──────────────────────────────────────────
  "sidebar.width": 260,
  "sidebar.sessions.height": 180,
  "sidebar.controls.height": 230,

  // ── Right sidebar ─────────────────────────────────────────
  "sidebar.right.width": 300,
  "sidebar.right.defaultPanel": "usage",
  "sidebar.right.usage.defaultTab": "overview",

  // ── Session defaults ──────────────────────────────────────
  "session.defaultHost": "local",
  "session.defaultMode": "bypassPermissions",
  "session.defaultThinking": "adaptive",
  "session.autoContinue": true,
  "session.autoLoadHistory": true,

  // ── Chat / editor ─────────────────────────────────────────
  "chat.fontSize": 13,
  "chat.lineHeight": 1.6,

  // ── Orchestrator ──────────────────────────────────────────
  "orchestrator.port": 4318,
  "orchestrator.token": "",

  // ── Theme overrides ───────────────────────────────────────
  // Any key here is applied as a CSS custom property, overriding the dark
  // palette. Keys may be given with or without the leading "--".
  // e.g. "--accent": "#007acc",  "--ed-bg": "#1e1e1e"
  "theme.colors": {
  }
}`;

/** Strip // comments and trailing commas, then JSON.parse. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

/** Load the raw settings.json text the user last saved (or the default). */
export function loadSettingsText(): string {
  return localStorage.getItem(LS_KEY) ?? DEFAULT_SETTINGS_TEXT;
}

/** Load parsed settings merged over the defaults. */
export function loadSettings(): FleetSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = parseJsonc(raw) as Partial<FleetSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save raw text; returns { ok, settings } or { ok:false, error }. */
export function saveSettingsText(text: string): { ok: boolean; settings?: FleetSettings; error?: string } {
  try {
    const parsed = parseJsonc(text) as Partial<FleetSettings>;
    localStorage.setItem(LS_KEY, text);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    applyThemeColors(merged);
    return { ok: true, settings: merged };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Apply theme.colors overrides as CSS custom properties on :root. */
export function applyThemeColors(settings: FleetSettings) {
  const root = document.documentElement.style;
  const colors = settings['theme.colors'];
  if (colors && typeof colors === 'object') {
    for (const [key, val] of Object.entries(colors)) {
      if (!val) continue;
      root.setProperty(key.startsWith('--') ? key : '--' + key, String(val));
    }
  }
  // Chat font sizing
  const fs = settings['chat.fontSize'];
  if (fs) root.setProperty('--chat-font-size', fs + 'px');
  const lh = settings['chat.lineHeight'];
  if (lh) root.setProperty('--chat-line-height', String(lh));
}

/** Apply all settings on startup (theme + fonts). */
export function applySettingsOnLoad() {
  applyThemeColors(loadSettings());
}
