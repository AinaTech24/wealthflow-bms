import React, { useEffect, useMemo, useState } from 'react';
import { Wallet, RefreshCw } from 'lucide-react';
import { authFetch } from '../contexts/DataContext';
import { labelFor } from '../utils/payoutSources';

/**
 * Earned, paid and still-owed money, month by month, for one product or all of
 * them. The numbers are the server's own payout figures (the ones the Payouts page
 * reads), never a sum of whatever transactions the browser happened to download.
 *
 *   firmWide = true   Finance: everyone's rows added together.
 *   firmWide = false  an RM or BM: the server sends only their own row.
 */

interface SourceFigures { earned: number; paid: number; carriedIn: number; outstanding: number }
interface MonthRow {
  period: string; mf: number; partner: number;
  earned: number; paid: number; carriedIn: number; outstanding: number;
  bySource?: Record<string, SourceFigures>;
}
interface Person { userId: string; name: string; months: MonthRow[] }
interface Overview { periods: string[]; people: Person[]; sources?: string[] }

type Mode = 'all' | 'month' | 'quarter' | 'year';
interface Row { period: string; mf: number; partner: number; earned: number; paid: number; carriedIn: number; outstanding: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const prettyMonth = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return y && m ? `${MONTHS[m - 1].slice(0, 3)} ${y}` : p;
};
const pad = (n: number) => String(n).padStart(2, '0');
const selectCls = 'text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none';

