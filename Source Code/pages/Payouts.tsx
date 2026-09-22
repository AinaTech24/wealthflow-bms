import React, { useState, useEffect, useMemo } from 'react';
import { Wallet, Search, RefreshCw, AlertTriangle, Download } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { authFetch } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { exportToExcel } from '../utils/excelExport';

interface Props { currentUser: TeamMember }

interface MonthRow {
  period: string; mf: number; partner: number;
  earned: number; paid: number; carriedIn: number; outstanding: number;
}
interface Person {
  userId: string; name: string; code: string; role: string; level: number | null;
  months: MonthRow[]; totalEarned: number; totalPaid: number; outstanding: number;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const prettyMonth = (p: string) => {
  const [y, m] = p.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return Number.isNaN(d.getTime()) ? p : d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
};

/**
 * The accounts desk. Everyone, one month: what they earned, what has been paid,
 * and what is still owed.
 *
 * `payout_ledger` has always known the earned half. Nothing recorded the paid
 * half, so "how much is still owed to this RM" could not be answered inside the
 * system at all. The balance carries: an unpaid amount from July is still owed in
 * August rather than disappearing when the month turns.
 */
export const Payouts: React.FC<Props> = ({ currentUser }) => {
  const { showToast } = useToast();
  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;

  const [data, setData] = useState<{ periods: string[]; people: Person[] } | null>(null);
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyOwed, setOnlyOwed] = useState(false);
  const [payFor, setPayFor] = useState<{ p: Person; m: MonthRow } | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');

