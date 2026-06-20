import React, { useRef, useEffect } from "react";
import { Trash2 } from "lucide-react";

interface ConsoleMessage {
  id: string;
  level: "log" | "error" | "warn";
  args: string[];
  timestamp: Date;
}

interface TerminalPanelProps {
  messages: ConsoleMessage[];
  onClear: () => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ messages, onClear }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--vsc-editor-bg)" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        padding: "2px 8px", borderBottom: "1px solid var(--vsc-border)",
        background: "var(--vsc-tab-bg)",
      }}>
        <button className="vsc-icon-btn" onClick={onClear} title="Clear Console"
          style={{ fontSize: 11, gap: 4, display: "flex", alignItems: "center" }}>
          <Trash2 size={12} /> <span>Clear</span>
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {messages.length === 0 ? (
          <div style={{ padding: "12px 16px", color: "var(--vsc-muted)", fontSize: 12 }}>
            Console output will appear here. Run the preview to see messages.
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`vsc-terminal-line ${msg.level}`}>
              <span className="vsc-terminal-prefix">{fmt(msg.timestamp)}</span>
              <span style={{ opacity: 0.6, marginRight: 6, fontSize: 10 }}>
                {msg.level === "error" ? "✕" : msg.level === "warn" ? "⚠" : "›"}
              </span>
              {msg.args.join(" ")}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
};
