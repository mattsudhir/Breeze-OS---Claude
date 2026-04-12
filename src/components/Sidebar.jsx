import {
  MessageSquare, LayoutDashboard, Building2, Users, FileText,
  DollarSign, Wrench, BarChart3, Settings, HelpCircle, LogOut,
  ChevronLeft, ChevronRight, CheckSquare, Workflow,
} from 'lucide-react';
import BreezeLogo from './BreezeLogo';

const NAV_ITEMS = [
  { id: 'chat', icon: MessageSquare, label: 'Chat Home', section: 'primary' },
  { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', section: 'primary' },
  { id: 'divider1', type: 'divider' },
  { id: 'properties', icon: Building2, label: 'Properties', section: 'manage' },
  { id: 'tenants', icon: Users, label: 'Tenants', section: 'manage' },
  { id: 'leases', icon: FileText, label: 'Leases', section: 'manage' },
  { id: 'accounting', icon: DollarSign, label: 'Accounting', section: 'manage' },
  { id: 'maintenance', icon: Wrench, label: 'Maintenance', section: 'manage' },
  { id: 'tasks', icon: CheckSquare, label: 'Tasks', section: 'manage' },
  { id: 'workflows', icon: Workflow, label: 'Workflows', section: 'manage' },
  { id: 'reports', icon: BarChart3, label: 'Reports', section: 'manage' },
  { id: 'divider2', type: 'divider' },
  { id: 'settings', icon: Settings, label: 'Settings', section: 'bottom' },
  { id: 'help', icon: HelpCircle, label: 'Help', section: 'bottom' },
];

export default function Sidebar({ activeView, onNavigate, collapsed, onToggleCollapse, mobileOpen }) {
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        <BreezeLogo size={collapsed ? 32 : 36} showText={!collapsed} />
        <button className="sidebar-collapse-btn" onClick={onToggleCollapse}>
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          if (item.type === 'divider') {
            return <div key={item.id} className="sidebar-divider" />;
          }
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              className={`sidebar-item ${isActive ? 'active' : ''} ${item.id === 'chat' ? 'chat-nav-item' : ''}`}
              onClick={() => onNavigate(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={20} />
              {!collapsed && <span>{item.label}</span>}
              {item.id === 'chat' && !collapsed && (
                <span className="nav-badge">AI</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="user-avatar-small">PM</div>
          {!collapsed && (
            <div className="user-info">
              <span className="user-name">Property Manager</span>
              <span className="user-role">Admin</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