  const load = async () => {
    setBusy(true);
    try {
      const r = await authFetch(`/api/data?action=payout_overview&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { showToast('Could not load payouts.', 'error'); return; }
      const j = await r.json();
      setData(j);
      setPeriod(cur => cur || (j.periods?.length ? j.periods[j.periods.length - 1] : ''));
    } catch {
      showToast('Could not load payouts.', 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // One row per person FOR THE CHOSEN MONTH, carrying their prior balance in.
  const rows = useMemo(() => {
    if (!data || !period) return [];
    const q = search.trim().toLowerCase();
    return data.people
      .map(p => ({ p, m: p.months.find(m => m.period === period) }))
      .filter((x): x is { p: Person; m: MonthRow } => !!x.m)
      .filter(x => !q || x.p.name.toLowerCase().includes(q) || (x.p.code || '').toLowerCase().includes(q))
      .filter(x => !onlyOwed || x.m.outstanding > 0.005)
      .sort((a, b) => b.m.outstanding - a.m.outstanding || b.m.earned - a.m.earned);
  }, [data, period, search, onlyOwed]);

  const totals = useMemo(() => rows.reduce((a, x) => ({
    earned: a.earned + x.m.earned,
    paid: a.paid + x.m.paid,
    carriedIn: a.carriedIn + x.m.carriedIn,
    outstanding: a.outstanding + x.m.outstanding,
  }), { earned: 0, paid: 0, carriedIn: 0, outstanding: 0 }), [rows]);

  const anyPartner = rows.some(x => x.m.partner !== 0);

  const recordPayment = async () => {
    if (!payFor) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) { showToast('Enter an amount.', 'warning'); return; }
    const res = await authFetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        payload: { source: 'MF', period: payFor.m.period, userId: payFor.p.userId, amount: amt, reference: reference || null },
      }),
    });
    const j = await res.json();
    if (!res.ok) { showToast(j?.error || 'Could not record the payment.', 'error'); return; }
    showToast(`${inr(amt)} recorded for ${payFor.p.name} · ${prettyMonth(payFor.m.period)}.`, 'success');
    setPayFor(null); setAmount(''); setReference('');
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Payouts</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            What every BM and RM has earned, what has been paid, and what is still owed.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            id="payout-period"
            value={period}
            onChange={e => setPeriod(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 text-sm font-bold"
          >
            {(data?.periods || []).slice().reverse().map(p => (
              <option key={p} value={p}>{prettyMonth(p)}</option>
            ))}
          </select>
          <button
            onClick={load}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-blue-400 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={() => {
              if (!rows.length) { showToast('Nothing to export for this month.', 'warning'); return; }
              exportToExcel(rows.map(({ p, m }) => ({
                Name: p.name, Code: p.code, Level: p.level ?? '',
                'Brought forward': m.carriedIn,
                'Mutual fund': m.mf, 'Partner': m.partner,
                'Earned this month': m.earned, Paid: m.paid,
                'Still owed': m.outstanding,
              })), `Payouts_${period}`, 'Payouts');
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-emerald-400 transition"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Brought forward" value={totals.carriedIn} hint="unpaid from earlier months" />
        <Tile label="Earned this month" value={totals.earned} hint={`${rows.length} people`} />
        <Tile label="Paid" value={totals.paid} accent="emerald" />
        <Tile label="Still owed" value={totals.outstanding} accent={totals.outstanding > 0 ? 'red' : 'emerald'} hint="carries into next month" />
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm flex items-center gap-2">
            <Wallet className="w-4 h-4 text-slate-400" /> {prettyMonth(period)}
          </h3>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 dark:text-slate-400 cursor-pointer">
              <input id="only-owed" type="checkbox" checked={onlyOwed} onChange={e => setOnlyOwed(e.target.checked)} />
              Only those still owed
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="payout-search" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search person…"
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 w-48"
              />
            </div>
          </div>
        </div>

        <div className="p-4">
          {!rows.length ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              {busy ? 'Loading…' : onlyOwed ? 'Everyone is settled for this month.' : 'Nothing for this month.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-200 dark:border-slate-700">
                    <th className="pb-2 pr-4 text-left">Person</th>
                    <th className="pb-2 pr-4 text-right">Brought fwd</th>
                    {anyPartner && <th className="pb-2 pr-4 text-right">Mutual fund</th>}
                    {anyPartner && <th className="pb-2 pr-4 text-right">Partner</th>}
                    <th className="pb-2 pr-4 text-right">Earned</th>
                    <th className="pb-2 pr-4 text-right">Paid</th>
                    <th className="pb-2 pr-4 text-right">Still owed</th>
                    <th className="pb-2 pr-4 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, m }) => (
                    <tr key={p.userId} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2 pr-4">
                        <div className="font-bold text-slate-900 dark:text-slate-100">{p.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono uppercase">
                          {p.code || p.userId.slice(0, 12)}{p.level != null && ` · L${p.level}`}
                        </div>
                      </td>
                      <Num v={m.carriedIn} muted />
                      {anyPartner && <Num v={m.mf} muted />}
                      {anyPartner && <Num v={m.partner} muted />}
                      <Num v={m.earned} bold />
                      <Num v={m.paid} tone="emerald" />
                      <Num v={m.outstanding} bold tone={m.outstanding > 0.005 ? 'red' : 'emerald'} />
                      <td className="py-2 pr-4 text-right">
                        <button
                          onClick={() => { setPayFor({ p, m }); setAmount(m.outstanding > 0 ? String(Math.round(m.outstanding * 100) / 100) : ''); setReference(''); }}
                          className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600 transition whitespace-nowrap"
                        >
                          Record payment
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3 max-w-3xl">
                <b>Brought forward</b> is what was still owed when this month opened, and <b>Still owed</b> is what
                carries into the next one. A month can be paid in parts — each payment is its own record and they add up.
              </p>
            </div>
          )}
        </div>
      </div>

      {isFinance && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-3xl leading-relaxed">
            You can see the whole firm and record what has been paid. Changing what is <i>owed</i> — imports, client
            hierarchies, sharing rates — stays with an administrator, so the figures on this page cannot move
            underneath a payment you have already made.
          </p>
        </div>
      )}

      {payFor && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setPayFor(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 dark:text-slate-100">Record a payment</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {payFor.p.name} · {prettyMonth(payFor.m.period)}
            </p>
            <dl className="mt-3 text-xs space-y-1">
              <Line k="Brought forward" v={payFor.m.carriedIn} />
              <Line k="Earned this month" v={payFor.m.earned} />
              <Line k="Already paid" v={payFor.m.paid} />
              <Line k="Still owed" v={payFor.m.outstanding} strong />
            </dl>
            <label htmlFor="pay-amt" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-4 mb-1">Amount paid</label>
            <input
              id="pay-amt" type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 tabular-nums"
              placeholder="0.00"
            />
            <label htmlFor="pay-ref" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-3 mb-1">
              Reference <span className="font-normal normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="pay-ref" value={reference} onChange={e => setReference(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              placeholder="UTR / cheque no."
            />
            <div className="flex gap-2 mt-5">
              <button onClick={() => setPayFor(null)} className="flex-1 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
              <button onClick={recordPayment} className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition">Record</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Tile: React.FC<{ label: string; value: number; hint?: string; accent?: 'emerald' | 'red' }> =
({ label, value, hint, accent }) => (
  <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className={`text-2xl font-black mt-1 tabular-nums ${
      accent === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
      : accent === 'red' ? 'text-red-600 dark:text-red-400'
      : 'text-slate-900 dark:text-slate-100'}`}>
      {formatCompactINR(value)}
    </p>
    {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
  </div>
);

const Num: React.FC<{ v: number; bold?: boolean; muted?: boolean; tone?: 'emerald' | 'red' }> =
({ v, bold, muted, tone }) => (
  <td className={`py-2 pr-4 text-right font-mono text-xs tabular-nums ${bold ? 'font-bold' : ''} ${
    tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'red' ? 'text-red-600 dark:text-red-400'
    : muted ? 'text-slate-400' : 'text-slate-700 dark:text-slate-200'}`}>
    {inr(v)}
  </td>
);

const Line: React.FC<{ k: string; v: number; strong?: boolean }> = ({ k, v, strong }) => (
  <div className="flex justify-between">
    <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
    <dd className={`font-mono tabular-nums ${strong ? 'font-bold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>{inr(v)}</dd>
  </div>
);
