import React from 'react';
import { BarChart2, Monitor, Cpu, Terminal, GitBranch, Folder, ListOrdered, Wand2, ScrollText } from 'lucide-react';
import type { RightPanel } from './types';

interface Props {
  activePanel: RightPanel;
  onPanelChange: (p: RightPanel) => void;
}

const BUTTONS: { panel: RightPanel; icon: React.ReactNode; title: string; color: string }[] = [
  { panel: 'usage',        icon: <BarChart2    size={20} strokeWidth={1.5} />, title: 'Usage Statistics',       color: '#4ade80' },
  { panel: 'vms',          icon: <Monitor      size={20} strokeWidth={1.5} />, title: 'Virtual Machines (WSL)',  color: '#fbbf24' },
  { panel: 'intelligence', icon: <Cpu          size={20} strokeWidth={1.5} />, title: 'Intelligence Tools',      color: '#c678dd' },
  { panel: 'commands',     icon: <Terminal     size={20} strokeWidth={1.5} />, title: 'Slash Commands',          color: '#61afef' },
  { panel: 'repos',        icon: <GitBranch    size={20} strokeWidth={1.5} />, title: 'Repositories',            color: '#e5c07b' },
  { panel: 'directories',  icon: <Folder       size={20} strokeWidth={1.5} />, title: 'Directories',             color: '#56b6c2' },
  { panel: 'queue',        icon: <ListOrdered  size={20} strokeWidth={1.5} />, title: 'Instruction Queue',       color: '#f97316' },
  { panel: 'skills',       icon: <Wand2        size={20} strokeWidth={1.5} />, title: 'Skills Library',          color: '#38bdf8' },
  { panel: 'instructions', icon: <ScrollText   size={20} strokeWidth={1.5} />, title: 'Instructions',            color: '#a78bfa' },
];

export default function RightActivityBar({ activePanel, onPanelChange }: Props) {
  return (
    <div style={{
      width: 40, flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: 'var(--ab-bg)',
      borderLeft: '1px solid var(--ab-border)',
      paddingTop: 4,
    }}>
      {BUTTONS.map(({ panel, icon, title, color }) => {
        const active = activePanel === panel;
        return (
          <button
            key={panel}
            title={title}
            onClick={() => onPanelChange(panel)}
            style={{
              width: 40, height: 44,
              background: 'transparent', border: 'none',
              borderRight: active ? `2px solid ${color}` : '2px solid transparent',
              color: active ? color : 'var(--ab-fg)',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative',
              transition: 'color .12s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = color; }}
            onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--ab-fg)'; }}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
