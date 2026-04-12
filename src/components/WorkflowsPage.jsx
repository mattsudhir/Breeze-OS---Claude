import { Workflow, Plus, Zap, Clock, CheckCircle2, Play, Pause } from 'lucide-react';

// Placeholder workflow data — once we wire this to a real rules engine
// we'll replace these with the user's configured automations.
const SAMPLE_WORKFLOWS = [
  {
    id: 1,
    name: 'Auto-notify plumbing on water-related tickets',
    trigger: 'New work order with category "Plumbing"',
    action: 'Send notification to plumbing team in Zoho Cliq',
    status: 'active',
    runs: 47,
    lastRun: '2h ago',
  },
  {
    id: 2,
    name: 'Lease expiration reminder',
    trigger: 'Lease ends in 60 days',
    action: 'Email tenant + create renewal task',
    status: 'active',
    runs: 12,
    lastRun: 'Yesterday',
  },
  {
    id: 3,
    name: 'Late rent escalation',
    trigger: 'Rent past due by 5+ days',
    action: 'Send late notice + notify property manager',
    status: 'active',
    runs: 8,
    lastRun: '3 days ago',
  },
  {
    id: 4,
    name: 'Urgent ticket auto-escalation',
    trigger: 'Work order marked urgent/emergency',
    action: 'Page on-call maintenance + SMS supervisor',
    status: 'active',
    runs: 3,
    lastRun: '5 days ago',
  },
  {
    id: 5,
    name: 'Vacancy listing sync',
    trigger: 'Unit marked vacant',
    action: 'Post to Zillow, Apartments.com, craigslist',
    status: 'paused',
    runs: 0,
    lastRun: '—',
  },
];

export default function WorkflowsPage() {
  const active = SAMPLE_WORKFLOWS.filter((w) => w.status === 'active');
  const paused = SAMPLE_WORKFLOWS.filter((w) => w.status === 'paused');

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <Workflow size={14} /> Preview — sample workflows while we design the rules engine
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#6A1B9A15', color: '#6A1B9A' }}>
            <Workflow size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Workflows</h2>
            <p className="property-detail-address">
              {active.length} active · {paused.length} paused
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Plus size={14} /> New Workflow
        </button>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Zap size={18} /> Active Automations</h3>
        </div>
        <div className="tenants-list">
          {active.map((w) => (
            <div key={w.id} className="tenant-row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
              <div className="tenant-avatar" style={{ background: '#6A1B9A15', color: '#6A1B9A' }}>
                <Workflow size={22} />
              </div>
              <div className="tenant-info">
                <span className="tenant-name">{w.name}</span>
                <div className="tenant-contact" style={{ marginTop: 4, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span className="tenant-contact-item">
                    <Zap size={12} /> When: {w.trigger}
                  </span>
                  <span className="tenant-contact-item">
                    <Play size={12} /> Then: {w.action}
                  </span>
                  <span className="tenant-contact-item" style={{ fontSize: 11, color: '#888' }}>
                    {w.runs} runs · last ran {w.lastRun}
                  </span>
                </div>
              </div>
              <span className="unit-status status-in_progress">
                <Play size={12} /> Active
              </span>
            </div>
          ))}
        </div>
      </div>

      {paused.length > 0 && (
        <div className="dashboard-card">
          <div className="card-header">
            <h3><Pause size={18} /> Paused</h3>
          </div>
          <div className="tenants-list">
            {paused.map((w) => (
              <div key={w.id} className="tenant-row" style={{ opacity: 0.6, cursor: 'default' }}>
                <div className="tenant-avatar" style={{ background: '#ECEFF1', color: '#546E7A' }}>
                  <Pause size={22} />
                </div>
                <div className="tenant-info">
                  <span className="tenant-name">{w.name}</span>
                  <div className="tenant-contact">
                    <span className="tenant-contact-item">
                      <Zap size={12} /> {w.trigger}
                    </span>
                  </div>
                </div>
                <span className="unit-status status-onhold">
                  <Pause size={12} /> Paused
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
