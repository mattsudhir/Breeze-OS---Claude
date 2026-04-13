import { BarChart3, Download, TrendingUp, Home, Users, Wrench, DollarSign, FileText, Calendar } from 'lucide-react';

// Placeholder reports data — dashboards will be wired to live metrics next.
const HEADLINE_METRICS = [
  { id: 'occupancy', label: 'Portfolio Occupancy', value: '94.2%', trend: '+1.4pp', up: true, icon: Home, color: '#2E7D32' },
  { id: 'collections', label: 'Collections Rate', value: '98.1%', trend: '+0.3pp', up: true, icon: DollarSign, color: '#1565C0' },
  { id: 'avgTurn', label: 'Avg. Turn Time', value: '6.3 days', trend: '-0.8d', up: true, icon: Wrench, color: '#E65100' },
  { id: 'satisfaction', label: 'Tenant Satisfaction', value: '4.6 / 5', trend: '+0.1', up: true, icon: Users, color: '#6A1B9A' },
];

const OCCUPANCY_BY_PROPERTY = [
  { name: 'Oakwood Apartments', occupied: 23, total: 24, pct: 96 },
  { name: 'Birchwood Commons', occupied: 41, total: 44, pct: 93 },
  { name: 'Maple Grove', occupied: 17, total: 18, pct: 94 },
  { name: 'Willow Creek Villas', occupied: 11, total: 12, pct: 92 },
  { name: 'Cedar Park Townhomes', occupied: 8, total: 8, pct: 100 },
];

const SAVED_REPORTS = [
  { id: 'rpt-1', name: 'Monthly Rent Roll', type: 'Financial', schedule: 'Monthly · 1st', lastRun: 'Apr 1, 2026', format: 'PDF' },
  { id: 'rpt-2', name: 'Delinquency Report', type: 'Financial', schedule: 'Weekly · Mon', lastRun: 'Apr 6, 2026', format: 'XLSX' },
  { id: 'rpt-3', name: 'Maintenance Backlog', type: 'Operations', schedule: 'Weekly · Fri', lastRun: 'Apr 10, 2026', format: 'PDF' },
  { id: 'rpt-4', name: 'Vacancy & Turn Report', type: 'Operations', schedule: 'Monthly · 1st', lastRun: 'Apr 1, 2026', format: 'PDF' },
  { id: 'rpt-5', name: 'Owner Statement — Oakwood', type: 'Owner', schedule: 'Monthly · 5th', lastRun: 'Apr 5, 2026', format: 'PDF' },
  { id: 'rpt-6', name: 'Lease Expiration Forecast (90d)', type: 'Leasing', schedule: 'Weekly · Mon', lastRun: 'Apr 6, 2026', format: 'XLSX' },
];

const REVENUE_TREND = [
  { month: 'Nov', revenue: 162 },
  { month: 'Dec', revenue: 168 },
  { month: 'Jan', revenue: 171 },
  { month: 'Feb', revenue: 175 },
  { month: 'Mar', revenue: 179 },
  { month: 'Apr', revenue: 184 },
];

export default function ReportsPage() {
  const maxRevenue = Math.max(...REVENUE_TREND.map((r) => r.revenue));

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <BarChart3 size={14} /> Preview — sample metrics while reporting pipelines are wired up
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1565C015', color: '#1565C0' }}>
            <BarChart3 size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Reports</h2>
            <p className="property-detail-address">
              Live portfolio metrics · {SAVED_REPORTS.length} saved reports
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Download size={14} /> Export All
        </button>
      </div>

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
              <div style={{ fontSize: 12, fontWeight: 600, color: m.up ? '#2E7D32' : '#C62828', marginTop: 4 }}>
                <TrendingUp size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -2 }} />
                {m.trend} vs prior period
              </div>
            </div>
          );
        })}
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><TrendingUp size={18} /> Revenue — Last 6 Months ($K)</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '18px', padding: '20px 8px 8px', height: 180 }}>
          {REVENUE_TREND.map((r) => {
            const height = (r.revenue / maxRevenue) * 140;
            return (
              <div key={r.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#666' }}>${r.revenue}K</span>
                <div style={{
                  width: '100%',
                  height,
                  background: 'linear-gradient(180deg, #0077B6, #023E8A)',
                  borderRadius: '6px 6px 0 0',
                }} />
                <span style={{ fontSize: 11, color: '#888' }}>{r.month}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Home size={18} /> Occupancy by Property</h3>
        </div>
        <div style={{ padding: '8px 4px' }}>
          {OCCUPANCY_BY_PROPERTY.map((p) => (
            <div key={p.name} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
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

      <div className="dashboard-card">
        <div className="card-header">
          <h3><FileText size={18} /> Saved & Scheduled Reports</h3>
        </div>
        <table className="properties-table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Type</th>
              <th>Schedule</th>
              <th>Last Run</th>
              <th>Format</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SAVED_REPORTS.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td style={{ color: '#666' }}>{r.type}</td>
                <td style={{ color: '#666' }}>
                  <Calendar size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                  {r.schedule}
                </td>
                <td style={{ color: '#666' }}>{r.lastRun}</td>
                <td>
                  <span className="unit-status status-in_progress">{r.format}</span>
                </td>
                <td>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>
                    <Download size={12} /> Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
