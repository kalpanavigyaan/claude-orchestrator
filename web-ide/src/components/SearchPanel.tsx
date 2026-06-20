import { useState, useCallback } from 'react';
import { Search, ChevronRight, ChevronDown } from 'lucide-react';
import { FileNode } from '../types';

interface Match {
  line: number;
  text: string;
  start: number;
  end: number;
}

interface SearchResult {
  fileId: string;
  fileName: string;
  filePath: string;
  matches: Match[];
}

interface SearchPanelProps {
  files: FileNode[];
  onFileClick: (id: string) => void;
}

function getFilePath(nodes: FileNode[], id: string, prefix = ''): string {
  for (const node of nodes) {
    const current = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.id === id) return current;
    if (node.children) {
      const found = getFilePath(node.children, id, current);
      if (found) return found;
    }
  }
  return '';
}

function searchNodes(
  nodes: FileNode[],
  query: string,
  allFiles: FileNode[],
  results: SearchResult[],
): void {
  for (const node of nodes) {
    if (node.type === 'file' && node.content) {
      const lines = node.content.split('\n');
      const lowerQuery = query.toLowerCase();
      const matches: Match[] = [];
      lines.forEach((lineText, idx) => {
        let start = lineText.toLowerCase().indexOf(lowerQuery);
        while (start !== -1) {
          matches.push({ line: idx + 1, text: lineText, start, end: start + query.length });
          start = lineText.toLowerCase().indexOf(lowerQuery, start + 1);
        }
      });
      if (matches.length > 0) {
        results.push({
          fileId: node.id,
          fileName: node.name,
          filePath: getFilePath(allFiles, node.id),
          matches,
        });
      }
    }
    if (node.children) {
      searchNodes(node.children, query, allFiles, results);
    }
  }
}

export function SearchPanel({ files, onFileClick }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q);
      if (!q.trim()) {
        setResults([]);
        return;
      }
      const found: SearchResult[] = [];
      searchNodes(files, q, files, found);
      setResults(found);
    },
    [files],
  );

  const toggleCollapse = (fileId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const totalMatches = results.reduce((s, r) => s + r.matches.length, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: 8,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 8, opacity: 0.5, pointerEvents: 'none' }}
          />
          <input
            className="fi"
            style={{ width: '100%', paddingLeft: 28 }}
            placeholder="Search files..."
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        {query && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            {totalMatches} result{totalMatches !== 1 ? 's' : ''} in {results.length} file
            {results.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {results.map((result) => (
          <div key={result.fileId}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                cursor: 'pointer',
                gap: 4,
              }}
              onClick={() => toggleCollapse(result.fileId)}
            >
              {collapsed.has(result.fileId) ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>
                {result.fileName}
              </span>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: 'var(--accent)',
                  color: '#fff',
                  borderRadius: 10,
                  padding: '1px 6px',
                }}
              >
                {result.matches.length}
              </span>
            </div>
            {!collapsed.has(result.fileId) &&
              result.matches.map((match, i) => (
                <div
                  key={i}
                  style={{
                    padding: '2px 8px 2px 24px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  onClick={() => onFileClick(result.fileId)}
                >
                  <span
                    style={{
                      opacity: 0.5,
                      flexShrink: 0,
                      minWidth: 28,
                      textAlign: 'right',
                      fontSize: 11,
                    }}
                  >
                    {match.line}
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {match.text.slice(0, match.start)}
                    <mark style={{ background: '#ffd700', color: '#000', borderRadius: 2 }}>
                      {match.text.slice(match.start, match.end)}
                    </mark>
                    {match.text.slice(match.end)}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
