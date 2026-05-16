import { Workflow, Plus, Zap, Play, Pause } from 'lucide-react';

// Catalogue of automations we plan to ship. Until the rules engine
// lands, this page is a feature preview — every card is decorated
// with a Coming soon pill so users don't mistake the catalogue for
// live automation state. Real runs / last-ran timestamps will
// surface once the engine starts firing.
const PLANNED_WORKFLOWS = [
  {
    id: 1,
    name: 'Auto-notify plumbing on water-related tickets',
    trigger: 'New work order with category "Plumbing"',
    action: 'Send notification to plumbing team in Zoho Cliq',
  },
  {
    id: 2,
    name: 'Lease expiration reminder',
    trigger: 'Lease ends in 60 days',
    action: 'Email tenant + create renewal task',
  },
  {
    id: 3,
    name: 'Late rent escalation',
    trigger: 'Rent past due by 5+ days',
    action: 'Send late notice + notify property manager',
  },
  {
    id: 4,
    name: 'Urgent ticket auto-escalation',
    trigger: 'Work order marked urgent/emergency',
    action: 'Page on-call maintenance + SMS supervisor',
  },
  {
    id: 5,
    name: 'Vacancy listing sync',
    trigger: 'Unit marked vacant',
    action: 'Post to Zillow, Apartments.com, craigslist',
  },
];

export default function WorkflowsPage() {
  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <Workflow size={14} /> Feature preview — these automations are designed
        but not yet wired to the rules engine. Real run counts and timestamps
        will appear here once the engine fires.
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#6A1B9A15', color: '#6A1B9A' }}>
            <Workflow size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Workflows</h2>
            <p className="property-detail-address">
              {PLANNED_WORKFLOWS.length} automations on the roadmap
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary tenant-edit-btn"
          disabled
          title="Available once the rules engine ships"
          style={{ opacity: 0.5, cursor: 'not-allowed' }}
        >
          <Plus size={14} /> New Workflow
        </button>
      </div>

      <div className="dashboard-card">
        <div className="card-header">
          <h3><Zap size={18} /> Planned Automations</h3>
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#E65100',
            background: '#FFF3E0', padding: '2px 8px', borderRadius: 999,
          }}>
            Coming soon
          </span>
        </div>
        <div className="tenants-list">
          {PLANNED_WORKFLOWS.map((w) => (
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
                </div>
              </div>
              <span className="unit-status status-onhold">
                <Pause size={12} /> Not yet active
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

