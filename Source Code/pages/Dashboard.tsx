
import React, { useMemo, useState, Suspense, lazy } from 'react';
// Recharts is ~104 KB gzipped — lazy so the dashboard above-the-fold KPI cards
// paint before the chart library downloads.
const RevenueAreaChart = lazy(() => import('../components/DashboardCharts').then(m => ({ default: m.RevenueAreaChart })));
const CategoryPieChart = lazy(() => import('../components/DashboardCharts').then(m => ({ default: m.CategoryPieChart })));
import { Users, TrendingUp, Landmark, Briefcase, Calendar, BarChart3, FilterX, Trophy, Award } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { useData } from '../contexts/DataContext';
import { calculateUserShare } from '../services/calculationService';
import { ComplianceAlerts } from '../components/ComplianceAlerts';
import { TopClientsWidget } from '../components/TopClientsWidget';
import { EarningsByMonth } from '../components/EarningsByMonth';
import { MotilalSummary } from '../components/MotilalSummary';
import { RedemptionAlerts } from '../components/RedemptionAlerts';
import { formatCurrencyINR, formatCompactINR, formatINR } from '../utils/formatINR';

interface DashboardProps {
  currentUser: TeamMember;
}

interface StatCardProps {
  title: string;
  value: string | number;
  sub: string;
  icon: React.ElementType;
  color: string;
}

