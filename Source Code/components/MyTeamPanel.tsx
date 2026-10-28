import React, { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { authFetch, useData } from '../contexts/DataContext';
import { TeamMember } from '../types';

/**
 * "My team": the RMs and BMs under a BM-level login (L4 and above), as the server reads them: people who report to them on the team
 * tree plus the ones placed beneath them on their clients. It is the same list the Team Payouts tab in Reports is built from, so the
 * two screens agree. When nobody is placed under the user it says so, instead of showing nothing at all.
 */
export const MyTeamPanel: React.FC<{ currentUser: TeamMember; onOpenTeamPayouts?: () => void }> = ({ currentUser, onOpenTeamPayouts }) => {
  const { team, globalConfig } = useData();
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/data?action=my_team')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!cancelled) setIds(j && Array.isArray(j.ids) ? j.ids : []); })
      .catch(() => { if (!cancelled) setIds([]); });
    return () => { cancelled = true; };
  }, [currentUser.id]);

  const members = useMemo(() => {
    const set = new Set(ids || []);
    return team.filter(t => set.has(t.id) && t.role !== 'ADMIN' && t.role !== 'FINANCE')
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  }, [ids, team]);

  if (ids === null) return null;
  const levelName = (l: number) => (globalConfig.levelNames as any)?.[l] || `Level ${l}`;
  const bms = members.filter(m => m.level >= 4).length;
  const rms = members.length - bms;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-blue-600" />
          <h3 className="font-bold text-slate-900 dark:text-slate-100">My team</h3>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{rms} RM{rms !== 1 ? 's' : ''}{bms ? ` · ${bms} BM${bms !== 1 ? 's' : ''}` : ''}</span>
        </div>
        {onOpenTeamPayouts && members.length > 0 && (
          <button onClick={onOpenTeamPayouts} className="text-[10px] font-black uppercase tracking-widest text-blue-600 hover:underline">See their payouts month by month</button>
        )}
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">No RM or BM is placed under you yet. When one is, they show up here and in Reports &amp; Payouts → Team Payouts.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {members.slice(0, 18).map(m => (
            <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 dark:border-slate-700 px-3 py-2">
              <span className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{m.name}</span>
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">{levelName(m.level)} · L{m.level}</span>
            </li>
          ))}
          {members.length > 18 && <li className="text-xs text-slate-400 px-3 py-2">+ {members.length - 18} more</li>}
        </ul>
      )}
    </div>
  );
};
