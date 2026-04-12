import { Bell, Menu, MessageSquare, LayoutDashboard } from 'lucide-react';

export default function TopBar({ showClassic, onToggleClassic, activeView, onMenuToggle }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="mobile-menu-btn" onClick={onMenuToggle} title="Menu">
          <Menu size={22} />
        </button>
        <h1 className="topbar-title">
          {activeView === 'chat' ? 'Chat Home' :
           activeView === 'dashboard' ? 'Dashboard' :
           activeView.charAt(0).toUpperCase() + activeView.slice(1)}
        </h1>
      </div>

      <div className="topbar-center">
        {(activeView === 'chat' || activeView === 'dashboard') && (
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
        <button className="topbar-icon-btn" title="Notifications">
          <Bell size={20} />
          <span className="notification-dot" />
        </button>
      </div>
    </header>
  );
}
