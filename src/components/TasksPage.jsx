import { CheckSquare, Plus, Clock, AlertCircle, CheckCircle2 } from 'lucide-react';

// Placeholder task data — once we wire this to a real backend (RM's
// user-defined tasks, an internal DB, or a to-do service) we'll
// replace the static list with live fetches.
const SAMPLE_TASKS = [
  {
    id: 1,
    title: 'Follow up with Marcia Clark on lease renewal',
    due: 'Today',
    priority: 'high',
    status: 'open',
    related: 'Tenant #t0001',
  },
  {
    id: 2,
    title: 'Review Q2 vacancy report',
    due: 'Tomorrow',
    priority: 'medium',
    status: 'open',
    related: 'Reports',
  },
  {
    id: 3,
    title: 'Schedule HVAC inspection at Oakwood',
    due: 'Apr 15',
    priority: 'medium',
    status: 'open',
    related: 'Oakwood Apartments',
  },
  {
    id: 4,
    title: 'Approve vendor invoice for landscaping',
    due: 'Apr 18',
    priority: 'low',
    status: 'open',
    related: 'Maple Ridge',
  },
  {
    id: 5,
    title: 'Send welcome packet — Unit 508',
    due: 'Apr 20',
    priority: 'low',
    status: 'completed',
    related: 'Pine Valley Homes',
  },
];

function priorityBadge(p) {
  if (p === 'high') return { className: 'priority-high', label: 'High', icon: AlertCircle };
  if (p === 'medium') return { className: 'priority-medium', label: 'Medium', icon: Clock };
  return { className: 'priority-low', label: 'Low', icon: Clock };
}

export default function TasksPage() {
  const open = SAMPLE_TASKS.filter((t) => t.status !== 'completed');
  const completed = SAMPLE_TASKS.filter((t) => t.status === 'completed');

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <CheckSquare size={14} /> Preview — task data is sample content while we design the schema
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#2E7D3215', color: '#2E7D32' }}>
            <CheckSquare size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Tasks</h2>
            <p className="property-detail-address">
              {open.length} open · {completed.length} completed
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Plus size={14} /> New Task
        </button>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Clock size={18} /> Open</h3>
        </div>
        <div className="tenants-list">
          {open.map((t) => {
            const pri = priorityBadge(t.priority);
            const PriIcon = pri.icon;
            return (
              <div key={t.id} className="tenant-row" style={{ cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#2E7D3215', color: '#2E7D32' }}>
                  <CheckSquare size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{t.title}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item">
                      <Clock size={12} /> Due {t.due}
                    </span>
                    {t.related && (
                      <span className="tenant-contact-item">{t.related}</span>
                    )}
                  </div>
                </div>
                <span className={`unit-status ${pri.className}`}>
                  <PriIcon size={12} /> {pri.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {completed.length > 0 && (
        <div className="dashboard-card">
          <div className="card-header">
            <h3><CheckCircle2 size={18} /> Completed</h3>
          </div>
          <div className="tenants-list">
            {completed.map((t) => (
              <div key={t.id} className="tenant-row" style={{ opacity: 0.6, cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#E8F5E9', color: '#2E7D32' }}>
                  <CheckCircle2 size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name" style={{ textDecoration: 'line-through' }}>
                    {t.title}
                  </span>
                  <div className="tenant-contact">
                    {t.related && (
                      <span className="tenant-contact-item">{t.related}</span>
                    )}
                  </div>
                </div>
                <span className="unit-status status-completed">Done</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
