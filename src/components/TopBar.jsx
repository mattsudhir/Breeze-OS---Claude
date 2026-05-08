import { Menu, MessageSquare, LayoutDashboard } from 'lucide-react';
import NotificationsBell from './NotificationsBell.jsx';

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

      <div className="topbar-right">
        <NotificationsBell onNavigate={onNavigate} />
      </div>
    </header>
  );
}
