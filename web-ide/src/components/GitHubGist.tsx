import { useState } from 'react';
import { X } from 'lucide-react';
import { FileNode } from '../types';
import { createFile } from '../lib/fs';

interface GitHubGistProps {
  isOpen: boolean;
  onClose: () => void;
  files: FileNode[];
  onLoadFiles: (files: FileNode[]) => void;
}

function flattenFiles(files: FileNode[]): { name: string; content: string }[] {
  const result: { name: string; content: string }[] = [];
  function traverse(nodes: FileNode[], prefix = '') {
    for (const node of nodes) {
      if (node.type === 'file') {
        const name = prefix ? `${prefix}/${node.name}` : node.name;
        result.push({ name, content: node.content ?? '' });
      } else if (node.children) {
        const p = prefix ? `${prefix}/${node.name}` : node.name;
        traverse(node.children, p);
      }
    }
  }
  traverse(files);
  return result;
}

interface GistStatus {
  type: 'success' | 'error';
  message: string;
}

export function GitHubGist({ isOpen, onClose, files, onLoadFiles }: GitHubGistProps) {
  const [token, setToken] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [gistId, setGistId] = useState('');
  const [status, setStatus] = useState<GistStatus | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!token.trim()) {
      setStatus({ type: 'error', message: 'GitHub PAT is required' });
      return;
    }
    const flatFiles = flattenFiles(files);
    if (flatFiles.length === 0) {
      setStatus({ type: 'error', message: 'No files to save' });
      return;
    }

    const gistFiles: Record<string, { content: string }> = {};
    for (const f of flatFiles) {
      // Flatten path separators to underscores for gist file names
      const safeName = f.name.replace(/\//g, '_');
      gistFiles[safeName] = { content: f.content || ' ' };
    }

    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: description || 'Web IDE Workspace',
          public: isPublic,
          files: gistFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      setStatus({ type: 'success', message: `Saved! Gist ID: ${(data as { id: string }).id}` });
    } catch (e) {
      setStatus({
        type: 'error',
        message: e instanceof Error ? e.message : 'Failed to save gist',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleLoad = async () => {
    if (!token.trim()) {
      setStatus({ type: 'error', message: 'GitHub PAT is required' });
      return;
    }
    if (!gistId.trim()) {
      setStatus({ type: 'error', message: 'Gist ID is required' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`https://api.github.com/gists/${gistId.trim()}`, {
        headers: { Authorization: `token ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
      }

      type GistFile = { filename?: string; content?: string };
      const gistData = data as { files?: Record<string, GistFile> };
      const loadedFiles: FileNode[] = Object.entries(gistData.files ?? {}).map(
        ([name, info]) => {
          return createFile(name, (info as GistFile).content ?? '');
        },
      );
      onLoadFiles(loadedFiles);
      setStatus({ type: 'success', message: `Loaded ${loadedFiles.length} files from gist` });
    } catch (e) {
      setStatus({
        type: 'error',
        message: e instanceof Error ? e.message : 'Failed to load gist',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hdr">
          <span>GitHub Gist</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-group">
            <div className="settings-group-title">Authentication</div>
            <div className="settings-row">
              <div>
                <div className="settings-label">GitHub Personal Access Token</div>
                <div className="settings-desc">Requires a token with the "gist" scope</div>
              </div>
            </div>
            <input
              className="fi"
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ width: '100%', marginTop: 4 }}
            />
          </div>

          <div className="settings-group">
            <div className="settings-group-title">Save to Gist</div>
            <div className="settings-row">
              <div className="settings-label">Description</div>
            </div>
            <input
              className="fi"
              placeholder="Gist description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="gist-visibility"
                  checked={!isPublic}
                  onChange={() => setIsPublic(false)}
                />
                Private
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="gist-visibility"
                  checked={isPublic}
                  onChange={() => setIsPublic(true)}
                />
                Public
              </label>
            </div>
            <button className="btn" onClick={handleSave} disabled={loading}>
              {loading ? 'Saving...' : 'Save to Gist'}
            </button>
          </div>

          <div className="settings-group">
            <div className="settings-group-title">Load from Gist</div>
            <input
              className="fi"
              placeholder="Enter Gist ID..."
              value={gistId}
              onChange={(e) => setGistId(e.target.value)}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <button className="btn secondary" onClick={handleLoad} disabled={loading}>
              {loading ? 'Loading...' : 'Load from Gist'}
            </button>
          </div>

          {status && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 4,
                fontSize: 12,
                marginTop: 8,
                background:
                  status.type === 'success'
                    ? 'rgba(78,201,176,0.12)'
                    : 'rgba(241,76,76,0.12)',
                color: status.type === 'success' ? '#4ec9b0' : '#f14c4c',
                border: `1px solid ${status.type === 'success' ? '#4ec9b0' : '#f14c4c'}`,
              }}
            >
              {status.message}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
