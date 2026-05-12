import { useEffect, useState } from 'react';
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatHome from './components/ChatHome';
import SetupWizard from './components/SetupWizard';
import ClassicDashboard from './components/ClassicDashboard';
import PropertiesPage from './components/PropertiesPage';
import TenantsPage from './components/TenantsPage';
import MaintenancePage from './components/MaintenancePage';
import TasksPage from './components/TasksPage';
import WorkflowsPage from './components/WorkflowsPage';
import LeasingPage from './components/LeasingPage';
import AccountingPage from './components/AccountingPage';
import MailSlapperPage from './components/MailSlapperPage';
import AiAgentsPage from './components/AiAgentsPage';
import ReportsPage from './components/ReportsPage';
import SettingsPage from './components/SettingsPage';
import HelpPage from './components/HelpPage';
import PropertiesDrilldown from './components/PropertiesDrilldown';
import PropertyDirectoryPage from './components/PropertyDirectoryPage';
import MoveEventsPage from './components/MoveEventsPage';
import './App.css';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

function App() {
  const [activeView, setActiveView] = useState('chat');
  const [showClassic, setShowClassic] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Filters to seed a page with when navigating from a chat Show Me link.
  // Keyed by view id (e.g. 'maintenance') → plain object of filter values.
  const [pendingFilters, setPendingFilters] = useState({});

  // On first mount, auto-open the setup wizard if onboarding state is
  // null or not marked complete. We gate this behind a per-session
  // 'dismissed' flag so closing the wizard doesn't re-pop it for the
  // rest of the session.
  useEffect(() => {
    if (sessionStorage.getItem('breeze.wizard.dismissed') === 'true') return;
    (async () => {
      try {
        const url = new URL('/api/admin/onboarding-state', window.location.origin);
        const tok = sessionStorage.getItem('breeze.admin.token');
        if (tok) url.searchParams.set('secret', tok);
        else if (CLERK_ENABLED) url.searchParams.set('secret', 'clerk');
        const res = await fetch(url.toString());
        if (!res.ok) return;
        const json = await res.json();
        const state = json.onboarding_state;
        if (!state || !state.completed_at) setWizardOpen(true);
      } catch { /* network blip — don't pester the user */ }
    })();
  }, []);

  const closeWizard = () => {
    sessionStorage.setItem('breeze.wizard.dismissed', 'true');
    setWizardOpen(false);
  };

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
    if (
      activeView === 'mail-slapper' ||
      activeView === 'mail-snail' ||
      activeView === 'mail-registered-agent' ||
      activeView === 'mail-email'
    ) {
      return <MailSlapperPage activeView={activeView} onNavigate={handleNavigate} />;
    }
    if (
      activeView === 'ai-agents' ||
      activeView === 'ai-switch-utilities' ||
      activeView === 'ai-payment-plan-followup'
    ) {
      return <AiAgentsPage activeView={activeView} onNavigate={handleNavigate} />;
    }
    if (activeView === 'reports') return <ReportsPage />;
    if (activeView === 'property-directory') return <PropertyDirectoryPage />;
    if (activeView === 'move-events') return <MoveEventsPage />;
    if (activeView === 'settings') return <SettingsPage />;
    if (activeView === 'help') return <HelpPage />;
    if (activeView === 'properties-drilldown') {
      return <PropertiesDrilldown initialFilters={pendingFilters['properties-drilldown']} />;
    }
    if (activeView === 'dashboard' || showClassic) {
      return <ClassicDashboard onNavigate={handleNavigate} />;
    }
    // Other nav items default to dashboard for now
    return <ClassicDashboard onNavigate={handleNavigate} />;
  };

  const showToggle = activeView === 'chat' || activeView === 'dashboard';

  const shell = (
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
          onNavigate={handleNavigate}
        />
        <main className="content-area">
          {renderContent()}
        </main>
      </div>
      {wizardOpen && (
        <SetupWizard onClose={closeWizard} onNavigate={handleNavigate} />
      )}
    </div>
  );

  // When Clerk is not configured (no publishable key in env), render
  // the app as-is — admin endpoints stay gated by BREEZE_ADMIN_TOKEN.
  // Once VITE_CLERK_PUBLISHABLE_KEY is set, the same shell is shown
  // only to authenticated users; unauthenticated visitors see the
  // hosted Clerk sign-in.
  if (!CLERK_ENABLED) return shell;

  return (
    <>
      <SignedIn>{shell}</SignedIn>
      <SignedOut>
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: '24px',
          background: 'linear-gradient(135deg, #E3F2FD 0%, #E8EAF6 100%)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ marginBottom: 8, color: '#1A1A1A' }}>Breeze OS</h1>
            <p style={{ marginTop: 0, marginBottom: 24, color: '#555' }}>
              Sign in to access your property accounting workspace.
            </p>
            <SignIn routing="hash" />
          </div>
        </div>
      </SignedOut>
    </>
  );
}

export default App;
