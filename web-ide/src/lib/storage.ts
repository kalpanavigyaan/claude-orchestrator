import JSZip from 'jszip';
import { WorkspaceState, FileNode } from '../types';

export const WORKSPACE_KEY = 'vsc-ide-workspace';

export function saveWorkspace(ws: WorkspaceState): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws));
  } catch (e) {
    console.error('Failed to save workspace', e);
  }
}

export function loadWorkspace(): WorkspaceState | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkspaceState;
  } catch (e) {
    console.error('Failed to load workspace', e);
    return null;
  }
}

function addFilesToZip(zip: JSZip, files: FileNode[], path = ''): void {
  for (const file of files) {
    const filePath = path ? `${path}/${file.name}` : file.name;
    if (file.type === 'file') {
      zip.file(filePath, file.content ?? '');
    } else if (file.type === 'folder' && file.children) {
      addFilesToZip(zip, file.children, filePath);
    }
  }
}

export async function exportZip(files: FileNode[]): Promise<void> {
  const zip = new JSZip();
  addFilesToZip(zip, files);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'workspace.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
