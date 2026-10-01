import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Wallet, Search, RefreshCw, AlertTriangle, Download, Upload, ShieldAlert, ChevronDown } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { authFetch } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { exportToExcel } from '../utils/excelExport';

interface Props { currentUser: TeamMember }

interface MonthRow {
  period: string; mf: number; partner: number;
  earned: number; paid: number; carriedIn: number; outstanding: number;
  /** GST the RM bills on top, TDS deducted, and the resulting cheque. Taken
   *  from their raised invoice where one exists, estimated otherwise. */
  gst: number; tds: number; payable: number; invoiced: boolean; invoiceStatus?: string;
  /** The same three figures split by revenue stream, so one product can be read
   *  on its own and still carry its own arrears. */
  paidMf: number; paidPartner: number;
  carriedInMf: number; carriedInPartner: number;
  outstandingMf: number; outstandingPartner: number;
}

/** Which revenue stream the desk is looking at. */
type Source = 'all' | 'mf' | 'partner';
const SOURCE_LABEL: Record<Source, string> = {
  all: 'All products',
  mf: 'Mutual fund',
  partner: 'Partner broking',
};
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
  const [source, setSource] = useState<Source>('all');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyOwed, setOnlyOwed] = useState(false);
  const [payFor, setPayFor] = useState<{ p: Person; m: MonthRow } | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const [health, setHealth] = useState<any>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

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

  // Attribution health is per MONTH, so it reloads when the month changes.
  useEffect(() => {
    if (!period) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/data?action=attribution_health&period=${period}&_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        setHealth(await r.json());
      } catch { /* the page is still useful without it */ }
    })();
    return () => { cancelled = true; };
  }, [period]);

  /**
   * The four money figures for whichever product is selected.
   *
   * Each stream carries its own balance forward, because a settlement records
   * which stream it paid. Reading only mutual fund must therefore not show an
   * arrear that was really partner broking — that would have finance paying the
   * same money twice.
   */
  const view = (m: MonthRow) => source === 'mf'
    ? { carriedIn: m.carriedInMf, earned: m.mf, paid: m.paidMf, outstanding: m.outstandingMf }
    : source === 'partner'
      ? { carriedIn: m.carriedInPartner, earned: m.partner, paid: m.paidPartner, outstanding: m.outstandingPartner }
      : { carriedIn: m.carriedIn, earned: m.earned, paid: m.paid, outstanding: m.outstanding };

  // One row per person FOR THE CHOSEN MONTH, carrying their prior balance in.
  const rows = useMemo(() => {
    if (!data || !period) return [];
    const q = search.trim().toLowerCase();
    return data.people
      .map(p => ({ p, m: p.months.find(m => m.period === period) }))
      .filter((x): x is { p: Person; m: MonthRow } => !!x.m)
      .map(x => ({ ...x, v: view(x.m) }))
      .filter(x => !q || x.p.name.toLowerCase().includes(q) || (x.p.code || '').toLowerCase().includes(q))
      // A person with nothing at all in this stream is noise, not a zero worth reading.
      .filter(x => source === 'all' || x.v.earned !== 0 || x.v.paid !== 0 || x.v.carriedIn !== 0)
      .filter(x => !onlyOwed || x.v.outstanding > 0.005)
      .sort((a, b) => b.v.outstanding - a.v.outstanding || b.v.earned - a.v.earned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, period, search, onlyOwed, source]);

  const totals = useMemo(() => rows.reduce((a, x) => ({
    earned: a.earned + x.v.earned,
    paid: a.paid + x.v.paid,
    carriedIn: a.carriedIn + x.v.carriedIn,
    outstanding: a.outstanding + x.v.outstanding,
    gst: a.gst + x.m.gst,
    payable: a.payable + x.m.payable,
  }), { earned: 0, paid: 0, carriedIn: 0, outstanding: 0, gst: 0, payable: 0 }), [rows]);

  // GST, TDS and the cheque are month-level facts off the RM's invoice — they are
  // not split by product, so they are only shown when nothing is filtered out.
  const showTax = source === 'all';
  const anyPartner = source === 'all' && rows.some(x => x.m.partner !== 0);

  // ── Bulk import ───────────────────────────────────────────────────────────
  // Export the month, fill the "Pay now" column, upload it back. Settling 121
  // people one dialog at a time is not a workflow.
  const importPayments = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch('/api/parse-sheet', { method: 'POST', body: form });
      const j = await res.json();
      if (!j?.ok || !Array.isArray(j.jsonData) || j.jsonData.length < 2) {
        showToast('Could not read that file.', 'error'); return;
      }
      const grid: any[][] = j.jsonData;
      const header = grid[0].map((h: any) => String(h ?? '').trim().toLowerCase());
      const col = (...names: string[]) => {
        for (const n of names) { const i = header.indexOf(n.toLowerCase()); if (i >= 0) return i; }
        return -1;
      };
      const iAmount = col('pay now', 'amount', 'paid now', 'payment');
      const iCode = col('code', 'employee code', 'arn');
      const iName = col('name', 'person');
      const iRef = col('reference', 'utr', 'ref');
      if (iAmount < 0) {
        showToast('That sheet has no "Pay now" column. Export this month, fill that column in, and upload it back.', 'error');
        return;
      }
      if (iCode < 0 && iName < 0) {
        showToast('That sheet has neither a Code nor a Name column, so the payments cannot be matched to people.', 'error');
        return;
      }
      const payload = grid.slice(1).map(r => ({
        code: iCode >= 0 ? String(r[iCode] ?? '').trim() : '',
        name: iName >= 0 ? String(r[iName] ?? '').trim() : '',
        reference: iRef >= 0 ? String(r[iRef] ?? '').trim() : '',
        amount: Number(String(r[iAmount] ?? '').replace(/[₹,\s]/g, '')),
      })).filter(x => Number.isFinite(x.amount) && x.amount !== 0);

      if (!payload.length) {
        showToast('Nothing to record — the "Pay now" column is empty on every row.', 'warning');
        return;
      }
      const total = payload.reduce((a, x) => a + x.amount, 0);
      if (!window.confirm(
        `Record ${payload.length} payment${payload.length !== 1 ? 's' : ''} totalling ${inr(total)} ` +
        `for ${prettyMonth(period)}?\n\nThis adds to whatever has already been recorded for this month.`)) return;

      const save = await authFetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settle_bulk', payload: { source: 'MF', period, rows: payload } }),
      });
      const sj = await save.json();
      if (!save.ok) { showToast(sj?.error || 'Import failed.', 'error'); return; }
      showToast(
        `${sj.recorded} payment${sj.recorded !== 1 ? 's' : ''} recorded, ${inr(sj.total)} in total` +
        (sj.skipped?.length ? ` · ${sj.skipped.length} row(s) skipped (${sj.skipped.slice(0, 3).map((s: any) => s.label || '?').join(', ')}${sj.skipped.length > 3 ? '…' : ''})` : ''),
        sj.skipped?.length ? 'warning' : 'success');
      await load();
    } catch (e: any) {
      showToast(e?.message || 'Import failed.', 'error');
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

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
            id="payout-source"
            value={source}
            onChange={e => setSource(e.target.value as Source)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 text-sm font-bold"
            title="Which revenue stream to show"
          >
            {(['all', 'mf', 'partner'] as Source[]).map(s => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>
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
              // "Pay now" ships empty on purpose: fill it in, upload the same
              // sheet back, and those become the month's payments. Leaving the
              // already-Paid column to be re-read would double every payment.
              exportToExcel(rows.map(({ p, m, v }) => ({
                Name: p.name, Code: p.code, Level: p.level ?? '',
                Product: SOURCE_LABEL[source],
                'Brought forward': v.carriedIn,
                ...(showTax ? { 'Mutual fund': m.mf, 'Partner': m.partner } : {}),
                'Earned this month': v.earned,
                ...(showTax ? { GST: m.gst, TDS: m.tds, 'Payable': m.payable,
                                'Invoice raised': m.invoiced ? (m.invoiceStatus || 'YES') : 'no' } : {}),
                'Already paid': v.paid,
                'Still owed': v.outstanding,
                'Pay now': '',
                Reference: '',
              })), `Payouts_${period}${source === 'all' ? '' : `_${source}`}`, 'Payouts');
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-emerald-400 transition"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <input
            ref={importRef}
            id="payout-import"
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) importPayments(f); }}
          />
          <button
            onClick={() => importRef.current?.click()}
            disabled={busy}
            className="bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-bold shadow-lg shadow-blue-100 dark:shadow-none hover:bg-blue-700 transition flex items-center gap-1.5 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" /> Import payments
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Brought forward" value={totals.carriedIn} hint="unpaid from earlier months" />
        <Tile
          label="Earned this month"
          value={totals.earned}
          hint={source === 'all' ? `${rows.length} people` : `${rows.length} people · ${SOURCE_LABEL[source].toLowerCase()} only`}
        />
        {showTax && <Tile label="GST on top" value={totals.gst} hint="only RMs with a GSTIN bill it" />}
        {showTax && <Tile label="Payable (after GST &amp; TDS)" value={totals.payable} accent="emerald" hint="what the cheques come to" />}
        <Tile label="Paid" value={totals.paid} accent="emerald" hint="recorded against this month" />
        <Tile label="Still owed" value={totals.outstanding} accent={totals.outstanding > 0 ? 'red' : 'emerald'} hint="carries into next month" />
      </div>

      {!showTax && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2">
          Showing <b>{SOURCE_LABEL[source].toLowerCase()}</b> only. GST, TDS and the cheque amount come from the RM&rsquo;s
          invoice for the whole month and are not split by product, so they are hidden here — switch to{' '}
          <b>All products</b> to see them.
          {source === 'partner' && ' Partner payments are recorded on the Partner Brokerage page, where each partner has its own ledger.'}
        </p>
      )}

      {health && <AttributionHealth h={health} open={openCheck} setOpen={setOpenCheck} />}

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
                    {showTax && <th className="pb-2 pr-4 text-right">GST</th>}
                    {showTax && <th className="pb-2 pr-4 text-right">TDS</th>}
                    {showTax && <th className="pb-2 pr-4 text-right">Payable</th>}
                    <th className="pb-2 pr-4 text-right">Paid</th>
                    <th className="pb-2 pr-4 text-right">Still owed</th>
                    <th className="pb-2 pr-4 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, m, v }) => (
                    <tr key={p.userId} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2 pr-4">
                        <div className="font-bold text-slate-900 dark:text-slate-100">{p.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono uppercase">
                          {p.code || p.userId.slice(0, 12)}{p.level != null && ` · L${p.level}`}
                        </div>
                      </td>
                      <Num v={v.carriedIn} muted />
                      {anyPartner && <Num v={m.mf} muted />}
                      {anyPartner && <Num v={m.partner} muted />}
                      <Num v={v.earned} bold />
                      {showTax && <Num v={m.gst} muted />}
                      {showTax && <Num v={m.tds} muted />}
                      {showTax && (
                        <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {inr(m.payable)}
                          {!m.invoiced && <span className="ml-1 text-[9px] font-black uppercase tracking-widest text-amber-600" title="No invoice raised for this month — estimated from the configured GST and TDS rates">est</span>}
                        </td>
                      )}
                      <Num v={v.paid} tone="emerald" />
                      <Num v={v.outstanding} bold tone={v.outstanding > 0.005 ? 'red' : 'emerald'} />
                      <td className="py-2 pr-4 text-right">
                        {/* A settlement carries the stream it paid. Recording one while
                            filtered to partner broking would have to guess WHICH partner,
                            so that is done on the Partner Brokerage page instead. */}
                        {source === 'partner' ? (
                          <span className="text-[10px] text-slate-400">on Partner Brokerage</span>
                        ) : (
                          <button
                            onClick={() => { setPayFor({ p, m }); setAmount(v.outstanding > 0 ? String(Math.round(v.outstanding * 100) / 100) : ''); setReference(''); }}
                            className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600 transition whitespace-nowrap"
                          >
                            Record payment
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3 max-w-3xl">
                <b>Brought forward</b> is what was still owed when this month opened, and <b>Still owed</b> is what
                carries into the next one. A month can be paid in parts — each payment is its own record and they add up.
                <br />
                <b>Payable</b> is the cheque: earned + GST &minus; TDS, rounded. Where the RM has raised an invoice those are
                its own figures; <span className="text-amber-600 font-black">est</span> marks a month with no invoice yet, priced at the configured rates.
                Only RMs with a GSTIN bill GST, and an intra-state bill splits it as CGST + SGST.
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
              {payFor.m.gst > 0 && <Line k="GST" v={payFor.m.gst} />}
              {payFor.m.tds > 0 && <Line k="Less TDS" v={-payFor.m.tds} />}
              <Line k={payFor.m.invoiced ? "Payable (invoice)" : "Payable (estimated)"} v={payFor.m.payable} />
              <Line k="Already paid" v={payFor.m.paid} />
              <Line k="Still owed" v={payFor.m.outstanding} strong />
            </dl>
            {/* The ledger runs on earnings, not on the cheque. GST is collected on
                the RM's behalf and TDS is withheld, so entering the payable here
                would over-credit the balance and push it negative. Say so, and
                warn the moment the typed figure looks like the cheque. */}
            <label htmlFor="pay-amt" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-4 mb-1">
              Amount paid <span className="font-normal normal-case tracking-normal text-slate-400">— against earnings, before GST and TDS</span>
            </label>
            <input
              id="pay-amt" type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 tabular-nums"
              placeholder="0.00"
            />
            {Number(amount) > payFor.m.outstanding + 0.5 && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5 leading-relaxed">
                That is more than the {inr(payFor.m.outstanding)} outstanding
                {Math.abs(Number(amount) - payFor.m.payable) < 1 && <> — it looks like the payable {inr(payFor.m.payable)}, which includes GST</>}.
                Recording it leaves a credit that carries into next month.
              </p>
            )}
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

/**
 * Three data faults decide whether a month's brokerage reaches the right person,
 * and each one comes BACK with every import — they are not one-time repairs.
 * Reconciling against AdvisorKhoj used to find them by hand; this finds them
 * without it, which is the point now that the firm is leaving AdvisorKhoj.
 */
const AttributionHealth: React.FC<{ h: any; open: string | null; setOpen: (k: string | null) => void }> =
({ h, open, setOpen }) => {
  const checks = [
    {
      key: 'noRm',
      title: 'Clients with no RM',
      why: 'Their brokerage reaches nobody. Assign each one on Clients & Map.',
      data: h.noRm,
      render: (r: any) => <><b>{r.name}</b>{r.investor && r.investor !== r.name && <span className="text-slate-400"> · {r.investor}</span>}</>,
    },
    {
      key: 'shared',
      title: 'Folios on two clients',
      why: 'The import attaches each to whichever it matches first, and that can change month to month — it silently swaps two people’s pay. Remove the folio from whichever record should not hold it.',
      data: h.sharedFolios,
      render: (r: any) => (
        <>
          <span className="font-mono">{r.folio}</span> → <b>{r.holder}</b> <span className="text-slate-400">· {r.holderRm}</span>
          {r.others?.length > 0 && <div className="text-slate-400 text-[11px] pl-2">also claimed by {r.others.join(' · ')}</div>}
        </>
      ),
    },
    {
      key: 'multi',
      title: 'One record, unrelated investors',
      why: 'A catch-all record pays its own RM for everyone inside it. Moving the transactions is not enough — take the borrowed FOLIOS off the record too, or the next import puts them straight back.',
      data: h.multiInvestor,
      render: (r: any) => (
        <>
          <b>{r.name}</b> <span className="text-slate-400">· {r.rm} · {r.investors} investors</span>
          {r.people && <div className="text-slate-400 text-[11px] pl-2">{r.people.join(' | ')}</div>}
        </>
      ),
    },
  ];
  const clean = checks.every(c => (c.data?.count || 0) === 0);

  return (
    <div className={`rounded-xl border-2 overflow-hidden ${clean
      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10'
      : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10'}`}>
      <div className="px-4 py-3 flex items-center gap-2">
        <ShieldAlert className={`w-4 h-4 ${clean ? 'text-emerald-600' : 'text-amber-600'}`} />
        <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">Attribution health</h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          {clean ? 'nothing is misattributed this month' : 'money that may be reaching the wrong person'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-amber-200/50 dark:bg-amber-800/40">
        {checks.map(c => {
          const count = c.data?.count || 0;
          const isOpen = open === c.key;
          return (
            <div key={c.key} className="bg-white dark:bg-slate-800">
              <button
                onClick={() => setOpen(isOpen ? null : c.key)}
                disabled={!count}
                className="w-full text-left px-4 py-3 disabled:cursor-default hover:bg-slate-50 dark:hover:bg-slate-700/40 transition"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-2xl font-black tabular-nums ${count ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {count}
                  </span>
                  {!!count && <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition ${isOpen ? 'rotate-180' : ''}`} />}
                </div>
                <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 mt-0.5">{c.title}</div>
                <div className="text-[10px] text-slate-400 tabular-nums">
                  {count ? `${inr(c.data.gross)} this month` : 'clear'}
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 border-t border-slate-100 dark:border-slate-700 pt-2">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">{c.why}</p>
                  <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                    {c.data.rows.map((r: any, i: number) => (
                      <li key={i} className="text-xs text-slate-700 dark:text-slate-200 border-b border-slate-50 dark:border-slate-700/40 pb-1.5">
                        <span className="font-mono tabular-nums text-slate-500 mr-2">{inr(r.gross)}</span>
                        {c.render(r)}
                      </li>
                    ))}
                  </ul>
                  {c.data.count > c.data.rows.length && (
                    <p className="text-[10px] text-slate-400 mt-2">
                      Showing the largest {c.data.rows.length} of {c.data.count}.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
