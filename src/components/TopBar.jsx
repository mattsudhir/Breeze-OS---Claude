import { useState } from 'react';
import { Menu, MessageSquare, LayoutDashboard, Wrench } from 'lucide-react';
import { UserButton } from '@clerk/clerk-react';
import NotificationsBell from './NotificationsBell.jsx';
import MigrationFixButton from './MigrationFixButton.jsx';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

const TITLES = {
  chat: 'Chat Home',
  dashboard: 'Dashboard',
  properties: 'Properties',
  tenants: 'Tenants',
  leases: 'Leases',
  accounting: 'Accounting',
  maintenance: 'Maintenance',
  tasks: 'Tasks',
  workflows: 'Workflows',
  'mail-slapper': 'Mail Slapper',
  'mail-snail': 'Mail Slapper · Snail Mail',
  'mail-registered-agent': 'Mail Slapper · Registered Agent',
  'mail-email': 'Mail Slapper · Email',
  'ai-agents': 'AI Agents',
  'ai-inbox': 'AI · Inbox',
  'ai-approval-queue': 'AI · Approval Queue',
  'ai-switch-utilities': 'AI · Switch Utilities',
  'ai-payment-plan-followup': 'AI · Payment Plan Followup',
  reports: 'Reports',
  settings: 'Settings',
  help: 'Help',
};

export default function TopBar({
  showClassic,
  onToggleClassic,
  activeView,
  onMenuToggle,
  showToggle,
  onNavigate,
}) {
  const [opsOpen, setOpsOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="mobile-menu-btn" onClick={onMenuToggle} title="Menu">
          <Menu size={22} />
        </button>
        <h1 className="topbar-title">
          {TITLES[activeView] || activeView.charAt(0).toUpperCase() + activeView.slice(1)}
        </h1>
      </div>

      <div className="topbar-center">
        {showToggle && (
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${!showClassic ? 'active' : ''}`}
              onClick={() => onToggleClassic(false)}
            >
              <MessageSquare size={16} />
              <span>Chat</span>
            </button>
            <button
              className={`view-toggle-btn ${showClassic ? 'active' : ''}`}
              onClick={() => onToggleClassic(true)}
            >
              <LayoutDashboard size={16} />
              <span>Classic</span>
            </button>
          </div>
        )}
      </div>

      <div className="topbar-right" style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpsOpen(!opsOpen)}
          title="Ops: apply pending migrations"
          className="topbar-ops-btn"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#666',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <Wrench size={18} />
        </button>
        <NotificationsBell onNavigate={onNavigate} />
        {CLERK_ENABLED && <UserButton afterSignOutUrl="/" />}
        {opsOpen && (
          <div style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 360,
            background: 'white',
            border: '1px solid #DDD',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: 14,
            zIndex: 200,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Ops</div>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
              Sync the DB schema after a deploy. Safe to run any time — drizzle skips
              migrations that already applied.
            </div>
            <MigrationFixButton error="" alwaysShow onApplied={() => setOpsOpen(false)} />
          </div>
        )}
      </div>
    </header>
  );
}
