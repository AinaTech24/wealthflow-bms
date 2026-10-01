import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Upload, Link2, AlertTriangle, Landmark, Search, Check, RefreshCw } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { useData, authFetch } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';

interface Props { currentUser: TeamMember }

/**
 * Revenue that is NOT mutual fund trail — Motilal Oswal's Brokerage Sharing
 * statement and the others like it.
 *
 * It is deliberately a separate page and a separate table. The statement shares
 * nothing with a CAMS/Kfin file: a client CODE rather than a folio, a daily trade
 * date rather than a settled month, no AUM at all, and a split the file states
 * outright ("Flat 65 PERCNT") instead of one the hierarchy derives. It is not a
 * side note either — July 2026 paid ₹5.53L here against ₹2.60L of fund brokerage.
 */

// ── Partner file formats ────────────────────────────────────────────────────
// Each partner gets a signature (columns that must be present) and a column map.
// Adding the next broker is adding one entry here, not a new page.
interface PartnerFormat {
  code: string;
  label: string;
  signature: string[];
  columns: {
    clientCode: string; tradeDate: string; segment: string; tradeCategory: string;
    totalBrokerage: string; ourShare: string; partnerShare: string;
  };
  /** Columns kept verbatim for the detail view; not used in any total. */
  extra: string[];
}

const PARTNER_FORMATS: PartnerFormat[] = [
  {
    code: 'MOFSL',
    label: 'Motilal Oswal — Brokerage Sharing',
    signature: ['Trade Date', 'Client Code', 'Total Brok'],
    columns: {
      clientCode: 'Client Code',
      tradeDate: 'Trade Date',
      segment: 'Segment',
      tradeCategory: 'Trade Category',
      totalBrokerage: 'Total Brok',
      // "Parent Sharing" is our cut; "MOFSL Sharing" is theirs.
      ourShare: 'Parent Sharing',
      partnerShare: 'MOFSL Sharing',
    },
    extra: ['Branch Code', 'Subbroker Code', 'DealerCode', 'BusinessType', 'Product',
            'Sub Prod Code', 'Parent Profile', 'BA Profile', 'BA Sharing',
            'Referral Value', 'Parent Sharing Percent'],
  },
];

