import { useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatHome from './components/ChatHome';
import ClassicDashboard from './components/ClassicDashboard';
import PropertiesPage from './components/PropertiesPage';
import TenantsPage from './components/TenantsPage';
import MaintenancePage from './components/MaintenancePage';
import TasksPage from './components/TasksPage';
import WorkflowsPage from './components/WorkflowsPage';
import AccountingPage from './components/AccountingPage';
import LeasingPage from './components/LeasingPage';
import ReportsPage from './components/ReportsPage';
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
    if (viewId === 'chat') {
      setShowClassic(false);
    } else if (viewId === 'dashboard') {
      setShowClassic(true);
    }
  };

  const handleToggleClassic = (classic) => {
    setShowClassic(classic);
    setActiveView(classic ? 'dashboard' : 'chat');
  };

  // Decide which view to render
  const renderContent = () => {
    if (activeView === 'chat') return <ChatHome onNavigate={handleNavigate} />;
    if (activeView === 'properties') return <PropertiesPage />;
    if (activeView === 'tenants') return <TenantsPage />;
    if (activeView === 'maintenance') {
      return <MaintenancePage initialFilters={pendingFilters.maintenance} />;
    }
    if (activeView === 'tasks') return <TasksPage />;
    if (activeView === 'workflows') return <WorkflowsPage />;
    if (activeView === 'accounting') return <AccountingPage />;
    if (activeView === 'leasing') return <LeasingPage />;
    if (activeView === 'reports') return <ReportsPage />;
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
