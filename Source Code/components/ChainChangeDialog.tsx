import React, { useEffect, useMemo, useState } from 'react';
import { authFetch } from '../contexts/DataContext';

/**
 * Shown when a client's RM / BM is changed by hand (Clients & Map: one client, a bulk assignment, a quick
 * re-assign). The person says FROM WHICH MONTH the change counts and whether to recalculate now; the months
 * before it keep the RM/BM they were paid with. Locked months never change whatever is chosen here.
 */
interface Props {
  title: string;
  /** What is about to change, one line each ("L2 Ninja: Anil → Bhavna"). */
  lines: string[];
  /** How many clients the change touches. */
  count: number;
  /** The caller rebuilds payouts itself (partner statements do), so there is no "Recalculate" choice: just Save. */
  simple?: boolean;
  /** What is being changed, for the sentence that explains the month ("RM/BM", the default). */
  noun?: string;
  onConfirm: (effectiveFrom: string, recalculate: boolean) => void;
  onCancel: () => void;
}

const ALL_MONTHS = '0000-01';
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const pretty = (p: string) => {
  const d = new Date(`${p}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? p : d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
};

export const ChainChangeDialog: React.FC<Props> = ({ title, lines, count, simple, noun = 'RM/BM', onConfirm, onCancel }) => {
  const [locked, setLocked] = useState<string[]>([]);
  const [lockKnown, setLockKnown] = useState(false);
  const [month, setMonth] = useState<string>('');

  // Locked months come from the server; if they cannot be read the server still refuses to touch them.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await authFetch(`/api/data?action=lock_status&_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (live && Array.isArray(j.lockedPeriods)) { setLocked(j.lockedPeriods); setLockKnown(true); }
      } catch { /* leave it unknown */ }
    })();
    return () => { live = false; };
  }, []);

  // Six months back to three ahead. The current month is the default: "from now on".
  const options = useMemo(() => {
    const now = new Date();
    const out: string[] = [];
    for (let i = 6; i >= -3; i--) out.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    return out;
  }, []);
  const thisMonth = ym(new Date());
  useEffect(() => { if (month && locked.includes(month)) setMonth(''); }, [locked, month]);   // the lock list arrived after a default was picked
  useEffect(() => {
    if (month) return;
    const first = options.filter(m => m >= thisMonth).find(m => !locked.includes(m));
    setMonth(first || thisMonth);
  }, [locked, options, month, thisMonth]);

  const lockedList = locked.slice().sort();
  const isAll = month === ALL_MONTHS;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Apply the change from which month">
      <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-7 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700">
          <h3 className="font-black text-lg text-slate-900 dark:text-slate-100 tracking-tight">{title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{simple ? 'This client code is already attached, so the month matters.' : `${count} client${count !== 1 ? 's' : ''} will change.`}</p>
        </div>
        <div className="px-7 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
          <ul className="text-sm space-y-1 text-slate-700 dark:text-slate-200">
            {lines.slice(0, 8).map((l, i) => <li key={i} className="font-semibold">{l}</li>)}
            {lines.length > 8 && <li className="text-xs text-slate-400">…and {lines.length - 8} more</li>}
          </ul>

          <div>
            <label htmlFor="chain-from" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Apply this change from</label>
            <select
              id="chain-from"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-full border border-slate-200 dark:border-slate-600 rounded-xl px-4 py-3 text-sm font-bold text-slate-700 dark:text-slate-100 bg-slate-50/50 dark:bg-slate-900 outline-none"
            >
              {options.map(m => (
                <option key={m} value={m} disabled={locked.includes(m)}>
                  {pretty(m)}{locked.includes(m) ? ' (locked, stays as paid)' : m === thisMonth ? ' (this month)' : ''}
                </option>
              ))}
              <option value={ALL_MONTHS}>All months (only to fix a mistake)</option>
            </select>
          </div>

          <div className={`rounded-xl border px-4 py-3 text-xs leading-relaxed ${isAll ? 'border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200' : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200'}`}>
            {isAll
              ? <>Every month that is <b>not locked</b> will use the new {noun}, including past ones. Use this only if the earlier mapping was simply wrong.</>
              : <>From <b>{pretty(month || thisMonth)}</b> on, payouts use the new {noun}. <b>Earlier months keep the {noun} they were paid with</b> and are not touched.</>}
            {' '}{lockKnown
              ? (lockedList.length ? <>Locked months ({lockedList.length}, up to {pretty(lockedList[lockedList.length - 1])}) never change.</> : <>No month is locked yet.</>)
              : <>Locked months never change.</>}
          </div>
          <p className="text-[11px] text-slate-400">
            {simple
              ? 'The partner payouts are rebuilt as soon as you save.'
              : `Recalculate re-builds the payouts with the new ${noun} from that month. “Save only” stores the change; payouts follow at the next Recalculate or import.`}
          </p>
        </div>
        <div className="px-7 py-4 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-700 flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} className="px-5 py-2.5 text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-600">Cancel</button>
          {simple ? (
            <button disabled={!month} onClick={() => onConfirm(month, false)} className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-lg shadow-blue-100 dark:shadow-none disabled:opacity-40">Save</button>
          ) : (
            <>
              <button disabled={!month} onClick={() => onConfirm(month, false)} className="px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 text-xs font-black uppercase tracking-widest text-slate-600 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40">Save only</button>
              <button disabled={!month} onClick={() => onConfirm(month, true)} className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-lg shadow-blue-100 dark:shadow-none disabled:opacity-40">Save &amp; Recalculate</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
