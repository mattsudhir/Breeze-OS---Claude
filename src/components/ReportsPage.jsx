import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3, TrendingUp, Home, Wrench, DollarSign, FileText,
  Loader2, AlertCircle, Building2,
} from 'lucide-react';
import { getAdminToken } from '../lib/admin';

// Reports — portfolio-wide metrics derived from our own DB
// (list-properties-summary). Headline numbers and the per-property
// occupancy table both reflect post-reimport state.
//
// What's NOT here yet:
//   - Revenue trend (would need a per-month rollup over
//     journal_entries; future endpoint)
//   - Tenant satisfaction (no source data yet)
//   - "Saved & scheduled reports" table — that's a feature, not
//     data; kept as a labeled stub until the report-generation
//     pipeline ships.

function formatCurrency(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatPercent(n) {
  if (n == null) return '—';
  return `${Math.round(n * 10) / 10}%`;
}

async function fetchPortfolio() {
  const token = getAdminToken();
  const qs = token ? `?secret=${encodeURIComponent(token)}` : '';
  try {
    const resp = await fetch(`/api/admin/list-properties-summary${qs}`, {
      headers: token ? { 'X-Breeze-Admin-Token': token } : {},
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      return { error: data.error || `HTTP ${resp.status}` };
    }
    return { properties: data.properties || [] };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
}

export default function ReportsPage() {
  const [properties, setProperties] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetchPortfolio();
      if (cancelled) return;
      if (res.error) {
        setError(res.error);
        setProperties([]);
      } else {
        setProperties(res.properties);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const totals = useMemo(() => {
    if (!properties) return null;
    const t = properties.reduce(
      (acc, p) => ({
        properties: acc.properties + 1,
        units:        acc.units        + (p.unit_count || 0),
        occupied:     acc.occupied     + (p.occupied_count || 0),
        rentCents:    acc.rentCents    + (p.total_monthly_rent_cents || 0),
        openMaint:    acc.openMaint    + (p.open_maintenance_count || 0),
        openArCents:  acc.openArCents  + (p.open_ar_cents || 0),
        ytdIncome:    acc.ytdIncome    + (p.ytd_income_cents || 0),
        ytdExpense:   acc.ytdExpense   + (p.ytd_expense_cents || 0),
      }),
      { properties: 0, units: 0, occupied: 0, rentCents: 0, openMaint: 0,
        openArCents: 0, ytdIncome: 0, ytdExpense: 0 },
    );
    t.occupancyPct = t.units > 0 ? (t.occupied / t.units) * 100 : 0;
    t.monthlyRent = t.rentCents / 100;
    t.openAr = t.openArCents / 100;
    t.ytdIncomeDollars = t.ytdIncome / 100;
    t.ytdExpenseDollars = t.ytdExpense / 100;
    t.ytdNetDollars = (t.ytdIncome - t.ytdExpense) / 100;
    return t;
  }, [properties]);

  const occupancyRows = useMemo(() => {
    if (!properties) return [];
    return properties
      .filter((p) => (p.unit_count || 0) > 0)
      .map((p) => {
        const total = p.unit_count || 0;
        const occupied = p.occupied_count || 0;
        const pct = total > 0 ? Math.round((occupied / total) * 100) : 0;
        return {
          id: p.id,
          name: p.display_name || '—',
          occupied,
          total,
          pct,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);
  }, [properties]);

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading portfolio metrics...</span>
        </div>
      </div>
    );
  }

  const HEADLINE_METRICS = totals ? [
    {
      id: 'occupancy',
      label: 'Portfolio Occupancy',
      value: formatPercent(totals.occupancyPct),
      hint: `${totals.occupied} of ${totals.units} units occupied`,
      icon: Home, color: '#2E7D32',
    },
    {
      id: 'rent',
      label: 'Monthly Rent Roll',
      value: formatCurrency(totals.monthlyRent),
      hint: `across ${totals.properties} properties`,
      icon: DollarSign, color: '#1565C0',
    },
    {
      id: 'maint',
      label: 'Open Work Orders',
      value: String(totals.openMaint),
      hint: totals.openMaint === 0 ? 'queue is clear' : 'across the portfolio',
      icon: Wrench, color: totals.openMaint > 0 ? '#E65100' : '#888',
    },
    {
      id: 'ar',
      label: 'Open Receivables',
      value: formatCurrency(totals.openAr),
      hint: 'tenant balances outstanding',
      icon: DollarSign, color: totals.openAr > 0 ? '#C62828' : '#888',
    },
  ] : [];

  return (
    <div className="properties-page">
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', marginBottom: 16, borderRadius: 8,
          fontSize: 12, fontWeight: 600,
          background: '#FFEBEE', color: '#C62828', border: '1px solid #FFCDD2',
        }}>
          <AlertCircle size={14} /> Couldn't load portfolio: {error}
        </div>
      )}

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1565C015', color: '#1565C0' }}>
            <BarChart3 size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Reports</h2>
            <p className="property-detail-address">
              Live metrics from our DB
              {totals && (
                <span> · {totals.properties} properties · {totals.units} units</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Headline KPIs */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '12px',
        marginBottom: '16px',
      }}>
        {HEADLINE_METRICS.map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.id} className="dashboard-card" style={{ padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <div className="tenant-avatar" style={{ background: `${m.color}15`, color: m.color, width: 36, height: 36 }}>
                  <Icon size={18} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{m.label}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a1a' }}>{m.value}</div>
              {m.hint && (
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{m.hint}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* YTD income/expense — derived from journal_entries that have
          actually been posted. Shows null state until accounting
          entries exist for the year. */}
      {totals && (totals.ytdIncome !== 0 || totals.ytdExpense !== 0) && (
        <div className="dashboard-card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h3><TrendingUp size={18} /> Year-to-date — All Properties</h3>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 16, padding: 16,
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Income</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#2E7D32' }}>
                {formatCurrency(totals.ytdIncomeDollars)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Expense</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#C62828' }}>
                {formatCurrency(totals.ytdExpenseDollars)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Net</div>
              <div style={{
                fontSize: 22, fontWeight: 700,
                color: totals.ytdNetDollars >= 0 ? '#2E7D32' : '#C62828',
              }}>
                {formatCurrency(totals.ytdNetDollars)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Occupancy table */}
      <div className="dashboard-card">
        <div className="card-header">
          <h3><Building2 size={18} /> Occupancy — Top 15 by Unit Count</h3>
          <span style={{ fontSize: 12, color: '#888' }}>
            {occupancyRows.length} of {totals?.properties || 0} properties shown
          </span>
        </div>
        <div style={{ padding: '8px 4px' }}>
          {occupancyRows.length === 0 ? (
            <div style={{ padding: 20, color: '#888', fontSize: 13 }}>
              No properties with units yet.
            </div>
          ) : occupancyRows.map((p) => (
            <div key={p.id} style={{ marginBottom: 14 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginBottom: 4, fontSize: 13,
              }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ color: '#666' }}>{p.occupied}/{p.total} · {p.pct}%</span>
              </div>
              <div style={{ background: '#ECEFF1', borderRadius: 6, height: 8, overflow: 'hidden' }}>
                <div style={{
                  width: `${p.pct}%`,
                  height: '100%',
                  background: p.pct >= 95 ? '#2E7D32' : p.pct >= 90 ? '#0077B6' : '#E65100',
                }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Saved reports — feature stub. Marked as such so users
          don't think the data is fake. */}
      <div className="dashboard-card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3><FileText size={18} /> Saved & Scheduled Reports</h3>
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#E65100',
            background: '#FFF3E0', padding: '2px 8px', borderRadius: 999,
          }}>
            Coming soon
          </span>
        </div>
        <div style={{ padding: 16, color: '#666', fontSize: 13 }}>
          PDF/XLSX exports of rent rolls, delinquency reports, owner
          statements, and maintenance backlogs will appear here once
          the report-generation pipeline ships. Until then, every
          metric in this page is queryable directly from the DB.
        </div>
      </div>
    </div>
  );
}
