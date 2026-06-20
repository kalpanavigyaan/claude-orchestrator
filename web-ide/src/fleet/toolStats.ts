/**
 * Tool usage + token-savings tracker.
 *
 * The orchestrator streams tool invocations over the per-session SSE channel
 * (role: 'tool' messages). We tally each tool call here and estimate token
 * savings using per-tool efficiency factors measured on real repo data
 * (see tool-server/proof/RESULTS.txt).
 *
 * This lets the Tool Analytics panel show, live, which intelligence tools are
 * actually reducing token usage and which aren't.
 */

export interface ToolEfficiency {
  /** Average % of tokens saved when this tool is used (0-100). */
  savedPct: number;
  /** Typical "before" token size for one invocation (for estimating savings). */
  typicalBefore: number;
  /** Short human description of what it saves. */
  note: string;
}

// Measured efficiency from tool-server/proof/RESULTS.txt + design targets.
export const TOOL_EFFICIENCY: Record<string, ToolEfficiency> = {
  region_extract: { savedPct: 88.4, typicalBefore: 16732, note: 'Extracts only the requested region instead of whole file' },
  tds:            { savedPct: 87.2, typicalBefore: 62498, note: 'Summarises diffs to changed-hunk essentials' },
  log_dedup:      { savedPct: 63.0, typicalBefore: 5227,  note: 'Collapses repeated log lines to templates' },
  safr:           { savedPct: 72.0, typicalBefore: 12000, note: 'Symbol-aware reads skip irrelevant code' },
  chunkhound:     { savedPct: 65.0, typicalBefore: 9000,  note: 'Returns only semantically-matching chunks' },
  symbol_scope:   { savedPct: 70.0, typicalBefore: 8000,  note: 'Targets symbol definition/usages only' },
  stack_collapse: { savedPct: 55.0, typicalBefore: 4000,  note: 'Collapses deep stack frames' },
  noise_filter:   { savedPct: 0.4,  typicalBefore: 82202, note: 'Marginal on already-clean source' },
  graphify:       { savedPct: 40.0, typicalBefore: 6000,  note: 'Compact dependency graph vs raw imports' },
  ast_query:      { savedPct: 60.0, typicalBefore: 7000,  note: 'Returns matched AST nodes only' },
  cavemem_read:   { savedPct: 30.0, typicalBefore: 3000,  note: 'Recalls facts instead of re-deriving' },
  cavemem_write:  { savedPct: 0,    typicalBefore: 500,   note: 'Persists facts (no immediate saving)' },
};

export interface ToolStat {
  calls: number;
  estBefore: number;   // estimated tokens that would have been used
  estSaved: number;    // estimated tokens saved
  lastUsed: number;    // ms timestamp
}

type Listener = () => void;

class ToolStatsStore {
  private stats = new Map<string, ToolStat>();
  private listeners = new Set<Listener>();

  /** Normalise the many possible tool-name forms to our catalogue ids. */
  private normalize(name: string): string {
    const n = name.toLowerCase().replace(/[^a-z_]/g, '');
    // strip common prefixes (mcp__toolserver__region_extract → region_extract)
    const parts = n.split('__');
    const tail = parts[parts.length - 1];
    if (TOOL_EFFICIENCY[tail]) return tail;
    // try direct
    if (TOOL_EFFICIENCY[n]) return n;
    // fuzzy contains
    for (const id of Object.keys(TOOL_EFFICIENCY)) {
      if (n.includes(id)) return id;
    }
    return tail || n;
  }

  record(rawName: string) {
    const id = this.normalize(rawName);
    const eff = TOOL_EFFICIENCY[id];
    const cur = this.stats.get(id) ?? { calls: 0, estBefore: 0, estSaved: 0, lastUsed: 0 };
    cur.calls += 1;
    cur.lastUsed = Date.now();
    if (eff) {
      cur.estBefore += eff.typicalBefore;
      cur.estSaved  += Math.round(eff.typicalBefore * eff.savedPct / 100);
    }
    this.stats.set(id, cur);
    this.emit();
  }

  get(): Map<string, ToolStat> {
    return new Map(this.stats);
  }

  totalSaved(): number {
    let t = 0;
    for (const s of this.stats.values()) t += s.estSaved;
    return t;
  }

  reset() {
    this.stats.clear();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export const toolStats = new ToolStatsStore();
