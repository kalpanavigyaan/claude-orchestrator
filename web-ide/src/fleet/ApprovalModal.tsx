import React, { useState } from 'react';
import { apiPost } from '../fleet/api';

interface Approval {
  id: string;
  tool?: string;
  input?: unknown;
  description?: string;
}

interface Props {
  approval: Approval | null;
  sessionId: string | null;
  onResolved: () => void;
}

export function ApprovalModal({ approval, sessionId, onResolved }: Props) {
  const [loading, setLoading] = useState(false);

  if (!approval || !sessionId) return null;

  async function decide(decision: 'allow' | 'deny') {
    if (!sessionId || !approval) return;
    setLoading(true);
    await apiPost(`/api/sessions/${sessionId}/approval`, { id: approval.id, decision });
    setLoading(false);
    onResolved();
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--sb-bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        width: 460,
        maxWidth: '95vw',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600,
          fontSize: 14,
          color: 'var(--sb-fg)',
        }}>
          Tool Approval Request
        </div>

        {/* Body */}
        <div style={{ padding: '14px 16px' }}>
          {approval.tool && (
            <div style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Tool</span>
              <div style={{
                marginTop: 3,
                fontFamily: 'monospace',
                fontSize: 13,
                color: 'var(--cyan, #67e8f9)',
                background: 'rgba(103,232,249,.08)',
                padding: '4px 8px',
                borderRadius: 3,
              }}>
                {approval.tool}
              </div>
            </div>
          )}

          {approval.description && (
            <div style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Description</span>
              <div style={{ marginTop: 3, fontSize: 13, color: 'var(--sb-fg)', lineHeight: 1.5 }}>
                {approval.description}
              </div>
            </div>
          )}

          {approval.input != null && (
            <div style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Input</span>
              <pre style={{
                marginTop: 3,
                background: 'rgba(255,255,255,.04)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '8px 10px',
                fontSize: 12,
                fontFamily: 'monospace',
                color: 'var(--sb-fg)',
                overflowX: 'auto',
                maxHeight: 200,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {JSON.stringify(approval.input, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{
          display: 'flex', gap: 10, padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={() => decide('deny')}
            disabled={loading}
            style={{
              background: 'rgba(248,113,113,.15)',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              padding: '6px 18px',
              borderRadius: 3,
              cursor: loading ? 'default' : 'pointer',
              fontSize: 13,
              opacity: loading ? 0.5 : 1,
            }}
          >
            Deny
          </button>
          <button
            onClick={() => decide('allow')}
            disabled={loading}
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: '#fff',
              padding: '6px 18px',
              borderRadius: 3,
              cursor: loading ? 'default' : 'pointer',
              fontSize: 13,
              opacity: loading ? 0.5 : 1,
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
