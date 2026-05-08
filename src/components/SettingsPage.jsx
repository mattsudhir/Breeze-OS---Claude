import { useState, useEffect } from 'react';
import {
  Settings, User, Bell, Lock, CreditCard, Building2, Database,
  Mail, Phone, Shield, Palette, Users, Save, ChevronRight,
} from 'lucide-react';

// Placeholder settings UI — wires up to the real backend when we build
// the account management layer. Tabs mimic the shape of what that will
// eventually look like.
const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'organization', label: 'Organization', icon: Building2 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'integrations', label: 'Integrations', icon: Database },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'appearance', label: 'Appearance', icon: Palette },
];

export default function SettingsPage() {
  const [active, setActive] = useState('profile');
  const activeSection = SECTIONS.find((s) => s.id === active);
  const ActiveIcon = activeSection?.icon || Settings;

  return (
    <div className="properties-page settings-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <Settings size={14} /> Preview — sample settings while the account layer is wired up
      </div>

      <div className="settings-topbar">
        <div className="settings-topbar-title">
          <div className="wo-detail-icon" style={{ background: '#49505715', color: '#495057' }}>
            <Settings size={28} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>Settings</h2>
            <p className="property-detail-address" style={{ margin: '4px 0 0' }}>
              Breeze Property Group · Pro plan · 4 team members
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn settings-save-btn">
          <Save size={14} /> Save Changes
        </button>
      </div>

      {/* Mobile-only horizontal section chip row (hidden on desktop via CSS) */}
      <div className="settings-section-chips">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              className={`settings-chip ${active === s.id ? 'active' : ''}`}
            >
              <Icon size={14} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div className="settings-grid">
        {/* Desktop-only left rail (hidden on mobile via CSS) */}
        <aside className="settings-nav">
          <div className="settings-nav-heading">Account</div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={`settings-nav-item ${active === s.id ? 'active' : ''}`}
              >
                <Icon size={16} />
                <span>{s.label}</span>
                {active === s.id && <ChevronRight size={14} />}
              </button>
            );
          })}
        </aside>

        <main className="settings-body">
          <div className="settings-section-header">
            <ActiveIcon size={20} />
            <h3>{activeSection?.label}</h3>
          </div>

          {active === 'profile' && <ProfileSection />}
          {active === 'organization' && <OrganizationSection />}
          {active === 'notifications' && <NotificationsSection />}
          {active === 'security' && <SecuritySection />}
          {active === 'integrations' && <IntegrationsSection />}
          {active === 'billing' && <BillingSection />}
          {active === 'team' && <TeamSection />}
          {active === 'appearance' && <AppearanceSection />}
        </main>
      </div>
    </div>
  );
}

// ── Shared building blocks ──────────────────────────────────────────

