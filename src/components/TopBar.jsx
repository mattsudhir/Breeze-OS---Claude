import { Menu, MessageSquare, LayoutDashboard } from 'lucide-react';
import { UserButton } from '@clerk/clerk-react';
import NotificationsBell from './NotificationsBell.jsx';

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

      <div className="topbar-right" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <NotificationsBell onNavigate={onNavigate} />
        {CLERK_ENABLED && <UserButton afterSignOutUrl="/" />}
      </div>
    </header>
  );
}
