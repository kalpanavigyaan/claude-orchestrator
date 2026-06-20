import { useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCursorChange: (line: number, col: number) => void;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  theme: 'dark' | 'light';
}

export function MonacoEditor({
  value,
  language,
  onChange,
  onSave,
  onCursorChange,
  fontSize,
  tabSize,
  wordWrap,
  minimap,
  theme,
}: MonacoEditorProps) {
  const onSaveRef = useRef(onSave);
  const onCursorChangeRef = useRef(onCursorChange);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);

  const handleMount: OnMount = (editor, monacoInstance) => {
    monacoInstance.editor.defineTheme('vsc-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.lineHighlightBackground': '#2a2d2e',
        'editor.selectionBackground': '#264f78',
      },
    });

    monacoInstance.editor.defineTheme('vsc-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {},
    });

    monacoInstance.editor.setTheme(theme === 'dark' ? 'vsc-dark' : 'vsc-light');

    // Ctrl+S to save
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => {
        onSaveRef.current();
      },
    );

    // Ctrl+Shift+F to format document
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd |
        monacoInstance.KeyMod.Shift |
        monacoInstance.KeyCode.KeyF,
      () => {
        editor.getAction('editor.action.formatDocument')?.run();
      },
    );

    // Cursor position listener
    editor.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
      onCursorChangeRef.current(e.position.lineNumber, e.position.column);
    });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Editor
        height="100%"
        value={value}
        language={language}
        theme={theme === 'dark' ? 'vsc-dark' : 'vsc-light'}
        onChange={(val) => onChange(val ?? '')}
        onMount={handleMount}
        options={{
          fontSize,
          tabSize,
          wordWrap: wordWrap ? 'on' : 'off',
          minimap: { enabled: minimap },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          padding: { top: 8 },
          folding: true,
        }}
      />
    </div>
  );
}
