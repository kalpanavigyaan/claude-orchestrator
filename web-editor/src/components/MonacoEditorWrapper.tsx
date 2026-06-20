import React, { useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';

interface MonacoEditorWrapperProps {
  value: string;
  language: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCursorChange?: (line: number, col: number) => void;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  theme?: 'dark' | 'light';
}

export const MonacoEditorWrapper: React.FC<MonacoEditorWrapperProps> = ({
  value,
  language,
  onChange,
  onSave,
  onCursorChange,
  fontSize,
  tabSize,
  wordWrap,
  minimap,
  theme = 'dark',
}) => {
  const editorRef = useRef<any>(null);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;

    // Save shortcut
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);

    // Format shortcut
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => editor.getAction('editor.action.formatDocument')?.run()
    );

    // Editor options
    editor.updateOptions({
      fontSize,
      tabSize,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: minimap },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      fontLigatures: true,
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true,
      lineDecorationsWidth: 10,
      lineNumbersMinChars: 4,
      padding: { top: 8 },
    });

    // VS Code-like dark theme
    monaco.editor.defineTheme('vscode-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
        { token: 'keyword', foreground: '569cd6' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'type', foreground: '4ec9b0' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editorLineNumber.foreground': '#858585',
        'editorLineNumber.activeForeground': '#c6c6c6',
        'editor.selectionBackground': '#264f78',
        'editor.inactiveSelectionBackground': '#3a3d41',
        'editorIndentGuide.background': '#404040',
        'editorIndentGuide.activeBackground': '#707070',
        'editor.lineHighlightBackground': '#2a2d2e',
        'editorCursor.foreground': '#aeafad',
        'scrollbarSlider.background': '#797979',
        'scrollbarSlider.hoverBackground': '#646464',
        'scrollbarSlider.activeBackground': '#bfbfbf',
      },
    });

    monaco.editor.defineTheme('vscode-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '008000', fontStyle: 'italic' },
        { token: 'keyword', foreground: '0000ff' },
        { token: 'string', foreground: 'a31515' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#000000',
        'editorLineNumber.foreground': '#237893',
        'editor.selectionBackground': '#add6ff',
        'editor.lineHighlightBackground': '#f0f0f0',
      },
    });

    // Cursor position tracking
    if (onCursorChange) {
      editor.onDidChangeCursorPosition((e: any) => {
        onCursorChange(e.position.lineNumber, e.position.column);
      });
    }
  };

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({
        fontSize,
        tabSize,
        wordWrap: wordWrap ? 'on' : 'off',
        minimap: { enabled: minimap },
      });
    }
  }, [fontSize, tabSize, wordWrap, minimap]);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({
        theme: theme === 'dark' ? 'vscode-dark' : 'vscode-light',
      });
    }
  }, [theme]);

  return (
    <div style={{ flex: 1, overflow: 'hidden', background: 'var(--vsc-editor-bg)' }}>
      <Editor
        height="100%"
        language={language}
        value={value}
        onChange={(newValue) => onChange(newValue || '')}
        onMount={handleEditorDidMount}
        theme={theme === 'dark' ? 'vscode-dark' : 'vscode-light'}
        options={{
          selectOnLineNumbers: true,
          roundedSelection: false,
          readOnly: false,
          cursorStyle: 'line',
          automaticLayout: true,
          folding: true,
          foldingHighlight: true,
          showFoldingControls: 'mouseover',
          unfoldOnClickAfterEndOfLine: false,
          dragAndDrop: true,
          formatOnType: true,
          formatOnPaste: true,
        }}
      />
    </div>
  );
};