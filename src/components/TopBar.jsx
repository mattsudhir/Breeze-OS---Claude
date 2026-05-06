import { useState, useRef, useEffect } from 'react';
import {
  Bell, Menu, MessageSquare, LayoutDashboard, Database, ChevronDown,
} from 'lucide-react';
import { useDataSource } from '../contexts/DataSourceContext.jsx';

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

export default function TopBar({ showClassic, onToggleClassic, activeView, onMenuToggle, showToggle }) {
  const { dataSource, setDataSource, sources } = useDataSource();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapperRef = useRef(null);

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (e) => {
      if (!menuWrapperRef.current?.contains(e.target)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const activeLabel =
    sources.find((s) => s.value === dataSource)?.label || dataSource;

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
        <div
          ref={menuWrapperRef}
          className="data-source-toggle-wrapper"
          style={{ position: 'relative' }}
        >
          <button
            className="data-source-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            title="Data source — applies to chat and every menu page"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              border: '1px solid #D0D7DE',
              background: '#FFF',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <Database size={14} />
            <span>{activeLabel}</span>
            <ChevronDown
              size={12}
              style={{
                transform: menuOpen ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s',
              }}
            />
          </button>
          {menuOpen && (
            <div
              className="data-source-menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 240,
                background: '#FFF',
                border: '1px solid #D0D7DE',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                zIndex: 100,
                overflow: 'hidden',
              }}
            >
              {sources.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    setDataSource(option.value);
                    setMenuOpen(false);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: 'none',
                    background: option.value === dataSource ? '#F2F6FA' : 'transparent',
                    cursor: 'pointer',
                    borderBottom: '1px solid #EEF0F2',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#1A1A1A' }}>
                    {option.label}
                    {option.value === dataSource && (
                      <span style={{ marginLeft: 6, color: '#1565C0', fontSize: 11 }}>
                        • active
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#6A737D', marginTop: 2 }}>
                    {option.hint}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="topbar-icon-btn" title="Notifications">
          <Bell size={20} />
          <span className="notification-dot" />
        </button>
      </div>
    </header>
  );
}
