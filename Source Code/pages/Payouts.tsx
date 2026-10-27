import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Wallet, Search, RefreshCw, AlertTriangle, Download, ShieldAlert, ChevronDown } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { authFetch, useData } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { exportToExcel } from '../utils/excelExport';
import { labelFor, registerLabels } from '../utils/payoutSources';

interface Props { currentUser: TeamMember }

interface MonthRow {
  period: string; mf: number; partner: number;
  earned: number; paid: number; carriedIn: number; outstanding: number;
  /** GST the RM bills on top, TDS deducted, and the resulting cheque. Taken
   *  from their raised invoice where one exists, estimated otherwise. */
  gst: number; tds: number; payable: number; invoiced: boolean; invoiceStatus?: string;
  /** The same figures per product — 'MF' for fund trail, then each partner by
   *  its own code — so one product reads on its own and carries its own arrears. */
  bySource: Record<string, { earned: number; paid: number; carriedIn: number; outstanding: number; gst?: number; tds?: number; payable?: number }>;
  /** Each payment recorded for this month, with the note that says why it was paid short, if it was. */
  payments?: Array<{ id: string; source: string; amount: number; paidOn: string; method: string; reference: string; note: string }>;
}

// Product names live in utils/payoutSources.ts, shared with the earnings panel on
// the dashboard, so the two screens always call a product the same thing.
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

