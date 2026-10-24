import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, Users, FileText, LayoutDashboard, Upload, Settings, Landmark, PieChart, ArrowRight, User } from 'lucide-react';
import { useData } from '../contexts/DataContext';
import { TeamMember, Role } from '../types';

interface GlobalSearchProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
  currentUser: TeamMember;
}

interface SearchResult {
  id: string;
  type: 'page' | 'client' | 'team' | 'transaction';
  title: string;
  subtitle: string;
  icon: React.ElementType;
  action: () => void;
  color: string;
}

const PAGES = [
  { id: 'dashboard', label: 'Dashboard', subtitle: 'Overview & analytics', icon: LayoutDashboard, color: 'text-blue-600', adminOnly: false },
  { id: 'imports', label: 'Imports & Data', subtitle: 'Upload brokerage files', icon: Upload, color: 'text-indigo-600', adminOnly: true },
  { id: 'clients', label: 'Clients & Map', subtitle: 'Client hierarchy management', icon: Users, color: 'text-emerald-600', adminOnly: false },
  { id: 'reports', label: 'Reports & Payouts', subtitle: 'Invoices, payouts, summaries', icon: FileText, color: 'text-amber-600', adminOnly: false },
  { id: 'brokerage', label: 'Brokerage Rates', subtitle: 'AMC scheme structure', icon: Landmark, color: 'text-violet-600', adminOnly: true },
  { id: 'settings', label: 'Admin Console', subtitle: 'System settings & team', icon: Settings, color: 'text-slate-600', adminOnly: false },
];

export const GlobalSearch: React.FC<GlobalSearchProps> = ({ isOpen, onClose, onNavigate, currentUser }) => {
  const { clients, team, transactions } = useData();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isAdmin = currentUser.role === Role.ADMIN;

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const results = useMemo((): SearchResult[] => {
    if (!query.trim()) {
      // Show all pages when no query
      return PAGES
        .filter(p => isAdmin || !p.adminOnly)
        .map(p => ({
          id: p.id,
          type: 'page',
          title: p.label,
          subtitle: p.subtitle,
          icon: p.icon,
          color: p.color,
          action: () => { onNavigate(p.id); onClose(); },
        }));
    }

    const q = query.toLowerCase();
    const items: SearchResult[] = [];

    // Pages
    PAGES
      .filter(p => isAdmin || !p.adminOnly)
      .filter(p => p.label.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q))
      .forEach(p => items.push({
        id: `page_${p.id}`,
        type: 'page',
        title: p.label,
        subtitle: p.subtitle,
        icon: p.icon,
        color: p.color,
        action: () => { onNavigate(p.id); onClose(); },
      }));

    // Clients
    clients
      .filter(c => c.name.toLowerCase().includes(q) || (c.pan || "").toLowerCase().includes(q))
      .slice(0, 5)
      .forEach(c => items.push({
        id: `client_${c.id}`,
        type: 'client',
        title: c.name,
        subtitle: `PAN: ${c.pan} · ${c.folios.length} folio(s)`,
        icon: Users,
        color: 'text-emerald-600',
        action: () => { onNavigate('clients'); onClose(); },
      }));

    // Team members
    team
      .filter(t => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q))
      .slice(0, 3)
      .forEach(t => items.push({
        id: `team_${t.id}`,
        type: 'team',
        title: t.name,
        subtitle: `${t.role} · ${t.code}`,
        icon: User,
        color: 'text-indigo-600',
        action: () => { onNavigate('settings'); onClose(); },
      }));

    // Transactions (search by investor name or AMC)
    if (isAdmin) {
      transactions
        .filter(tx => tx.investorName.toLowerCase().includes(q) || tx.amcName.toLowerCase().includes(q) || (tx.pan || "").toLowerCase().includes(q))
        .slice(0, 3)
        .forEach(tx => items.push({
          id: `tx_${tx.id}`,
          type: 'transaction',
          title: tx.investorName,
          subtitle: `${tx.amcName} · ₹${tx.grossAmount.toLocaleString()}`,
          icon: PieChart,
          color: 'text-amber-600',
          action: () => { onNavigate('reports'); onClose(); },
        }));
    }

    return items;
  }, [query, clients, team, transactions, isAdmin, onNavigate, onClose]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[selectedIndex]?.action();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen) return null;

  const typeLabels: Record<string, string> = {
    page: 'Navigation',
    client: 'Client',
    team: 'Team Member',
    transaction: 'Transaction',
  };

  const typeBadgeColors: Record<string, string> = {
    page: 'bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300',
    client: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300',
    team: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300',
    transaction: 'bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300',
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-20 px-4" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-100 dark:border-slate-700">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages, clients, team members..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 text-sm bg-transparent outline-none text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center px-2 py-1 rounded border border-slate-200 dark:border-slate-600 text-[10px] font-bold text-slate-400 dark:text-slate-500">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Search className="w-8 h-8 text-slate-200 dark:text-slate-600 mb-2" />
              <p className="text-sm font-bold text-slate-500 dark:text-slate-400">No results found</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Try searching for pages, clients, or team members</p>
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                onClick={result.action}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition ${
                  index === selectedIndex
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`}
              >
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  index === selectedIndex ? 'bg-blue-100 dark:bg-blue-800' : 'bg-slate-100 dark:bg-slate-700'
                }`}>
                  <result.icon className={`w-4 h-4 ${result.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{result.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{result.subtitle}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${typeBadgeColors[result.type]}`}>
                    {typeLabels[result.type]}
                  </span>
                  {index === selectedIndex && <ArrowRight className="w-3.5 h-3.5 text-blue-500" />}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600">↑↓</kbd> Navigate</span>
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600">↵</kbd> Select</span>
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600">ESC</kbd> Close</span>
          </div>
          <span className="text-[10px] font-bold text-slate-400">{results.length} result{results.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Backdrop blur */}
      <div className="fixed inset-0 -z-10 bg-slate-900/40 backdrop-blur-sm" />
    </div>
  );
};
