export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  content?: string;
  children?: FileNode[];
  isUnsaved?: boolean;
}

export interface Tab {
  id: string;
  name: string;
  content: string;
  language: string;
  isUnsaved: boolean;
  filePath: string;
}

export interface EditorSettings {
  theme: 'dark' | 'light';
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
}

export interface WorkspaceState {
  files: FileNode[];
  tabs: Tab[];
  activeTabId: string | null;
  settings: EditorSettings;
}

export interface ConsoleMsg {
  id: string;
  level: 'log' | 'error' | 'warn' | 'info';
  text: string;
  ts: Date;
}
