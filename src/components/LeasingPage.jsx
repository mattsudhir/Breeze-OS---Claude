import { FileText, Plus, Calendar, DollarSign, Home, CheckCircle2, Clock, AlertCircle } from 'lucide-react';

// Placeholder leasing data — will be replaced by live Rent Manager lease queries.
const PIPELINE = [
  { stage: 'Applications', count: 9, color: '#1565C0' },
  { stage: 'Screening', count: 4, color: '#0077B6' },
  { stage: 'Approved', count: 3, color: '#2E7D32' },
  { stage: 'Signed', count: 2, color: '#6A1B9A' },
];

const ACTIVE_LEASES = [
  { id: 1, tenant: 'Marcia Clark', unit: 'Unit 204 · Oakwood Apartments', rent: 2150, start: 'Jun 1, 2025', end: 'May 31, 2026', status: 'active' },
  { id: 2, tenant: 'Daniel Kim', unit: 'Unit 8B · Birchwood Commons', rent: 1895, start: 'Aug 15, 2025', end: 'Aug 14, 2026', status: 'active' },
  { id: 3, tenant: 'Sam Patel', unit: 'Unit 22 · Maple Grove', rent: 945, start: 'Jan 1, 2025', end: 'May 1, 2026', status: 'expiring' },
  { id: 4, tenant: 'Jenna Wong', unit: 'Unit 11B · Birchwood Commons', rent: 1650, start: 'Mar 12, 2026', end: 'Mar 11, 2027', status: 'active' },
  { id: 5, tenant: 'Robert Hayes', unit: 'Unit 14C · Birchwood Commons', rent: 2100, start: 'Feb 1, 2025', end: 'Apr 30, 2026', status: 'expiring' },
];

const APPLICATIONS = [
  { id: 'APP-2301', applicant: 'Elena Rodriguez', unit: 'Unit 3A · Oakwood', appliedOn: 'Apr 8, 2026', status: 'screening', score: 742 },
  { id: 'APP-2300', applicant: 'Marcus Chen', unit: 'Unit 19 · Maple Grove', appliedOn: 'Apr 7, 2026', status: 'approved', score: 801 },
  { id: 'APP-2299', applicant: 'Priya Shah', unit: 'Unit 6C · Birchwood', appliedOn: 'Apr 6, 2026', status: 'screening', score: 688 },
  { id: 'APP-2298', applicant: 'Tyler Brooks', unit: 'Unit 12 · Oakwood', appliedOn: 'Apr 5, 2026', status: 'pending', score: null },
];

function formatCurrency(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function statusBadge(status) {
  switch (status) {
    case 'active':
      return { className: 'unit-occupied', label: 'Active', Icon: CheckCircle2 };
    case 'expiring':
      return { className: 'unit-vacant', label: 'Expiring Soon', Icon: AlertCircle };
    case 'approved':
      return { className: 'unit-occupied', label: 'Approved', Icon: CheckCircle2 };
    case 'screening':
      return { className: 'status-in_progress', label: 'Screening', Icon: Clock };
    case 'pending':
      return { className: 'status-onhold', label: 'Pending', Icon: Clock };
    default:
      return { className: 'status-onhold', label: status, Icon: Clock };
  }
}

export default function LeasingPage() {
  const expiringSoon = ACTIVE_LEASES.filter((l) => l.status === 'expiring').length;

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <FileText size={14} /> Preview — sample leasing pipeline while live data is connected
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#0077B615', color: '#0077B6' }}>
            <FileText size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Leasing</h2>
            <p className="property-detail-address">
              {ACTIVE_LEASES.length} active leases · {expiringSoon} expiring within 60 days
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Plus size={14} /> New Lease
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        marginBottom: '16px',
      }}>
        {PIPELINE.map((p) => (
          <div key={p.stage} className="dashboard-card" style={{ padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{p.stage}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: p.color, marginTop: 4 }}>{p.count}</div>
          </div>
        ))}
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Home size={18} /> Active Leases</h3>
        </div>
        <div className="tenants-list">
          {ACTIVE_LEASES.map((l) => {
            const badge = statusBadge(l.status);
            const Icon = badge.Icon;
            return (
              <div key={l.id} className="tenant-row" style={{ cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#0077B615', color: '#0077B6' }}>
                  <FileText size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{l.tenant}</span>
                  <div className="tenant-contact" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span className="tenant-contact-item"><Home size={12} /> {l.unit}</span>
                    <span className="tenant-contact-item">
                      <Calendar size={12} /> {l.start} – {l.end}
                    </span>
                    <span className="tenant-contact-item">
                      <DollarSign size={12} /> {formatCurrency(l.rent)}/mo
                    </span>
                  </div>
                </div>
                <span className={`unit-status ${badge.className}`}>
                  <Icon size={12} /> {badge.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Clock size={18} /> Applications in Progress</h3>
        </div>
        <table className="properties-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Applicant</th>
              <th>Unit</th>
              <th>Applied</th>
              <th>Credit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {APPLICATIONS.map((a) => {
              const badge = statusBadge(a.status);
              return (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.id}</td>
                  <td>{a.applicant}</td>
                  <td style={{ color: '#666' }}>{a.unit}</td>
                  <td style={{ color: '#666' }}>{a.appliedOn}</td>
                  <td>{a.score ? a.score : '—'}</td>
                  <td>
                    <span className={`unit-status ${badge.className}`}>{badge.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
