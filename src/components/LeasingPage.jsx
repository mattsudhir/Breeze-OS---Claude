import {
  FileText, Plus, Calendar, DollarSign, AlertCircle, Clock, CheckCircle2,
} from 'lucide-react';

// Placeholder leasing data — once the Rent Manager lease endpoint is
// wired up we'll replace this with a live fetch of active leases,
// renewals, and move-outs. Shape mirrors what we'd pull from RM so the
// component won't need reshaping later.
const SAMPLE_LEASES = [
  {
    id: 'L-1042',
    tenant: 'Marcia Clark',
    unit: 'Oakwood Apartments · Unit 204',
    start: 'Aug 1, 2024',
    end: 'Jul 31, 2026',
    rent: 2450,
    status: 'active',
    daysToRenewal: 110,
  },
  {
    id: 'L-1038',
    tenant: 'Jonas Berg',
    unit: 'Maple Ridge · Unit 12B',
    start: 'May 15, 2025',
    end: 'May 14, 2026',
    rent: 1875,
    status: 'renewal-due',
    daysToRenewal: 32,
  },
  {
    id: 'L-1029',
    tenant: 'Priya Shah',
    unit: 'Pine Valley Homes · Unit 508',
    start: 'Jan 10, 2026',
    end: 'Jan 9, 2027',
    rent: 2100,
    status: 'active',
    daysToRenewal: 273,
  },
  {
    id: 'L-1021',
    tenant: 'Dmitri Volkov',
    unit: 'Oakwood Apartments · Unit 117',
    start: 'Apr 1, 2025',
    end: 'May 31, 2026',
    rent: 2625,
    status: 'renewal-due',
    daysToRenewal: 49,
  },
  {
    id: 'L-0998',
    tenant: 'Aisha Mohammed',
    unit: 'Cedar Court · Unit 3A',
    start: 'Sep 1, 2023',
    end: 'Aug 31, 2025',
    rent: 1950,
    status: 'expiring',
    daysToRenewal: 12,
  },
  {
    id: 'L-1015',
    tenant: 'Carlos Rivera',
    unit: 'Riverside Lofts · Unit 7',
    start: 'Mar 1, 2025',
    end: 'Feb 28, 2026',
    rent: 2250,
    status: 'active',
    daysToRenewal: 320,
  },
];

const APPLICATIONS = [
  { id: 'A-219', applicant: 'Sean O\'Malley', unit: 'Oakwood · Unit 303', submitted: 'Apr 10', status: 'screening' },
  { id: 'A-218', applicant: 'Lena Park', unit: 'Maple Ridge · Unit 8A', submitted: 'Apr 9', status: 'approved' },
  { id: 'A-217', applicant: 'Tevita Tupou', unit: 'Cedar Court · Unit 2B', submitted: 'Apr 7', status: 'docs-pending' },
];

function statusBadge(status) {
  if (status === 'renewal-due') {
    return { className: 'priority-medium', label: 'Renewal due', icon: Clock };
  }
  if (status === 'expiring') {
    return { className: 'priority-high', label: 'Expiring soon', icon: AlertCircle };
  }
  return { className: 'priority-low', label: 'Active', icon: CheckCircle2 };
}

function appStatusBadge(status) {
  if (status === 'approved') return { className: 'priority-low', label: 'Approved' };
  if (status === 'screening') return { className: 'priority-medium', label: 'Screening' };
  return { className: 'priority-high', label: 'Docs pending' };
}

function formatCurrency(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function LeasingPage() {
  const needsAttention = SAMPLE_LEASES.filter(
    (l) => l.status === 'renewal-due' || l.status === 'expiring',
  );
  const active = SAMPLE_LEASES.filter((l) => l.status === 'active');
  const monthlyRentRoll = SAMPLE_LEASES.reduce((sum, l) => sum + l.rent, 0);

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <FileText size={14} /> Preview — leasing data is sample content while we wire up the Rent Manager lease endpoint
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1976D215', color: '#1976D2' }}>
            <FileText size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Leasing</h2>
            <p className="property-detail-address">
              {SAMPLE_LEASES.length} active leases · {needsAttention.length} need attention · {formatCurrency(monthlyRentRoll)}/mo rent roll
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Plus size={14} /> New Lease
        </button>
      </div>

      {needsAttention.length > 0 && (
        <div className="dashboard-card">
          <div className="card-header">
            <h3><AlertCircle size={18} /> Needs Attention</h3>
          </div>
          <div className="tenants-list">
            {needsAttention.map((l) => {
              const badge = statusBadge(l.status);
              const BadgeIcon = badge.icon;
              return (
                <div key={l.id} className="tenant-row" style={{ cursor: 'default' }}>
                  <div className="tenant-avatar" style={{ background: '#1976D215', color: '#1976D2' }}>
                    <FileText size={22} />
                  </div>
                  <div className="tenant-info">
                    <span className="tenant-name">{l.tenant}</span>
                    <div className="tenant-contact">
                      <span className="tenant-contact-item">{l.unit}</span>
                      <span className="tenant-contact-item">
                        <Calendar size={12} /> Ends {l.end}
                      </span>
                      <span className="tenant-contact-item">
                        <DollarSign size={12} /> {formatCurrency(l.rent)}/mo
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
      )}

      <div className="dashboard-card">
        <div className="card-header">
          <h3><CheckCircle2 size={18} /> Active Leases</h3>
        </div>
        <div className="tenants-list">
          {active.map((l) => (
            <div key={l.id} className="tenant-row" style={{ cursor: 'default' }}>
              <div className="tenant-avatar" style={{ background: '#E8F5E9', color: '#2E7D32' }}>
                <FileText size={22} />
              </div>
              <div className="tenant-info">
                <span className="tenant-name">{l.tenant}</span>
                <div className="tenant-contact">
                  <span className="tenant-contact-item">{l.unit}</span>
                  <span className="tenant-contact-item">
                    <Calendar size={12} /> {l.start} – {l.end}
                  </span>
                  <span className="tenant-contact-item">
                    <DollarSign size={12} /> {formatCurrency(l.rent)}/mo
                  </span>
                </div>
              </div>
              <span className="unit-status priority-low">
                <CheckCircle2 size={12} /> Active
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Clock size={18} /> Pending Applications</h3>
        </div>
        <div className="tenants-list">
          {APPLICATIONS.map((a) => {
            const badge = appStatusBadge(a.status);
            return (
              <div key={a.id} className="tenant-row" style={{ cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#FFF3E0', color: '#E65100' }}>
                  <FileText size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{a.applicant}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item">{a.unit}</span>
                    <span className="tenant-contact-item">
                      <Calendar size={12} /> Submitted {a.submitted}
                    </span>
                  </div>
                </div>
                <span className={`unit-status ${badge.className}`}>{badge.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
