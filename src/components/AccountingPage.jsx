import {
  DollarSign, TrendingUp, TrendingDown, AlertCircle, Clock, CheckCircle2,
  ArrowUpRight, ArrowDownRight, Receipt,
} from 'lucide-react';

// Placeholder accounting data — when the RM GL / charges / payments
// endpoints are wired, we'll swap the static figures below for a live
// financial snapshot. Kept rough-order-of-magnitude realistic so
// screenshots look credible during demos.

const SUMMARY = {
  monthRevenue: 148320.50,
  monthRevenueDelta: 3.8, // percent vs last month
  outstandingAR: 22845.00,
  outstandingARDelta: -5.2,
  monthExpenses: 41760.25,
  monthExpensesDelta: 1.4,
};

const RECENT_TRANSACTIONS = [
  { id: 'T-2104', date: 'Apr 11', type: 'payment', description: 'Rent payment — Priya Shah', amount: 2100.00, account: 'Pine Valley 508' },
  { id: 'T-2103', date: 'Apr 11', type: 'expense', description: 'HVAC service — Maple Ridge', amount: -450.00, account: 'Maintenance' },
  { id: 'T-2102', date: 'Apr 10', type: 'payment', description: 'Rent payment — Marcia Clark', amount: 2450.00, account: 'Oakwood 204' },
  { id: 'T-2101', date: 'Apr 10', type: 'payment', description: 'Rent payment — Carlos Rivera', amount: 2250.00, account: 'Riverside 7' },
  { id: 'T-2100', date: 'Apr 10', type: 'expense', description: 'Landscaping — Q2 invoice', amount: -1275.00, account: 'Maple Ridge' },
  { id: 'T-2099', date: 'Apr 9', type: 'payment', description: 'Rent payment — Jonas Berg', amount: 1875.00, account: 'Maple Ridge 12B' },
  { id: 'T-2098', date: 'Apr 9', type: 'expense', description: 'Insurance premium', amount: -3200.00, account: 'Portfolio' },
];

const OUTSTANDING = [
  { tenant: 'Dmitri Volkov', unit: 'Oakwood 117', amount: 2625.00, daysLate: 11, severity: 'high' },
  { tenant: 'Aisha Mohammed', unit: 'Cedar Court 3A', amount: 1950.00, daysLate: 4, severity: 'medium' },
  { tenant: 'Lena Park', unit: 'Maple Ridge 8A', amount: 950.00, daysLate: 2, severity: 'low' },
  { tenant: 'Sean O\'Malley', unit: 'Oakwood 303', amount: 2450.00, daysLate: 7, severity: 'medium' },
  { tenant: 'Vera Hollings', unit: 'Pine Valley 112', amount: 14870.00, daysLate: 43, severity: 'high' },
];

function formatCurrency(n, { signed = false } = {}) {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  if (!signed) return `$${abs}`;
  return `${n < 0 ? '-' : '+'}$${abs}`;
}

function severityBadge(s) {
  if (s === 'high') return { className: 'priority-high', label: 'Collections', icon: AlertCircle };
  if (s === 'medium') return { className: 'priority-medium', label: 'Past due', icon: Clock };
  return { className: 'priority-low', label: 'Late', icon: Clock };
}

export default function AccountingPage() {
  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <DollarSign size={14} /> Preview — accounting figures are sample content until the RM GL endpoints are connected
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#2E7D3215', color: '#2E7D32' }}>
            <DollarSign size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Accounting</h2>
            <p className="property-detail-address">
              {formatCurrency(SUMMARY.monthRevenue)} collected this month · {formatCurrency(SUMMARY.outstandingAR)} outstanding
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Receipt size={14} /> Record Transaction
        </button>
      </div>

      {/* Three-up summary card row. Uses inline grid so we don't need
          a new CSS class — matches the look of the dashboard cards. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '14px',
        marginBottom: '16px',
      }}>
        <div className="dashboard-card" style={{ marginBottom: 0 }}>
          <div style={{ padding: '18px 20px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Revenue this month
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#222', marginTop: 6 }}>
              {formatCurrency(SUMMARY.monthRevenue)}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, marginTop: 4,
              fontSize: 12, fontWeight: 600,
              color: SUMMARY.monthRevenueDelta >= 0 ? '#2E7D32' : '#C62828',
            }}>
              {SUMMARY.monthRevenueDelta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {SUMMARY.monthRevenueDelta >= 0 ? '+' : ''}{SUMMARY.monthRevenueDelta}% vs last month
            </div>
          </div>
        </div>

        <div className="dashboard-card" style={{ marginBottom: 0 }}>
          <div style={{ padding: '18px 20px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Outstanding A/R
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#222', marginTop: 6 }}>
              {formatCurrency(SUMMARY.outstandingAR)}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, marginTop: 4,
              fontSize: 12, fontWeight: 600,
              color: SUMMARY.outstandingARDelta <= 0 ? '#2E7D32' : '#C62828',
            }}>
              {SUMMARY.outstandingARDelta <= 0 ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
              {SUMMARY.outstandingARDelta}% vs last month
            </div>
          </div>
        </div>

        <div className="dashboard-card" style={{ marginBottom: 0 }}>
          <div style={{ padding: '18px 20px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Expenses this month
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#222', marginTop: 6 }}>
              {formatCurrency(SUMMARY.monthExpenses)}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, marginTop: 4,
              fontSize: 12, fontWeight: 600,
              color: SUMMARY.monthExpensesDelta <= 0 ? '#2E7D32' : '#C62828',
            }}>
              {SUMMARY.monthExpensesDelta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {SUMMARY.monthExpensesDelta >= 0 ? '+' : ''}{SUMMARY.monthExpensesDelta}% vs last month
            </div>
          </div>
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><AlertCircle size={18} /> Outstanding Balances</h3>
        </div>
        <div className="tenants-list">
          {OUTSTANDING.map((o) => {
            const badge = severityBadge(o.severity);
            const BadgeIcon = badge.icon;
            return (
              <div key={o.tenant} className="tenant-row" style={{ cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#FFEBEE', color: '#C62828' }}>
                  <DollarSign size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{o.tenant}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item">{o.unit}</span>
                    <span className="tenant-contact-item">
                      <Clock size={12} /> {o.daysLate} days late
                    </span>
                    <span className="tenant-contact-item" style={{ fontWeight: 700 }}>
                      {formatCurrency(o.amount)}
                    </span>
                  </div>
                </div>
                <span className={`unit-status ${badge.className}`}>
                  <BadgeIcon size={12} /> {badge.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Receipt size={18} /> Recent Transactions</h3>
        </div>
        <div className="tenants-list">
          {RECENT_TRANSACTIONS.map((t) => {
            const isPayment = t.type === 'payment';
            return (
              <div key={t.id} className="tenant-row" style={{ cursor: 'default' }}>
                <div className="tenant-avatar" style={{
                  background: isPayment ? '#E8F5E9' : '#FFF3E0',
                  color: isPayment ? '#2E7D32' : '#E65100',
                }}>
                  {isPayment ? <ArrowUpRight size={22} /> : <ArrowDownRight size={22} />}
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{t.description}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item">{t.date}</span>
                    <span className="tenant-contact-item">{t.account}</span>
                    <span className="tenant-contact-item">#{t.id}</span>
                  </div>
                </div>
                <span style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: isPayment ? '#2E7D32' : '#C62828',
                  whiteSpace: 'nowrap',
                }}>
                  {formatCurrency(t.amount, { signed: true })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
