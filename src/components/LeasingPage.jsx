import { useEffect, useMemo, useState } from 'react';
import {
  FileText, Calendar, DollarSign, Home, AlertCircle, Loader2,
  Users,
} from 'lucide-react';
import { getAdminToken } from '../lib/admin';

// Leasing — currently a read-only view over our DB's leases via
// /api/admin/list-tenants (which already returns each tenant with
// their current lease + unit + property).
//
// Active deliverables:
//   - Headline KPIs: active leases, total rent roll, expiring soon
//   - Lease expirations table for the next 90 days (renewal queue)
//   - Active leases table
//
// Marked as not-yet-built:
//   - Applications / screening / pipeline (no `applications` table
//     yet; the surface is a stub with a "Coming soon" pill so
//     users don't think the data is fake).
//   - New-lease creation flow (also "Coming soon").

function formatCurrency(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(d);
  }
}

function daysUntil(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / (1000 * 60 * 60 * 24));
}

async function fetchTenantsWithLeases() {
  const token = getAdminToken();
  const qs = token ? `?secret=${encodeURIComponent(token)}` : '';
  try {
    const resp = await fetch(`/api/admin/list-tenants${qs}`, {
      headers: token ? { 'X-Breeze-Admin-Token': token } : {},
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      return { error: data.error || `HTTP ${resp.status}` };
    }
    return { tenants: data.tenants || [] };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
}

export default function LeasingPage() {
  const [tenants, setTenants] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetchTenantsWithLeases();
      if (cancelled) return;
      if (res.error) {
        setError(res.error);
        setTenants([]);
      } else {
        setTenants(res.tenants);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Tenant-on-lease rows for the renewal table and the all-leases
  // table. Co-tenants on the same lease produce multiple rows; that's
  // what those tables want (so each tenant is visible). Counting and
  // summing rent happens against the deduplicated set below.
  const tenantLeaseRows = useMemo(() => {
    if (!tenants) return [];
    return tenants
      .filter((t) => t.status === 'current' && t.lease_id)
      .map((t) => ({
        id: t.lease_id,
        tenant: t.name,
        tenantId: t.id,
        unit: [t.unitName, t.propertyName].filter(Boolean).join(' · '),
        unitName: t.unitName,
        propertyName: t.propertyName,
        rent: t.rent,
        start: t.lease_start_date,
        end: t.lease_end_date,
        role: t.lease_role,
        daysUntilEnd: daysUntil(t.lease_end_date),
      }));
  }, [tenants]);

  // Unique-by-lease set for headline counts + rent roll. A lease with
  // two tenants on it is ONE lease and ONE rent obligation, not two.
  // Keep the primary tenant's row when there's one; otherwise first
  // seen wins.
  const uniqueLeases = useMemo(() => {
    const byLease = new Map();
    for (const row of tenantLeaseRows) {
      const existing = byLease.get(row.id);
      if (!existing) {
        byLease.set(row.id, row);
      } else if (row.role === 'primary' && existing.role !== 'primary') {
        byLease.set(row.id, row);
      }
    }
    return [...byLease.values()];
  }, [tenantLeaseRows]);

  // The expiring-in-90-days table also dedupes — one card per lease.
  const expiring = useMemo(() => {
    return uniqueLeases
      .filter((l) => l.daysUntilEnd != null && l.daysUntilEnd >= 0 && l.daysUntilEnd <= 90)
      .sort((a, b) => a.daysUntilEnd - b.daysUntilEnd);
  }, [uniqueLeases]);

  const totals = useMemo(() => {
    const t = uniqueLeases.reduce(
      (acc, l) => ({
        count:        acc.count + 1,
        rentRoll:     acc.rentRoll + (l.rent || 0),
        expiringSoon: acc.expiringSoon + (l.daysUntilEnd != null && l.daysUntilEnd <= 60 ? 1 : 0),
      }),
      { count: 0, rentRoll: 0, expiringSoon: 0 },
    );
    return t;
  }, [uniqueLeases]);

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading leases...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="properties-page">
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', marginBottom: 16, borderRadius: 8,
          fontSize: 12, fontWeight: 600,
          background: '#FFEBEE', color: '#C62828', border: '1px solid #FFCDD2',
        }}>
          <AlertCircle size={14} /> Couldn't load leases: {error}
        </div>
      )}

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1565C015', color: '#1565C0' }}>
            <FileText size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Leasing</h2>
            <p className="property-detail-address">
              {totals.count} active leases · {formatCurrency(totals.rentRoll)}/mo · {totals.expiringSoon} expiring in 60 days
            </p>
          </div>
        </div>
      </div>

      {/* Headline KPIs */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12, marginBottom: 16,
      }}>
        {[
          { label: 'Active Leases',   value: String(totals.count),                    icon: FileText, color: '#1565C0' },
          { label: 'Rent Roll/mo',    value: formatCurrency(totals.rentRoll),         icon: DollarSign, color: '#2E7D32' },
          { label: 'Expiring (60d)',  value: String(totals.expiringSoon),
            icon: AlertCircle,
            color: totals.expiringSoon > 0 ? '#E65100' : '#888' },
          { label: 'Total Tenants',   value: String((tenants || []).length),          icon: Users, color: '#6A1B9A' },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="dashboard-card" style={{ padding: '14px 16px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                color: '#666', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                <Icon size={14} style={{ color: kpi.color }} />
                {kpi.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#222', marginTop: 4 }}>
                {kpi.value}
              </div>
            </div>
          );
        })}
      </div>

      {/* Expiring soon — actionable view */}
      <div className="dashboard-card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3><Calendar size={18} /> Expiring in the next 90 days</h3>
          <span style={{ fontSize: 12, color: '#888' }}>
            {expiring.length} lease{expiring.length === 1 ? '' : 's'}
          </span>
        </div>
        {expiring.length === 0 ? (
          <div style={{ padding: 16, color: '#888', fontSize: 13 }}>
            Nothing expires in the next 90 days. Good news — no renewal queue to clear.
          </div>
        ) : (
          <table className="properties-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Unit · Property</th>
                <th style={{ textAlign: 'right' }}>Rent</th>
                <th>Ends</th>
                <th style={{ textAlign: 'right' }}>Days</th>
              </tr>
            </thead>
            <tbody>
              {expiring.map((l) => {
                const urgent = l.daysUntilEnd <= 30;
                return (
                  <tr key={l.id + '-' + l.tenantId}>
                    <td style={{ fontWeight: 600 }}>{l.tenant}</td>
                    <td style={{ color: '#666' }}>
                      <Home size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                      {l.unit || '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(l.rent)}</td>
                    <td style={{ color: '#666' }}>{formatDate(l.end)}</td>
                    <td style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: urgent ? '#C62828' : '#E65100',
                    }}>
                      {l.daysUntilEnd}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Active leases — one row per tenant (so couples show both
          names), with the lease count itself surfaced separately
          from the row count so the user can tell them apart. */}
      <div className="dashboard-card">
        <div className="card-header">
          <h3><FileText size={18} /> All Active Leases</h3>
          <span style={{ fontSize: 12, color: '#888' }}>
            {uniqueLeases.length} lease{uniqueLeases.length === 1 ? '' : 's'}
            {tenantLeaseRows.length !== uniqueLeases.length && (
              <> · {tenantLeaseRows.length} tenant rows</>
            )}
          </span>
        </div>
        {tenantLeaseRows.length === 0 ? (
          <div style={{ padding: 16, color: '#888', fontSize: 13 }}>
            No active leases yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="properties-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Unit · Property</th>
                  <th style={{ textAlign: 'right' }}>Rent/mo</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {tenantLeaseRows.slice(0, 250).map((l) => (
                  <tr key={l.id + '-' + l.tenantId}>
                    <td style={{ fontWeight: 600 }}>{l.tenant}</td>
                    <td style={{ color: '#666' }}>{l.unit || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(l.rent)}</td>
                    <td style={{ color: '#666' }}>{formatDate(l.start)}</td>
                    <td style={{ color: '#666' }}>{formatDate(l.end)}</td>
                    <td style={{ color: '#666' }}>{l.role || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tenantLeaseRows.length > 250 && (
              <div style={{
                padding: '12px 16px', color: '#888', fontSize: 12,
                borderTop: '1px solid #eee', textAlign: 'center',
              }}>
                Showing first 250 of {tenantLeaseRows.length} tenant rows
                ({uniqueLeases.length} unique leases).
              </div>
            )}
          </div>
        )}
      </div>

      {/* Applications pipeline — feature stub */}
      <div className="dashboard-card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3><Users size={18} /> Applications & Screening Pipeline</h3>
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#E65100',
            background: '#FFF3E0', padding: '2px 8px', borderRadius: 999,
          }}>
            Coming soon
          </span>
        </div>
        <div style={{ padding: 16, color: '#666', fontSize: 13 }}>
          The application pipeline (intake → screening → approval →
          signed) needs its own `applications` table; it'll be wired
          up when leasing flows ship. For now this page surfaces the
          read-side of existing leases only.
        </div>
      </div>
    </div>
  );
}
