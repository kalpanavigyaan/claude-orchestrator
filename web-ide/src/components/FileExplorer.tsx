import { useState, useRef, useEffect } from 'react';
import { Plus, FolderPlus, ChevronRight, ChevronDown } from 'lucide-react';
import { FileNode } from '../types';
import { findById } from '../lib/fs';

const EXT_COLORS: Record<string, string> = {
  html: '#e34f26',
  css: '#264de4',
  js: '#f0db4f',
  jsx: '#61dafb',
  ts: '#007acc',
  tsx: '#61dafb',
  py: '#3572a5',
  json: '#cbcb41',
  md: '#083fa1',
  rs: '#dea584',
};

function getExtColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_COLORS[ext] ?? '#858585';
}

function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={open ? '#e8c27a' : '#c09a47'}
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <path d="M1 3C1 2.44772 1.44772 2 2 2H6.41421L7.70711 3.29289C7.89464 3.48043 8.14899 3.58579 8.41421 3.58579H14C14.5523 3.58579 15 4.03351 15 4.58579V13C15 13.5523 14.5523 14 14 14H2C1.44772 14 1 13.5523 1 13V3Z" />
    </svg>
  );
}

interface CtxMenu {
  x: number;
  y: number;
  nodeId: string;
  nodeType: 'file' | 'folder';
}

interface CreatingState {
  type: 'file' | 'folder';
  parentId: string | null;
}

interface TreeItemProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onFileClick: (id: string) => void;
  onCtxMenu: (e: React.MouseEvent, node: FileNode) => void;
  renaming: { id: string; value: string } | null;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  activeFileId: string | null;
  focused: string | null;
  onFocus: (id: string) => void;
}

function TreeItem({
  node,
  depth,
  expanded,
  onToggle,
  onFileClick,
  onCtxMenu,
  renaming,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  activeFileId,
  focused,
  onFocus,
}: TreeItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isExpanded = expanded.has(node.id);
  const isRenaming = renaming?.id === node.id;

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  return (
    <>
      <div
        className={`tree-item${activeFileId === node.id ? ' selected' : ''}${focused === node.id ? ' focused' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          onFocus(node.id);
          if (node.type === 'folder') {
            onToggle(node.id);
          } else {
            onFileClick(node.id);
          }
        }}
        onContextMenu={(e) => onCtxMenu(e, node)}
      >
        {node.type === 'folder' ? (
          <>
            <span style={{ marginRight: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span style={{ marginRight: 4, display: 'flex', alignItems: 'center' }}>
              <FolderIcon open={isExpanded} />
            </span>
          </>
        ) : (
          <>
            <span style={{ width: 14, flexShrink: 0 }} />
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: getExtColor(node.name),
                display: 'inline-block',
                marginRight: 6,
                flexShrink: 0,
              }}
            />
          </>
        )}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="fi"
            style={{ flex: 1, padding: '0 4px', fontSize: 12, height: 20 }}
            value={renaming.value}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 13,
            }}
          >
            {node.name}
          </span>
        )}
        {node.isUnsaved && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#e2c08d',
              display: 'inline-block',
              marginLeft: 4,
              flexShrink: 0,
            }}
          />
        )}
      </div>
      {node.type === 'folder' &&
        isExpanded &&
        node.children?.map((child) => (
          <TreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onFileClick={onFileClick}
            onCtxMenu={onCtxMenu}
            renaming={renaming}
            onRenameValueChange={onRenameValueChange}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            activeFileId={activeFileId}
            focused={focused}
            onFocus={onFocus}
          />
        ))}
    </>
  );
}

interface FileExplorerProps {
  files: FileNode[];
  onFileClick: (id: string) => void;
  onCreateFile: (name: string, parentId: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  activeFileId: string | null;
}

export function FileExplorer({
  files,
  onFileClick,
  onCreateFile,
  onCreateFolder,
  onDelete,
  onRename,
  activeFileId,
}: FileExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [newName, setNewName] = useState('');
  const [focused, setFocused] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      const t = setTimeout(() => createInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [creating]);

  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCtxMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, nodeType: node.type });
  };

  const handleRenameValueChange = (value: string) => {
    setRenaming((prev) => (prev ? { ...prev, value } : null));
  };

  const handleRenameCommit = () => {
    if (renaming?.value.trim()) {
      onRename(renaming.id, renaming.value.trim());
    }
    setRenaming(null);
  };

  const handleRenameCancel = () => setRenaming(null);

  const handleCreateSubmit = () => {
    if (!newName.trim() || !creating) return;
    if (creating.type === 'file') {
      onCreateFile(newName.trim(), creating.parentId);
    } else {
      onCreateFolder(newName.trim(), creating.parentId);
    }
    setCreating(null);
    setNewName('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          gap: 4,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: 0.7,
          }}
        >
          Files
        </span>
        <button
          className="icon-btn"
          onClick={() => {
            setCreating({ type: 'file', parentId: null });
            setNewName('');
          }}
          title="New File"
        >
          <Plus size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            setCreating({ type: 'folder', parentId: null });
            setNewName('');
          }}
          title="New Folder"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {files.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggleExpand}
            onFileClick={onFileClick}
            onCtxMenu={handleCtxMenu}
            renaming={renaming}
            onRenameValueChange={handleRenameValueChange}
            onRenameCommit={handleRenameCommit}
            onRenameCancel={handleRenameCancel}
            activeFileId={activeFileId}
            focused={focused}
            onFocus={setFocused}
          />
        ))}
      </div>

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 9999 }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.nodeType === 'folder' && (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  setCreating({ type: 'file', parentId: ctxMenu.nodeId });
                  setNewName('');
                  setCtxMenu(null);
                }}
              >
                New File
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setCreating({ type: 'folder', parentId: ctxMenu.nodeId });
                  setNewName('');
                  setCtxMenu(null);
                }}
              >
                New Folder
              </div>
              <div className="ctx-sep" />
            </>
          )}
          <div
            className="ctx-item"
            onClick={() => {
              const node = findById(files, ctxMenu.nodeId);
              if (node) setRenaming({ id: node.id, value: node.name });
              setCtxMenu(null);
            }}
          >
            Rename
          </div>
          <div
            className="ctx-item danger"
            onClick={() => {
              onDelete(ctxMenu.nodeId);
              setCtxMenu(null);
            }}
          >
            Delete
          </div>
        </div>
      )}

      {creating && (
        <div
          className="modal-overlay"
          style={{ zIndex: 9998 }}
          onClick={() => setCreating(null)}
        >
          <div className="modal-qp-box" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                padding: '8px 12px',
                fontSize: 12,
                opacity: 0.7,
                borderBottom: '1px solid var(--border)',
              }}
            >
              {creating.type === 'file' ? 'New File Name' : 'New Folder Name'}
            </div>
            <div style={{ padding: 8 }}>
              <input
                ref={createInputRef}
                className="fi"
                style={{ width: '100%' }}
                value={newName}
                placeholder={creating.type === 'file' ? 'filename.js' : 'folder-name'}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateSubmit();
                  if (e.key === 'Escape') setCreating(null);
                }}
              />
            </div>
            <div
              style={{
                padding: '4px 8px 8px',
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
              }}
            >
              <button className="btn secondary" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button className="btn" onClick={handleCreateSubmit}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