export const EarningsByMonth: React.FC<{ firmWide: boolean }> = ({ firmWide }) => {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const [source, setSource] = useState('all');
  const [mode, setMode] = useState<Mode>('month');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());      // 0-based
  const [initialised, setInitialised] = useState(false);

  const load = async () => {
    setBusy(true); setFailed(false);
    try {
      const r = await authFetch(`/api/data?action=payout_overview&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setData(await r.json());
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  // One row per month for the chosen product, added up over everyone in scope.
  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const byPeriod = new Map<string, Row>();
    for (const p of data.people || []) {
      for (const m of p.months || []) {
        const v = source === 'all'
          ? { earned: m.earned, paid: m.paid, carriedIn: m.carriedIn, outstanding: m.outstanding }
          : (m.bySource?.[source] || { earned: 0, paid: 0, carriedIn: 0, outstanding: 0 });
        const cur = byPeriod.get(m.period) || { period: m.period, mf: 0, partner: 0, earned: 0, paid: 0, carriedIn: 0, outstanding: 0 };
        cur.earned += v.earned; cur.paid += v.paid; cur.carriedIn += v.carriedIn; cur.outstanding += v.outstanding;
        cur.mf += m.mf; cur.partner += m.partner;
        byPeriod.set(m.period, cur);
      }
    }
    return [...byPeriod.values()]
      .filter(r => r.earned !== 0 || r.paid !== 0 || r.carriedIn !== 0)
      .sort((a, b) => a.period.localeCompare(b.period));
  }, [data, source]);

  // Open on the newest month that actually has money in it. Starting on "today"
  // showed an empty screen whenever the latest statement had not been imported yet.
  useEffect(() => {
    if (initialised || !data) return;
    const all = new Set<string>();
    for (const p of data.people || []) for (const m of p.months || []) all.add(m.period);
    const latest = [...all].sort().pop();
    if (latest) {
      const [y, m] = latest.split('-').map(Number);
      if (y && m) { setYear(y); setMonth(m - 1); }
    }
    setInitialised(true);
  }, [data, initialised]);

  const years = useMemo(() => {
    const ys = new Set<number>(rows.map(r => Number(r.period.slice(0, 4))).filter(Boolean));
    ys.add(year);
    return [...ys].sort((a, b) => b - a);
  }, [rows, year]);

  // The last month the chosen range covers; the balance still owed is read there.
  const endPeriod = mode === 'month' ? `${year}-${pad(month + 1)}`
    : mode === 'quarter' ? `${year}-${pad(Math.floor(month / 3) * 3 + 3)}`
    : mode === 'year' ? `${year}-12`
    : '9999-99';

  const selected = useMemo(() => rows.filter(r => {
    const [y, m] = r.period.split('-').map(Number);
    if (mode === 'all') return true;
    if (mode === 'month') return y === year && m === month + 1;
    if (mode === 'quarter') { const q = Math.floor(month / 3) * 3; return y === year && m >= q + 1 && m <= q + 3; }
    return y === year;
  }), [rows, mode, year, month]);

  const totals = useMemo(() => {
    const earned = selected.reduce((a, r) => a + r.earned, 0);
    const paid = selected.reduce((a, r) => a + r.paid, 0);
    // Unpaid money carries from month to month, so "still owed" is the balance at
    // the END of the range, not a sum of the months in it.
    const upTo = rows.filter(r => r.period <= endPeriod);
    const owed = upTo.length ? upTo[upTo.length - 1].outstanding : 0;
    return { earned, paid, owed };
  }, [selected, rows, endPeriod]);

  const maxEarned = Math.max(1, ...selected.map(r => Math.abs(r.earned)));
  const rangeLabel = mode === 'all' ? 'All time'
    : mode === 'month' ? `${MONTHS[month]} ${year}`
    : mode === 'quarter' ? `Q${Math.floor(month / 3) + 1} ${year}`
    : `${year}`;
  const sources = data?.sources?.length ? data.sources : ['MF'];

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-slate-400" /> {firmWide ? 'Team earnings by month' : 'My earnings by month'}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {firmWide
              ? 'Earned, paid and still owed across the whole team. Pick a product and a period.'
              : 'What you earned, what has been paid to you and what is still owed. Pick a product and a period.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select id="earn-product" aria-label="Product" value={source} onChange={e => setSource(e.target.value)} className={selectCls}>
            <option value="all">{labelFor('all')}</option>
            {sources.map(s => <option key={s} value={s}>{labelFor(s)}</option>)}
          </select>
          <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm">
            {(['all', 'month', 'quarter', 'year'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${mode === m ? 'bg-blue-600 text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'}`}>
                {m === 'all' ? 'All' : m === 'month' ? 'Month' : m === 'quarter' ? 'Quarter' : 'Year'}
              </button>
            ))}
          </div>
          {mode === 'month' && (
            <select id="earn-month" aria-label="Month" value={month} onChange={e => setMonth(Number(e.target.value))} className={selectCls}>
              {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          )}
          {mode === 'quarter' && (
            <select id="earn-quarter" aria-label="Quarter" value={Math.floor(month / 3)} onChange={e => setMonth(Number(e.target.value) * 3)} className={selectCls}>
              {[0, 1, 2, 3].map(q => <option key={q} value={q}>Q{q + 1}</option>)}
            </select>
          )}
          {mode !== 'all' && (
            <select id="earn-year" aria-label="Year" value={year} onChange={e => setYear(Number(e.target.value))} className={selectCls}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
          <button onClick={load} title="Refresh"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-500 hover:border-blue-400 transition">
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {failed && !data && (
        <p className="p-6 text-sm text-red-600 dark:text-red-400">Could not load earnings. Use the refresh button to try again.</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-5">
            <Figure label={`Earned · ${rangeLabel}`} value={inr(totals.earned)} />
            <Figure label={`Paid · ${rangeLabel}`} value={inr(totals.paid)} />
            <Figure label={mode === 'all' ? 'Still owed now' : `Still owed at end of ${rangeLabel}`} value={inr(totals.owed)} tone={totals.owed > 0.005 ? 'owed' : 'clear'} />
          </div>

          {selected.length === 0 ? (
            <p className="px-5 pb-6 text-sm text-slate-400 text-center">
              {firmWide ? 'Nothing earned or paid in this period.' : 'Nothing earned or paid to you in this period.'}
              {mode !== 'all' && <> Try <button className="underline font-bold" onClick={() => setMode('all')}>All</button> to see every month.</>}
            </p>
          ) : (
            <div className="overflow-x-auto px-5 pb-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-200 dark:border-slate-700">
                    <th className="pb-2 pr-4 text-left">Month</th>
                    {source === 'all' && <th className="pb-2 pr-4 text-right">Mutual fund</th>}
                    {source === 'all' && <th className="pb-2 pr-4 text-right">Partners</th>}
                    <th className="pb-2 pr-4 text-right">Earned</th>
                    <th className="pb-2 pr-4 text-right">Paid</th>
                    <th className="pb-2 text-right">Still owed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...selected].reverse().map(r => (
                    <tr key={r.period} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2 pr-4 font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">{prettyMonth(r.period)}</td>
                      {source === 'all' && <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">{inr(r.mf)}</td>}
                      {source === 'all' && <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">{inr(r.partner)}</td>}
                      <td className="py-2 pr-4 text-right">
                        <div className="font-mono text-xs tabular-nums font-bold text-slate-900 dark:text-slate-100">{inr(r.earned)}</div>
                        <div className="h-1 mt-1 rounded bg-slate-100 dark:bg-slate-700 ml-auto w-24 overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, (r.earned / maxEarned) * 100))}%` }} />
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">{inr(r.paid)}</td>
                      <td className={`py-2 text-right font-mono text-xs tabular-nums font-bold ${r.outstanding > 0.005 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{inr(r.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mode !== 'month' && selected.length > 1 && (
                <p className="text-[11px] text-slate-400 mt-3">Still owed carries forward: an unpaid balance from one month is still owed the next, so it is the balance at that month's end, not something to add up.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const Figure: React.FC<{ label: string; value: string; tone?: 'owed' | 'clear' }> = ({ label, value, tone }) => (
  <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className={`text-2xl font-black mt-1 tabular-nums ${tone === 'owed' ? 'text-red-600 dark:text-red-400' : tone === 'clear' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-slate-100'}`}>{value}</p>
  </div>
);
