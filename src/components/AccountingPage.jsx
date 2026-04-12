import { DollarSign, TrendingUp, TrendingDown, Receipt, CreditCard, AlertCircle, CheckCircle2, Plus } from 'lucide-react';

// Placeholder accounting data — swap for real Rent Manager GL pulls later.
const KPIS = [
  { id: 'income', label: 'Income (MTD)', value: '$184,320.00', delta: '+8.2%', up: true, icon: TrendingUp, color: '#2E7D32' },
  { id: 'expenses', label: 'Expenses (MTD)', value: '$62,115.47', delta: '+3.1%', up: false, icon: TrendingDown, color: '#C62828' },
  { id: 'noi', label: 'Net Operating Income', value: '$122,204.53', delta: '+11.4%', up: true, icon: DollarSign, color: '#1565C0' },
  { id: 'outstanding', label: 'Outstanding AR', value: '$14,782.00', delta: '-2.6%', up: true, icon: Receipt, color: '#E65100' },
];

const RECENT_TRANSACTIONS = [
  { id: 'txn-1042', date: 'Apr 11, 2026', description: 'Rent payment — Marcia Clark (Unit 204)', account: 'Income · Rent', amount: 2150.00, type: 'credit' },
  { id: 'txn-1041', date: 'Apr 11, 2026', description: 'Plumbing repair — Oakwood #12', account: 'Expense · Maintenance', amount: -487.50, type: 'debit' },
  { id: 'txn-1040', date: 'Apr 10, 2026', description: 'Rent payment — Daniel Kim (Unit 8B)', account: 'Income · Rent', amount: 1895.00, type: 'credit' },
  { id: 'txn-1039', date: 'Apr 10, 2026', description: 'Electric utility — Birchwood Commons', account: 'Expense · Utilities', amount: -2340.18, type: 'debit' },
  { id: 'txn-1038', date: 'Apr 9, 2026', description: 'Late fee — Unit 14C', account: 'Income · Fees', amount: 75.00, type: 'credit' },
  { id: 'txn-1037', date: 'Apr 9, 2026', description: 'Landscaping contract — Q2', account: 'Expense · Grounds', amount: -1800.00, type: 'debit' },
  { id: 'txn-1036', date: 'Apr 8, 2026', description: 'Security deposit — new lease (Unit 3A)', account: 'Liability · Deposits', amount: 2400.00, type: 'credit' },
];

const OUTSTANDING_INVOICES = [
  { id: 'INV-3391', tenant: 'Robert Hayes', unit: 'Unit 14C · Birchwood', amount: 2100.00, daysLate: 12, status: 'overdue' },
  { id: 'INV-3388', tenant: 'Lena Park', unit: 'Unit 7 · Oakwood', amount: 1875.00, daysLate: 5, status: 'overdue' },
  { id: 'INV-3385', tenant: 'Sam Patel', unit: 'Unit 22 · Maple Grove', amount: 945.00, daysLate: 2, status: 'due' },
  { id: 'INV-3384', tenant: 'Jenna Wong', unit: 'Unit 11B · Birchwood', amount: 1650.00, daysLate: 0, status: 'due' },
];

function formatCurrency(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AccountingPage() {
  const totalOutstanding = OUTSTANDING_INVOICES.reduce((s, i) => s + i.amount, 0);

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <DollarSign size={14} /> Preview — sample accounting data while GL integration is wired up
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#2E7D3215', color: '#2E7D32' }}>
            <DollarSign size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Accounting</h2>
            <p className="property-detail-address">
              April 2026 · {OUTSTANDING_INVOICES.length} outstanding invoices · {formatCurrency(totalOutstanding)} due
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Plus size={14} /> New Transaction
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '12px',
        marginBottom: '16px',
      }}>
        {KPIS.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.id} className="dashboard-card" style={{ padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <div className="tenant-avatar" style={{ background: `${k.color}15`, color: k.color, width: 36, height: 36 }}>
                  <Icon size={18} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{k.label}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a1a' }}>{k.value}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: k.up ? '#2E7D32' : '#C62828', marginTop: 4 }}>
                {k.delta} vs last month
              </div>
            </div>
          );
        })}
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Receipt size={18} /> Recent Transactions</h3>
        </div>
        <table className="properties-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {RECENT_TRANSACTIONS.map((t) => (
              <tr key={t.id}>
                <td>{t.date}</td>
                <td>{t.description}</td>
                <td style={{ color: '#666', fontSize: 12 }}>{t.account}</td>
                <td style={{
                  textAlign: 'right',
                  fontWeight: 600,
                  color: t.type === 'credit' ? '#2E7D32' : '#C62828',
                }}>
                  {formatCurrency(t.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><CreditCard size={18} /> Outstanding Invoices</h3>
        </div>
        <div className="tenants-list">
          {OUTSTANDING_INVOICES.map((inv) => (
            <div key={inv.id} className="tenant-row" style={{ cursor: 'default' }}>
              <div className="tenant-avatar" style={{
                background: inv.status === 'overdue' ? '#C6282815' : '#E6510015',
                color: inv.status === 'overdue' ? '#C62828' : '#E65100',
              }}>
                {inv.status === 'overdue' ? <AlertCircle size={22} /> : <CheckCircle2 size={22} />}
              </div>
              <div className="tenant-info">
                <span className="tenant-name">{inv.tenant} · {inv.id}</span>
                <div className="tenant-contact">
                  <span className="tenant-contact-item">{inv.unit}</span>
                  <span className="tenant-contact-item">
                    {inv.daysLate > 0 ? `${inv.daysLate} days late` : 'Due today'}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color: '#1a1a1a' }}>{formatCurrency(inv.amount)}</div>
                <span className={`unit-status ${inv.status === 'overdue' ? 'unit-vacant' : 'status-in_progress'}`}>
                  {inv.status === 'overdue' ? 'Overdue' : 'Due'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
