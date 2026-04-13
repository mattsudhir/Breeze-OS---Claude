import { useState } from 'react';
import {
  Settings, User, Bell, Lock, CreditCard, Building2, Database,
  Mail, Phone, Globe, Key, Shield, Palette, Users, Save,
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

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
      }}>
        <Settings size={14} /> Preview — sample settings while the account layer is wired up
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#49505715', color: '#495057' }}>
            <Settings size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Settings</h2>
            <p className="property-detail-address">
              Breeze Property Group · Pro plan · 4 team members
            </p>
          </div>
        </div>
        <button className="btn-primary tenant-edit-btn">
          <Save size={14} /> Save Changes
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '16px' }}>
        {/* Section nav */}
        <div className="dashboard-card" style={{ padding: '8px', height: 'fit-content' }}>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className="sidebar-item"
                style={{
                  background: active === s.id ? '#E3F2FD' : 'transparent',
                  color: active === s.id ? '#0077B6' : '#495057',
                  fontWeight: active === s.id ? 600 : 500,
                }}
              >
                <Icon size={18} /> {s.label}
              </button>
            );
          })}
        </div>

        {/* Section body */}
        <div>
          {active === 'profile' && <ProfileSection />}
          {active === 'organization' && <OrganizationSection />}
          {active === 'notifications' && <NotificationsSection />}
          {active === 'security' && <SecuritySection />}
          {active === 'integrations' && <IntegrationsSection />}
          {active === 'billing' && <BillingSection />}
          {active === 'team' && <TeamSection />}
          {active === 'appearance' && <AppearanceSection />}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon: Icon, children }) {
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3>{Icon && <Icon size={18} />} {title}</h3>
      </div>
      <div style={{ padding: '4px 0' }}>{children}</div>
    </div>
  );
}

function Field({ label, value, type = 'text' }) {
  return (
    <label style={{ display: 'block', marginBottom: '14px' }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6C757D', marginBottom: 4 }}>
        {label}
      </span>
      <input
        type={type}
        defaultValue={value}
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid #DEE2E6',
          borderRadius: '8px',
          fontSize: 14,
        }}
      />
    </label>
  );
}

function Toggle({ label, desc, defaultOn = false }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 0',
      borderBottom: '1px solid #F1F3F5',
    }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#6C757D', marginTop: 2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => setOn(!on)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 12,
          background: on ? '#2E7D32' : '#CED4DA',
          position: 'relative',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'white',
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  );
}

function ProfileSection() {
  return (
    <Card title="Profile" icon={User}>
      <Field label="Full Name" value="Matt Sudhir" />
      <Field label="Email" value="matt@breezepropertygroup.com" type="email" />
      <Field label="Phone" value="(419) 555-0199" type="tel" />
      <Field label="Job Title" value="Managing Partner" />
      <Field label="Time Zone" value="America/New_York (EST)" />
    </Card>
  );
}

function OrganizationSection() {
  return (
    <>
      <Card title="Company Details" icon={Building2}>
        <Field label="Company Name" value="Breeze Property Group" />
        <Field label="Legal Entity" value="Breeze Property Group LLC" />
        <Field label="EIN" value="87-1234567" />
        <Field label="Primary Address" value="1250 Main Street, Toledo, OH 43604" />
        <Field label="Website" value="https://breezepropertygroup.com" type="url" />
      </Card>
      <Card title="Portfolio">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: '8px 4px' }}>
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
    <div style={{ padding: '12px', background: '#F8F9FA', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#023E8A' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6C757D', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
    </div>
  );
}

function NotificationsSection() {
  return (
    <>
      <Card title="Email Notifications" icon={Mail}>
        <Toggle label="New work orders" desc="Get notified when a tenant submits a maintenance request" defaultOn />
        <Toggle label="Rent payments" desc="Alert when rent is paid or becomes overdue" defaultOn />
        <Toggle label="Lease renewals" desc="Reminder 60 days before a lease expires" defaultOn />
        <Toggle label="Weekly digest" desc="Summary of portfolio activity every Monday morning" defaultOn />
        <Toggle label="Product updates" desc="New Breeze features and release notes" />
      </Card>
      <Card title="SMS / Push" icon={Phone}>
        <Toggle label="Urgent work orders only" desc="Text me when an urgent or emergency ticket is filed" defaultOn />
        <Toggle label="Chat responses" desc="Push notification when the AI finishes a long-running query" />
        <Toggle label="Call summaries" desc="SMS a transcript summary after each outbound AI call" defaultOn />
      </Card>
    </>
  );
}

function SecuritySection() {
  return (
    <Card title="Security" icon={Shield}>
      <Toggle label="Two-factor authentication" desc="Require a code from your authenticator app on sign-in" defaultOn />
      <Toggle label="Session timeout" desc="Auto sign-out after 30 minutes of inactivity" defaultOn />
      <Toggle label="IP allowlist" desc="Only allow sign-ins from approved IP ranges" />
      <Toggle label="Audit log export" desc="Weekly CSV email of all account activity" />
      <div style={{ marginTop: 16, padding: 12, background: '#FFF3E0', borderRadius: 8, fontSize: 13, color: '#E65100' }}>
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
        <div key={i.name} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 0', borderBottom: '1px solid #F1F3F5',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{i.name}</div>
            <div style={{ fontSize: 12, color: '#6C757D', marginTop: 2 }}>{i.desc}</div>
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
        <div style={{ padding: '12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#023E8A' }}>Breeze Pro</div>
            <div style={{ fontSize: 13, color: '#6C757D', marginTop: 2 }}>Up to 150 units · Unlimited AI calls · Priority support</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 24, fontWeight: 700 }}>$249<span style={{ fontSize: 14, color: '#6C757D' }}>/mo</span></div>
            <div style={{ fontSize: 12, color: '#6C757D' }}>Next invoice: May 1, 2026</div>
          </div>
        </div>
      </Card>
      <Card title="Payment Method">
        <div style={{ padding: '12px 4px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 28, background: '#023E8A', color: 'white', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>VISA</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Visa ending in 4821</div>
            <div style={{ fontSize: 12, color: '#6C757D' }}>Expires 09/2028</div>
          </div>
          <button className="btn-secondary">Update</button>
        </div>
      </Card>
      <Card title="Recent Invoices">
        <table className="properties-table">
          <thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Apr 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
            <tr><td>Mar 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
            <tr><td>Feb 1, 2026</td><td>$249.00</td><td><span className="unit-status unit-occupied">Paid</span></td></tr>
          </tbody>
        </table>
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
        <div key={m.email} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 0', borderBottom: '1px solid #F1F3F5',
        }}>
          <div className="user-avatar-small">{m.name.split(' ').map(n => n[0]).join('')}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
            <div style={{ fontSize: 12, color: '#6C757D' }}>{m.email} · Last active {m.lastActive}</div>
          </div>
          <span className="unit-status status-in_progress">{m.role}</span>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="btn-primary tenant-edit-btn"><User size={14} /> Invite Member</button>
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
