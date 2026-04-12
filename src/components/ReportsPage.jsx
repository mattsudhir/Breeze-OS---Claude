import {
  BarChart3, TrendingUp, TrendingDown, Building2, Users, Wrench,
  DollarSign, FileText, Download, ArrowRight,
} from 'lucide-react';

// Placeholder reports data — once we have a reports service backing
// Breeze, these cards will link to live PDF/CSV exports and inline
// chart renders. For now they're static so the page looks populated
// during demos and the layout can be reviewed.

const PORTFOLIO_KPIS = [
  { label: 'Occupancy rate', value: '94.2%', delta: 1.8, good: true, icon: Building2 },
  { label: 'Avg days vacant', value: '12.4', delta: -2.1, good: true, icon: Building2 },
  { label: 'Rent collected (YTD)', value: '$1.42M', delta: 6.3, good: true, icon: DollarSign },
  { label: 'Open work orders', value: '37', delta: -8, good: true, icon: Wrench },
  { label: 'Active tenants', value: '284', delta: 4, good: true, icon: Users },
  { label: 'Lease renewals (90d)', value: '18', delta: 2, good: true, icon: FileText },
];

const STANDARD_REPORTS = [
  {
    id: 'rent-roll',
    title: 'Rent Roll',
    description: 'Per-unit rent, lease dates, tenants, and current balances across the portfolio.',
    category: 'Financial',
    lastRun: 'Apr 11, 2026',
  },
  {
    id: 'delinquency',
    title: 'Delinquency Report',
    description: 'Outstanding balances aged into 0–30, 31–60, 61–90, and 90+ day buckets.',
    category: 'Financial',
    lastRun: 'Apr 11, 2026',
  },
  {
    id: 'income-statement',
    title: 'Income Statement',
    description: 'Revenue, operating expenses, and NOI by property for the current period.',
    category: 'Financial',
    lastRun: 'Apr 1, 2026',
  },
  {
    id: 'cash-flow',
    title: 'Cash Flow Statement',
    description: 'Inflows and outflows by account over the selected period.',
    category: 'Financial',
    lastRun: 'Apr 1, 2026',
  },
  {
    id: 'vacancy',
    title: 'Vacancy Summary',
    description: 'Current vacancies, days on market, and market rent vs. asking rent deltas.',
    category: 'Occupancy',
    lastRun: 'Apr 10, 2026',
  },
  {
    id: 'turn-time',
    title: 'Unit Turnover',
    description: 'Turn time, make-ready costs, and downtime by property over the past 12 months.',
    category: 'Occupancy',
    lastRun: 'Apr 5, 2026',
  },
  {
    id: 'wo-summary',
    title: 'Work Order Summary',
    description: 'Open vs. completed, average resolution time, and category breakdown.',
    category: 'Maintenance',
    lastRun: 'Apr 11, 2026',
  },
  {
    id: 'vendor-spend',
    title: 'Vendor Spend',
    description: 'Year-to-date spend by vendor and category, ranked by dollar volume.',
    category: 'Maintenance',
    lastRun: 'Apr 8, 2026',
  },
  {
    id: 'lease-expirations',
    title: 'Lease Expirations',
    description: 'Leases ending in the next 30, 60, and 90 days with renewal status.',
    category: 'Leasing',
    lastRun: 'Apr 11, 2026',
  },
];

const CATEGORY_COLORS = {
  Financial: { bg: '#E8F5E9', color: '#2E7D32' },
  Occupancy: { bg: '#E3F2FD', color: '#1976D2' },
  Maintenance: { bg: '#FFF3E0', color: '#E65100' },
  Leasing: { bg: '#F3E5F5', color: '#7B1FA2' },
};

export default function ReportsPage() {
  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <BarChart3 size={14} /> Preview — KPIs and reports are sample content; wiring live exports is tracked separately
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#7B1FA215', color: '#7B1FA2' }}>
            <BarChart3 size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Reports</h2>
            <p className="property-detail-address">
              {STANDARD_REPORTS.length} standard reports · Portfolio snapshot as of April 12, 2026
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Download size={14} /> Export Portfolio
        </button>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><TrendingUp size={18} /> Portfolio KPIs</h3>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '14px',
          padding: '16px 20px',
        }}>
          {PORTFOLIO_KPIS.map((kpi) => {
            const Icon = kpi.icon;
            const deltaPositive = kpi.delta >= 0;
            // "Good" depends on whether up-is-good or down-is-good for
            // this metric. kpi.good expresses that intent directly.
            const deltaColor = kpi.good === (deltaPositive || kpi.delta < 0)
              ? '#2E7D32'
              : '#C62828';
            return (
              <div key={kpi.label} style={{
                padding: '14px 16px',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                background: '#FAFAFA',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#666' }}>
                  <Icon size={14} />
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>
                    {kpi.label}
                  </span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#222', marginTop: 6 }}>
                  {kpi.value}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4, marginTop: 2,
                  fontSize: 12, fontWeight: 600, color: deltaColor,
                }}>
                  {deltaPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  {deltaPositive ? '+' : ''}{kpi.delta}{typeof kpi.delta === 'number' && kpi.label.includes('%') ? 'pts' : ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><FileText size={18} /> Standard Reports</h3>
        </div>
        <div className="tenants-list">
          {STANDARD_REPORTS.map((r) => {
            const cat = CATEGORY_COLORS[r.category] || CATEGORY_COLORS.Financial;
            return (
              <div key={r.id} className="tenant-row" style={{ cursor: 'pointer' }}>
                <div className="tenant-avatar" style={{ background: cat.bg, color: cat.color }}>
                  <FileText size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{r.title}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item" style={{ maxWidth: 520 }}>
                      {r.description}
                    </span>
                  </div>
                  <div className="tenant-contact" style={{ marginTop: 2 }}>
                    <span className="tenant-contact-item">Last run {r.lastRun}</span>
                    <span className="tenant-contact-item" style={{
                      background: cat.bg,
                      color: cat.color,
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontWeight: 600,
                    }}>
                      {r.category}
                    </span>
                  </div>
                </div>
                <ArrowRight size={16} style={{ color: '#888' }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
