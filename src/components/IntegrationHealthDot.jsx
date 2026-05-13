// Topbar status dot for integration health. Green / yellow / red / grey
// based on the overall_status reported by /api/admin/list-integration-health.
// Popover shows every integration's last status + last error message,
// plus a "Probe all now" button that runs the same probes the cron does.

import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, AlertTriangle, AlertCircle, RefreshCw, X } from 'lucide-react';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const ADMIN_TOKEN_KEY = 'breeze.admin.token';
const getToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
};

const STATUS_META = {
  ok:       { color: '#2E7D32', bg: '#E8F5E9', label: 'Healthy',  Icon: CheckCircle2 },
  degraded: { color: '#EF6C00', bg: '#FFF3E0', label: 'Degraded', Icon: AlertTriangle },
  down:     { color: '#C62828', bg: '#FFEBEE', label: 'Down',     Icon: AlertCircle },
  unknown:  { color: '#757575', bg: '#ECEFF1', label: 'Unknown',  Icon: Activity },
};

function fmtTime(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return d; }
}

export default function IntegrationHealthDot() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const url = new URL('/api/admin/list-integration-health', window.location.origin);
      url.searchParams.set('secret', getToken());
      const r = await fetch(url.toString());
      if (!r.ok) return;
      setData(await r.json());
      setError(null);
    } catch {
      // silent — dot just stays grey
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const probeAll = async () => {
    setProbing(true);
    setError(null);
    try {
      const url = new URL('/api/admin/probe-integrations', window.location.origin);
      url.searchParams.set('secret', getToken());
      const r = await fetch(url.toString(), { method: 'POST' });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setProbing(false);
    }
  };

  const overall = data?.overall_status || 'unknown';
  const meta = STATUS_META[overall];
  const integrations = data?.integrations || [];

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Integration health: ${meta.label}`}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 4,
          display: 'inline-flex', alignItems: 'center', position: 'relative',
        }}
      >
        <Activity size={18} color="#666" />
        <span style={{
          position: 'absolute', top: 4, right: 4,
          width: 9, height: 9, borderRadius: '50%',
          background: meta.color,
          border: '1.5px solid #fff',
        }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0,
          width: 340, background: 'white', border: '1px solid #DDD',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          zIndex: 200, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid #EEE',
            background: meta.bg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <meta.Icon size={16} color={meta.color} />
              <strong style={{ fontSize: 13, color: meta.color }}>
                Integrations: {meta.label}
              </strong>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#666', padding: 2 }}
            ><X size={14} /></button>
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {integrations.length === 0 ? (
              <div style={{ padding: 14, fontSize: 12, color: '#666' }}>
                No probes run yet. Click "Probe all" to check every integration.
              </div>
            ) : integrations.map((i) => {
              const m = STATUS_META[i.status] || STATUS_META.unknown;
              return (
                <div key={i.name} style={{
                  padding: '10px 12px', borderBottom: '1px solid #F4F4F4',
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        background: m.color,
                      }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{i.display_name}</span>
                    </div>
                    <span style={{ fontSize: 11, color: m.color, fontWeight: 600 }}>{m.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4, marginLeft: 14 }}>
                    Last success: {fmtTime(i.last_success_at)}
                    {i.last_failure_at && i.status !== 'ok' && (
                      <> · Last failure: {fmtTime(i.last_failure_at)}</>
                    )}
                  </div>
                  {i.last_error_message && i.status !== 'ok' && (
                    <div style={{
                      marginTop: 6, marginLeft: 14, padding: '4px 8px',
                      background: '#FFEBEE', border: '1px solid #FFCDD2',
                      borderRadius: 4, fontSize: 10, color: '#C62828',
                      fontFamily: 'monospace', wordBreak: 'break-word',
                    }}>{i.last_error_message}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{
            padding: '10px 12px', borderTop: '1px solid #EEE',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}>
            <button
              type="button"
              onClick={probeAll}
              disabled={probing}
              style={{
                padding: '5px 10px', border: '1px solid #1976D2', background: 'white',
                color: '#1976D2', borderRadius: 6, cursor: probing ? 'wait' : 'pointer',
                fontSize: 12, fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >
              {probing
                ? <><RefreshCw size={12} className="spin" /> Probing…</>
                : <><RefreshCw size={12} /> Probe all</>}
            </button>
            {error && (
              <span style={{ fontSize: 11, color: '#C62828', flex: 1, textAlign: 'right' }}>
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
