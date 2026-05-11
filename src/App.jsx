import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatHome from './components/ChatHome';
import ClassicDashboard from './components/ClassicDashboard';
import PropertiesPage from './components/PropertiesPage';
import TenantsPage from './components/TenantsPage';
import MaintenancePage from './components/MaintenancePage';
import TasksPage from './components/TasksPage';
import WorkflowsPage from './components/WorkflowsPage';
import LeasingPage from './components/LeasingPage';
import AccountingPage from './components/AccountingPage';
import ReportsPage from './components/ReportsPage';
import SettingsPage from './components/SettingsPage';
import HelpPage from './components/HelpPage';
import PropertiesDrilldown from './components/PropertiesDrilldown';
import PropertyDirectoryPage from './components/PropertyDirectoryPage';
import MoveEventsPage from './components/MoveEventsPage';
import { initPush } from './lib/push';
import './App.css';

function App() {
  const [activeView, setActiveView] = useState('chat');
  const [showClassic, setShowClassic] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Filters to seed a page with when navigating from a chat Show Me link.
  // Keyed by view id (e.g. 'maintenance') → plain object of filter values.
  const [pendingFilters, setPendingFilters] = useState({});

  const handleNavigate = (viewId, filters) => {
    setActiveView(viewId);
    setMobileMenuOpen(false);
    if (filters) {
      setPendingFilters((prev) => ({ ...prev, [viewId]: filters }));
    }
    // showClassic tracks whether the dashboard is the *default* surface.
    // Only the dashboard itself sets it true; every other destination
    // clears it so a dashboard stat card click lands cleanly on the
    // target page without the dashboard lingering underneath.
    if (viewId === 'dashboard') {
      setShowClassic(true);
    } else {
      setShowClassic(false);
    }
  };

  // On native shells, register for push notifications once at app
  // start. initPush() is a no-op on the web, so the same hook is safe
  // everywhere. The `data.view` field on an inbound notification is
  // an opt-in deep link: server-side code that wants the tap to land
  // a user on, say, the Move Events page can send `{ view: 'move-events' }`
  // in the FCM data payload.
  useEffect(() => {
    initPush({
      onReceive: (notification) => {
        // Foreground push arrived while the app is open. For now we
        // just log; once we have an in-app toast component, surface
        // it here.
        console.log('[push] received', notification);
      },
      onAction: (action) => {
        const view = action?.notification?.data?.view;
        if (view) handleNavigate(view);
      },
    });
  }, []);

  const handleToggleClassic = (classic) => {
    setShowClassic(classic);
    setActiveView(classic ? 'dashboard' : 'chat');
  };

  // Decide which view to render
  const renderContent = () => {
    if (activeView === 'chat') return <ChatHome onNavigate={handleNavigate} />;
    if (activeView === 'properties') return <PropertiesPage onNavigate={handleNavigate} />;
    if (activeView === 'tenants') return <TenantsPage />;
    if (activeView === 'maintenance') {
      return <MaintenancePage initialFilters={pendingFilters.maintenance} />;
    }
    if (activeView === 'tasks') return <TasksPage />;
    if (activeView === 'workflows') return <WorkflowsPage />;
    if (activeView === 'leasing') return <LeasingPage />;
    if (activeView === 'accounting') return <AccountingPage />;
    if (activeView === 'reports') return <ReportsPage />;
    if (activeView === 'property-directory') return <PropertyDirectoryPage />;
    if (activeView === 'move-events') return <MoveEventsPage />;
    if (activeView === 'settings') return <SettingsPage />;
    if (activeView === 'help') return <HelpPage />;
    if (activeView === 'properties-drilldown') return <PropertiesDrilldown />;
    if (activeView === 'dashboard' || showClassic) {
      return <ClassicDashboard onNavigate={handleNavigate} />;
    }
    // Other nav items default to dashboard for now
    return <ClassicDashboard onNavigate={handleNavigate} />;
  };

  const showToggle = activeView === 'chat' || activeView === 'dashboard';

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {mobileMenuOpen && (
        <div className="mobile-overlay" onClick={() => setMobileMenuOpen(false)} />
      )}
      <Sidebar
        activeView={activeView}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileMenuOpen}
      />
      <div className="main-content">
        <TopBar
          showClassic={showClassic}
          onToggleClassic={handleToggleClassic}
          activeView={activeView}
          onMenuToggle={() => setMobileMenuOpen(!mobileMenuOpen)}
          showToggle={showToggle}
        />
        <main className="content-area">
          {renderContent()}
        </main>
      </div>
    </div>
  );
}

export default App;