/** Why a payment fell short of what was owed. Chosen from a list so the reasons can be counted and filtered later. */
const SHORT_REASONS = [
  'Part payment - balance will be paid later',
  'Held - amount under review or disputed',
  'Held - invoice not received or not approved',
  'Held - bank details missing or wrong',
  'Adjusted against an advance or recovery',
  'Paid the invoice amount (after GST and TDS)',
  'Other (write it below)',
];
const METHODS = ['NEFT', 'IMPS', 'RTGS', 'UPI', 'Cheque', 'Cash', 'Other'];
const todayIso = () => new Date().toISOString().slice(0, 10);

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
  const { updateInvoice } = useData();
  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;

  const [data, setData] = useState<{ periods: string[]; people: Person[]; sources?: string[]; settledThrough?: string; sourceLabels?: Record<string, string> } | null>(null);
  const [period, setPeriod] = useState('');
  /** 'all', or one of the product codes the server reports. */
  const [source, setSource] = useState('all');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyOwed, setOnlyOwed] = useState(false);
  const [payFor, setPayFor] = useState<{ p: Person; m: MonthRow } | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState('NEFT');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [health, setHealth] = useState<any>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    try {
      const r = await authFetch(`/api/data?action=payout_overview&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { showToast('Could not load payouts.', 'error'); return; }
      const j = await r.json();
      registerLabels(j.sourceLabels);
      setData(j);
      setPeriod(cur => cur || (j.periods?.length ? j.periods[j.periods.length - 1] : ''));
    } catch {
      showToast('Could not load payouts.', 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Switching product jumps to the newest month that actually has that product's money, so a
  // partner whose statements are in Jul-Sep does not open on an empty October.
  const pickSource = (next: string) => {
    setSource(next);
    if (!data) return;
    let latest = '';
    for (const p of data.people) for (const m of p.months) {
      const v = next === 'all' ? m : (m.bySource?.[next] || { earned: 0, paid: 0, carriedIn: 0 });
      if ((v.earned !== 0 || v.paid !== 0 || v.carriedIn !== 0) && m.period > latest) latest = m.period;
    }
    if (latest) setPeriod(latest);
  };

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
  const view = (m: MonthRow) => source === 'all'
    ? { carriedIn: m.carriedIn, earned: m.earned, paid: m.paid, outstanding: m.outstanding }
    : (m.bySource?.[source] || { carriedIn: 0, earned: 0, paid: 0, outstanding: 0 });

  // GST, TDS and the cheque for the month. On the combined view they are the RM's invoice figures
  // (or the rate estimate when none is raised). On a single product they are estimates on that
  // product's earnings, because an invoice covers the whole month and is not split by product.
  const taxFor = (m: MonthRow) => source === 'all'
    ? { gst: m.gst, tds: m.tds, payable: m.payable, invoiced: m.invoiced, invoiceStatus: m.invoiceStatus }
    : { gst: m.bySource?.[source]?.gst || 0, tds: m.bySource?.[source]?.tds || 0, payable: m.bySource?.[source]?.payable || 0, invoiced: false, invoiceStatus: '' };

  // One row per person FOR THE CHOSEN MONTH, carrying their prior balance in.
  const rows = useMemo(() => {
    if (!data || !period) return [];
    const q = search.trim().toLowerCase();
    return data.people
      .map(p => ({ p, m: p.months.find(m => m.period === period) }))
      .filter((x): x is { p: Person; m: MonthRow } => !!x.m)
      .map(x => ({ ...x, v: view(x.m), t: taxFor(x.m) }))
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
    gst: a.gst + x.t.gst,
    payable: a.payable + x.t.payable,
  }), { earned: 0, paid: 0, carriedIn: 0, outstanding: 0, gst: 0, payable: 0 }), [rows]);

  const showTax = true;
  const anyPartner = source === 'all' && rows.some(x => x.m.partner !== 0);
  /**
   * Which product a payment recorded from this page is booked against.
   *
   * On a single-product view that is the product on screen, so a Motilal cheque
   * clears the Motilal balance and nothing else. On the combined view it stays
   * the fund stream, which is what an unlabelled payment has always meant here.
   */
  const paySource = source === 'all' ? 'MF' : source;
  /** The dialog's figures follow the same product the table is showing. */
  const payView = payFor ? view(payFor.m) : null;
  const payTax = payFor ? taxFor(payFor.m) : null;

  // The invoice and the payment are one event to the people involved: once Admin has approved an RM's invoice and the
  // money recorded for that month reaches the invoice's base, the invoice is marked PAID, so Admin sees the status change
  // without Finance having to do it twice. A part payment leaves the invoice APPROVED.
  const markInvoicePaidIfCovered = async (userId: string, month: string, paidSoFar: number) => {
    try {
      const r = await authFetch('/api/data?type=invoices&_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const list: any[] = await r.json();
      const inv = list.find(i => i.userId === userId && i.month === month && String(i.status).toUpperCase() === 'APPROVED');
      if (!inv || paidSoFar + 1 < Number(inv.amount || 0)) return;
      // updateInvoice saves it and updates the invoice list this session already holds, so the Invoices screen shows PAID without a reload.
      updateInvoice({ ...inv, status: 'PAID', paidDate: todayIso() } as any);
      showToast('Invoice ' + (inv.invoiceNumber || inv.id) + ' is now marked PAID.', 'success');
    } catch { /* the payment itself is recorded; the invoice can still be marked paid from the Invoices screen */ }
  };

  const recordPayment = async () => {
    if (!payFor) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) { showToast('Enter an amount.', 'warning'); return; }
    // Paying less than is owed is allowed, but it must say why: a balance that just sits there is how a month gets forgotten.
    const owed = payView ? payView.outstanding : 0;
    const shortBy = Math.round((owed - amt) * 100) / 100;
    const isShort = amt > 0 && shortBy > 1;
    const isOther = reason.startsWith('Other');
    if (isShort && !reason) { showToast('You are paying ' + inr(shortBy) + ' less than is owed. Choose a reason.', 'warning'); return; }
    if (isShort && isOther && !reasonText.trim()) { showToast('Write the reason in the note box.', 'warning'); return; }
    const note = isShort
      ? 'Short by ' + inr(shortBy) + ': ' + (isOther ? '' : reason) + (reasonText.trim() ? (isOther ? '' : ' - ') + reasonText.trim() : '')
      : (reasonText.trim() || null);
    const res = await authFetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        payload: { source: paySource, period: payFor.m.period, userId: payFor.p.userId, amount: amt, reference: reference || null, method, paidOn, note },
      }),
    });
    const j = await res.json();
    if (!res.ok) { showToast(j?.error || 'Could not record the payment.', 'error'); return; }
    showToast(`${inr(amt)} recorded for ${payFor.p.name} · ${prettyMonth(payFor.m.period)}.`, 'success');
    await markInvoicePaidIfCovered(payFor.p.userId, payFor.m.period, payFor.m.paid + amt);
    setPayFor(null); setAmount(''); setReference(''); setReason(''); setReasonText('');
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
            onChange={e => pickSource(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 text-sm font-bold"
            title="Which product to show"
          >
            {['all', ...(data?.sources || ['MF'])].map(s => (
              <option key={s} value={s}>{labelFor(s)}</option>
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
              exportToExcel(rows.map(({ p, m, v, t }) => ({
                Name: p.name, Code: p.code, Level: p.level ?? '',
                Product: labelFor(source),
                'Brought forward': v.carriedIn,
                ...(source === 'all' ? { 'Mutual fund': m.mf, 'Partner': m.partner } : {}),
                'Earned this month': v.earned,
                ...{ GST: t.gst, TDS: t.tds, 'Payable': t.payable,
                     'Invoice raised': t.invoiced ? (t.invoiceStatus || 'YES') : 'no' },
                'Already paid': v.paid,
                'Still owed': v.outstanding,
              })), `Payouts_${period}${source === 'all' ? '' : `_${source}`}`, 'Payouts');
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-emerald-400 transition"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Brought forward" value={totals.carriedIn} hint="unpaid from earlier months" />
        <Tile
          label="Earned this month"
          value={totals.earned}
          hint={source === 'all' ? `${rows.length} people` : `${rows.length} people · ${labelFor(source).toLowerCase()} only`}
        />
        {showTax && <Tile label="GST on top" value={totals.gst} hint="only RMs with a GSTIN bill it" />}
        {showTax && <Tile label="Payable (after GST &amp; TDS)" value={totals.payable} accent="emerald" hint="what the cheques come to" />}
        <Tile label="Paid" value={totals.paid} accent="emerald" hint="recorded against this month" />
        <Tile label="Still owed" value={totals.outstanding} accent={totals.outstanding > 0 ? 'red' : 'emerald'} hint="carries into next month" />
      </div>

      {source !== 'all' && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2">
          Showing <b>{labelFor(source)}</b> only. GST, TDS and the cheque here are <span className="text-amber-600 font-black">estimates</span> on this
          product&rsquo;s earnings at the configured rates (an RM&rsquo;s invoice covers the whole month, so see <b>All products</b> for the invoice figures).
          {' '}A payment recorded here is booked against <b>{labelFor(source)}</b>, so it clears this balance and no other.
        </p>
      )}

      {data?.settledThrough && source !== 'MF' && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2">
          Partner payouts up to <b>{prettyMonth(data.settledThrough)}</b> were paid before this system took over, so they show as paid in full. Anything after that is owed until you record a payment.
        </p>
      )}

      {health && (source === 'all' || source === 'MF') && <AttributionHealth h={health} open={openCheck} setOpen={setOpenCheck} />}

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
            <div className="py-8 text-center">
              <p className="text-sm text-slate-400">
                {busy ? 'Loading…' : onlyOwed ? 'Everyone is settled for this month.' : 'Nothing for this month.'}
              </p>
              {/* An empty product reads as a broken page unless it says why it is
                  empty. Two things have to be true before a partner statement pays
                  anybody, and neither of them happens on this page. */}
              {!busy && !onlyOwed && source !== 'all' && source !== 'MF' && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 max-w-xl mx-auto leading-relaxed">
                  {labelFor(source)} has no payout in this month. Pick another month, or check on the Partner Brokerage page that
                  the statement's client codes are attached to clients &mdash; a code that is not attached reaches nobody.
                </p>
              )}
            </div>
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
                  {rows.map(({ p, m, v, t }) => (
                    <tr key={p.userId} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2 pr-4">
                        <div className="font-bold text-slate-900 dark:text-slate-100">{p.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono uppercase">
                          {p.code || p.userId.slice(0, 12)}{p.level != null && ` · L${p.level}`}
                        </div>
                        {v.outstanding > 0.005 && (() => {
                          const last = [...(m.payments || [])].reverse().find(x => x.note && x.note.startsWith('Short by'));
                          return last ? <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 max-w-[16rem] leading-snug" title={last.note}>Part paid {inr(last.amount)} · {last.note.replace(/^Short by [^:]*: ?/, '')}</div> : null;
                        })()}
                      </td>
                      <Num v={v.carriedIn} muted />
                      {anyPartner && <Num v={m.mf} muted />}
                      {anyPartner && <Num v={m.partner} muted />}
                      <Num v={v.earned} bold />
                      {showTax && <Num v={t.gst} muted />}
                      {showTax && <Num v={t.tds} muted />}
                      {showTax && (
                        <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {inr(t.payable)}
                          {!t.invoiced && <span className="ml-1 text-[9px] font-black uppercase tracking-widest text-amber-600" title="No invoice raised for this month — estimated from the configured GST and TDS rates">est</span>}
                        </td>
                      )}
                      <Num v={v.paid} tone="emerald" />
                      <Num v={v.outstanding} bold tone={v.outstanding > 0.005 ? 'red' : 'emerald'} />
                      <td className="py-2 pr-4 text-right">
                        {/* The settlement is booked against whichever product is on
                            screen, so a Motilal cheque clears the Motilal balance. */}
                        <button
                          onClick={() => { setPayFor({ p, m }); setAmount(v.outstanding > 0 ? String(Math.round(v.outstanding * 100) / 100) : ''); setReference(''); setReason(''); setReasonText(''); setMethod('NEFT'); setPaidOn(todayIso()); }}
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

      {payFor && payView && payTax && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setPayFor(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 dark:text-slate-100">Record a payment</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {payFor.p.name} · {prettyMonth(payFor.m.period)} · <b>{labelFor(paySource)}</b>
            </p>
            <dl className="mt-3 text-xs space-y-1">
              <Line k="Brought forward" v={payView.carriedIn} />
              <Line k="Earned this month" v={payView.earned} />
              {payTax.gst > 0 && <Line k="GST" v={payTax.gst} />}
              {payTax.tds > 0 && <Line k="Less TDS" v={-payTax.tds} />}
              <Line k={payTax.invoiced ? "Payable (invoice)" : "Payable (estimated)"} v={payTax.payable} />
              <Line k="Already paid" v={payView.paid} />
              <Line k="Still owed" v={payView.outstanding} strong />
            </dl>
            {(payFor.m.payments || []).filter(x => x.source === paySource).length > 0 && (
              <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 p-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Already recorded this month</p>
                <ul className="space-y-1">
                  {(payFor.m.payments || []).filter(x => x.source === paySource).map(x => (
                    <li key={x.id} className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                      <b className="font-mono">{inr(x.amount)}</b> · {x.paidOn}{x.method ? ' · ' + x.method : ''}{x.reference ? ' · ' + x.reference : ''}
                      {x.note && <div className="text-amber-700 dark:text-amber-400">{x.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            {Number(amount) > payView.outstanding + 0.5 && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5 leading-relaxed">
                That is more than the {inr(payView.outstanding)} outstanding
                {Math.abs(Number(amount) - payTax.payable) < 1 && <> — it looks like the payable {inr(payTax.payable)}, which includes GST</>}.
                Recording it leaves a credit that carries into next month.
              </p>
            )}
            {(() => {
              const amt = Number(amount) || 0;
              const left = Math.round((payView.outstanding - amt) * 100) / 100;
              const short = amt > 0 && left > 1;
              return (
                <>
                  <div className="flex items-center justify-between text-[11px] mt-2">
                    <span className="text-slate-500 dark:text-slate-400">Balance left after this payment</span>
                    <span className={`font-mono font-bold tabular-nums ${left > 0.005 ? 'text-red-600' : 'text-emerald-600'}`}>{inr(Math.max(left, 0))}</span>
                  </div>
                  {short && (
                    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-2.5">
                      <label htmlFor="pay-reason" className="block text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-1">
                        Paying {inr(left)} less than owed — why?
                      </label>
                      <select id="pay-reason" value={reason} onChange={e => setReason(e.target.value)}
                        className="w-full px-2 py-2 rounded-lg border border-amber-300 dark:border-amber-700 dark:bg-slate-900 dark:text-slate-100 text-xs">
                        <option value="">Choose a reason…</option>
                        {SHORT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  )}
                  <label htmlFor="pay-note" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-3 mb-1">
                    Note <span className="font-normal normal-case tracking-normal">({short && reason.startsWith('Other') ? 'required' : 'optional'})</span>
                  </label>
                  <input id="pay-note" value={reasonText} onChange={e => setReasonText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    placeholder="Anything finance or the RM should know" />
                </>
              );
            })()}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <div>
                <label htmlFor="pay-method" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Paid by</label>
                <select id="pay-method" value={method} onChange={e => setMethod(e.target.value)}
                  className="w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm">
                  {METHODS.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pay-date" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Paid on</label>
                <input id="pay-date" type="date" value={paidOn} max={todayIso()} onChange={e => setPaidOn(e.target.value)}
                  className="w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm" />
              </div>
            </div>
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
