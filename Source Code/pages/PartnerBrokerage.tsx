import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Upload, Link2, AlertTriangle, Landmark, Search, Check, RefreshCw, Download } from 'lucide-react';
import { exportSheetsToExcel } from '../utils/excelExport';
import { TeamMember, Role } from '../types';
import { useData, authFetch } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { labelFor } from '../utils/payoutSources';

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
  /** A statement that is not a daily trade list (e.g. one line per customer per month) reads itself. */
  parse?: (grid: string[][], header: string[]) => { rows: any[]; skipped: number };
}

// "2026-06" | "Jun 2026" | "01/06/2026" -> "2026-06"
function monthOf(raw: string): string | null {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const m = s.match(/^([A-Za-z]{3})[a-z]*[\s-]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}`;
  // A CSV month like "2026-09" comes back from the sheet reader as a US-style short date ("9/1/26").
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (us) { const a1 = Number(us[1]), b1 = Number(us[2]); const mo = a1 <= 12 ? a1 : b1; if (mo >= 1 && mo <= 12) return `20${us[3]}-${String(mo).padStart(2, '0')}`; }
  const d = parseTradeDate(s);
  return d ? d.slice(0, 7) : null;
}
const lastDayOf = (period: string) => { const [y, mo] = period.split('-').map(Number); return `${period}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };

// Volt Money: one line per customer per month, upfront + trail, and the invoice total the firm raises.
// There is no client code, so the customer NAME is the code; it is matched to a client by name.
function parseVolt(grid: string[][], header: string[]) {
  const at = (n: string) => header.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const iM = at('Month'), iN = at('Customer name'), iU = at('Upfront amount'), iT = at('Trail amount'), iTot = at('Total invoice amount');
  const rows: any[] = []; let skipped = 0;
  for (const r of grid.slice(1)) {
    if (!r || r.every(c => String(c ?? '').trim() === '')) continue;
    const period = monthOf(String(r[iM] ?? '')) || '';
    const name = String(r[iN] ?? '').replace(/\s+/g, ' ').trim();
    if (!name) { skipped++; continue; }
    const up = num(r[iU]), tr = num(r[iT]), tot = num(r[iTot]);
    const parts = ([['UPFRONT', up], ['TRAIL', tr]] as [string, number][]).filter(([, v]) => v !== 0);
    if (!parts.length && tot !== 0) parts.push(['TOTAL', tot]);
    for (const [cat, amt] of parts) {
      rows.push({
        clientCode: name.toUpperCase(), tradeDate: period ? lastDayOf(period) : '', period, segment: 'Volt Money', tradeCategory: cat,
        totalBrokerage: amt, ourShare: amt, partnerShare: 0, product: '', parentProfile: '',
        extra: { clientName: name, 'Customer name': name },
      });
    }
  }
  return { rows, skipped };
}

