import React, { useEffect, useState } from 'react';
import { TrendingUp, RefreshCw, Users, AlertTriangle } from 'lucide-react';
import { authFetch } from '../contexts/DataContext';

/**
 * Motilal Oswal (broking) at the top of the Dashboard.
 *
 *   firmWide = true   Admin and Finance: the whole book, and an RM / BM table.
 *   firmWide = false  an RM or BM: only their own clients and their own payout.
 *
 * Every number is the server's (action=partner_overview), computed from the same
 * per-level sharing percentages as the Partner Brokerage ledger, so the two screens
 * can never disagree. Active = a statement row in the month; inactive = on Motilal's
 * client sheet but nothing traded that month.
 */

interface Person { userId: string; name: string; level: number | null; activeClients: number; inactiveClients: number; brokerage: number; earned: number }
interface Overview {
  partner: string; period: string; periods: string[]; configured: boolean; pct: Record<string, number>;
  totals: { brokerage: number; ourShare: number; payout: number; companyKeeps: number | null; activeClients: number; inactiveClients: number; sheetClients: number };
  unmapped: { codes: number; ourShare: number } | null;
  people: Person[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pretty = (p: string) => { const [y, m] = p.split('-').map(Number); return y && m ? `${MONTHS[m - 1]} ${y}` : p; };
const roleOf = (lvl: number | null) => (lvl == null ? '' : lvl <= 3 ? 'RM' : lvl === 4 ? 'BM' : 'Upline');
const selectCls = 'text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none';

export const MotilalSummary: React.FC<{ firmWide: boolean }> = ({ firmWide }) => {
  const [data, setData] = useState<Overview | null>(null);
  const [period, setPeriod] = useState<string | null>(null);   // null = not chosen yet -> newest month
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = async (p: string | null) => {
    setBusy(true); setFailed(false);
    try {
      const q = p === null ? '' : `&period=${encodeURIComponent(p)}`;
      const res = await authFetch(`/api/data?action=partner_overview&partner=MOFSL${q}&_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const d: Overview = await res.json();
      // First load asks for everything; settle on the newest month so the card shows "this month".
      if (p === null && d.periods && d.periods.length) { setPeriod(d.periods[0]); const r2 = await authFetch(`/api/data?action=partner_overview&partner=MOFSL&period=${encodeURIComponent(d.periods[0])}&_=${Date.now()}`, { cache: 'no-store' }); if (r2.ok) { setData(await r2.json()); return; } }
      setData(d);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  useEffect(() => { load(null); /* eslint-disable-next-line */ }, []);

  if (failed) return null;                                  // never break the dashboard over a side card
  if (!data || !data.periods || data.periods.length === 0) return null;   // no Motilal data imported yet

  // Upline (L5 and above) with nothing earned is noise: they sit on every client but are paid nothing here.
  const rows = data.people.filter(p => p.earned !== 0 || (p.level != null && p.level <= 4));
  const t = data.totals;
  const tile = 'rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-4 py-3';
  const label = 'text-[10px] font-black uppercase tracking-widest text-slate-400';
  const levelsText = Object.entries(data.pct).filter(([, v]) => v > 0).map(([l, v]) => `L${l} ${v}%`).join(' · ');

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-blue-600" />
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Motilal Oswal — broking brokerage</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              {firmWide ? 'Brokerage received, what the team earns from it, and client activity.' : 'From your own clients only.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={period ?? ''} onChange={e => { setPeriod(e.target.value); load(e.target.value); }} className={selectCls} aria-label="Month">
            {data.periods.map(p => <option key={p} value={p}>{pretty(p)}</option>)}
            <option value="">All months</option>
          </select>
          <button onClick={() => load(period ?? '')} className={`${selectCls} flex items-center gap-1`} title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className={`grid grid-cols-2 ${firmWide ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-3`}>
        <div className={tile}><div className={label}>{firmWide ? 'Our share of brokerage' : 'Brokerage on your clients'}</div><div className="text-lg font-black text-slate-900 dark:text-slate-100 tabular-nums">{inr(t.ourShare)}</div><div className="text-[10px] text-slate-400">of {inr(t.brokerage)} total</div></div>
        <div className={tile}><div className={label}>{firmWide ? 'Payout to team' : 'Your payout'}</div><div className="text-lg font-black text-emerald-600 tabular-nums">{inr(t.payout)}</div><div className="text-[10px] text-slate-400">{data.configured ? levelsText : 'sharing % not set yet'}</div></div>
        {firmWide && <div className={tile}><div className={label}>Company keeps</div><div className="text-lg font-black text-slate-900 dark:text-slate-100 tabular-nums">{inr(t.companyKeeps ?? 0)}</div><div className="text-[10px] text-slate-400">share minus payout</div></div>}
        <div className={tile}><div className={label}>Active clients</div><div className="text-lg font-black text-slate-900 dark:text-slate-100 tabular-nums">{t.activeClients}</div><div className="text-[10px] text-slate-400">traded in {period ? pretty(period) : 'any month'}</div></div>
        <div className={tile}><div className={label}>Inactive clients</div><div className="text-lg font-black text-slate-900 dark:text-slate-100 tabular-nums">{t.inactiveClients}</div><div className="text-[10px] text-slate-400">on the sheet, no trade</div></div>
      </div>

      {firmWide && !data.configured && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          The per-level sharing is not set, so no payout is shown. Set it in Partner Brokerage → Save sharing.
        </div>
      )}
      {firmWide && data.unmapped && data.unmapped.codes > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {data.unmapped.codes} client code(s) are not mapped to a client yet ({inr(data.unmapped.ourShare)} of our share belongs to nobody). Map them in Partner Brokerage.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 dark:border-slate-700">
                <th className="py-2 pr-4">{firmWide ? 'RM / BM' : 'You'}</th>
                <th className="py-2 pr-4">Level</th>
                <th className="py-2 pr-4 text-right"><Users className="inline w-3 h-3 mr-1" />Active</th>
                <th className="py-2 pr-4 text-right">Inactive</th>
                <th className="py-2 pr-4 text-right">Our share</th>
                <th className="py-2 text-right">Payout</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
              {rows.map(p => (
                <tr key={p.userId}>
                  <td className="py-2 pr-4 font-semibold text-slate-800 dark:text-slate-100">{p.name}</td>
                  <td className="py-2 pr-4 text-xs text-slate-500">{roleOf(p.level)}{p.level != null ? ` · L${p.level}` : ''}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{p.activeClients}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-500">{p.inactiveClients}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{inr(p.brokerage)}</td>
                  <td className="py-2 text-right tabular-nums font-bold text-emerald-600">{inr(p.earned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
