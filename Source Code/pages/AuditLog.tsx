import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Search, RefreshCcw, Calendar, Download, AlertTriangle, Loader2, Inbox } from 'lucide-react';
import { TeamMember } from '../types';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import { EmptyState } from '../components/EmptyState';

interface AuditLogProps {
  currentUser: TeamMember;
}

interface ActivityEntry {
  id: number;
  userId?: string;
  userName?: string;
  action?: string;
  description?: string;
  createdAt: string;
}

const PAGE_SIZE = 25;

const formatRelativeTime = (dateStr: string) => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const actionTone = (action: string = ''): string => {
  const a = action.toLowerCase();
  if (a.includes('delete') || a.includes('reset') || a.includes('remove')) return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800';
  if (a.includes('create') || a.includes('add') || a.includes('import')) return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800';
  if (a.includes('update') || a.includes('edit') || a.includes('modify')) return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800';
  if (a.includes('login') || a.includes('logout') || a.includes('auth')) return 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800';
  return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600';
};

export const AuditLog: React.FC<AuditLogProps> = () => {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(1);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('wf_token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/data?type=activity_log', { headers });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: ActivityEntry[] = await res.json();
      data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setEntries(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const { uniqueActions, uniqueUsers } = useMemo(() => {
    const a = new Set<string>();
    const u = new Set<string>();
    for (const e of entries) {
      if (e.action) a.add(e.action);
      if (e.userName) u.add(e.userName);
    }
    return {
      uniqueActions: Array.from(a).sort(),
      uniqueUsers: Array.from(u).sort(),
    };
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (search.trim()) {
        const q = search.toLowerCase();
        const hit =
          (e.userName || '').toLowerCase().includes(q) ||
          (e.action || '').toLowerCase().includes(q) ||
          (e.description || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      if (actionFilter && e.action !== actionFilter) return false;
      if (userFilter && e.userName !== userFilter) return false;
      if (fromDate && new Date(e.createdAt) < new Date(fromDate)) return false;
      if (toDate) {
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        if (new Date(e.createdAt) > t) return false;
      }
      return true;
    });
  }, [entries, search, actionFilter, userFilter, fromDate, toDate]);

  useEffect(() => { setPage(1); }, [search, actionFilter, userFilter, fromDate, toDate]);

  const pageItems = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  const exportCsv = () => {
    if (filtered.length === 0) {
      showToast('Nothing to export.', 'warning');
      return;
    }
    const header = ['Timestamp', 'User', 'Action', 'Description'];
    const rows = filtered.map(e => [
      new Date(e.createdAt).toISOString(),
      e.userName || '',
      e.action || '',
      (e.description || '').replace(/"/g, '""'),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} entries.`, 'success');
  };

  const clearFilters = () => {
    setSearch(''); setFromDate(''); setToDate(''); setActionFilter(''); setUserFilter('');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Audit Log</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Forensic trail of all user actions, logins, imports, and configuration changes.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchLog}
            disabled={loading}
            className="border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 px-3 py-2 rounded-lg text-xs font-bold transition inline-flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
            Refresh
          </button>
          <button
            onClick={exportCsv}
            className="bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-bold hover:bg-blue-700 transition inline-flex items-center gap-2"
          >
            <Download className="w-3 h-3" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search user, action, description…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 dark:border-slate-600 rounded-lg bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <select
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="text-sm border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">All actions</option>
            {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            className="text-sm border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">All users</option>
            {uniqueUsers.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="w-full pl-7 pr-2 py-2 text-xs border border-slate-200 dark:border-slate-600 rounded-lg bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div className="relative">
              <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="w-full pl-7 pr-2 py-2 text-xs border border-slate-200 dark:border-slate-600 rounded-lg bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        </div>
        {(search || fromDate || toDate || actionFilter || userFilter) && (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Showing <span className="font-bold">{filtered.length.toLocaleString()}</span> of {entries.length.toLocaleString()}
            </span>
            <button onClick={clearFilters} className="text-xs font-bold text-blue-600 hover:underline">Clear filters</button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        {error && (
          <div className="p-6 flex items-center gap-3 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[10px]">
            <tr>
              <th className="px-6 py-4">When</th>
              <th className="px-6 py-4">User</th>
              <th className="px-6 py-4">Action</th>
              <th className="px-6 py-4">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
            {loading && entries.length === 0 ? (
              <tr><td colSpan={4} className="py-20 text-center text-slate-400 dark:text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
              </td></tr>
            ) : pageItems.length === 0 ? (
              <tr><td colSpan={4}>
                <EmptyState
                  icon={entries.length === 0 ? ShieldCheck : Inbox}
                  title={entries.length === 0 ? 'No audit entries yet' : 'No matches'}
                  description={entries.length === 0
                    ? 'User actions, logins, imports, and config changes will appear here as they happen.'
                    : 'No audit entries match your current filters. Try clearing them.'
                  }
                  cta={entries.length > 0 ? { label: 'Clear filters', onClick: clearFilters } : undefined}
                />
              </td></tr>
            ) : pageItems.map(entry => (
              <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                <td className="px-6 py-4 align-top">
                  <div className="font-bold text-slate-900 dark:text-slate-100">{formatRelativeTime(entry.createdAt)}</div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
                    {new Date(entry.createdAt).toLocaleString('en-IN')}
                  </div>
                </td>
                <td className="px-6 py-4 align-top">
                  <div className="font-bold text-slate-900 dark:text-slate-100">{entry.userName || 'System'}</div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{entry.userId || '-'}</div>
                </td>
                <td className="px-6 py-4 align-top">
                  <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-black border uppercase tracking-widest ${actionTone(entry.action)}`}>
                    {entry.action || 'unknown'}
                  </span>
                </td>
                <td className="px-6 py-4 align-top text-slate-600 dark:text-slate-300 max-w-md break-words">
                  {entry.description || <span className="text-slate-400 italic">No details</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > PAGE_SIZE && (
          <Pagination
            currentPage={page}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
};
