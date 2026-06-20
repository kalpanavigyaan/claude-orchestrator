import React, { useCallback, useEffect, useState } from 'react';
import { Monitor, Server, Box } from 'lucide-react';
import { apiGet } from './api';
import type { VM } from './types';

const GROUP_ORDER: VM['type'][] = ['wsl', 'hyperv', 'vmware', 'virtualbox'];

const GROUP_LABELS: Record<string, string> = {
  wsl:        'WSL',
  hyperv:     'Hyper-V',
  vmware:     'VMware',
  virtualbox: 'VirtualBox',
};

function stateColor(state: string | undefined): string {
  if (!state) return 'var(--muted)';
  switch (state.toLowerCase()) {
    case 'running': return 'var(--green)';
    case 'paused':  return 'var(--amber)';
    default:        return 'var(--muted)';
  }
}

function VmIcon({ type }: { type: VM['type'] }) {
  const s = { width: 13, height: 13, color: 'var(--muted)', flexShrink: 0 as const };
  switch (type) {
    case 'wsl':    return <Monitor {...s} />;
    case 'hyperv': return <Server  {...s} />;
    default:       return <Box     {...s} />;
  }
}

export default function VMsPanel() {
  const [vms,     setVms]     = useState<VM[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Same fallback as electron app: try /api/wsl/distros (web context has no native VM scan)
    const d = await apiGet('/api/wsl/distros');
    if (d?.distros && Array.isArray(d.distros)) {
      const mapped: VM[] = (d.distros as Array<{name:string;state:string;default?:boolean;version?:number}>).map(dist => ({
        name: dist.name,
        type: 'wsl' as const,
        state: /running/i.test(dist.state) ? 'running' : 'stopped',
        distro: dist.name,
      }));
      setVms(mapped);
    } else if (d === null) {
      setError('Failed to load VMs — is the orchestrator running?');
    } else {
      setVms([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Group VMs by type
  const grouped = vms.reduce<Partial<Record<string, VM[]>>>((acc, vm) => {
    const k = vm.type ?? 'other';
    if (!acc[k]) acc[k] = [];
    acc[k]!.push(vm);
    return acc;
  }, {});

  const extraKeys = Object.keys(grouped).filter(k => !(GROUP_ORDER as string[]).includes(k));
  const allGroups = ([...GROUP_ORDER, ...extraKeys] as string[]).filter(k => grouped[k]?.length);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--sb-bg)', fontSize: 12, color: 'var(--sb-fg)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 6px 4px 10px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 9, textTransform: 'uppercase',
          letterSpacing: '0.07em', color: 'var(--sb-hdr-fg)', fontWeight: 600,
        }}>
          Virtual Machines
        </span>
        <button
          onClick={load}
          title="Refresh"
          disabled={loading}
          style={{
            background: 'none', border: 'none',
            color: loading ? 'var(--muted)' : 'var(--sb-fg)',
            cursor: loading ? 'default' : 'pointer',
            fontSize: 14, padding: '2px 5px', borderRadius: 2,
            lineHeight: 1,
          }}
        >
          ↻
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--muted)' }}>Loading…</div>
        )}
        {error && !loading && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--red)' }}>{error}</div>
        )}
        {!loading && !error && vms.length === 0 && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
            No virtual machines found.
          </div>
        )}

        {allGroups.map(type => (
          <div key={type}>
            {/* Group sub-header */}
            <div style={{
              padding: '4px 10px',
              fontSize: 9, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--muted)',
              background: 'var(--tab-strip, rgba(0,0,0,.15))',
              borderBottom: '1px solid var(--border)',
            }}>
              {GROUP_LABELS[type] ?? type}
            </div>

            {grouped[type]!.map(vm => {
              const color = stateColor(vm.state);
              return (
                <div key={vm.name} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <VmIcon type={vm.type} />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {vm.name}
                    </div>
                    {vm.distro && (
                      <div style={{
                        fontSize: 10, color: 'var(--muted)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {vm.distro}
                      </div>
                    )}
                  </div>
                  {/* State chip */}
                  <div style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 8,
                    border: `1px solid ${color}`, color,
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}>
                    {vm.state ?? 'Unknown'}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
