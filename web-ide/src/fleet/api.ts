// Fleet Console API client

const BASE = 'http://127.0.0.1:4318';

export async function apiPost(path: string, body: unknown = {}) {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? r.json().catch(() => ({})) : {};
  } catch {
    return {};
  }
}

export async function apiGet(path: string, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { signal: ctrl.signal });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function openSSE(path: string, onMsg: (d: unknown) => void, onError?: () => void) {
  const es = new EventSource(BASE + path);
  es.onmessage = (ev) => {
    try { onMsg(JSON.parse(ev.data)); } catch { /* ignore */ }
  };
  es.onerror = () => { onError?.(); };
  return es;
}

export function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n || 0);
}

export function fmtCountdown(targetMs: number, alwaysShowDays = false): string {
  let s = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return (d > 0 || alwaysShowDays) ? `${d}d ${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}:${p(s)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Minimal markdown → HTML (mirrors the electron app's renderer)
function mdInline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `@@C${codes.push(c) - 1}@@`);
  s = s
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
      const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : '#';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
  return s.replace(/@@C(\d+)@@/g, (_, i) => `<code>${codes[+i]}</code>`);
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l);

export function mdToHtml(src: string): string {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const splitRow = (l: string) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
      .map(c => mdInline(escHtml(c.trim())));

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="fc-code"><code>${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${mdInline(escHtml(h[2].trim()))}</h${h[1].length}>`); i++; continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line); i += 2;
      let t = '<table class="fc-table"><thead><tr>' + headers.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        t += '<tr>' + splitRow(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>'; i++;
      }
      out.push(t + '</tbody></table>'); continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdInline(escHtml(buf.join(' ')))}</blockquote>`); continue;
    }

    const ordered = /^\s*\d+\.\s+/.test(line);
    const listRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    if (listRe.test(line)) {
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i])) items.push(lines[i++].replace(listRe, '$1'));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map(it => `<li>${mdInline(escHtml(it))}</li>`).join('') + `</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) { para.push(lines[i++]); }
    out.push(`<p>${mdInline(escHtml(para.join('\n'))).replace(/\n/g, '<br />')}</p>`);
  }
  return out.join('');
}
