import React, { useMemo, useState } from 'react';
import { Trophy, TrendingUp, Briefcase } from 'lucide-react';
import { TeamMember } from '../types';
import { useData } from '../contexts/DataContext';
import { formatCompactINR } from '../utils/formatINR';
import { useClientAum } from '../utils/clientAum';

interface TopClientsWidgetProps {
  currentUser: TeamMember;
  limit?: number;
}

type Metric = 'AUM' | 'BROKERAGE';

export const TopClientsWidget: React.FC<TopClientsWidgetProps> = ({ currentUser, limit = 10 }) => {
  const { transactions, clients } = useData();
  const [metric, setMetric] = useState<Metric>('AUM');
  // The same AUM the clients page shows. This widget used to work it out itself and
  // landed somewhere else entirely for the same RM: Shakeel Khan Mansuri read ₹5,244
  // here against ₹15,517 under My Clients (it took the largest of his three folios
  // instead of adding them up), Sajid Khan ₹4,720 against ₹4,016 (a February value,
  // because the max ran across every month), and Hiba Mansuri ₹1,000 against ₹10,245
  // (the stale WBR9 snapshot from 2026-05-29).
  const { aum: liveAum } = useClientAum(transactions);

  // For non-admins, restrict to clients they own.
  const isAdmin = currentUser.role === 'ADMIN';
  const myClientIds = useMemo(() => {
    if (isAdmin) return null;
    return new Set(clients.filter(c => Object.values(c.hierarchy || {}).includes(currentUser.id)).map(c => c.id));
  }, [clients, currentUser, isAdmin]);

  const ranked = useMemo(() => {
    // Brokerage is aggregated from the transactions; AUM is NOT worked out here.
    // It comes from the one shared rule, so this widget, the clients page and the
    // Reports client-summary tab cannot report different money for one investor.
    const agg = new Map<string, { id: string; name: string; pan?: string; brokerage: number; aum: number; aumIsSnapshot: boolean; txCount: number }>();
    const clientById = new Map(clients.map(c => [c.id, c]));

    for (const t of transactions) {
      if (myClientIds && (!t.mappedClientId || !myClientIds.has(t.mappedClientId))) continue;

      const key = t.mappedClientId || `unmapped:${t.pan || t.folio}`;
      const client = t.mappedClientId ? clientById.get(t.mappedClientId) : undefined;
      const existing = agg.get(key);

      if (existing) {
        existing.brokerage += t.grossAmount || 0;
        existing.txCount++;
        continue;
      }

      const live = t.mappedClientId ? liveAum.get(t.mappedClientId) : undefined;
      // The stored folio-master figure is the fallback, and only then is it a
      // snapshot — it is months old whenever a brokerage import is more recent.
      const stored = Number(client?.totalAum) || 0;
      agg.set(key, {
        id: key,
        name: client?.name || t.investorName || 'Unknown',
        pan: client?.pan || t.pan,
        brokerage: t.grossAmount || 0,
        aum: live ? live.total : stored,
        aumIsSnapshot: !live && stored > 0,
        txCount: 1,
      });
    }

    const arr = Array.from(agg.values());
    arr.sort((a, b) => metric === 'AUM' ? b.aum - a.aum : b.brokerage - a.brokerage);
    return arr.slice(0, limit);
  }, [transactions, clients, myClientIds, metric, limit, liveAum]);

  if (ranked.length === 0) {
    return null; // Don't render until there's data.
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            {isAdmin ? 'Top Clients' : 'My Top Clients'}
          </h3>
        </div>
        <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-0.5">
          <button
            onClick={() => setMetric('AUM')}
            className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-md transition flex items-center gap-1 ${metric === 'AUM' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
          >
            <Briefcase className="w-3 h-3" /> AUM
          </button>
          <button
            onClick={() => setMetric('BROKERAGE')}
            className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-md transition flex items-center gap-1 ${metric === 'BROKERAGE' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
          >
            <TrendingUp className="w-3 h-3" /> Brokerage
          </button>
        </div>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {ranked.map((c, i) => {
          const primary = metric === 'AUM' ? c.aum : c.brokerage;
          const secondary = metric === 'AUM' ? c.brokerage : c.aum;
          const secondaryLabel = metric === 'AUM' ? 'brokerage' : 'AUM';
          return (
            <li key={c.id} className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-black flex-shrink-0 ${
                  i === 0 ? 'bg-amber-100 text-amber-700' :
                  i === 1 ? 'bg-slate-200 text-slate-700' :
                  i === 2 ? 'bg-orange-100 text-orange-700' :
                  'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
                }`}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{c.name}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono uppercase">{c.pan || c.id.replace('unmapped:', '')} · {c.txCount} txn{c.txCount !== 1 ? 's' : ''}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center justify-end gap-1.5">
                    <p className="text-sm font-black text-slate-900 dark:text-slate-100">{formatCompactINR(primary)}</p>
                    {/* The badge had these the wrong way round: a figure taken from
                        the live brokerage imports was labelled "Est" in amber, while
                        the months-old WBR9 snapshot got the reassuring green "Snap".
                        Live is the current figure; the stored one is the doubtful one. */}
                    {metric === 'AUM' && c.aum > 0 && (
                      <span className={`text-[8px] font-black uppercase tracking-widest px-1 py-0.5 rounded ${c.aumIsSnapshot
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'}`}>
                        {c.aumIsSnapshot ? 'Snap' : 'Latest'}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase">{formatCompactINR(secondary)} {secondaryLabel}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