// "01 Jul 2026" → "2026-07-01". Returns null rather than an Invalid Date, so a
// malformed row is skipped instead of poisoning a month.
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function parseTradeDate(raw: string): string | null {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const num = (v: any) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** "2026-07" → "July 2026". Falls back to the raw key rather than "Invalid Date". */
const prettyMonth = (p: string) => {
  const d = new Date(`${p}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? p : d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
};

interface CodeRow {
  partner: string; clientCode: string; rows_: number;
  firstPeriod: string; lastPeriod: string; ourShare: number;
  mappedClientId: string | null; label: string | null;
}

export const PartnerBrokerage: React.FC<Props> = ({ currentUser }) => {
  const { clients, globalConfig, updateConfig } = useData();
  const { showToast } = useToast();
  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;
  const canWrite = isAdmin || isFinance;

  const [summary, setSummary] = useState<any>(null);
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const partner = 'MOFSL';
  // Stored either as a bare number (all of it to the RM level) or per level.
  const rawShare = globalConfig?.partnerSharing?.[partner];
  const levelPct: Record<string, number> = typeof rawShare === 'number'
    ? { 3: rawShare }
    : Object.fromEntries(Object.entries(rawShare || {}).map(([k, v]) => [k, Number(v) || 0]));
  const sharePct = Object.values(levelPct).reduce((a, b) => a + b, 0);

  const [ledger, setLedger] = useState<any>(null);
  const [pctDraft, setPctDraft] = useState<Record<string, string>>({});
  const [payFor, setPayFor] = useState<{ userId: string; name: string; period: string; suggested: number } | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');

  // '' means every month. Kept separate from the month LIST, which always covers
  // everything imported — otherwise choosing a month would leave the dropdown
  // holding only that month and there would be no way back.
  const [period, setPeriod] = useState('');
  const [allPeriods, setAllPeriods] = useState<string[]>([]);

  const load = async (p = period) => {
    setBusy(true);
    const q = p ? `&period=${encodeURIComponent(p)}` : '';
    try {
      const [s, r, l] = await Promise.all([
        authFetch(`/api/data?action=partner_summary${q}&_=${Date.now()}`, { cache: 'no-store' }),
        authFetch(`/api/data?action=partner_rows${q}&_=${Date.now()}`, { cache: 'no-store' }),
        authFetch(`/api/data?action=partner_ledger&partner=${partner}&_=${Date.now()}`, { cache: 'no-store' }),
      ]);
      if (s.ok) {
        const body = await s.json();
        setSummary(body);
        // An unfiltered call already lists every month, so take it from there and
        // save a round trip.
        if (!p) setAllPeriods((body.periods || []).map((x: any) => x.period));
      }
      if (r.ok) setRows(await r.json());
      if (l.ok) setLedger(await l.json());
      if (p) {
        const a = await authFetch(`/api/data?action=partner_summary&_=${Date.now()}`, { cache: 'no-store' });
        if (a.ok) setAllPeriods(((await a.json()).periods || []).map((x: any) => x.period));
      }
      if (canWrite) {
        const c = await authFetch(`/api/data?action=partner_codes&_=${Date.now()}`, { cache: 'no-store' });
        if (c.ok) setCodes(await c.json());
      }
    } catch {
      showToast('Could not load partner brokerage.', 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  // Changing the month refetches rather than filtering in the browser: the row
  // endpoint caps at 20,000 rows, so a client-side filter would quietly lie once
  // more than one month of statements is in.
  useEffect(() => { if (allPeriods.length) load(period); /* eslint-disable-next-line */ }, [period]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch('/api/parse-sheet', { method: 'POST', body: form });
      const j = await res.json();
      if (!j?.ok || !Array.isArray(j.jsonData) || j.jsonData.length < 2) {
        showToast('Could not read that file.', 'error');
        return;
      }
      const grid: string[][] = j.jsonData;
      const header = grid[0].map((h: any) => String(h ?? '').trim());
      const fmt = PARTNER_FORMATS.find(f => f.signature.every(sig => header.includes(sig)));
      if (!fmt) {
        showToast(
          `Unrecognised file. Expected a ${PARTNER_FORMATS.map(f => f.label).join(' or ')} statement ` +
          `(needs the columns ${PARTNER_FORMATS[0].signature.join(', ')}).`,
          'error');
        return;
      }
      const idx = (name: string) => header.indexOf(name);
      const cell = (r: string[], name: string) => {
        const i = idx(name);
        return i >= 0 ? String(r[i] ?? '').trim() : '';
      };

      const out: any[] = [];
      let skipped = 0;
      for (const r of grid.slice(1)) {
        if (!r || r.every(c => String(c ?? '').trim() === '')) continue;
        const tradeDate = parseTradeDate(cell(r, fmt.columns.tradeDate));
        const clientCode = cell(r, fmt.columns.clientCode);
        if (!tradeDate || !clientCode) { skipped++; continue; }
        const extra: Record<string, string> = {};
        for (const e of fmt.extra) { const v = cell(r, e); if (v) extra[e] = v; }
        out.push({
          clientCode,
          tradeDate,
          period: tradeDate.slice(0, 7),
          segment: cell(r, fmt.columns.segment),
          tradeCategory: cell(r, fmt.columns.tradeCategory),
          totalBrokerage: num(cell(r, fmt.columns.totalBrokerage)),
          ourShare: num(cell(r, fmt.columns.ourShare)),
          partnerShare: num(cell(r, fmt.columns.partnerShare)),
          product: extra['Product'] || '',
          parentProfile: extra['Parent Profile'] || '',
          extra,
        });
      }
      if (!out.length) { showToast('No usable rows in that file.', 'error'); return; }

      const save = await authFetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'partner_import',
          payload: { partner: fmt.code, fileName: file.name, rows: out },
        }),
      });
      const sj = await save.json();
      if (!save.ok) { showToast(sj?.error || 'Import failed.', 'error'); return; }
      showToast(
        `${fmt.label}: ${sj.written} row${sj.written !== 1 ? 's' : ''} imported` +
        (skipped ? `, ${skipped} skipped (no date or client code)` : '') +
        `. ${sj.unmapped} row${sj.unmapped !== 1 ? 's' : ''} await client mapping.`,
        'success');
      await load();
    } catch (e: any) {
      showToast(e?.message || 'Import failed.', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveMapping = async (clientCode: string, clientId: string) => {
    const client = clients.find(c => c.id === clientId);
    const res = await authFetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'partner_map',
        payload: { partner, pairs: [{ clientCode, clientId: clientId || null, label: client?.name || null }] },
      }),
    });
    const j = await res.json();
    if (!res.ok) { showToast(j?.error || 'Could not save the mapping.', 'error'); return; }
    showToast(
      clientId
        ? `${clientCode} → ${client?.name || clientId} · ${j.rowsTouched} row${j.rowsTouched !== 1 ? 's' : ''} re-attributed`
        : `${clientCode} unmapped · ${j.rowsTouched} row${j.rowsTouched !== 1 ? 's' : ''} detached`,
      'success');
    await load();
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const totals = summary?.totals;
  const myEarning = useMemo(() => {
    if (canWrite) return null;
    const ours = rows.reduce((a, r) => a + (Number(r.ourShare) || 0), 0);
    return ours * (sharePct / 100);
  }, [rows, sharePct, canWrite]);

  const filteredCodes = useMemo(() => {
    const q = codeSearch.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(c =>
      c.clientCode.toLowerCase().includes(q) ||
      (c.label || '').toLowerCase().includes(q));
  }, [codes, codeSearch]);

  const unmappedCount = codes.filter(c => !c.mappedClientId).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Partner Brokerage</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {canWrite
              ? 'Broking revenue from Motilal Oswal and other partners — separate from mutual fund trail.'
              : 'Broking revenue from your mapped clients.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load()}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-blue-400 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {canWrite && (
            <>
              <input
                ref={fileRef}
                id="partner-file"
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-lg shadow-blue-100 dark:shadow-none hover:bg-blue-700 transition flex items-center gap-1.5 disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" /> {uploading ? 'Reading…' : 'Upload statement'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Money ─────────────────────────────────────────────────────────── */}
      {/* Total = Mentor + Partner, exactly as the statement splits it: "Parent
          Sharing" is our side, "MOFSL Sharing" is theirs. Payout is the slice of
          OUR side that reaches people, so it is a part of Mentor, not a fifth
          number beside it. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Total brokerage" value={totals?.totalBrokerage} hint="what the partner billed" />
        <Tile
          label={canWrite ? 'Mentor brokerage' : 'Your clients’ share'}
          value={totals?.ourShare}
          accent
          hint={canWrite ? 'our side of the split, stated by the file' : "the firm's cut on your clients"}
        />
        <Tile label="Partner brokerage" value={totals?.partnerShare} hint={`retained by ${partner}`} />
        {canWrite
          ? <Tile
              label="Payout brokerage"
              value={(Number(totals?.ourShare) || 0) * (sharePct / 100)}
              hint={sharePct ? `${sharePct}% of mentor brokerage` : 'no sharing % set yet — set one below'}
            />
          : <Tile label="Your payout" value={myEarning ?? 0} accent hint={sharePct ? `${sharePct}% of your clients' share` : 'no sharing % set yet'} />}
      </div>

      {/* ── Month ─────────────────────────────────────────────────────────── */}
      {allPeriods.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="pb-month" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Month</label>
          <select
            id="pb-month"
            value={period}
            onChange={e => setPeriod(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-xs font-bold"
          >
            <option value="">All months</option>
            {allPeriods.map(p => <option key={p} value={p}>{prettyMonth(p)}</option>)}
          </select>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {period
              ? `${totals?.rows_ ?? 0} row${(totals?.rows_ ?? 0) !== 1 ? 's' : ''} from ${totals?.codes ?? 0} client code${(totals?.codes ?? 0) !== 1 ? 's' : ''}`
              : `${allPeriods.length} month${allPeriods.length !== 1 ? 's' : ''} imported · ${totals?.rows_ ?? 0} rows, ${totals?.codes ?? 0} codes`}
          </span>
        </div>
      )}

      {canWrite && (
        <div className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Sharing for {partner}
              </p>
              <p className="text-[11px] mt-1 max-w-3xl text-slate-500 dark:text-slate-400">
                The statement says what the firm earns; it says nothing about what reaches a person, because broking
                carries no level ladder of its own. Set a percentage against the hierarchy level that should be paid —
                most clients here sit at level 3 (RM) with their manager at level 4.
              </p>
              <div className="flex items-end gap-3 mt-3 flex-wrap">
                {[1, 2, 3, 4, 5, 6, 7].map(lv => (
                  <div key={lv}>
                    <label htmlFor={`pct-${lv}`} className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">
                      Level {lv}
                    </label>
                    <div className="relative">
                      <input
                        id={`pct-${lv}`}
                        type="number" min="0" max="100" step="0.5"
                        value={pctDraft[lv] ?? String(levelPct[lv] ?? '')}
                        onChange={e => setPctDraft(d => ({ ...d, [lv]: e.target.value }))}
                        className="w-20 pl-2 pr-5 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 tabular-nums"
                        placeholder="0"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">%</span>
                    </div>
                  </div>
                ))}
                <button
                  onClick={async () => {
                    const next: Record<string, number> = {};
                    for (const lv of [1, 2, 3, 4, 5, 6, 7]) {
                      const v = Number(pctDraft[lv] ?? levelPct[lv] ?? 0);
                      if (v > 0) next[lv] = v;
                    }
                    updateConfig({
                      ...globalConfig,
                      partnerSharing: { ...(globalConfig.partnerSharing || {}), [partner]: next },
                    });
                    setPctDraft({});
                    showToast(
                      Object.keys(next).length
                        ? `Saved — ${Object.entries(next).map(([l, v]) => `level ${l}: ${v}%`).join(', ')}.`
                        : 'Cleared — nobody is owed anything from this partner now.',
                      'success');
                    setTimeout(load, 400);
                  }}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Save sharing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {canWrite && unmappedCount > 0 && (
        <div className="rounded-xl border-2 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4 flex items-start gap-3">
          <Link2 className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-800 dark:text-red-300">
              {unmappedCount} client code{unmappedCount !== 1 ? 's are' : ' is'} not attached to a client yet.
            </p>
            <p className="text-[11px] text-red-700/90 dark:text-red-400/90 mt-1 max-w-3xl">
              The statement has no RM column — every row is one branch — so until a code is attached, nobody but an
              admin can see it and it reaches no payout. Attach them below; later imports of the same code then
              attribute themselves.
            </p>
          </div>
        </div>
      )}

      {/* ── By month ──────────────────────────────────────────────────────── */}
      <Panel title="By month">
        {!summary?.periods?.length
          ? <Empty>Nothing imported yet.</Empty>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <Head cols={['Partner', 'Month', 'Rows', 'Codes', 'Total brokerage', 'Mentor brokerage', 'Partner brokerage', 'Unmapped']} />
                <tbody>
                  {summary.periods.map((p: any) => (
                    <tr key={`${p.partner}-${p.period}`} className="border-b border-slate-100 dark:border-slate-700/50">
                      <Td>{p.partner}</Td>
                      <Td mono>{p.period}</Td>
                      <Td mono right>{p.rows_}</Td>
                      <Td mono right>{p.codes}</Td>
                      <Td mono right>₹{Number(p.totalBrokerage).toLocaleString('en-IN')}</Td>
                      <Td mono right bold>₹{Number(p.ourShare).toLocaleString('en-IN')}</Td>
                      <Td mono right>₹{Number(p.partnerShare).toLocaleString('en-IN')}</Td>
                      <Td mono right>
                        {p.unmappedRows > 0
                          ? <span className="text-red-600 dark:text-red-400 font-bold">{p.unmappedRows}</span>
                          : <span className="text-emerald-600 dark:text-emerald-400">0</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      {/* ── By segment ────────────────────────────────────────────────────── */}
      {!!summary?.segments?.length && (
        <Panel title="By segment">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <Head cols={['Partner', 'Segment', 'Rows', 'Total brokerage', 'Our share']} />
              <tbody>
                {summary.segments.map((s: any, i: number) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-slate-700/50">
                    <Td>{s.partner}</Td>
                    <Td mono>{String(s.segment || '—').trim()}</Td>
                    <Td mono right>{s.rows_}</Td>
                    <Td mono right>₹{Number(s.totalBrokerage).toLocaleString('en-IN')}</Td>
                    <Td mono right bold>₹{Number(s.ourShare).toLocaleString('en-IN')}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {canWrite && ledger?.unattributed?.total > 0 && (
        <div className="rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
              ₹{ledger.unattributed.total.toLocaleString('en-IN', { maximumFractionDigits: 2 })} reaches nobody,
              across {ledger.unattributed.clients} client{ledger.unattributed.clients !== 1 ? 's' : ''}.
            </p>
            <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 mt-1 max-w-3xl leading-relaxed">
              Those clients have no one sitting at a level you set a percentage against — hierarchies here are not
              uniform, so a client's RM can be at level 2 where another's is at level 3. The money stays with the
              firm rather than being owed to anyone. Either set a percentage for the levels those clients use, or
              fix the hierarchy on the clients page.
            </p>
          </div>
        </div>
      )}

      {/* ── Payout ledger ─────────────────────────────────────────────────── */}
      <Panel title={canWrite ? 'Payout ledger' : 'Your payout ledger'}>
        {!ledger?.people?.length
          ? (
            <Empty>
              {!ledger?.configured
                ? 'Set a sharing % above and the ledger fills in.'
                : canWrite
                  ? 'Nothing owed yet — attach client codes to clients and the earnings appear here.'
                  : 'Nothing owed to you from this partner yet.'}
            </Empty>
          )
          : (
            <>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-3 max-w-3xl">
                <b>Carried</b> is what is still owed once that month closes — an unpaid balance from July is still
                owed in August, so each month opens with the one before it built in. Pay a month in parts and the
                ledger adds the parts up.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <Head cols={canWrite
                    ? ['Person', 'Month', 'Earned', 'Paid', 'Carried', '']
                    : ['Month', 'Earned', 'Paid', 'Carried']} />
                  <tbody>
                    {ledger.people.map((p: any) => (
                      <React.Fragment key={p.userId}>
                        {p.months.map((m: any, i: number) => (
                          <tr key={`${p.userId}-${m.period}`} className="border-b border-slate-100 dark:border-slate-700/50">
                            {canWrite && (
                              <Td bold={i === 0}>
                                {i === 0
                                  ? <>{p.name}{p.level != null && <span className="text-slate-400 font-normal"> · L{p.level}</span>}</>
                                  : ''}
                              </Td>
                            )}
                            <Td mono>{m.period}</Td>
                            <Td mono right>₹{m.earned.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Td>
                            <Td mono right>₹{m.paid.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Td>
                            <Td mono right bold>
                              <span className={m.carried > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
                                ₹{m.carried.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                              </span>
                            </Td>
                            {canWrite && (
                              <td className="py-2 pr-4 text-right">
                                <button
                                  onClick={() => {
                                    setPayFor({ userId: p.userId, name: p.name, period: m.period, suggested: m.carried });
                                    setPayAmount(m.carried > 0 ? String(Math.round(m.carried * 100) / 100) : '');
                                    setPayRef('');
                                  }}
                                  className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600 transition"
                                >
                                  Record payment
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {canWrite && (
                          <tr className="border-b-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">
                            <Td bold>{p.name} — total</Td>
                            <Td />
                            <Td mono right bold>₹{p.totalEarned.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Td>
                            <Td mono right bold>₹{p.totalPaid.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Td>
                            <Td mono right bold>
                              <span className={p.outstanding > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
                                ₹{p.outstanding.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                              </span>
                            </Td>
                            <Td />
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </Panel>

      {/* Record-a-payment dialog */}
      {payFor && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setPayFor(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 dark:text-slate-100">Record a payment</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {payFor.name} · {payFor.period} · outstanding ₹{payFor.suggested.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </p>
            <label htmlFor="pay-amount" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-4 mb-1">Amount paid</label>
            <input
              id="pay-amount" type="number" step="0.01" value={payAmount}
              onChange={e => setPayAmount(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 tabular-nums"
              placeholder="0.00"
            />
            <label htmlFor="pay-ref" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-3 mb-1">Reference <span className="font-normal normal-case tracking-normal">(optional)</span></label>
            <input
              id="pay-ref" value={payRef} onChange={e => setPayRef(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              placeholder="UTR / cheque no."
            />
            <div className="flex gap-2 mt-5">
              <button onClick={() => setPayFor(null)} className="flex-1 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
              <button
                onClick={async () => {
                  const amt = Number(payAmount);
                  if (!Number.isFinite(amt) || amt === 0) { showToast('Enter an amount.', 'warning'); return; }
                  const res = await authFetch('/api/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'partner_pay',
                      payload: { partner, period: payFor.period, userId: payFor.userId, amount: amt, reference: payRef || null },
                    }),
                  });
                  const j = await res.json();
                  if (!res.ok) { showToast(j?.error || 'Could not record the payment.', 'error'); return; }
                  showToast(`₹${amt.toLocaleString('en-IN')} recorded for ${payFor.name} · ${payFor.period}.`, 'success');
                  setPayFor(null);
                  await load();
                }}
                className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition"
              >
                Record
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mapping ───────────────────────────────────────────────────────── */}
      {canWrite && (
        <Panel
          title="Client codes"
          action={
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="partner-code-search"
                value={codeSearch}
                onChange={e => setCodeSearch(e.target.value)}
                placeholder="Search code or client…"
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 w-56"
              />
            </div>
          }
        >
          {!filteredCodes.length
            ? <Empty>No client codes yet.</Empty>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <Head cols={['Code', 'Rows', 'Months', 'Our share', 'Attached to']} />
                  <tbody>
                    {filteredCodes.map(c => (
                      <tr key={`${c.partner}-${c.clientCode}`} className="border-b border-slate-100 dark:border-slate-700/50">
                        <Td mono bold>{c.clientCode}</Td>
                        <Td mono right>{c.rows_}</Td>
                        <Td mono>{c.firstPeriod === c.lastPeriod ? c.firstPeriod : `${c.firstPeriod} → ${c.lastPeriod}`}</Td>
                        <Td mono right bold>₹{Number(c.ourShare).toLocaleString('en-IN')}</Td>
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <select
                              id={`map-${c.clientCode}`}
                              value={pick[c.clientCode] ?? c.mappedClientId ?? ''}
                              onChange={e => setPick(p => ({ ...p, [c.clientCode]: e.target.value }))}
                              className="text-xs rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 px-2 py-1.5 max-w-[260px]"
                            >
                              <option value="">— not attached —</option>
                              {clients.map(cl => (
                                <option key={cl.id} value={cl.id}>{cl.name}{cl.pan ? ` · ${cl.pan}` : ''}</option>
                              ))}
                            </select>
                            {(pick[c.clientCode] ?? c.mappedClientId ?? '') !== (c.mappedClientId ?? '') && (
                              <button
                                onClick={() => saveMapping(c.clientCode, pick[c.clientCode] ?? '')}
                                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 transition flex items-center gap-1"
                              >
                                <Check className="w-3 h-3" /> Save
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Panel>
      )}

      {/* ── Rows ──────────────────────────────────────────────────────────── */}
      <Panel title={canWrite ? 'Statement rows' : 'Your rows'}>
        {!rows.length
          ? <Empty>{canWrite ? 'Nothing imported yet.' : 'None of your clients have broking activity yet.'}</Empty>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <Head cols={['Date', 'Code', 'Client', 'Segment', 'Category', 'Total', 'Our share', ...(canWrite ? [] : ['Your payout'])]} />
                <tbody>
                  {rows.slice(0, 500).map(r => {
                    const client = r.mappedClientId ? clients.find(c => c.id === r.mappedClientId) : null;
                    return (
                      <tr key={r.id} className="border-b border-slate-100 dark:border-slate-700/50">
                        <Td mono>{String(r.tradeDate || '').slice(0, 10)}</Td>
                        <Td mono>{r.clientCode}</Td>
                        <Td>{client?.name || <span className="text-red-500 text-xs font-bold">unattached</span>}</Td>
                        <Td mono>{String(r.segment || '').trim()}</Td>
                        <Td mono>{r.tradeCategory}</Td>
                        <Td mono right>₹{Number(r.totalBrokerage).toLocaleString('en-IN')}</Td>
                        <Td mono right bold>₹{Number(r.ourShare).toLocaleString('en-IN')}</Td>
                        {!canWrite && (
                          <Td mono right bold>
                            {sharePct
                              ? `₹${(Number(r.ourShare) * sharePct / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                              : '—'}
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 500 && (
                <p className="text-[11px] text-slate-400 mt-3">
                  Showing the 500 most recent of {rows.length.toLocaleString()} rows. The totals above cover all of them.
                </p>
              )}
            </div>
          )}
      </Panel>
    </div>
  );
};

// ── Small presentational helpers ──────────────────────────────────────────────
const Tile: React.FC<{ label: string; value: any; hint?: string; accent?: boolean; raw?: boolean }> =
({ label, value, hint, accent, raw }) => (
  <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className={`text-2xl font-black mt-1 tabular-nums ${accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-slate-100'}`}>
      {value == null ? '—' : raw ? Number(value).toLocaleString('en-IN') : formatCompactINR(Number(value))}
    </p>
    {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
  </div>
);

const Panel: React.FC<{ title: string; action?: React.ReactNode; children: React.ReactNode }> =
({ title, action, children }) => (
  <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
      <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm flex items-center gap-2">
        <Landmark className="w-4 h-4 text-slate-400" /> {title}
      </h3>
      {action}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

const Head: React.FC<{ cols: string[] }> = ({ cols }) => (
  <thead>
    <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-200 dark:border-slate-700">
      {cols.map((c, i) => (
        <th key={c} className={`pb-2 pr-4 ${i >= 2 && /share|total|rows|codes|payout|unmapped/i.test(c) ? 'text-right' : 'text-left'}`}>{c}</th>
      ))}
    </tr>
  </thead>
);

const Td: React.FC<{ children?: React.ReactNode; mono?: boolean; right?: boolean; bold?: boolean }> =
({ children, mono, right, bold }) => (
  <td className={`py-2 pr-4 ${mono ? 'font-mono text-xs tabular-nums' : ''} ${right ? 'text-right' : ''} ${bold ? 'font-bold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>
    {children}
  </td>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-sm text-slate-400 py-6 text-center">{children}</p>
);
