
import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Upload, Users, Settings, FileText, Menu, X, Bell, LogOut, Cloud, CloudOff, RefreshCw, Landmark, User, Clock, CheckCheck, Sun, Moon, Search, ShieldCheck, Briefcase, Wallet } from 'lucide-react';
import { Logo } from './Logo';
import { TeamMember, Role } from '../types';
import { useData } from '../contexts/DataContext';
import { useTheme } from '../contexts/ThemeContext';
import { GlobalSearch } from './GlobalSearch';

interface LayoutProps {
  children: React.ReactNode;
  activePage: string;
  onNavigate: (page: string) => void;
  currentUser: TeamMember;
  onSwitchUser: (user: TeamMember) => void;
  onLogout: () => void;
}

interface Notification {
  id: string;
  type: 'import' | 'invoice' | 'system' | 'payout';
  title: string;
  message: string;
  time: Date;
  read: boolean;
}

const SidebarItem = ({ icon: Icon, label, active, onClick }: any) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center space-x-3 px-4 py-3 text-sm font-medium transition-colors ${active
      ? 'bg-brand-teal-soft dark:bg-brand-teal/20 text-brand-teal dark:text-brand-teal-soft border-r-4 border-brand-orange'
      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
      }`}
  >
    <Icon className="w-5 h-5 shrink-0" />
    <span>{label}</span>
  </button>
);

export const Layout: React.FC<LayoutProps> = ({ children, activePage, onNavigate, currentUser, onSwitchUser, onLogout }) => {
  const { team, globalConfig, isOnline, isSyncing, batches, invoices } = useData();
  const { theme, toggleTheme, isDark } = useTheme();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;

  // Keyboard shortcut: Ctrl+K / Cmd+K for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Generate notifications dynamically from app state
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('wf_read_notifications');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const notifications: Notification[] = React.useMemo(() => {
    const notifs: Notification[] = [];

    // Recent imports (from batches)
    if (batches && batches.length > 0) {
      const recentBatches = [...batches]
        .sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime())
        .slice(0, 3);
      recentBatches.forEach(batch => {
        notifs.push({
          id: `batch_${batch.id}`,
          type: 'import',
          title: 'Data Import',
          message: `${batch.fileName} — ${batch.totalLines} transactions (₹${batch.totalGross.toLocaleString()})`,
          time: new Date(batch.uploadDate),
          read: readIds.has(`batch_${batch.id}`),
        });
      });
    }

    // Pending invoices
    if (invoices && invoices.length > 0) {
      const pendingInvoices = invoices.filter(inv => inv.status === 'SUBMITTED');
      if (pendingInvoices.length > 0) {
        if (isAdmin) {
          notifs.push({
            id: 'pending_invoices',
            type: 'invoice',
            title: 'Pending Approvals',
            message: `${pendingInvoices.length} invoice(s) waiting for settlement approval.`,
            time: new Date(),
            read: readIds.has('pending_invoices'),
          });
        }
        const myPending = pendingInvoices.filter(inv => inv.userId === currentUser.id);
        if (myPending.length > 0) {
          notifs.push({
            id: 'my_pending_invoices',
            type: 'payout',
            title: 'Payout Status',
            message: `You have ${myPending.length} submitted invoice(s) pending admin approval.`,
            time: new Date(),
            read: readIds.has('my_pending_invoices'),
          });
        }
      }

      // Recently paid invoices for current user
      const paidInvoices = invoices
        .filter(inv => inv.userId === currentUser.id && inv.status === 'PAID' && inv.paidDate)
        .sort((a, b) => new Date(b.paidDate!).getTime() - new Date(a.paidDate!).getTime())
        .slice(0, 2);
      paidInvoices.forEach(inv => {
        notifs.push({
          id: `paid_${inv.id}`,
          type: 'payout',
          title: 'Payment Received',
          message: `₹${inv.amount.toLocaleString()} for ${inv.month} has been settled.`,
          time: new Date(inv.paidDate!),
          read: readIds.has(`paid_${inv.id}`),
        });
      });
    }

    // Connection status
    if (!isOnline) {
      notifs.unshift({
        id: 'offline_warning',
        type: 'system',
        title: 'Disconnected',
        message: 'Unable to connect to the server. Data may be stale.',
        time: new Date(),
        read: false,
      });
    }

    return notifs.sort((a, b) => b.time.getTime() - a.time.getTime());
  }, [batches, invoices, isOnline, isAdmin, currentUser, readIds]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllRead = () => {
    const allIds = new Set(notifications.map(n => n.id));
    setReadIds(allIds);
    localStorage.setItem('wf_read_notifications', JSON.stringify(Array.from(allIds)));
  };

  const formatTimeAgo = (date: Date) => {
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  };

  const typeColors: Record<string, { bg: string; text: string }> = {
    import: { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-600 dark:text-blue-400' },
    invoice: { bg: 'bg-amber-100 dark:bg-amber-900/40', text: 'text-amber-600 dark:text-amber-400' },
    system: { bg: 'bg-red-100 dark:bg-red-900/40', text: 'text-red-600 dark:text-red-400' },
    payout: { bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-600 dark:text-emerald-400' },
  };

  // Close notification dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNavigate = (page: string) => {
    onNavigate(page);
    setIsMobileMenuOpen(false);
  };

  return (
    // h-screen, not min-h-screen: the page itself must not grow with its content. The content area below scrolls on its
    // own, so the sidebar stays one screen tall and Sign Out stays in view instead of sitting at the bottom of a long page.
    <div className="h-screen overflow-hidden bg-slate-50 dark:bg-slate-900 flex transition-colors duration-200">
      {/* Mobile overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 transform transition-transform duration-200 ease-in-out ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 flex flex-col`}>
        {/* Logo */}
        <div className="relative min-h-[7rem] flex items-center justify-center px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
          <Logo variant="header" />
          <button className="absolute right-3 top-3 md:hidden text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300" onClick={() => setIsMobileMenuOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="mt-4 space-y-0.5 flex-1 overflow-y-auto">
          <SidebarItem icon={LayoutDashboard} label="Dashboard" active={activePage === 'dashboard'} onClick={() => handleNavigate('dashboard')} />
          {isAdmin && <SidebarItem icon={Upload} label="Imports & Data" active={activePage === 'imports'} onClick={() => handleNavigate('imports')} />}
          {/* Finance is an accounts desk, not a second admin: Dashboard, Payouts,
              Audit Log and their own Profile. The screens that shape what people
              EARN — clients and hierarchies, rate cards, partner statements — are
              deliberately out of reach, matching the write rules on the server. */}
          {!isFinance && <SidebarItem icon={Users} label={isAdmin ? 'Clients & Map' : 'My Clients'} active={activePage === 'clients'} onClick={() => handleNavigate('clients')} />}
          {<SidebarItem icon={FileText} label={isFinance ? 'Invoices' : 'Reports & Payouts'} active={activePage === 'reports'} onClick={() => handleNavigate('reports')} />}
          {!isFinance && <SidebarItem icon={Landmark} label="Brokerage Rates" active={activePage === 'brokerage'} onClick={() => handleNavigate('brokerage')} />}
          {!isFinance && <SidebarItem icon={Briefcase} label="Partner Brokerage" active={activePage === 'partner'} onClick={() => handleNavigate('partner')} />}
          {(isAdmin || isFinance) && <SidebarItem icon={Wallet} label="Payouts" active={activePage === 'payouts'} onClick={() => handleNavigate('payouts')} />}
          {(isAdmin || isFinance) && <SidebarItem icon={ShieldCheck} label="Audit Log" active={activePage === 'audit'} onClick={() => handleNavigate('audit')} />}
          <SidebarItem icon={isAdmin ? Settings : User} label={isAdmin ? 'Admin Console' : 'My Profile'} active={activePage === 'settings'} onClick={() => handleNavigate('settings')} />
        </nav>

        {/* User + Logout */}
        <div className="border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0">
          <div className="p-4 flex items-center space-x-3">
            <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold ring-2 ring-white dark:ring-slate-800 shrink-0">
              {currentUser.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{currentUser.name}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-tighter font-semibold">{currentUser.role}</p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="w-full px-6 py-3 border-t border-slate-100 dark:border-slate-700 text-left text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center space-x-2 transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between px-4 sm:px-6 shrink-0 gap-3">
          {/* Mobile menu button */}
          <button className="md:hidden text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0" onClick={() => setIsMobileMenuOpen(true)}>
            <Menu className="w-6 h-6" />
          </button>

          {/* Search bar (visible on md+) */}
          <button
            onClick={() => setIsSearchOpen(true)}
            className="hidden md:flex flex-1 max-w-xs items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-400 dark:text-slate-500 hover:border-blue-300 dark:hover:border-blue-500 hover:bg-white dark:hover:bg-slate-600 transition text-sm"
          >
            <Search className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left text-xs">Search anything...</span>
            <kbd className="text-[10px] font-bold bg-white dark:bg-slate-600 border border-slate-200 dark:border-slate-500 rounded px-1.5 py-0.5 text-slate-400 dark:text-slate-400">⌘K</kbd>
          </button>

          {/* Right side: status + icons */}
          <div className="flex items-center gap-2 ml-auto">
            {/* Status badge */}
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-slate-50 dark:bg-slate-700 border border-slate-100 dark:border-slate-600 rounded-full">
              {isSyncing ? (
                <RefreshCw className="w-3 h-3 text-blue-600 animate-spin" />
              ) : isOnline ? (
                <Cloud className="w-3 h-3 text-emerald-500" />
              ) : (
                <CloudOff className="w-3 h-3 text-red-500" />
              )}
              <span className={`text-[10px] font-black uppercase tracking-tighter ${isOnline ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                {isSyncing ? 'Syncing...' : isOnline ? 'Live' : 'Offline'}
              </span>
            </div>

            {/* Mobile search button */}
            <button
              onClick={() => setIsSearchOpen(true)}
              className="md:hidden p-2 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition"
            >
              <Search className="w-5 h-5" />
            </button>

            {/* Dark mode toggle */}
            <button
              onClick={toggleTheme}
              className="p-2 text-slate-400 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition"
              title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* Sign Out */}
            <button
              onClick={onLogout}
              className="p-2 text-slate-400 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>

            {/* Notifications */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="p-2 text-slate-400 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg relative transition"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center px-1 ring-2 ring-white dark:ring-slate-800">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {/* Notification Dropdown */}
              {showNotifications && (
                <div className="absolute top-12 right-0 w-80 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">Notifications</h4>
                    {unreadCount > 0 && (
                      <button onClick={markAllRead} className="text-[10px] font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center gap-1">
                        <CheckCheck className="w-3 h-3" /> Mark all read
                      </button>
                    )}
                  </div>

                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Bell className="w-8 h-8 text-slate-200 dark:text-slate-600 mb-2" />
                        <p className="text-sm font-bold text-slate-500 dark:text-slate-400">All caught up!</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">No notifications right now.</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
                        {notifications.map(notif => {
                          const colors = typeColors[notif.type] || typeColors.system;
                          return (
                            <div key={notif.id} className={`px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition ${!notif.read ? 'bg-blue-50/30 dark:bg-blue-900/10' : ''}`}>
                              <div className="flex items-start gap-3">
                                <div className={`w-8 h-8 rounded-full ${colors.bg} ${colors.text} flex items-center justify-center shrink-0 mt-0.5`}>
                                  <Bell className="w-3.5 h-3.5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-slate-900 dark:text-slate-100">{notif.title}</span>
                                    {!notif.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
                                  </div>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{notif.message}</p>
                                  <div className="flex items-center gap-1 mt-1 text-slate-400 dark:text-slate-500">
                                    <Clock className="w-2.5 h-2.5" />
                                    <span className="text-[9px] font-bold uppercase tracking-wider">{formatTimeAgo(notif.time)}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          {children}
        </div>
      </main>

      {/* Global Search Modal */}
      <GlobalSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onNavigate={(page) => { onNavigate(page); setIsMobileMenuOpen(false); }}
        currentUser={currentUser}
      />
    </div>
  );
};
