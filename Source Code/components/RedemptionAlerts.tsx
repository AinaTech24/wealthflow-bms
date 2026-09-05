import React, { useMemo } from 'react';
import { TrendingDown, ArrowDownRight } from 'lucide-react';
import { TeamMember } from '../types';
import { useData } from '../contexts/DataContext';
import { formatCompactINR } from '../utils/formatINR';

interface RedemptionAlertsProps {
  currentUser: TeamMember;
  withinDays?: number;  // look-back window (default 60 days)
  limit?: number;
}

export const RedemptionAlerts: React.FC<RedemptionAlertsProps> = ({ currentUser, withinDays = 60, limit = 8 }) => {
  const { transactions, clients } = useData();
  const isAdmin = currentUser.role === 'ADMIN';

  const myClientIds = useMemo(() => {
    if (isAdmin) return null;
    return new Set(clients.filter(c => Object.values(c.hierarchy || {}).includes(currentUser.id)).map(c => c.id));
  }, [clients, currentUser, isAdmin]);

  const redemptions = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - withinDays);
    const out = transactions
      .filter(t => {
        if (t.transactionType !== 'REDEMPTION' && t.transactionType !== 'SWITCH_OUT' && t.transactionType !== 'SWP') return false;
        if (myClientIds && (!t.mappedClientId || !myClientIds.has(t.mappedClientId))) return false;
        const d = new Date(t.transactionDate);
        return !isNaN(d.getTime()) && d >= cutoff;
      })
      .sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime());
    return out.slice(0, limit);
  }, [transactions, myClientIds, withinDays, limit]);

  if (redemptions.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-red-500" />
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Recent Redemptions</h3>
        </div>
        <span className="text-[10px] font-black uppercase tracking-widest bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full">
          Last {withinDays}d · {redemptions.length}
        </span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {redemptions.map(t => (
          <li key={t.id} className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-900/30 flex items-center justify-center shrink-0">
                <ArrowDownRight className="w-4 h-4 text-red-600 dark:text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{t.investorName}</p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate">{t.schemeName}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-black text-red-600 dark:text-red-400">{formatCompactINR(t.currentValue ?? t.grossAmount)}</p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase">{new Date(t.transactionDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · {t.transactionType}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 py-2 text-[10px] text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-700">
        Tip: reach out proactively to retain AUM.
      </div>
    </div>
  );
};
