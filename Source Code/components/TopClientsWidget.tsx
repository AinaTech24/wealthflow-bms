import React, { useMemo, useState } from 'react';
import { Trophy, TrendingUp, Briefcase } from 'lucide-react';
import { TeamMember } from '../types';
import { useData } from '../contexts/DataContext';
import { formatCompactINR } from '../utils/formatINR';

interface TopClientsWidgetProps {
  currentUser: TeamMember;
  limit?: number;
}

type Metric = 'AUM' | 'BROKERAGE';

export const TopClientsWidget: React.FC<TopClientsWidgetProps> = ({ currentUser, limit = 10 }) => {
  const { transactions, clients } = useData();
  const [metric, setMetric] = useState<Metric>('AUM');

  // For non-admins, restrict to clients they own.
  const isAdmin = currentUser.role === 'ADMIN';
  const myClientIds = useMemo(() => {
    if (isAdmin) return null;
    return new Set(clients.filter(c => Object.values(c.hierarchy || {}).includes(currentUser.id)).map(c => c.id));
  }, [clients, currentUser, isAdmin]);

  const ranked = useMemo(() => {
    // Aggregate brokerage per client from transactions. AUM is read from the
    // client record (populated by WBR9 master imports or estimated from
    // brokerage avg_assets) for a true cross-folio snapshot.
    const agg = new Map<string, { id: string; name: string; pan?: string; brokerage: number; aum: number; aumIsSnapshot: boolean; txCount: number }>();
    const clientById = new Map(clients.map(c => [c.id, c]));

    for (const t of transactions) {
      if (myClientIds && (!t.mappedClientId || !myClientIds.has(t.mappedClientId))) continue;

      const key = t.mappedClientId || `unmapped:${t.pan || t.folio}`;
      const client = t.mappedClientId ? clientById.get(t.mappedClientId) : undefined;
      const existing = agg.get(key);
      const name = client?.name || t.investorName || 'Unknown';
      const clientAum = client?.totalAum || 0;
      const aumIsSnapshot = client?.aumSource === 'WBR9';

      if (existing) {
        existing.brokerage += t.grossAmount || 0;
        // Prefer client-level AUM if present; fall back to max(currentValue) for unmapped folios
        if (clientAum > 0) {
          existing.aum = clientAum;
          existing.aumIsSnapshot = aumIsSnapshot;
        } else {
          existing.aum = Math.max(existing.aum, t.currentValue || 0);
        }
        existing.txCount++;
      } else {
        agg.set(key, {
          id: key,
          name,
          pan: client?.pan || t.pan,
          brokerage: t.grossAmount || 0,
          aum: clientAum > 0 ? clientAum : (t.currentValue || 0),
          aumIsSnapshot,
          txCount: 1,
        });
      }
    }

    const arr = Array.from(agg.values());
    arr.sort((a, b) => metric === 'AUM' ? b.aum - a.aum : b.brokerage - a.brokerage);
    return arr.slice(0, limit);
  }, [transactions, clients, myClientIds, metric, limit]);

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
                    {metric === 'AUM' && c.aum > 0 && (
                      <span className={`text-[8px] font-black uppercase tracking-widest px-1 py-0.5 rounded ${c.aumIsSnapshot
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'}`}>
                        {c.aumIsSnapshot ? 'Snap' : 'Est'}
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
