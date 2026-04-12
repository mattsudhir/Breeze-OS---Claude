import { useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatHome from './components/ChatHome';
import ClassicDashboard from './components/ClassicDashboard';
import './App.css';

function App() {
  const [activeView, setActiveView] = useState('chat');
  const [showClassic, setShowClassic] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleNavigate = (viewId) => {
    setActiveView(viewId);
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

  // For non-chat/dashboard nav items, show classic dashboard as placeholder
  const showClassicView = showClassic || (activeView !== 'chat' && activeView !== 'dashboard');

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        activeView={activeView}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className="main-content">
        <TopBar
          showClassic={showClassicView}
          onToggleClassic={handleToggleClassic}
          activeView={activeView}
        />
        <main className="content-area">
          {showClassicView ? <ClassicDashboard /> : <ChatHome />}
        </main>
      </div>
    </div>
  );
}

export default App;
