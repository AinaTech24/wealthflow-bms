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

interface CodeRow {
  partner: string; clientCode: string; rows_: number;
  firstPeriod: string; lastPeriod: string; ourShare: number;
  mappedClientId: string | null; label: string | null;
}

export const PartnerBrokerage: React.FC<Props> = ({ currentUser }) => {
  const { clients, globalConfig } = useData();
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
  const sharePct = Number(globalConfig?.partnerSharing?.[partner] ?? 0);

  const load = async () => {
    setBusy(true);
    try {
      const [s, r] = await Promise.all([
        authFetch(`/api/data?action=partner_summary&_=${Date.now()}`, { cache: 'no-store' }),
        authFetch(`/api/data?action=partner_rows&_=${Date.now()}`, { cache: 'no-store' }),
      ]);
      if (s.ok) setSummary(await s.json());
      if (r.ok) setRows(await r.json());
      if (canWrite) {
        const c = await authFetch(`/api/data?action=partner_codes&_=${Date.now()}`, { cache: 'no-store' });
        if (c.ok) setCodes(await c.json());
      }
    } catch {
      showToast('Could not load partner brokerage.', 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

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
            onClick={load}
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Total brokerage" value={totals?.totalBrokerage} hint="what the partner billed" />
        <Tile label={canWrite ? 'Our share' : 'Your clients’ share'} value={totals?.ourShare} accent hint="the firm's cut, stated by the file" />
        {canWrite
          ? <Tile label="Partner's share" value={totals?.partnerShare} hint="retained by the partner" />
          : <Tile label="Your payout" value={myEarning ?? 0} accent hint={sharePct ? `${sharePct}% of your clients' share` : 'no sharing % set yet'} />}
        <Tile label="Rows" value={totals?.rows_} raw hint={`${totals?.codes ?? 0} client code${(totals?.codes ?? 0) !== 1 ? 's' : ''}`} />
      </div>

      {canWrite && sharePct === 0 && (
        <div className="rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
              No sharing % is set for {partner}, so no RM sees a payout from this yet.
            </p>
            <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 mt-1 max-w-3xl">
              The statement says what the firm earns, but not what reaches an RM — broking carries no level ladder of
              its own. Set that percentage in Admin Console → Sharing, and every mapped client's rows start
              reporting a payout.
            </p>
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
                <Head cols={['Partner', 'Month', 'Rows', 'Codes', 'Total brokerage', 'Our share', 'Partner share', 'Unmapped']} />
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

const Td: React.FC<{ children: React.ReactNode; mono?: boolean; right?: boolean; bold?: boolean }> =
({ children, mono, right, bold }) => (
  <td className={`py-2 pr-4 ${mono ? 'font-mono text-xs tabular-nums' : ''} ${right ? 'text-right' : ''} ${bold ? 'font-bold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>
    {children}
  </td>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-sm text-slate-400 py-6 text-center">{children}</p>
);
