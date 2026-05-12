import { useState } from 'react';
import {
  MessageSquare, LayoutDashboard, Building2, Users, FileText,
  DollarSign, Wrench, BarChart3, Settings, HelpCircle, LogOut,
  ChevronLeft, ChevronRight, ChevronDown, CheckSquare, Workflow, Database,
  Calendar, Mail, Stamp, Scale, AtSign, Bot, PhoneOutgoing,
} from 'lucide-react';
import BreezeLogo from './BreezeLogo';

const NAV_ITEMS = [
  { id: 'chat', icon: MessageSquare, label: 'Chat Home', section: 'primary' },
  { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', section: 'primary' },
  { id: 'divider1', type: 'divider' },
  { id: 'properties', icon: Building2, label: 'Properties', section: 'manage' },
  { id: 'tenants', icon: Users, label: 'Tenants', section: 'manage' },
  { id: 'leasing', icon: FileText, label: 'Leasing', section: 'manage', expandable: true },
  { id: 'move-events', icon: Calendar, label: 'Move Events', section: 'manage', child: true, parentId: 'leasing' },
  { id: 'accounting', icon: DollarSign, label: 'Accounting', section: 'manage' },
  { id: 'maintenance', icon: Wrench, label: 'Maintenance', section: 'manage' },
  { id: 'tasks', icon: CheckSquare, label: 'Tasks', section: 'manage' },
  { id: 'workflows', icon: Workflow, label: 'Workflows', section: 'manage' },
  { id: 'mail-slapper', icon: Mail, label: 'Mail Slapper', section: 'manage', expandable: true },
  { id: 'mail-snail', icon: Stamp, label: 'Snail Mail', section: 'manage', child: true, parentId: 'mail-slapper' },
  { id: 'mail-registered-agent', icon: Scale, label: 'Registered Agent', section: 'manage', child: true, parentId: 'mail-slapper' },
  { id: 'mail-email', icon: AtSign, label: 'Email', section: 'manage', child: true, parentId: 'mail-slapper' },
  { id: 'ai-agents', icon: Bot, label: 'AI Agents', section: 'manage', expandable: true, badge: 'AI' },
  { id: 'ai-switch-utilities', icon: PhoneOutgoing, label: 'Switch Utilities', section: 'manage', child: true, parentId: 'ai-agents' },
  { id: 'ai-payment-plan-followup', icon: PhoneOutgoing, label: 'Payment Plan Followup', section: 'manage', child: true, parentId: 'ai-agents' },
  { id: 'reports', icon: BarChart3, label: 'Reports', section: 'manage' },
  { id: 'property-directory', icon: Database, label: 'Property Directory', section: 'manage' },
  { id: 'divider2', type: 'divider' },
  { id: 'settings', icon: Settings, label: 'Settings', section: 'bottom' },
  { id: 'help', icon: HelpCircle, label: 'Help', section: 'bottom' },
];

export default function Sidebar({ activeView, onNavigate, collapsed, onToggleCollapse, mobileOpen }) {
  // Track which expandable parents are open. Default: only the
  // group containing the active view is open, so on a fresh load
  // (active=chat) Leasing's children stay tucked away.
  const [openGroups, setOpenGroups] = useState(() => {
    const initial = {};
    const activeItem = NAV_ITEMS.find((i) => i.id === activeView);
    if (activeItem?.parentId) initial[activeItem.parentId] = true;
    return initial;
  });

  const toggleGroup = (id) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        {/* The logo doubles as a collapse toggle — clicking it has the
            same effect as the chevron button next to it. Wrapped in a
            borderless <button> so it's keyboard-accessible without
            needing any CSS changes. */}
        <button
          type="button"
          className="sidebar-logo-btn"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
          }}
        >
          <BreezeLogo size={collapsed ? 32 : 36} showText={!collapsed} />
        </button>
        <button className="sidebar-collapse-btn" onClick={onToggleCollapse}>
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          if (item.type === 'divider') {
            return <div key={item.id} className="sidebar-divider" />;
          }
          // Hide children of collapsed groups. Sidebar-collapsed mode
          // (icons-only) flattens everything anyway, so children are
          // always shown there.
          if (item.child && !collapsed && !openGroups[item.parentId]) {
            return null;
          }
          const Icon = item.icon;
          const isActive = activeView === item.id;
          const isExpandable = item.expandable && !collapsed;
          const isOpen = !!openGroups[item.id];
          return (
            <button
              key={item.id}
              className={`sidebar-item ${isActive ? 'active' : ''} ${item.id === 'chat' ? 'chat-nav-item' : ''} ${item.child ? 'sidebar-child-item' : ''}`}
              onClick={() => {
                if (isExpandable) toggleGroup(item.id);
                onNavigate(item.id);
              }}
              title={collapsed ? item.label : undefined}
              style={item.child && !collapsed ? { paddingLeft: 36 } : undefined}
            >
              <Icon size={item.child ? 16 : 20} />
              {!collapsed && <span>{item.label}</span>}
              {item.id === 'chat' && !collapsed && (
                <span className="nav-badge">AI</span>
              )}
              {item.badge && !collapsed && (
                <span className="nav-badge">{item.badge}</span>
              )}
              {isExpandable && (
                <ChevronDown
                  size={14}
                  style={{
                    marginLeft: 'auto',
                    transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.15s',
                    opacity: 0.6,
                  }}
                />
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