// A partner whose layout was taught on screen: which column is the client, which is the firm's amount, and
// (optionally) which is the month. One line per client per month, the amount is what the firm earned.
interface CustomFormat { partner: string; label: string; clientCol: string; amountCol: string; monthCol?: string }
const plainNum = (v: any) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
function customToFormat(cf: CustomFormat, fixedMonth = ''): PartnerFormat {
  return {
    code: cf.partner, label: cf.label, signature: [cf.clientCol, cf.amountCol],
    columns: { clientCode: cf.clientCol, tradeDate: cf.monthCol || '', segment: '', tradeCategory: '', totalBrokerage: cf.amountCol, ourShare: cf.amountCol, partnerShare: '' },
    extra: [],
    parse: (grid, header) => {
      const iC = header.indexOf(cf.clientCol), iA = header.indexOf(cf.amountCol), iM = cf.monthCol ? header.indexOf(cf.monthCol) : -1;
      const rows: any[] = []; let skipped = 0;
      for (const r of grid.slice(1)) {
        if (!r || r.every(c => String(c ?? '').trim() === '')) continue;
        const name = String(r[iC] ?? '').replace(/\s+/g, ' ').trim();
        const amt = plainNum(r[iA]);
        if (!name) { skipped++; continue; }
        if (amt === 0) continue;
        const period = fixedMonth || (iM >= 0 ? monthOf(String(r[iM] ?? '')) || '' : '');
        rows.push({
          clientCode: name.toUpperCase(), tradeDate: period ? lastDayOf(period) : '', period, segment: cf.label, tradeCategory: 'EARNING',
          totalBrokerage: amt, ourShare: amt, partnerShare: 0, product: '', parentProfile: '', extra: { clientName: name },
        });
      }
      return { rows, skipped };
    },
  };
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
  {
    code: 'VOLT',
    label: 'Volt Money — Earnings report',
    signature: ['Customer name', 'Total invoice amount'],
    columns: { clientCode: 'Customer name', tradeDate: 'Month', segment: '', tradeCategory: '', totalBrokerage: 'Total invoice amount', ourShare: 'Total invoice amount', partnerShare: '' },
    extra: [],
    parse: parseVolt,
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
  firstPeriod: string | null; lastPeriod: string | null; ourShare: number;
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

  // Which partner's statements are on screen. Every partner that has imported a file is in the dropdown.
  const [partner, setPartner] = useState('MOFSL');
  const [partnerList, setPartnerList] = useState<string[]>(PARTNER_FORMATS.map(f => f.code));
  const [customFormats, setCustomFormats] = useState<CustomFormat[]>([]);
  const labelOfPartner = (c: string) => customFormats.find(f => f.partner === c)?.label || labelFor(c);
  const partnerName = labelOfPartner(partner);

  // Popups the upload can raise: which month a file is for, and what an unrecognised file's columns mean.
  const [monthAsk, setMonthAsk] = useState<{ message: string; resolve: (m: string | null) => void } | null>(null);
  const [monthPick, setMonthPick] = useState('');
  const askMonth = (message: string) => new Promise<string | null>(resolve => { setMonthPick(''); setMonthAsk({ message, resolve }); });
  const [setup, setSetup] = useState<{ fileName: string; header: string[]; grid: string[][]; resolve: (f: PartnerFormat | null) => void } | null>(null);
  const [setupForm, setSetupForm] = useState({ name: '', clientCol: '', amountCol: '', monthMode: 'column', monthCol: '', fixedMonth: '' });
  const askSetup = (fileName: string, header: string[], grid: string[][]) => new Promise<PartnerFormat | null>(resolve => {
    const guess = (re: RegExp, not = '') => header.find(h => re.test(h) && h !== not) || '';
    const clientCol = guess(/client|customer|name|code|investor|pan/i);
    const amountCol = guess(/total|amount|brok|commission|earning|earned|payout|revenue|income|fee/i, clientCol);
    const monthCol = guess(/month|period|date/i, clientCol);
    setSetupForm({ name: '', clientCol, amountCol, monthMode: monthCol ? 'column' : 'fixed', monthCol, fixedMonth: '' });
    setSetup({ fileName, header, grid, resolve });
  });
  const [settleMonth, setSettleMonth] = useState('');
  const [ledger, setLedger] = useState<any>(null);
  const [payFor, setPayFor] = useState<{ userId: string; name: string; period: string; suggested: number } | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');

  // '' means every month. Kept separate from the month LIST, which always covers
  // everything imported — otherwise choosing a month would leave the dropdown
  // holding only that month and there would be no way back.
  const [period, setPeriod] = useState('');
  const [allPeriods, setAllPeriods] = useState<string[]>([]);

  const load = async (p = period, pr = partner) => {
    setBusy(true);
    const q = (p ? `&period=${encodeURIComponent(p)}` : '') + `&partner=${encodeURIComponent(pr)}`;
    try {
      const [s, r, l] = await Promise.all([
        authFetch(`/api/data?action=partner_summary${q}&_=${Date.now()}`, { cache: 'no-store' }),
        authFetch(`/api/data?action=partner_rows${q}&_=${Date.now()}`, { cache: 'no-store' }),
        authFetch(`/api/data?action=partner_ledger&partner=${pr}&_=${Date.now()}`, { cache: 'no-store' }),
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
        const a = await authFetch(`/api/data?action=partner_summary&partner=${encodeURIComponent(pr)}&_=${Date.now()}`, { cache: 'no-store' });
        if (a.ok) setAllPeriods(((await a.json()).periods || []).map((x: any) => x.period));
      }
      if (canWrite) {
        const c = await authFetch(`/api/data?action=partner_codes&partner=${encodeURIComponent(pr)}&period=${encodeURIComponent(p || '')}&_=${Date.now()}`, { cache: 'no-store' });
        if (c.ok) setCodes(await c.json());
      }
    } catch {
      showToast('Could not load partner brokerage.', 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await authFetch(`/api/data?action=partner_summary&_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const have = ((await r.json()).periods || []).map((x: any) => String(x.partner));
        setPartnerList(prev => [...new Set([...prev, ...have])]);
        if (canWrite) {
          const f = await authFetch(`/api/data?action=partner_formats&_=${Date.now()}`, { cache: 'no-store' });
          if (f.ok) { const list: CustomFormat[] = await f.json(); setCustomFormats(list); setPartnerList(prev => [...new Set([...prev, ...list.map(x => x.partner)])]); }
        }
      } catch { /* the registry list is enough */ }
    })();
  }, []);
  useEffect(() => { setSettleMonth(ledger?.settledThrough || ''); }, [ledger]);
  const choosePartner = (code: string) => { setPartner(code); setPeriod(''); setPick({}); setCodeSearch(''); load('', code); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  // Changing the month refetches rather than filtering in the browser: the row
  // endpoint caps at 20,000 rows, so a client-side filter would quietly lie once
  // more than one month of statements is in.
  useEffect(() => { if (allPeriods.length) load(period); /* eslint-disable-next-line */ }, [period]);

  // ── Export: every month on its own sheet, plus the RM / BM wise figures ─────────────
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await authFetch(`/api/data?action=partner_export&partner=${partner}&_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { showToast('Could not build the export.', 'error'); return; }
      const d = await res.json();
      const lines: any[] = d.lines || [];
      if (!lines.length) { showToast('Nothing to export yet.', 'error'); return; }
      const monthLabel = (p: string) => { const dt = new Date(`${p}-01T00:00:00`); return Number.isNaN(dt.getTime()) ? p : dt.toLocaleString('en-IN', { month: 'short', year: 'numeric' }); };
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const months = [...new Set(lines.map(l => l.period))].sort();
      const sheets: { name: string; rows: object[] }[] = [];
      sheets.push({
        name: 'Summary',
        rows: months.map(m => {
          const ls = lines.filter(l => l.period === m);
          const pay = (d.people || []).filter((x: any) => x.period === m).reduce((a: number, x: any) => a + x.payout, 0);
          return { Month: monthLabel(m), 'Client codes': new Set(ls.map(l => l.clientCode)).size, 'Total brokerage': round2(ls.reduce((a, l) => a + l.total, 0)), 'Our share': round2(ls.reduce((a, l) => a + l.ourShare, 0)), 'Paid to RM/BM (at the set %)': round2(pay) };
        }),
      });
      for (const m of months) {
        sheets.push({
          name: monthLabel(m),
          rows: lines.filter(l => l.period === m).map(l => ({
            'Client code': l.clientCode, [`Name (${partnerName})`]: l.motilalName, 'WealthFlow client': l.client || '(not attached)',
            'L1 RM': l.l1, 'L2 RM': l.l2, 'L3 RM': l.l3, 'L4 BM': l.l4, L5: l.l5, L6: l.l6, L7: l.l7,
            Type: l.category === 'TRD' ? 'Trading' : l.category === 'DEL' ? 'Delivery' : l.category,
            'Total brokerage': round2(l.total), 'Our share': round2(l.ourShare),
          })),
        });
      }
      sheets.push({
        name: 'RM-BM wise',
        // Upline (L5 and above) with no payout only repeats every client, so leave them out.
        rows: (d.people || []).filter((x: any) => x.payout !== 0 || (x.level != null && x.level <= 4)).map((x: any) => ({
          Month: monthLabel(x.period), Person: x.name, Level: x.level == null ? '' : `L${x.level}`, Clients: x.clients,
          'Our share on their clients': x.ourShare, 'Payout (at the set %)': x.payout,
        })),
      });
      await exportSheetsToExcel(sheets, `${partner.toLowerCase()}-brokerage-${new Date().toISOString().slice(0, 10)}`);
      showToast(`Exported ${months.length} month${months.length !== 1 ? 's' : ''}.`, 'success');
    } catch { showToast('Could not build the export.', 'error'); } finally { setExporting(false); }
  };

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
      let fmt: PartnerFormat | undefined = PARTNER_FORMATS.find(f => f.signature.every(sig => header.includes(sig)));
      if (!fmt) {
        const taught = customFormats.find(f => header.includes(f.clientCol) && header.includes(f.amountCol));
        if (taught) fmt = customToFormat(taught);
      }
      if (!fmt) {
        // Nothing matches: ask what the columns mean instead of refusing the file.
        const made = await askSetup(file.name, header, grid);
        if (!made) return;
        fmt = made;
      }
      const idx = (name: string) => header.indexOf(name);
      const cell = (r: string[], name: string) => {
        const i = idx(name);
        return i >= 0 ? String(r[i] ?? '').trim() : '';
      };

      let out: any[] = [];
      let skipped = 0;
      if (fmt.parse) { const pr = fmt.parse(grid, header); out = pr.rows; skipped = pr.skipped; }
      else for (const r of grid.slice(1)) {
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
      // Lines with no month of their own: ask which month the file is for.
      const undated = out.filter(r => !r.period).length;
      if (undated) {
        const m = await askMonth(`${undated} line${undated !== 1 ? 's have' : ' has'} no month in this file. Which month is it for?`);
        if (!m) { showToast('Upload cancelled — no month chosen.', 'warning'); return; }
        for (const r of out) if (!r.period) { r.period = m; r.tradeDate = lastDayOf(m); }
      }

      const save = await authFetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'partner_import',
          payload: { partner: fmt!.code, fileName: file.name, rows: out },
        }),
      });
      const sj = await save.json();
      if (!save.ok) { showToast(sj?.error || 'Import failed.', 'error'); return; }
      showToast(
        `${fmt!.label}: ${sj.written} row${sj.written !== 1 ? 's' : ''} imported` +
        (skipped ? `, ${skipped} skipped (no month/date or client)` : '') +
        (sj.replaced ? `. Replaced ${sj.replaced} earlier row${sj.replaced !== 1 ? 's' : ''} for the same month` : '') +
        `. ${sj.unmapped} row${sj.unmapped !== 1 ? 's' : ''} await client mapping.`,
        'success');
      setPartnerList(prev => [...new Set([...prev, fmt!.code])]);
      setPartner(fmt!.code); setPeriod('');
      await load('', fmt!.code);
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
  // What the mutual-fund rule pays out of this partner's share, for the month on screen (or all months).
  const ledgerTotal = useMemo(() => {
    let t = 0;
    for (const person of (ledger?.people || [])) for (const m of (person.months || [])) if (!period || m.period === period) t += Number(m.earned) || 0;
    return t;
  }, [ledger, period]);
  const myEarning = canWrite ? null : ledgerTotal;

  const inr2 = (n: number) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  // One row per person: the selected month, or every month added up when none is selected.
  const ledgerRows = useMemo(() => {
    const out: any[] = [];
    for (const person of (ledger?.people || [])) {
      const ms = (person.months || []).filter((x: any) => !period || x.period === period);
      if (!ms.length) continue;
      const sum = (k: string) => ms.reduce((a: number, x: any) => a + (Number(x[k]) || 0), 0);
      out.push({
        userId: person.userId, name: person.name, level: person.level,
        carriedIn: Number(ms[0].carriedIn) || 0, earned: sum('earned'), gst: sum('gst'), tds: sum('tds'), payable: sum('payable'), paid: sum('paid'),
        carried: Number(ms[ms.length - 1].carried) || 0, lastPeriod: ms[ms.length - 1].period,
      });
    }
    return out.filter(r => r.earned !== 0 || r.paid !== 0 || r.carriedIn !== 0).sort((x, y) => y.carried - x.carried || y.earned - x.earned);
  }, [ledger, period]);
  const ledgerSum = useMemo(() => ledgerRows.reduce((a: any, r: any) => ({
    carriedIn: a.carriedIn + r.carriedIn, earned: a.earned + r.earned, gst: a.gst + r.gst, tds: a.tds + r.tds,
    payable: a.payable + r.payable, paid: a.paid + r.paid, carried: a.carried + r.carried,
  }), { carriedIn: 0, earned: 0, gst: 0, tds: 0, payable: 0, paid: 0, carried: 0 }), [ledgerRows]);


  const filteredCodes = useMemo(() => {
    const q = codeSearch.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(c =>
      c.clientCode.toLowerCase().includes(q) ||
      (c.label || '').toLowerCase().includes(q));
  }, [codes, codeSearch]);

  const unmappedCount = codes.filter(c => !c.mappedClientId && c.rows_ > 0).length;

  // Motilal's client sheet gives each code a name. When exactly one of our clients has
  // that name (case, spaces and punctuation ignored) it is pre-selected in the dropdown;
  // nothing is saved until Save is pressed.
  const suggestionFor = useMemo(() => {
    const norm = (v: string) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const byName = new Map<string, string[]>();
    for (const cl of clients) { const k = norm(cl.name); if (!k) continue; byName.set(k, [...(byName.get(k) || []), cl.id]); }
    return (label: string | null) => { const ids = label ? byName.get(norm(label)) : null; return ids && ids.length === 1 ? ids[0] : ''; };
  }, [clients]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Partner Brokerage</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {canWrite
              ? 'Broking and partner revenue (Motilal Oswal, Volt Money and others) — each partner on its own, separate from mutual fund trail.'
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
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center gap-1.5 hover:border-emerald-400 hover:text-emerald-600 transition disabled:opacity-60"
            title="Download every month, one sheet per month"
          >
            <Download className="w-3.5 h-3.5" /> {exporting ? 'Preparing…' : 'Export'}
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
        <Tile label="Partner brokerage" value={totals?.partnerShare} hint={`retained by ${partnerName}`} />
        {canWrite
          ? <Tile
              label="Payout brokerage"
              value={ledgerTotal}
              hint="paid to RMs and BMs by the mutual-fund rule"
            />
          : <Tile label="Your payout" value={myEarning ?? 0} accent hint="by the mutual-fund rule, on your clients" />}
      </div>

      {/* ── Partner / Month ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <label htmlFor="pb-partner" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Partner</label>
        <select
          id="pb-partner"
          value={partner}
          onChange={e => choosePartner(e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-xs font-bold"
        >
          {partnerList.map(p => <option key={p} value={p}>{labelOfPartner(p)}</option>)}
        </select>
      </div>
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
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100">How {partnerName} is paid out</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
            The statement gives the firm&rsquo;s share (&ldquo;mentor brokerage&rdquo;). That share is split across each client&rsquo;s RM and BM exactly as mutual funds are:
            the company&rsquo;s % comes off first (an L5 or L6 takes its 5% out of it), the RMs take their own %, and the BM &mdash; or whoever is first above
            when there is no L4 &mdash; takes what is left. The chain used is the one that applied in the statement&rsquo;s month, and a locked month stays as it was paid.
            A client code that is not attached to a client reaches nobody until you attach it below.
          </p>
        </div>
      )}

      {canWrite && unmappedCount > 0 && (
        <div className="rounded-xl border-2 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4 flex items-start gap-3">
          <Link2 className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-red-800 dark:text-red-300">
              {unmappedCount} client{unmappedCount !== 1 ? 's are' : ' is'} still missing mapping — {partnerName} money for {unmappedCount !== 1 ? 'them' : 'this client'} reaches no RM or BM yet.
            </p>
            <p className="text-[11px] text-red-700/90 dark:text-red-400/90 mt-1 max-w-3xl">
              Attach each one to a client in <b>Client codes</b> below. The moment you do, the amount shows under that client&rsquo;s RM and BM (their dashboard and the Payouts page) for every month it was earned.
            </p>
            <ul className="mt-2 text-[11px] text-red-800 dark:text-red-300 space-y-0.5">
              {codes.filter(c => !c.mappedClientId && c.rows_ > 0).sort((a, b) => b.ourShare - a.ourShare).slice(0, 8).map(c => (
                <li key={c.clientCode} className="font-mono">{c.label || c.clientCode}{c.label && c.label !== c.clientCode ? ` (${c.clientCode})` : ''} — ₹{Number(c.ourShare).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</li>
              ))}
              {unmappedCount > 8 && <li>…and {unmappedCount - 8} more</li>}
            </ul>
          </div>
        </div>
      )}
      {canWrite && (ledger?.noChain || []).length > 0 && (
        <div className="rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
              {(ledger.noChain as any[]).length} attached client{(ledger.noChain as any[]).length !== 1 ? 's have' : ' has'} no RM or BM above {(ledger.noChain as any[]).length !== 1 ? 'them' : 'it'}.
            </p>
            <p className="text-[11px] text-amber-800/90 dark:text-amber-400/90 mt-1 max-w-3xl">Their {partnerName} money reaches nobody. Set the RM/BM on Clients &amp; Map, then press Recalculate.</p>
            <ul className="mt-2 text-[11px] text-amber-900 dark:text-amber-300 space-y-0.5">
              {(ledger.noChain as any[]).slice(0, 8).map((n: any) => <li key={n.clientId} className="font-mono">{n.name} — ₹{Number(n.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</li>)}
            </ul>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 flex items-center gap-3 flex-wrap">
          <p className="text-xs text-slate-600 dark:text-slate-300 max-w-xl">
            <b>Already paid:</b> partner payouts for every month up to this one are treated as paid in full (still owed ₹0). Months after it are owed until a payment is recorded.
          </p>
          <input type="month" value={settleMonth} onChange={e => setSettleMonth(e.target.value)} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-xs font-bold" />
          <button
            onClick={async () => {
              const res = await authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'partner_settled_through', payload: { period: settleMonth || null } }) });
              const j = await res.json();
              if (!res.ok) { showToast(j?.error || 'Could not save.', 'error'); return; }
              showToast(settleMonth ? `Partner payouts up to ${prettyMonth(settleMonth)} now show as paid.` : 'Cleared — nothing is treated as paid automatically.', 'success');
              await load();
            }}
            className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition"
          >Save</button>
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
        {!ledgerRows.length
          ? (
            <Empty>
              {canWrite
                ? (period ? 'Nothing owed for this month — attach client codes to clients and the earnings appear here.' : 'Nothing owed yet — attach client codes to clients and the earnings appear here.')
                : 'Nothing owed to you from this partner for this period.'}
            </Empty>
          )
          : (
            <>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-3 max-w-3xl">
                {period ? <>Showing <b>{period}</b>.</> : <>Showing <b>all months</b> added up per person — pick a month above to see just that month.</>}
                {' '}<b>Brought fwd</b> is what was still owed when {period ? 'the month' : 'the first month'} opened and <b>Still owed</b> is what is
                owed after it. GST, TDS and the cheque are <span className="text-amber-600 font-black">estimates</span> on {partnerName}&rsquo;s earnings at the
                configured rates. Pay a month in parts and the ledger adds the parts up.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <Head cols={[...(canWrite ? ['Person'] : []), 'Month', 'Brought fwd', 'Earned', 'GST', 'TDS', 'Payable', 'Paid', 'Still owed', ...(canWrite ? [''] : [])]} />
                  <tbody>
                    {ledgerRows.map((r: any) => (
                      <tr key={r.userId} className="border-b border-slate-100 dark:border-slate-700/50">
                        {canWrite && (
                          <Td bold>{r.name}{r.level != null && <span className="text-slate-400 font-normal"> · L{r.level}</span>}</Td>
                        )}
                        <Td mono>{period || 'All months'}</Td>
                        <Td mono right><span className="text-slate-400">{inr2(r.carriedIn)}</span></Td>
                        <Td mono right bold>{inr2(r.earned)}</Td>
                        <Td mono right><span className="text-slate-400">{inr2(r.gst)}</span></Td>
                        <Td mono right><span className="text-slate-400">{inr2(r.tds)}</span></Td>
                        <Td mono right bold>{inr2(r.payable)} <span className="text-[9px] font-black uppercase tracking-widest text-amber-600">est</span></Td>
                        <Td mono right><span className="text-emerald-600 dark:text-emerald-400">{inr2(r.paid)}</span></Td>
                        <Td mono right bold>
                          <span className={r.carried > 0.005 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>{inr2(r.carried)}</span>
                        </Td>
                        {canWrite && (
                          <td className="py-2 pr-4 text-right">
                            <button
                              title={period ? undefined : `Recorded against ${r.lastPeriod}, the latest month`}
                              onClick={() => {
                                setPayFor({ userId: r.userId, name: r.name, period: r.lastPeriod, suggested: r.carried });
                                setPayAmount(r.carried > 0 ? String(Math.round(r.carried * 100) / 100) : '');
                                setPayRef('');
                              }}
                              className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600 transition whitespace-nowrap"
                            >
                              Record payment
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                    <tr className="bg-slate-50 dark:bg-slate-900/40">
                      <Td bold>Total</Td>
                      {canWrite && <Td />}
                      <Td mono right>{inr2(ledgerSum.carriedIn)}</Td>
                      <Td mono right bold>{inr2(ledgerSum.earned)}</Td>
                      <Td mono right>{inr2(ledgerSum.gst)}</Td>
                      <Td mono right>{inr2(ledgerSum.tds)}</Td>
                      <Td mono right bold>{inr2(ledgerSum.payable)}</Td>
                      <Td mono right>{inr2(ledgerSum.paid)}</Td>
                      <Td mono right bold>{inr2(ledgerSum.carried)}</Td>
                      {canWrite && <Td />}
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
      </Panel>

      {/* Which month is this file for? */}
      {monthAsk && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 w-full max-w-sm">
            <h3 className="font-bold text-slate-900 dark:text-slate-100">Which month is this file for?</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{monthAsk.message}</p>
            <input type="month" value={monthPick} onChange={e => setMonthPick(e.target.value)} className="mt-3 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100" />
            <p className="text-[11px] text-slate-400 mt-2">If this month was uploaded before for this partner, this file replaces it.</p>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { monthAsk.resolve(null); setMonthAsk(null); }} className="flex-1 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
              <button disabled={!monthPick} onClick={() => { monthAsk.resolve(monthPick); setMonthAsk(null); }} className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold disabled:opacity-40">Continue</button>
            </div>
          </div>
        </div>
      )}

      {/* A file the system has not seen before: say what its columns mean */}
      {setup && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold text-slate-900 dark:text-slate-100">New partner file</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{setup.fileName} is not a layout the system knows. Tell it what the columns mean once; the next file with the same columns is read on its own.</p>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-4 mb-1">Partner / product name</label>
            <input value={setupForm.name} onChange={e => setSetupForm({ ...setupForm, name: e.target.value })} placeholder="e.g. ICICI" className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100" />
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Client column</label>
                <select value={setupForm.clientCol} onChange={e => setSetupForm({ ...setupForm, clientCol: e.target.value })} className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm">
                  <option value="">Choose…</option>{setup.header.filter(h => h).map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Amount we earn</label>
                <select value={setupForm.amountCol} onChange={e => setSetupForm({ ...setupForm, amountCol: e.target.value })} className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm">
                  <option value="">Choose…</option>{setup.header.filter(h => h).map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mt-3 mb-1">Month</label>
            <div className="flex gap-2 flex-wrap items-center">
              <select value={setupForm.monthMode} onChange={e => setSetupForm({ ...setupForm, monthMode: e.target.value })} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm">
                <option value="column">The file has a month column</option>
                <option value="fixed">The whole file is one month</option>
              </select>
              {setupForm.monthMode === 'column'
                ? <select value={setupForm.monthCol} onChange={e => setSetupForm({ ...setupForm, monthCol: e.target.value })} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm"><option value="">Choose…</option>{setup.header.filter(h => h).map(h => <option key={h} value={h}>{h}</option>)}</select>
                : <input type="month" value={setupForm.fixedMonth} onChange={e => setSetupForm({ ...setupForm, fixedMonth: e.target.value })} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-sm" />}
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-[11px]"><tbody>
                <tr className="bg-slate-50 dark:bg-slate-900/40 font-bold">{setup.header.slice(0, 6).map((h, i) => <td key={i} className="px-2 py-1 whitespace-nowrap">{h}</td>)}</tr>
                {setup.grid.slice(1, 4).map((r, ri) => <tr key={ri}>{r.slice(0, 6).map((c, i) => <td key={i} className="px-2 py-1 whitespace-nowrap text-slate-500">{String(c ?? '')}</td>)}</tr>)}
              </tbody></table>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { setup.resolve(null); setSetup(null); }} className="flex-1 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
              <button
                onClick={async () => {
                  const f = setupForm; const code = f.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
                  if (code.length < 2) { showToast('Give the partner a name.', 'warning'); return; }
                  if (!f.clientCol || !f.amountCol || f.clientCol === f.amountCol) { showToast('Choose a client column and a different amount column.', 'warning'); return; }
                  if (f.monthMode === 'column' && !f.monthCol) { showToast('Choose the month column, or say the whole file is one month.', 'warning'); return; }
                  if (f.monthMode === 'fixed' && !f.fixedMonth) { showToast('Pick the month this file is for.', 'warning'); return; }
                  const cf: CustomFormat = { partner: code, label: f.name.trim(), clientCol: f.clientCol, amountCol: f.amountCol, monthCol: f.monthMode === 'column' ? f.monthCol : '' };
                  const res = await authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'partner_format_save', payload: { partner: code, label: cf.label, format: cf } }) });
                  const j = await res.json();
                  if (!res.ok) { showToast(j?.error || 'Could not save the layout.', 'error'); return; }
                  setCustomFormats(prev => [...prev.filter(x => x.partner !== code), cf]);
                  setup.resolve(customToFormat(cf, f.monthMode === 'fixed' ? f.fixedMonth : ''));
                  setSetup(null);
                }}
                className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
              >Save &amp; import</button>
            </div>
          </div>
        </div>
      )}

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
                        <td className="py-2 pr-4">
                          <div className="font-mono font-bold text-slate-900 dark:text-slate-100">{c.clientCode}</div>
                          {c.label && <div className="text-[11px] text-slate-500 dark:text-slate-400">{c.label}</div>}
                        </td>
                        <Td mono right>{c.rows_}</Td>
                        <Td mono>{!c.firstPeriod ? 'no trade yet' : c.firstPeriod === c.lastPeriod ? c.firstPeriod : `${c.firstPeriod} → ${c.lastPeriod}`}</Td>
                        <Td mono right bold>₹{Number(c.ourShare).toLocaleString('en-IN')}</Td>
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <select
                              id={`map-${c.clientCode}`}
                              value={pick[c.clientCode] ?? c.mappedClientId ?? suggestionFor(c.label || c.clientCode)}
                              onChange={e => setPick(p => ({ ...p, [c.clientCode]: e.target.value }))}
                              className="text-xs rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 px-2 py-1.5 max-w-[260px]"
                            >
                              <option value="">— not attached —</option>
                              {c.mappedClientId && !clients.some(cl => cl.id === c.mappedClientId) && (
                                <option value={c.mappedClientId}>{c.label || c.mappedClientId} (attached)</option>
                              )}
                              {clients.map(cl => (
                                <option key={cl.id} value={cl.id}>{cl.name}{cl.pan ? ` · ${cl.pan}` : ''}</option>
                              ))}
                            </select>
                            {(pick[c.clientCode] ?? c.mappedClientId ?? suggestionFor(c.label || c.clientCode)) !== (c.mappedClientId ?? '') && (
                              <button
                                onClick={() => saveMapping(c.clientCode, pick[c.clientCode] ?? suggestionFor(c.label || c.clientCode))}
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
                <Head cols={['Date', 'Code', 'Client', 'Segment', 'Category', 'Total', 'Our share']} />
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
