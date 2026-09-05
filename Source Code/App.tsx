
import React, { useState, useEffect, Suspense, lazy } from 'react';
import { Layout } from './components/Layout';
import { TeamMember, Role } from './types';
import { DataProvider, useData } from './contexts/DataContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { RefreshCcw } from 'lucide-react';

// Lazy-loaded routes — each page becomes its own bundle.
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Imports = lazy(() => import('./pages/Imports').then(m => ({ default: m.Imports })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const ClientsAndHierarchy = lazy(() => import('./pages/ClientsAndHierarchy').then(m => ({ default: m.ClientsAndHierarchy })));
const Reports = lazy(() => import('./pages/Reports').then(m => ({ default: m.Reports })));
const BrokerageStructure = lazy(() => import('./pages/BrokerageStructure').then(m => ({ default: m.BrokerageStructure })));
const AuditLog = lazy(() => import('./pages/AuditLog').then(m => ({ default: m.AuditLog })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));

const PageLoader: React.FC<{ label?: string }> = ({ label = 'Loading…' }) => (
  <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-12 flex flex-col items-center justify-center text-center">
    <RefreshCcw className="w-6 h-6 text-blue-600 animate-spin mb-3" />
    <p className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">{label}</p>
  </div>
);

const AppContent: React.FC = () => {
  const { team, loading } = useData();
  const [activePage, setActivePage] = useState('dashboard');
  const [currentUser, setCurrentUser] = useState<TeamMember | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Auto-login from stored JWT
  useEffect(() => {
    const storedUser = localStorage.getItem('wf_user');
    const storedToken = localStorage.getItem('wf_token');
    if (storedUser && storedToken) {
      try {
        const user = JSON.parse(storedUser);
        setCurrentUser(user);
        setIsLoggedIn(true);
      } catch (e) {
        localStorage.removeItem('wf_user');
        localStorage.removeItem('wf_token');
      }
    }
  }, []);

  useEffect(() => {
    if (currentUser) {
      const updatedUser = team.find(t => t.id === currentUser.id);
      if (updatedUser) setCurrentUser(updatedUser);
    }
  }, [team]);

  const handleLogin = (user: TeamMember) => {
    setCurrentUser(user);
    setIsLoggedIn(true);
    setActivePage('dashboard');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setIsLoggedIn(false);
    localStorage.removeItem('wf_token');
    localStorage.removeItem('wf_user');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col items-center justify-center transition-colors">
        <RefreshCcw className="w-10 h-10 text-blue-600 animate-spin mb-4" />
        <p className="text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest text-xs">Connecting to Freedom LifeX...</p>
      </div>
    );
  }

  if (!isLoggedIn || !currentUser) {
    return (
      <Suspense fallback={<PageLoader label="Loading sign-in…" />}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;

  const renderPage = () => {
    // Imports is admin-only. Audit Log is admin + finance (finance needs the
    // trail to cross-check before releasing payment).
    if (!isAdmin && activePage === 'imports') {
      return <Dashboard currentUser={currentUser} />;
    }
    if (!isAdmin && !isFinance && activePage === 'audit') {
      return <Dashboard currentUser={currentUser} />;
    }

    switch (activePage) {
      case 'dashboard':
        return <Dashboard currentUser={currentUser} />;
      case 'imports':
        return <Imports currentUser={currentUser} />;
      case 'clients':
        return <ClientsAndHierarchy currentUser={currentUser} />;
      case 'reports':
        return <Reports currentUser={currentUser} />;
      case 'brokerage':
        return <BrokerageStructure currentUser={currentUser} />;
      case 'audit':
        return <AuditLog currentUser={currentUser} />;
      case 'settings':
        return <Settings currentUser={currentUser} />;
      default:
        return <Dashboard currentUser={currentUser} />;
    }
  };

  return (
    <Layout
      activePage={activePage}
      onNavigate={setActivePage}
      currentUser={currentUser}
      onSwitchUser={setCurrentUser}
      onLogout={handleLogout}
    >
      <ErrorBoundary variant="inline" label={activePage} resetKey={activePage}>
        <Suspense fallback={<PageLoader />}>
          {renderPage()}
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <DataProvider>
            <AppContent />
          </DataProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

export default App;