const StatCard = ({ title, value, sub, icon: Icon, color }: StatCardProps) => (
  <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md transition-shadow">
    <div className="flex items-center justify-between mb-4">
      <div className={`p-2 rounded-lg ${color}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded-full uppercase tracking-widest">Live Sync</span>
    </div>
    <h3 className="text-slate-500 dark:text-slate-400 text-sm font-medium">{title}</h3>
    <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">{value}</p>
    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 font-medium">{sub}</p>
  </div>
);

const EmptyStateSvg = () => (
  <svg viewBox="0 0 200 160" className="w-40 h-32 mx-auto mb-4 opacity-60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="30" y="120" width="140" height="6" rx="3" fill="#e2e8f0" />
    <rect x="50" y="60" width="20" height="60" rx="4" fill="#cbd5e1" />
    <rect x="80" y="40" width="20" height="80" rx="4" fill="#94a3b8" />
    <rect x="110" y="70" width="20" height="50" rx="4" fill="#cbd5e1" />
    <rect x="140" y="50" width="20" height="70" rx="4" fill="#94a3b8" />
    <circle cx="100" cy="30" r="14" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="2" />
    <path d="M95 30L99 34L106 26" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CATEGORY_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

export const Dashboard: React.FC<DashboardProps> = ({ currentUser }) => {
  const { transactions, clients, globalConfig, team, serverSummary } = useData();

  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;
  const isSuperUser = isAdmin;
  const txLoaded = transactions.length > 0;

  // --- Date Filter State ---
  const now = new Date();
  const [filterMode, setFilterMode] = useState<'all' | 'month' | 'quarter' | 'year'>('all');
  const [filterMonth, setFilterMonth] = useState(now.getMonth()); // 0-indexed
  const [filterYear, setFilterYear] = useState(now.getFullYear());
  const [drillDown, setDrillDown] = useState<{ label: string; transactions: typeof transactions } | null>(null);

  // Open the filters on the newest month that has data. Defaulting to today showed
  // an empty screen whenever the latest statement had not been imported yet.
  const latestPeriod = useMemo(() => {
    let best = '';
    for (const tx of transactions) { const p = tx.brokeragePeriod; if (p && p > best) best = p; }
    return best;
  }, [transactions]);
  const filterTouched = React.useRef(false);
  React.useEffect(() => {
    if (filterTouched.current || !latestPeriod) return;
    const [y, m] = latestPeriod.split('-').map(Number);
    if (y && m) { setFilterYear(y); setFilterMonth(m - 1); }
  }, [latestPeriod]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrillDown(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Generate available years from transactions
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    transactions.forEach(tx => {
      const y = parseInt(tx.transactionDate?.substring(0, 4));
      if (!isNaN(y)) years.add(y);
    });
    if (years.size === 0) years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [transactions]);

  // Filter transactions by date
  const filteredTransactions = useMemo(() => {
    if (filterMode === 'all') return transactions;
    return transactions.filter(tx => {
      const dateStr = tx.brokeragePeriod || tx.transactionDate;
      if (!dateStr) return false;
      const [y, m] = dateStr.split('-').map(Number);
      if (filterMode === 'month') return y === filterYear && m === filterMonth + 1;
      if (filterMode === 'quarter') {
        const qStart = Math.floor(filterMonth / 3) * 3;
        return y === filterYear && m >= qStart + 1 && m <= qStart + 3;
      }
      if (filterMode === 'year') return y === filterYear;
      return true;
    });
  }, [transactions, filterMode, filterMonth, filterYear]);

  const visibleTransactions = useMemo(() => {
    const myClientIds = clients.filter(c => {
      if (isSuperUser) return true;
      const userLevelKey = `level${currentUser.level}Id` as keyof typeof c.hierarchy;
      return c.hierarchy[userLevelKey] === currentUser.id;
    }).map(c => c.id);
    return filteredTransactions.filter(tx => {
      if (isSuperUser) return true;
      return tx.mappedClientId && myClientIds.includes(tx.mappedClientId);
    });
  }, [filteredTransactions, clients, isSuperUser, currentUser]);

  const stats = useMemo(() => {
    const myClientIds = clients.filter(c => {
      if (isSuperUser) return true;
      const userLevelKey = `level${currentUser.level}Id` as keyof typeof c.hierarchy;
      return c.hierarchy[userLevelKey] === currentUser.id;
    }).map(c => c.id);

    const visibleTransactions = filteredTransactions.filter(tx => {
      if (isSuperUser) return true;
      return tx.mappedClientId && myClientIds.includes(tx.mappedClientId);
    });

    let totalMyNet = 0;
    let totalGrossVolume = 0;
    const monthlyAgg: Record<string, { name: string, myNet: number }> = {};
    const amcAgg: Record<string, number> = {};
    const clientAgg: Record<string, number> = {};
    const schemeAgg: Record<string, number> = {};
    const categoryAgg: Record<string, number> = {};

    visibleTransactions.forEach(tx => {
      const myShare = calculateUserShare(tx, currentUser, globalConfig);
      totalMyNet += myShare;
      totalGrossVolume += tx.grossAmount;

      const amc = tx.amcName || 'Unknown';
      amcAgg[amc] = (amcAgg[amc] || 0) + myShare;

      const clientName = tx.investorName || 'Unknown';
      clientAgg[clientName] = (clientAgg[clientName] || 0) + myShare;

      const scheme = tx.schemeName || 'Unknown';
      schemeAgg[scheme] = (schemeAgg[scheme] || 0) + myShare;

      const cat = tx.category || 'Other';
      categoryAgg[cat] = (categoryAgg[cat] || 0) + tx.grossAmount;

      const monthKey = tx.brokeragePeriod || tx.transactionDate.substring(0, 7);
      if (!monthlyAgg[monthKey]) {
        const [y, m] = monthKey.split('-');
        const date = new Date(parseInt(y), parseInt(m) - 1);
        const label = date.toLocaleString('default', { month: 'short', year: '2-digit' });
        monthlyAgg[monthKey] = { name: label, myNet: 0 };
      }
      monthlyAgg[monthKey].myNet += myShare;
    });

    const chartData = Object.entries(monthlyAgg)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, data]) => ({ ...data, key }));

    const categoryData = Object.entries(categoryAgg)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));

    const getTop = (agg: Record<string, number>) => {
      const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
      return sorted[0] ? { name: sorted[0][0], val: sorted[0][1] } : { name: 'None', val: 0 };
    };

    const topByValue = (agg: Record<string, number>, limit = 5) =>
      Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, val]) => ({ name, val }));

    return {
      totalTx: visibleTransactions.length,
      totalMyNet,
      totalGrossVolume,
      myClientsCount: myClientIds.length,
      monthlyData: chartData,
      topAmc: getTop(amcAgg),
      topClient: getTop(clientAgg),
      topScheme: getTop(schemeAgg),
      categoryData,
      topAmcList: topByValue(amcAgg, 5),
      topClientList: topByValue(clientAgg, 5),
    };
  }, [currentUser, filteredTransactions, clients, globalConfig, isSuperUser]);

  // Leaderboard: top team members by their share in current filtered period
  const leaderboard = useMemo(() => {
    if (!isAdmin) return [];
    const rmMap: Record<string, { name: string; total: number; txCount: number }> = {};

    const clientMap = new Map(clients.map(c => [c.id, c]));
    const teamMap = new Map(team.map(t => [t.id, t]));

    filteredTransactions.forEach(tx => {
      if (!tx.mappedClientId) return;
      const client = clientMap.get(tx.mappedClientId);
      if (!client) return;

      // Find the RM at level closest to bottom
      for (let lvl = 6; lvl >= 0; lvl--) {
        const memberId = client.hierarchy[`level${lvl}Id` as keyof typeof client.hierarchy];
        if (memberId) {
          const member = teamMap.get(memberId);
          if (member && member.role !== Role.ADMIN) {
            const share = calculateUserShare(tx, member, globalConfig);
            if (!rmMap[member.id]) rmMap[member.id] = { name: member.name, total: 0, txCount: 0 };
            rmMap[member.id].total += share;
            rmMap[member.id].txCount += 1;
          }
          break;
        }
      }
    });

    return Object.entries(rmMap)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([id, data], index) => ({ id, ...data, rank: index + 1 }));
  }, [filteredTransactions, clients, team, globalConfig, isAdmin]);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const quarterLabel = `Q${Math.floor(filterMonth / 3) + 1}`;

  const filterLabel = filterMode === 'all' ? 'All Time'
    : filterMode === 'month' ? `${monthNames[filterMonth]} ${filterYear}`
      : filterMode === 'quarter' ? `${quarterLabel} ${filterYear}`
        : `FY ${filterYear}`;

  const rankMedal = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  // For the unfiltered ("All time") view, trust the server-side summary: it is
  // computed over the FULL dataset and escapes the 200k client-side row cap, so
  // the headline gross / transaction totals never silently under-report. Only a
  // period-filtered view falls back to the (capped) client-side aggregation.
  const isAllTime = filterMode === 'all';
  const useServerTotals = isAllTime && !!serverSummary;
  // Only a LOADED-but-capped set is truncated. Without the txLoaded guard this fired
  // while the fetch was still in flight and announced "the most recent 0 of 562,417
  // transactions" — on a page that was, at that moment, showing server-authoritative
  // totals and nothing subset-based at all.
  const txTruncated = txLoaded && !!serverSummary && serverSummary.totalTx > transactions.length;

  const displayGross = useServerTotals ? serverSummary!.totalGross : (txLoaded ? stats.totalGrossVolume : (serverSummary?.totalGross ?? 0));
  const displayMyNet = txLoaded ? stats.totalMyNet : (serverSummary?.myTotal ?? 0);
  const displayTx = useServerTotals ? serverSummary!.totalTx : (txLoaded ? stats.totalTx : (serverSummary?.totalTx ?? 0));
  const displayClients = txLoaded ? stats.myClientsCount : (serverSummary?.clientCount ?? clients.length);
  const summaryMonthlyData = serverSummary?.monthly.map(r => {
    const [y, mo] = r.month.split('-').map(Number);
    const date = new Date(y, mo - 1);
    return { name: date.toLocaleString('default', { month: 'short', year: '2-digit' }), myNet: r.gross, key: r.month };
  }) ?? [];
  const displayMonthlyData = txLoaded ? stats.monthlyData : summaryMonthlyData;
  const isLiveData = txLoaded; // true = computed from full tx data, false = from server summary

  // Finance is an accounts desk: it owns no clients, so "my net receivable" and
  // "portfolio count" were always zero. It sees the team's payout figures instead,
  // straight from the server, by product and by month.
  if (isFinance) {
    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Payout Summary</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 font-medium">What the team earned, what has been paid and what is still owed.</p>
        </div>
        <MotilalSummary firmWide />
        <EarningsByMonth firmWide />
        <ComplianceAlerts currentUser={currentUser} />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <MotilalSummary firmWide={isAdmin} />
      {!isAdmin && <EarningsByMonth firmWide={false} />}
      {txTruncated && !useServerTotals && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2.5 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
          Showing the most recent {transactions.length.toLocaleString()} of {serverSummary!.totalTx.toLocaleString()} transactions. Figures for this filtered view are based on that subset — switch to “All time” for server-authoritative totals, or use Reports → Team Payouts.
        </div>
      )}
      {/* Header + Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">System Performance</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 font-medium">
            {isAdmin ? 'Real-time analytics across all hierarchies.' : `Earnings dashboard for ${currentUser.name}.`}
          </p>
        </div>

        {/* Date Filter Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm">
            {(['all', 'month', 'quarter', 'year'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => { filterTouched.current = true; setFilterMode(mode); }}
                className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${filterMode === mode
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
                  }`}
              >
                {mode === 'all' ? 'All' : mode === 'month' ? 'Month' : mode === 'quarter' ? 'Quarter' : 'Year'}
              </button>
            ))}
          </div>

          {filterMode !== 'all' && (
            <div className="flex items-center gap-1.5">
              {filterMode === 'month' && (
                <select
                  value={filterMonth}
                  onChange={e => setFilterMonth(Number(e.target.value))}
                  className="text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {monthNames.map((m, i) => <option key={i} value={i}>{m}</option>)}
                </select>
              )}
              {filterMode === 'quarter' && (
                <select
                  value={Math.floor(filterMonth / 3)}
                  onChange={e => setFilterMonth(Number(e.target.value) * 3)}
                  className="text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {[0, 1, 2, 3].map(q => <option key={q} value={q}>Q{q + 1}</option>)}
                </select>
              )}
              <select
                value={filterYear}
                onChange={e => setFilterYear(Number(e.target.value))}
                className="text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <button onClick={() => setFilterMode('all')} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition" title="Clear filter">
                <FilterX className="w-4 h-4" />
              </button>
            </div>
          )}

          {filterMode !== 'all' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-full text-[10px] font-black uppercase tracking-widest border border-blue-100 dark:border-blue-800">
              <Calendar className="w-3 h-3" />
              {filterLabel}
            </span>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isAdmin && (
          <StatCard title="Enterprise Gross Volume" value={formatCompactINR(displayGross)} sub={isLiveData ? 'Aggregated Brokerage' : 'Aggregated Brokerage (Summary)'} icon={TrendingUp} color="bg-blue-600" />
        )}
        <StatCard title={isAdmin ? 'Total Payout Pool' : 'My Net Receivable'} value={formatCurrencyINR(displayMyNet, 2)} sub={isLiveData ? 'Realized Earnings' : 'Realized Earnings (Summary)'} icon={Landmark} color="bg-emerald-600" />
        <StatCard title="Portfolio Count" value={displayClients} sub={`${formatINR(displayTx)} Active Transactions`} icon={Users} color="bg-indigo-600" />
      </div>

      {/* Compliance alerts (ARN/EUIN expiry) */}
      <ComplianceAlerts currentUser={currentUser} />

      {/* Client intelligence row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopClientsWidget currentUser={currentUser} />
        <RedemptionAlerts currentUser={currentUser} />
      </div>


      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Revenue Growth Chart */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Revenue Growth</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Net Monthly Share Trends (INR)</p>
            </div>
          </div>
          <div className="h-72">
            {displayMonthlyData.length > 0 ? (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">Loading chart…</div>}>
                <RevenueAreaChart
                  data={displayMonthlyData}
                  onPointClick={(key, name) => {
                    const monthTxs = visibleTransactions.filter(tx =>
                      (tx.brokeragePeriod || tx.transactionDate?.substring(0, 7)) === key
                    );
                    setDrillDown({ label: name, transactions: monthTxs });
                  }}
                />
              </Suspense>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <EmptyStateSvg />
                <h4 className="text-slate-700 dark:text-slate-300 font-bold text-sm">No Revenue Data</h4>
                <p className="text-slate-400 dark:text-slate-500 text-xs mt-1 max-w-[220px]">
                  {filterMode !== 'all' ? `No transactions found for ${filterLabel}.` : 'Import transactions to start tracking revenue.'}
                </p>
                {filterMode !== 'all' && (
                  <button onClick={() => setFilterMode('all')} className="mt-3 text-xs font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 flex items-center gap-1">
                    <FilterX className="w-3 h-3" /> Show All Data
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Top Producers */}
        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-1">Top Producers</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mb-6">Real-time Performance</p>

          {stats.totalTx > 0 ? (
            <div className="flex-1 space-y-4">
              {[
                { label: 'Asset Management', data: stats.topAmc, icon: Landmark, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                { label: 'Key Investor', data: stats.topClient, icon: Users, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
                { label: 'Prime Scheme', data: stats.topScheme, icon: Briefcase, color: 'text-indigo-600', bg: 'bg-indigo-50 dark:bg-indigo-900/20' }
              ].map((item, idx) => (
                <div key={idx} className={`${item.bg} p-4 rounded-xl border border-slate-100 dark:border-slate-700 flex flex-col`}>
                  <div className="flex items-center space-x-2 mb-2">
                    <item.icon className={`w-4 h-4 ${item.color}`} />
                    <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">{item.label}</span>
                  </div>
                  <div className="flex justify-between items-end">
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300 truncate max-w-[140px]">{item.data.name}</span>
                    <span className={`text-base font-black ${item.color}`}>₹{item.data.val.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
              <BarChart3 className="w-10 h-10 text-slate-200 dark:text-slate-600 mb-3" />
              <h4 className="text-slate-600 dark:text-slate-400 font-bold text-sm">No Producers Yet</h4>
              <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Performance data will appear after transactions are imported.</p>
            </div>
          )}
        </div>
      </div>

      {/* Charts Row 2: Fund Category Breakdown + RM Leaderboard */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Fund Category Breakdown */}
        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
          <div className="mb-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Fund Category Breakdown</h3>
            <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Gross Brokerage by Category</p>
          </div>
          {stats.categoryData.length > 0 ? (
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="w-full sm:w-48 h-48 shrink-0">
                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">…</div>}>
                  <CategoryPieChart data={stats.categoryData} colors={CATEGORY_COLORS} />
                </Suspense>
              </div>
              <div className="flex-1 space-y-2 w-full">
                {stats.categoryData.map((cat, idx) => {
                  const total = stats.categoryData.reduce((s, c) => s + c.value, 0);
                  const pct = total > 0 ? ((cat.value / total) * 100).toFixed(1) : '0';
                  return (
                    <div key={cat.name} className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[idx % CATEGORY_COLORS.length] }} />
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex-1 truncate">{cat.name}</span>
                      <span className="text-xs font-bold text-slate-500 dark:text-slate-400">{pct}%</span>
                      <span className="text-xs font-black text-slate-900 dark:text-slate-100">₹{(cat.value / 1000).toFixed(1)}k</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-center">
              <BarChart3 className="w-10 h-10 text-slate-200 dark:text-slate-600 mb-3" />
              <p className="text-slate-500 dark:text-slate-400 font-bold text-sm">No category data yet</p>
              <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Import transactions to see category breakdown</p>
            </div>
          )}
        </div>

        {/* RM Leaderboard (admin only) / Top Clients (non-admin) */}
        {isAdmin ? (
          <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Trophy className="w-5 h-5 text-amber-500" />
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">RM Leaderboard</h3>
                <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Top Performers by Earnings</p>
              </div>
            </div>
            {leaderboard.length > 0 ? (
              <div className="space-y-3">
                {leaderboard.map((rm, idx) => (
                  <div key={rm.id} className={`flex items-center gap-3 p-3 rounded-xl transition ${idx === 0 ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                    <div className={`text-lg font-black w-8 text-center shrink-0 ${idx === 0 ? 'text-amber-500' : idx === 1 ? 'text-slate-400' : idx === 2 ? 'text-amber-700' : 'text-slate-300 dark:text-slate-600 text-sm'}`}>
                      {rankMedal(rm.rank)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{rm.name}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{rm.txCount} transaction{rm.txCount !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">₹{rm.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-40 text-center">
                <Award className="w-10 h-10 text-slate-200 dark:text-slate-600 mb-3" />
                <p className="text-slate-500 dark:text-slate-400 font-bold text-sm">No leaderboard data</p>
                <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Import transactions to see RM rankings</p>
              </div>
            )}
          </div>
        ) : (
          /* Non-admin: show top clients */
          <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
            <div className="mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Top Clients</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">By Net Earnings</p>
            </div>
            {stats.topClientList.length > 0 ? (
              <div className="space-y-3">
                {stats.topClientList.map((c, idx) => (
                  <div key={idx} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                    <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-xs font-black shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{c.name}</p>
                    </div>
                    <p className="text-sm font-black text-emerald-600 dark:text-emerald-400 shrink-0">₹{c.val.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-40 text-center">
                <Users className="w-10 h-10 text-slate-200 dark:text-slate-600 mb-3" />
                <p className="text-slate-500 dark:text-slate-400 font-bold text-sm">No client data yet</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Drill-down slide-over */}
      {drillDown && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={() => setDrillDown(null)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-white dark:bg-slate-800 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-slate-100">Transactions — {drillDown.label}</h3>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{drillDown.transactions.length} transactions</p>
              </div>
              <button onClick={() => setDrillDown(null)} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition">
                <span className="text-lg font-bold leading-none">×</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700">
              {drillDown.transactions.map(tx => {
                const myShare = calculateUserShare(tx, currentUser, globalConfig);
                return (
                  <div key={tx.id} className="px-6 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0 pr-4">
                        <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{tx.investorName || 'Unknown'}</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 truncate mt-0.5">{tx.schemeName || tx.amcName || '—'}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">₹{myShare.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">{tx.transactionDate}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
              <div className="flex justify-between items-center">
                <span className="text-xs font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest">Total</span>
                <span className="text-base font-black text-emerald-600 dark:text-emerald-400">
                  ₹{drillDown.transactions.reduce((s, tx) => s + calculateUserShare(tx, currentUser, globalConfig), 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
