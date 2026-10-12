import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Unlock, Loader2, AlertTriangle } from 'lucide-react';
import { authFetch } from '../contexts/DataContext';
import { useToast } from './Toast';

/**
 * Lock months. A locked month keeps its stored payouts for ever: imports, rate
 * changes, promotions, re-mappings and Recalculate all leave it alone, so a figure
 * that has been paid and invoiced can never move. Lock a month once it is paid.
 */

interface Month { period: string; rows: number; gross: number; missingBreakdown: number; locked: boolean }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pretty = (p: string) => { const [y, m] = p.split('-').map(Number); return y && m ? `${MONTHS[m - 1]} ${y}` : p; };
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export const LockMonths: React.FC = () => {
  const { showToast, showConfirm } = useToast();
  const [months, setMonths] = useState<Month[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [through, setThrough] = useState('');

  const load = async () => {
    try {
      const r = await authFetch(`/api/data?action=lock_status&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const list: Month[] = j.months || [];
      setMonths(list);
      setThrough(cur => cur || (() => {
        // Suggest the newest month that is not the very latest: the latest is usually still being worked on.
        const open = list.filter(m => !m.locked);
        return (open.length > 1 ? open[open.length - 2] : open[open.length - 1])?.period || '';
      })());
    } catch {
      showToast('Could not load the locked months.', 'error');
    } finally { setLoaded(true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const openMonths = useMemo(() => months.filter(m => !m.locked), [months]);
  const toLock = useMemo(() => months.filter(m => !m.locked && m.period <= through), [months, through]);
  const unsafe = toLock.filter(m => m.missingBreakdown > 0);
  const recent = useMemo(() => [...months].reverse().slice(0, 12), [months]);

  const lock = async () => {
    if (!toLock.length) return;
    const ok = await showConfirm({
      title: `Lock ${toLock.length} month${toLock.length === 1 ? '' : 's'} up to ${pretty(through)}?`,
      message: `Their payouts are frozen exactly as they stand. Imports, rate changes, promotions and Recalculate will no longer touch them. You can unlock a month later if you must.`,
      confirmText: 'Lock', variant: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lock_periods', payload: { through } }) });
      const j = await r.json();
      if (!r.ok) { showToast(j?.error || 'Could not lock the months.', 'error'); return; }
      showToast(`Locked ${j.added?.length ?? 0} month${(j.added?.length ?? 0) === 1 ? '' : 's'}.`, 'success');
      await load();
    } catch (e: any) {
      showToast(e?.message || 'Could not lock the months.', 'error');
    } finally { setBusy(false); }
  };

  const unlock = async (period: string) => {
    const ok = await showConfirm({
      title: `Unlock ${pretty(period)}?`,
      message: `${pretty(period)} will be recalculated again by the next import, rate change, promotion or Recalculate. Only do this if its payouts really have to change.`,
      confirmText: 'Unlock', variant: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unlock_period', payload: { period } }) });
      const j = await r.json();
      if (!r.ok) { showToast(j?.error || 'Could not unlock the month.', 'error'); return; }
      showToast(`${pretty(period)} is open again.`, 'success');
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div className="p-8 border-b border-slate-100">
      <h4 className="font-bold text-slate-900 mb-2 flex items-center gap-2"><Lock className="w-4 h-4 text-slate-400" /> Lock months</h4>
      <p className="text-sm text-slate-600 mb-4">
        A locked month keeps its payouts exactly as they were paid. Imports, rate changes, promotions, re-mapping and
        Recalculate never touch it. Lock a month once it has been paid.
      </p>

      {!loaded && <p className="text-xs text-slate-400">Loading…</p>}
      {loaded && months.length === 0 && <p className="text-xs text-slate-400">No months have been imported yet.</p>}

      {months.length > 0 && (
        <>
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <label htmlFor="lock-through" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Lock every month up to</label>
            <select id="lock-through" value={through} onChange={e => setThrough(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold bg-white text-slate-900">
              {openMonths.length === 0 && <option value="">Everything is locked</option>}
              {openMonths.map(m => <option key={m.period} value={m.period}>{pretty(m.period)}</option>)}
            </select>
            <button onClick={lock} disabled={busy || !toLock.length || unsafe.length > 0}
              className="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-blue-700 transition disabled:opacity-40 flex items-center">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Lock className="w-4 h-4 mr-2" />}
              Lock {toLock.length ? `${toLock.length} month${toLock.length === 1 ? '' : 's'}` : ''}
            </button>
          </div>
          {unsafe.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 mb-3">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              {unsafe.map(m => pretty(m.period)).join(', ')} {unsafe.length === 1 ? 'has' : 'have'} transactions with no stored payout. Run Recalculate first, or freezing would lock in zeros.
            </p>
          )}

          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2 text-left">Month</th>
                  <th className="px-3 py-2 text-right">Rows</th>
                  <th className="px-3 py-2 text-right">Brokerage</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {recent.map(m => (
                  <tr key={m.period} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-bold text-slate-800">{pretty(m.period)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-600">{m.rows.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-600">{inr(m.gross)}</td>
                    <td className="px-3 py-2">
                      {m.locked
                        ? <span className="inline-flex items-center gap-1 text-emerald-700 font-bold"><Lock className="w-3 h-3" /> Locked</span>
                        : <span className="text-slate-500">Open</span>}
                      {m.missingBreakdown > 0 && <span className="ml-2 text-amber-700">{m.missingBreakdown.toLocaleString('en-IN')} without a payout</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {m.locked && (
                        <button onClick={() => unlock(m.period)} disabled={busy}
                          className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-600 disabled:opacity-40">
                          <Unlock className="w-3 h-3" /> Unlock
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {months.length > recent.length && <p className="text-[11px] text-slate-400 mt-2">Showing the latest {recent.length} of {months.length} months. Locking up to a month also covers every earlier one.</p>}
        </>
      )}
    </div>
  );
};