function Card({ title, icon: Icon, children }) {
  return (
    <section className="settings-card">
      {title && (
        <header className="settings-card-header">
          {Icon && <Icon size={16} />}
          <h4>{title}</h4>
        </header>
      )}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function Field({ label, value, type = 'text', full = false }) {
  return (
    <label className={`settings-field ${full ? 'full' : ''}`}>
      <span className="settings-field-label">{label}</span>
      <input type={type} defaultValue={value} className="settings-field-input" />
    </label>
  );
}

function FieldRow({ children }) {
  return <div className="settings-field-row">{children}</div>;
}

function Toggle({ label, desc, defaultOn = false }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="settings-toggle">
      <div className="settings-toggle-text">
        <div className="settings-toggle-label">{label}</div>
        {desc && <div className="settings-toggle-desc">{desc}</div>}
      </div>
      <button
        type="button"
        onClick={() => setOn(!on)}
        className={`settings-toggle-switch ${on ? 'on' : ''}`}
        aria-pressed={on}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  );
}

// ── Sections ────────────────────────────────────────────────────────

function ProfileSection() {
  return (
    <Card title="Personal Information" icon={User}>
      <FieldRow>
        <Field label="First Name" value="Matt" />
        <Field label="Last Name" value="Sudhir" />
      </FieldRow>
      <Field label="Email" value="matt@breezepropertygroup.com" type="email" full />
      <FieldRow>
        <Field label="Phone" value="(419) 555-0199" type="tel" />
        <Field label="Job Title" value="Managing Partner" />
      </FieldRow>
      <Field label="Time Zone" value="America/New_York (EST)" full />
    </Card>
  );
}

function OrganizationSection() {
  return (
    <>
      <Card title="Company Details" icon={Building2}>
        <Field label="Company Name" value="Breeze Property Group" full />
        <FieldRow>
          <Field label="Legal Entity" value="Breeze Property Group LLC" />
          <Field label="EIN" value="87-1234567" />
        </FieldRow>
        <Field label="Primary Address" value="1250 Main Street, Toledo, OH 43604" full />
        <Field label="Website" value="https://breezepropertygroup.com" type="url" full />
      </Card>
      <Card title="Portfolio Snapshot">
        <div className="settings-stat-grid">
          <Stat label="Properties" value="12" />
          <Stat label="Total Units" value="106" />
          <Stat label="Active Leases" value="98" />
        </div>
      </Card>
    </>
  );
}

function Stat({ label, value }) {
  return (
    <div className="settings-stat">
      <div className="settings-stat-value">{value}</div>
      <div className="settings-stat-label">{label}</div>
    </div>
  );
}

function NotificationsSection() {
  const [categories, setCategories] = useState([]);
  const [subscribed, setSubscribed] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // category id currently saving
  const [error, setError] = useState(null);

  // Load the category catalog + the user's current opt-ins.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/category-subscriptions')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok) {
          setCategories(data.categories || []);
          setSubscribed(new Set(data.subscribed || []));
        } else {
          setError(data?.error || 'Could not load subscriptions');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Network error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const toggleCategory = async (categoryId, currentlyOn) => {
    setSaving(categoryId);
    setError(null);
    // Optimistic
    setSubscribed((prev) => {
      const next = new Set(prev);
      if (currentlyOn) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
    try {
      const res = await fetch('/api/category-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: categoryId, enabled: !currentlyOn }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message || 'Save failed');
      // Roll back optimistic
      setSubscribed((prev) => {
        const next = new Set(prev);
        if (currentlyOn) next.add(categoryId);
        else next.delete(categoryId);
        return next;
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <Card title="Notification categories" icon={Bell}>
        <div style={{ fontSize: 12, color: '#6A737D', marginBottom: 12 }}>
          Toggle on the events you want to be alerted about across the whole
          portfolio. Each category fires both the in-app bell and (if enabled)
          a native push notification.
        </div>
        {loading ? (
          <div style={{ padding: '12px 0', color: '#6A737D', fontSize: 13 }}>
            Loading…
          </div>
        ) : error ? (
          <div style={{
            padding: '8px 12px',
            background: '#FFF3F3',
            border: '1px solid #F5C6CB',
            borderRadius: 6,
            color: '#C62828',
            fontSize: 12,
          }}>
            {error}
          </div>
        ) : categories.length === 0 ? (
          <div style={{ padding: '12px 0', color: '#6A737D', fontSize: 13 }}>
            No categories configured.
          </div>
        ) : (
          categories.map((cat) => (
            <BackedToggle
              key={cat.id}
              label={cat.label}
              desc={cat.description}
              on={subscribed.has(cat.id)}
              loading={saving === cat.id}
              onToggle={() => toggleCategory(cat.id, subscribed.has(cat.id))}
            />
          ))
        )}
      </Card>
      <Card title="Other channels (coming soon)" icon={Phone}>
        <div style={{ fontSize: 12, color: '#6A737D', lineHeight: 1.5 }}>
          SMS and email delivery for these categories is in design. For now
          alerts are delivered as in-app notifications and (with permission) as
          native browser push pop-ups via the bell icon at the top.
        </div>
      </Card>
    </>
  );
}

// Backend-driven toggle. Same look as <Toggle /> but the on-state is
// owned by the parent (so optimistic updates roll back cleanly on
// save failure) and a small spinner replaces the knob while the
// network call is in flight.
function BackedToggle({ label, desc, on, loading, onToggle }) {
  return (
    <div className="settings-toggle">
      <div className="settings-toggle-text">
        <div className="settings-toggle-label">{label}</div>
        {desc && <div className="settings-toggle-desc">{desc}</div>}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={loading}
        className={`settings-toggle-switch ${on ? 'on' : ''}`}
        aria-pressed={on}
        style={{ opacity: loading ? 0.6 : 1 }}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  );
}

function SecuritySection() {
  return (
    <Card title="Account Security" icon={Shield}>
      <Toggle label="Two-factor authentication" desc="Require a code from your authenticator app on sign-in" defaultOn />
      <Toggle label="Session timeout" desc="Auto sign-out after 30 minutes of inactivity" defaultOn />
      <Toggle label="IP allowlist" desc="Only allow sign-ins from approved IP ranges" />
      <Toggle label="Audit log export" desc="Weekly CSV email of all account activity" />
      <div className="settings-info-banner">
        Last sign-in: Today at 10:34 PM from Toledo, OH · 174.xxx.xxx.22
      </div>
    </Card>
  );
}

function IntegrationsSection() {
  const integrations = [
    { name: 'Rent Manager', status: 'connected', desc: 'Live data sync for tenants, properties, and work orders' },
    { name: 'Zoho Cliq', status: 'connected', desc: 'Two-way chat bot and team notifications' },
    { name: 'Vapi', status: 'connected', desc: 'AI voice calling via ElevenLabs' },
    { name: 'Anthropic', status: 'connected', desc: 'Claude models powering Breeze AI' },
    { name: 'ElevenLabs', status: 'connected', desc: 'Voice synthesis for outbound calls' },
    { name: 'QuickBooks', status: 'disconnected', desc: 'Sync GL entries for accounting reconciliation' },
    { name: 'Zillow', status: 'disconnected', desc: 'Auto-post vacancies to rental listings' },
    { name: 'DocuSign', status: 'disconnected', desc: 'Electronic lease signing workflow' },
  ];
  return (
    <Card title="Connected Services" icon={Database}>
      {integrations.map((i) => (
        <div key={i.name} className="settings-integration-row">
          <div className="settings-integration-info">
            <div className="settings-integration-name">{i.name}</div>
            <div className="settings-integration-desc">{i.desc}</div>
          </div>
          <span className={`unit-status ${i.status === 'connected' ? 'unit-occupied' : 'status-onhold'}`}>
            {i.status === 'connected' ? 'Connected' : 'Not connected'}
          </span>
        </div>
      ))}
    </Card>
  );
}

function BillingSection() {
  return (
    <>
      <Card title="Current Plan" icon={CreditCard}>
        <div className="settings-plan">
          <div className="settings-plan-info">
            <div className="settings-plan-name">Breeze Pro</div>
            <div className="settings-plan-desc">Up to 150 units · Unlimited AI calls · Priority support</div>
          </div>
          <div className="settings-plan-price">
            <div className="settings-plan-amount">$249<span>/mo</span></div>
            <div className="settings-plan-next">Next invoice: May 1, 2026</div>
          </div>
        </div>
      </Card>
      <Card title="Payment Method">
        <div className="settings-payment">
          <div className="settings-card-brand">VISA</div>
          <div className="settings-payment-info">
            <div className="settings-payment-number">Visa ending in 4821</div>
            <div className="settings-payment-exp">Expires 09/2028</div>
          </div>
          <button className="btn-secondary">Update</button>
        </div>
      </Card>
      <Card title="Recent Invoices">
        <div className="settings-table-wrap">
          <table className="properties-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>Apr 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
              <tr><td>Mar 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
              <tr><td>Feb 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function TeamSection() {
  const members = [
    { name: 'Matt Sudhir', email: 'matt@breezepropertygroup.com', role: 'Owner', lastActive: 'Just now' },
    { name: 'Sarah Chen', email: 'sarah@breezepropertygroup.com', role: 'Admin', lastActive: '2 hours ago' },
    { name: 'David Park', email: 'david@breezepropertygroup.com', role: 'Manager', lastActive: 'Yesterday' },
    { name: 'Jessica Ruiz', email: 'jessica@breezepropertygroup.com', role: 'Maintenance', lastActive: '3 days ago' },
  ];
  return (
    <Card title="Team Members" icon={Users}>
      {members.map((m) => (
        <div key={m.email} className="settings-team-row">
          <div className="user-avatar-small">{m.name.split(' ').map((n) => n[0]).join('')}</div>
          <div className="settings-team-info">
            <div className="settings-team-name">{m.name}</div>
            <div className="settings-team-meta">{m.email} · Last active {m.lastActive}</div>
          </div>
          <span className="unit-status status-in_progress">{m.role}</span>
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <button className="btn-primary tenant-edit-btn">
          <User size={14} /> Invite Member
        </button>
      </div>
    </Card>
  );
}

function AppearanceSection() {
  return (
    <Card title="Appearance" icon={Palette}>
      <Toggle label="Dark mode" desc="Switch to a dark color scheme (coming soon)" />
      <Toggle label="Compact sidebar" desc="Use smaller icons and tighter spacing" />
      <Toggle label="Show tenant avatars" desc="Display tenant initials in lists and dashboards" defaultOn />
      <Toggle label="Live data badges" desc='Show the "Live" indicator when Rent Manager data is fresh' defaultOn />
    </Card>
  );
}
