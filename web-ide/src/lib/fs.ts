import { FileNode, EditorSettings } from '../types';

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createFile(name: string, content = ''): FileNode {
  return { id: generateId(), name, type: 'file', content, isUnsaved: false };
}

export function createFolder(name: string): FileNode {
  return { id: generateId(), name, type: 'folder', children: [] };
}

export function findById(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function addNode(
  nodes: FileNode[],
  parentId: string | null,
  node: FileNode,
): FileNode[] {
  if (!parentId) return [...nodes, node];
  return nodes.map((n) => {
    if (n.id === parentId && n.type === 'folder') {
      return { ...n, children: [...(n.children || []), node] };
    }
    if (n.children) {
      return { ...n, children: addNode(n.children, parentId, node) };
    }
    return n;
  });
}

export function deleteNode(nodes: FileNode[], id: string): FileNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) =>
      n.children ? { ...n, children: deleteNode(n.children, id) } : n,
    );
}

export function updateContent(
  nodes: FileNode[],
  id: string,
  content: string,
): FileNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, content, isUnsaved: true };
    if (n.children)
      return { ...n, children: updateContent(n.children, id, content) };
    return n;
  });
}

export function getPath(
  nodes: FileNode[],
  id: string,
  prefix = '',
): string {
  for (const node of nodes) {
    const current = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.id === id) return current;
    if (node.children) {
      const found = getPath(node.children, id, current);
      if (found) return found;
    }
  }
  return '';
}

export function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    py: 'python',
    go: 'go',
    rs: 'rust',
    md: 'markdown',
    sh: 'shell',
    bash: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    java: 'java',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    c: 'c',
    rb: 'ruby',
    php: 'php',
  };
  return map[ext] ?? 'plaintext';
}

export const defaultSettings: EditorSettings = {
  theme: 'dark',
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  formatOnSave: true,
};

export const SAMPLE_PROJECT: FileNode[] = [
  createFile(
    'index.html',
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hello World</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="container">
    <h1 class="title">Hello, World!</h1>
    <p class="subtitle">Welcome to the Web IDE</p>
    <button id="btn" class="button">Click me</button>
    <p id="output" class="output"></p>
  </div>
  <script src="script.js"></script>
</body>
</html>`,
  ),
  createFile(
    'styles.css',
    `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #1a1a2e;
  color: #eee;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.container {
  text-align: center;
  padding: 2rem;
}

.title {
  font-size: 3rem;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, #007acc, #00d4ff);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.subtitle {
  font-size: 1.2rem;
  color: #888;
  margin-bottom: 2rem;
}

.button {
  background: #007acc;
  color: white;
  border: none;
  padding: 0.75rem 2rem;
  border-radius: 6px;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

.button:hover {
  background: #005fa3;
}

.output {
  margin-top: 1rem;
  font-size: 1.1rem;
  color: #00d4ff;
  min-height: 1.5rem;
}`,
  ),
  createFile(
    'script.js',
    `const btn = document.getElementById('btn');
const output = document.getElementById('output');
let clickCount = 0;

btn.addEventListener('click', () => {
  clickCount++;
  output.textContent = \`Button clicked \${clickCount} time\${clickCount === 1 ? '' : 's'}!\`;
  console.log('Button clicked!', { count: clickCount });
});

console.log('Script loaded successfully!');`,
  ),
];
