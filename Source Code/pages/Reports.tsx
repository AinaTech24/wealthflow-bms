
import React, { useState, useMemo, useEffect, Suspense, lazy } from 'react';
import { Search, Download, Filter, Layers, Clock, Briefcase, FileText, Landmark, ShieldCheck, Users, TrendingUp, AlertTriangle } from 'lucide-react';
import { exportToExcel, exportSheetsToExcel } from '../utils/excelExport';
import { TeamMember, Role, InvoiceStatus, PayoutInvoice, Client } from '../types';
import { useData, authFetch } from '../contexts/DataContext';
import { calculateUserShare } from '../services/calculationService';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { useClientAum } from '../utils/clientAum';

// Recharts is ~150KB gzipped; load only when a chart-using tab is rendered.
const ReportsCharts = lazy(() => import('../components/ReportsCharts'));

interface ReportsProps {
  currentUser: TeamMember;
  onNavigate?: (page: string) => void;
}

/**
 * Compute India-compliant GST split for a B2B invoice.
 * - Same state (intra-state) → CGST + SGST (each = rate/2)
 * - Different state (inter-state) → IGST (full rate)
 * - If firmState or payeeState is missing, falls back to IGST conservatively.
 */
const computeGstSplit = (baseAmount: number, gstRate: number, firmState?: string, payeeState?: string) => {
  const total = Math.round(baseAmount * gstRate) / 100;
  const norm = (s?: string) => (s || '').trim().toLowerCase();
  const isIntra = !!firmState && !!payeeState && norm(firmState) === norm(payeeState);
  if (isIntra) {
    const half = Math.round((total / 2) * 100) / 100;
    return {
      split: 'INTRA' as const,
      gstAmount: total,
      cgstRate: gstRate / 2,
      cgstAmount: half,
      sgstRate: gstRate / 2,
      sgstAmount: total - half, // absorbs rounding remainder
      igstRate: undefined,
      igstAmount: undefined,
    };
  }
  return {
    split: 'INTER' as const,
    gstAmount: total,
    cgstRate: undefined,
    cgstAmount: undefined,
    sgstRate: undefined,
    sgstAmount: undefined,
    igstRate: gstRate,
    igstAmount: total,
  };
};

export const Reports: React.FC<ReportsProps> = ({ currentUser }) => {
  const { transactions, clients, team, globalConfig, invoices, addInvoice, updateInvoice, serverSummary, refreshTick } = useData();
  const { showToast, showConfirm } = useToast();

  const [activeTab, setActiveTab] = useState<'overview' | 'monthly' | 'client-summary' | 'transactions' | 'invoices' | 'approvals' | 'team-payouts' | 'growth' | 'reconciliation'>('overview');

  const isAdmin = currentUser.role === Role.ADMIN;
  const isFinance = currentUser.role === Role.FINANCE;
  // Super-user = admin OR finance (both see firm-wide data; finance is read-only outside payouts).
  const isSuperUser = isAdmin || isFinance;
  // Per-action permissions for the invoice approval workflow:
  //   • Admin     → approves SUBMITTED → APPROVED
  //   • Finance   → settles APPROVED  → PAID (the payment release)
  //   • Either    → can reject with a reason
  const canApproveInvoices = isAdmin;
  const canSettleInvoices = isAdmin || isFinance;
  const canRejectInvoices = isAdmin || isFinance;

  const [filters, setFilters] = useState({
    month: 'All',
    year: new Date().getFullYear().toString()
  });

  const [currentPage, setCurrentPage] = useState(1);
  const [userSearchTerm, setUserSearchTerm] = useState('');
  const [clientSearchTerm, setClientSearchTerm] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<'ALL' | 'SUBMITTED' | 'PAID' | 'REJECTED'>('ALL');
  const pageSize = 50;

  // Growth tab state
  const [growthMode, setGrowthMode] = useState<'mom' | 'qoq' | 'yoy' | 'custom'>('mom');
  const [customRangeA, setCustomRangeA] = useState({ start: '', end: '' });
  const [customRangeB, setCustomRangeB] = useState({ start: '', end: '' });
  const [growthSortKey, setGrowthSortKey] = useState<'brokerage' | 'avgAum' | 'snapAum'>('brokerage');

  // GST/TDS configuration (persisted per user)
  const [taxConfig, setTaxConfig] = useState(() => {
    try {
      const stored = localStorage.getItem('wf_tax_config');
      // TDS defaults ON at 2% (194H brokerage/commission). GST is auto-applied only
      // when the RM has a GSTIN, so its toggle is advisory.
      return stored ? JSON.parse(stored) : { gstEnabled: false, gstRate: 18, tdsEnabled: true, tdsRate: 2 };
    } catch { return { gstEnabled: false, gstRate: 18, tdsEnabled: true, tdsRate: 2 }; }
  });

  const saveTaxConfig = (updated: typeof taxConfig) => {
    setTaxConfig(updated);
    localStorage.setItem('wf_tax_config', JSON.stringify(updated));
  };

  React.useEffect(() => {
    setCurrentPage(1);
  }, [activeTab]);

  const yearsList = useMemo(() => {
    const years = new Set<string>();
    years.add(new Date().getFullYear().toString());
    transactions.forEach(tx => {
      const year = (tx.brokeragePeriod || tx.transactionDate).split('-')[0];
      if (year && year.length === 4) years.add(year);
    });
    return Array.from(years).sort().reverse();
  }, [transactions]);



  const { visibleTransactions } = useMemo(() => {
    // ── Pre-index clients by id so the per-transaction lookup is O(1).
    //    Without this, `clients.find()` inside the filter ran ~clients.length
    //    times per transaction — for a 1057-client / 10k-tx firm that's
    //    10M+ ops on every filter / date / role change. Now it's O(N+M).
    const clientById = new Map(clients.map(c => [c.id, c] as const));
    const userLevelKey = `level${currentUser.level}Id` as keyof import('../types').Client['hierarchy'];

    const filtered = transactions.filter(tx => {
      if (!isSuperUser) {
        if (!tx.mappedClientId) return false;
        const client = clientById.get(tx.mappedClientId);
        if (!client) return false;
        if (client.hierarchy[userLevelKey] !== currentUser.id) return false;
      }
      const periodOrDate = tx.brokeragePeriod || tx.transactionDate;
      // Avoid two .split() allocations per row — slice the YYYY/MM out directly.
      if (filters.year !== 'All' && periodOrDate.slice(0, 4) !== filters.year) return false;
      if (filters.month !== 'All' && periodOrDate.slice(5, 7) !== filters.month) return false;
      return true;
    });
    return { visibleTransactions: [...filtered].sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime()) };
  }, [currentUser, transactions, clients, filters, isSuperUser]);

  const totalMyNetAllTime = useMemo(() => {
    return visibleTransactions.reduce((acc, tx) => acc + calculateUserShare(tx, currentUser, globalConfig), 0);
  }, [visibleTransactions, currentUser, globalConfig]);

  // Authoritative, uncapped overview totals. For the unfiltered ("All") view we
  // use the server summary (full dataset) so System Gross / Transactions never
  // silently under-report past the 200k client-side cap. A specific period still
  // aggregates the loaded subset, with a truncation note when data was capped.
  // Period totals straight from the database. The Summary tab used to add up
  // whatever slice of transactions the browser held, so it disagreed with Team
  // Payouts and double-counted anything imported in the same session.
  const [periodTotals, setPeriodTotals] = useState<{ totalRows: number; totalGross: number;
    periods: Array<{ period: string; rows: number; gross: number; distributed: number | null }> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/data?action=period_totals&_=${Date.now()}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(b => { if (!cancelled) setPeriodTotals(b); })
      .catch(() => { if (!cancelled) setPeriodTotals(null); });
    return () => { cancelled = true; };
  }, [refreshTick]);

  // Rows for the Summary breakdown, honouring the year/month filter.
  const visiblePeriods = useMemo(() => (periodTotals?.periods || []).filter(p =>
    (filters.year === 'All' || p.period.slice(0, 4) === filters.year) &&
    (filters.month === 'All' || p.period.slice(5, 7) === filters.month)),
    [periodTotals, filters.year, filters.month]);

  const isAllPeriod = filters.year === 'All' && filters.month === 'All';
  // Only warn about the client-side cap when the figures still depend on it.
  // Once period_totals is loaded the Summary numbers come from the database and
  // the cap is irrelevant, so the warning would just be wrong.
  const txTruncated = !periodTotals && !!serverSummary && serverSummary.totalTx > transactions.length;
  // Both cards now come from period_totals, so a filtered month reports the FULL
  // month rather than the part that happened to be loaded in the browser.
  const overviewGross = useMemo(() => {
    if (periodTotals) return Math.round(visiblePeriods.reduce((a, p) => a + p.gross, 0) * 100) / 100;
    if (isAllPeriod && serverSummary) return serverSummary.totalGross;
    return visibleTransactions.reduce((a, b) => a + b.grossAmount, 0);
  }, [periodTotals, visiblePeriods, isAllPeriod, serverSummary, visibleTransactions]);
  const overviewTxCount = periodTotals
    ? visiblePeriods.reduce((a, p) => a + p.rows, 0)
    : (isAllPeriod && serverSummary ? serverSummary.totalTx : visibleTransactions.length);

  // ── The signed-in user's own monthly payouts, served from payout_ledger via
  //    /api/data?action=my_payouts. This MUST NOT be computed from
  //    `visibleTransactions`: that array is capped at 200k of ~450k rows, so any
  //    user whose book fell partly outside the loaded slice saw an understated
  //    share — and raised INVOICES on it (Virendra: 2,810 of 3,361 tx,
  //    Rs 4,569.75 vs the ledger's Rs 5,408.22, while admin showed Rs 5,396.78).
  //    The ledger is what recalcRun/recomputeAllBreakdowns write, so this agrees
  //    with the admin view by construction rather than by luck.
  const [serverMyPayouts, setServerMyPayouts] = useState<Array<{ month: string; count: number; myShare: number; gross: number }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    authFetch('/api/data?action=my_payouts')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body: { monthly?: Array<{ month: string; count: number; myShare: number; gross: number }> }) => {
        if (!cancelled) setServerMyPayouts(body.monthly || []);
      })
      .catch(err => {
        // Fall back to the (capped) client compute rather than showing nothing,
        // but surface it — a silently low payout is what caused this bug.
        if (!cancelled) { console.warn('[my_payouts] fetch failed, falling back to capped client compute:', err.message); setServerMyPayouts(null); }
      });
    return () => { cancelled = true; };
  }, [currentUser.id]);

  const monthlySummary = useMemo(() => {
    const withInvoice = (item: { month: string, count: number, myShare: number, gross: number }) => ({
      ...item,
      invoice: invoices.find(inv => inv.month === item.month && inv.userId === currentUser.id),
    });

    if (serverMyPayouts) {
      return serverMyPayouts
        .filter(m => (filters.year === 'All' || m.month.slice(0, 4) === filters.year)
                  && (filters.month === 'All' || m.month.slice(5, 7) === filters.month))
        .sort((a, b) => b.month.localeCompare(a.month))
        .map(withInvoice);
    }

    const summary: Record<string, { month: string, count: number, myShare: number, gross: number }> = {};
    visibleTransactions.forEach(tx => {
      const month = tx.brokeragePeriod || tx.transactionDate.substring(0, 7);
      if (!summary[month]) summary[month] = { month, count: 0, myShare: 0, gross: 0 };
      summary[month].count += 1;
      summary[month].gross += tx.grossAmount;
      summary[month].myShare += calculateUserShare(tx, currentUser, globalConfig);
    });
    return Object.values(summary).sort((a, b) => b.month.localeCompare(a.month)).map(withInvoice);
  }, [serverMyPayouts, filters.year, filters.month, visibleTransactions, currentUser, invoices, globalConfig]);

  // Server-authoritative net + tx count for the SIGNED-IN user over the selected
  // period, summed from the ledger-backed my_payouts rows. The Summary/overview
  // "My Net Payout" and "Transactions" cards must use this rather than
  // `totalMyNetAllTime` / `overviewTxCount`, which aggregate the browser's
  // 200k-capped `transactions` slice and under-report exactly like the Monthly
  // Payouts tab did (Virendra Summary showed ₹4,569.75 / 2,810 vs ledger
  // ₹5,408.22 / 3,359). Null until the fetch lands, then the cards prefer it.
  const myServerPeriodStats = useMemo(() => {
    if (!serverMyPayouts) return null;
    const rows = serverMyPayouts.filter(m =>
      (filters.year === 'All' || m.month.slice(0, 4) === filters.year) &&
      (filters.month === 'All' || m.month.slice(5, 7) === filters.month));
    return {
      net: rows.reduce((s, m) => s + m.myShare, 0),
      count: rows.reduce((s, m) => s + m.count, 0),
    };
  }, [serverMyPayouts, filters.year, filters.month]);

  // AUM is a current snapshot, so it is derived from ALL transactions rather than
  // the period-filtered slice — it must not reset when you filter to a past month.
  // The rule itself lives in utils/clientAum, shared with the clients page: this tab
  // used to carry its own copy, and the two drifted until the same investor read
  // ₹10,986 on one screen and ₹12,266 on the other.
  const { aum: liveAumByClient } = useClientAum(transactions);

  const clientWiseSummary = useMemo(() => {
    const summary: Record<string, { id: string, name: string, pan: string, count: number, gross: number, myShare: number, aum: number, aumAsOf: string }> = {};
    visibleTransactions.forEach(tx => {
      const clientId = tx.mappedClientId || 'Unmapped';
      const clientName = tx.investorName || 'Unknown';
      const pan = tx.pan || 'N/A';
      if (!summary[clientId]) {
        const live = liveAumByClient.get(clientId);
        summary[clientId] = { id: clientId, name: clientName, pan, count: 0, gross: 0, myShare: 0, aum: live?.total || 0, aumAsOf: live?.asOf || '' };
      }
      summary[clientId].count += 1;
      summary[clientId].gross += tx.grossAmount;
      summary[clientId].myShare += calculateUserShare(tx, currentUser, globalConfig);
    });
    return Object.values(summary).sort((a, b) => b.myShare - a.myShare);
  }, [visibleTransactions, currentUser, globalConfig, liveAumByClient]);

  const filteredClientWiseSummary = useMemo(() => {
    return clientWiseSummary.filter(c =>
      c.name.toLowerCase().includes(clientSearchTerm.toLowerCase()) ||
      (c.pan || "").toLowerCase().includes(clientSearchTerm.toLowerCase())
    );
  }, [clientWiseSummary, clientSearchTerm]);

  // ── Authoritative gross + earnings by user, fetched server-side via
  //    /api/data?action=team_payouts. Bypasses the 200k transaction row cap
  //    AND bypasses the stale stored tx.breakdown blobs (which reflect whatever
  //    sharing rules were in effect at the moment each tx was last calculated).
  const [serverGrossByUser, setServerGrossByUser] = useState<Map<string, number>>(new Map());
  // Gross credited to the ARN holder (the BM): the basis AdvisorKhoj uses, so the BM rows can be compared directly.
  const [serverBmGrossByUser, setServerBmGrossByUser] = useState<Map<string, number>>(new Map());
  // Gross of the clients a user PRIMARILY owns (their RM book), regardless of the
  // hierarchy slot they sit in. Defining "RM gross" by ownership rather than by
  // level3Id is what keeps the RM-wise total equal to the BM-wise total — RMs are
  // placed at L1/L2/L3 depending on grade, so a slot-based rule drops whole books.
  const [serverOwnerGrossByUser, setServerOwnerGrossByUser] = useState<Map<string, number>>(new Map());
  const [serverEarningsByUser, setServerEarningsByUser] = useState<Map<string, number>>(new Map());
  // Exact % of gross, computed server-side from unrounded figures. Deriving it
  // here from the 2dp rupee amounts made a true 50% display as 49.96%.
  const [serverPctByUser, setServerPctByUser] = useState<Map<string, number>>(new Map());
  const [isLoadingServerPayouts, setIsLoadingServerPayouts] = useState(false);
  // Why this exists: the figures below come from the server PER MONTH. Until the new
  // month's request finished, the maps still held the PREVIOUS month's numbers, so
  // changing the dropdown showed June's gross under a July label — and exporting in
  // that window wrote the wrong month into the file. A request that failed (a proxy
  // timeout is enough) only logged to the console and left the stale figures up with
  // no warning at all.
  const [serverPayoutsError, setServerPayoutsError] = useState<string | null>(null);
  const [payoutsRetry, setPayoutsRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setIsLoadingServerPayouts(true);
    setServerPayoutsError(null);
    // Never leave another month's figures on screen while this one loads.
    setServerGrossByUser(new Map());
    setServerOwnerGrossByUser(new Map());
    setServerBmGrossByUser(new Map());
    setServerEarningsByUser(new Map());
    setServerPctByUser(new Map());
    const url = `/api/data?action=team_payouts&year=${encodeURIComponent(filters.year)}&month=${encodeURIComponent(filters.month)}`;
    authFetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body: { payouts?: Array<{ userId: string; grossTotal: number; ownerGross?: number; bmOwnerGross?: number; earnings?: number; pctOfGross?: number }> }) => {
        if (cancelled) return;
        const grossMap = new Map<string, number>();
        const ownerMap = new Map<string, number>();
        const bmMap = new Map<string, number>();
        const earnMap = new Map<string, number>();
        const pctMap = new Map<string, number>();
        for (const p of body.payouts || []) {
          grossMap.set(p.userId, p.grossTotal);
          if (typeof p.ownerGross === 'number') ownerMap.set(p.userId, p.ownerGross);
          if (typeof p.bmOwnerGross === 'number') bmMap.set(p.userId, p.bmOwnerGross);
          if (typeof p.earnings === 'number') earnMap.set(p.userId, p.earnings);
          if (typeof p.pctOfGross === 'number') pctMap.set(p.userId, p.pctOfGross);
        }
        setServerGrossByUser(grossMap);
        setServerOwnerGrossByUser(ownerMap);
        setServerBmGrossByUser(bmMap);
        setServerEarningsByUser(earnMap);
        setServerPctByUser(pctMap);
      })
      .catch(err => {
        if (!cancelled) {
          console.warn('[team_payouts] fetch failed, falling back to client compute:', err.message);
          setServerPayoutsError(err.message || 'request failed');
        }
      })
      .finally(() => { if (!cancelled) setIsLoadingServerPayouts(false); });
    return () => { cancelled = true; };
  }, [filters.year, filters.month, refreshTick, payoutsRetry]);

  // ── Reconciliation: fetch unmapped (orphan) transactions for the active period.
  type UnmappedGroup = { pan: string | null; folio: string | null; name: string | null; gross: number; n: number };
  const [unmapped, setUnmapped] = useState<{ totalRows: number; totalGross: number; groups: UnmappedGroup[] } | null>(null);
  const [isLoadingUnmapped, setIsLoadingUnmapped] = useState(false);
  useEffect(() => {
    if (activeTab !== 'reconciliation') return;
    let cancelled = false;
    setIsLoadingUnmapped(true);
    const period = (filters.year !== 'All' && filters.month !== 'All') ? `${filters.year}-${filters.month}` : '';
    const url = `/api/data?action=unmapped${period ? `&period=${encodeURIComponent(period)}` : ''}`;
    authFetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body) => { if (!cancelled) setUnmapped(body); })
      .catch(err => { if (!cancelled) { console.warn('[unmapped] fetch failed:', err.message); setUnmapped(null); } })
      .finally(() => { if (!cancelled) setIsLoadingUnmapped(false); });
    return () => { cancelled = true; };
  }, [activeTab, filters.year, filters.month, refreshTick]);

  // ── "Map RM from Registrar File" tool ──────────────────────────────────
  const [mapRmId, setMapRmId] = useState('');
  const [mapBusy, setMapBusy] = useState(false);
  const [mapMsg, setMapMsg] = useState<string | null>(null);
  // Parse the "RM-wise / Investor-wise Brokerage" Excel and pull the Folio column.
  const parseFoliosFromFile = async (file: File): Promise<string[]> => {
    const XLSX = await import('xlsx');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    // find the header row containing a "Folio" column
    let hdr = -1, col = -1;
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const idx = (rows[r] || []).findIndex((c: any) => String(c).trim().toLowerCase() === 'folio');
      if (idx >= 0) { hdr = r; col = idx; break; }
    }
    if (hdr < 0) throw new Error('Could not find a "Folio" column in the file.');
    const out = new Set<string>();
    for (let r = hdr + 1; r < rows.length; r++) {
      const v = String((rows[r] || [])[col] ?? '').trim();
      if (v) out.add(v);
    }
    return [...out];
  };
  const handleMapRmFile = async (file: File) => {
    if (!mapRmId) { setMapMsg('Select the RM first.'); return; }
    setMapBusy(true); setMapMsg('Reading file…');
    try {
      const folios = await parseFoliosFromFile(file);
      if (!folios.length) { setMapMsg('No folios found in the file.'); setMapBusy(false); return; }
      setMapMsg(`Mapping ${folios.length} folios…`);
      const r = await authFetch('/api/data', { method: 'POST', body: JSON.stringify({ action: 'map_rm_folios', rmId: mapRmId, folios }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rm = team.find(t => t.id === mapRmId);
      setMapMsg(`✓ Mapped ${j.clientsMapped} clients (${j.foliosReceived} folios${j.foliosUnmatched ? `, ${j.foliosUnmatched} not found in system` : ''}) to ${rm?.name || 'RM'}. Recalculating — refresh in ~1–2 min.`);
    } catch (e: any) {
      setMapMsg(`✗ ${e.message || 'Failed to map'}`);
    } finally { setMapBusy(false); }
  };

  // ── Bulk client mapping from a spreadsheet ─────────────────────────────
  // Name | PAN | RM | BM  →  preview  →  apply. Header names are matched loosely
  // (the team's sheets say "Client Name", "PAN Card", "RM Name", "Business Manager"
  // in different months) so a re-typed header never rejects the whole file.
  type BulkRow = { __row: number; clientId: string; name: string; pan: string; rm: string; rmId: string; bm: string; bmId: string };
  type BulkResult = {
    dryRun: boolean;
    summary: { total: number; willUpdate: number; unchanged: number; errors: number };
    rows: Array<{ row: number; name: string; pan: string; status: string; message: string; clientName?: string }>;
    truncated?: boolean;
  };
  const [bulkRows, setBulkRows] = useState<BulkRow[] | null>(null);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const parseBulkFile = async (file: File): Promise<BulkRow[]> => {
    const XLSX = await import('xlsx');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const norm = (v: any) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
    // Accept the many header spellings these sheets arrive with.
    const WANT: Record<keyof Omit<BulkRow, '__row'>, string[]> = {
      clientId: ['clientid', 'id'],
      name: ['name', 'clientname', 'investorname', 'investor', 'client'],
      pan:  ['pan', 'pancard', 'panno', 'pannumber'],
      rm:   ['rm', 'rmname', 'relationshipmanager', 'sherpa', 'advisor'],

      bm:   ['bm', 'bmname', 'businessmanager', 'manager'],
      // IDs are the only unambiguous keys: 16 team names repeat and the firm
      // ARN (ARN-270604) is shared by 119 of 184 members, so neither name nor
      // code can be trusted on its own.
      rmId: ['rmid'],
      bmId: ['bmid'],
    };
    let hdr = -1; const col: Record<string, number> = {};
    for (let r = 0; r < Math.min(grid.length, 30); r++) {
      const cells = (grid[r] || []).map(norm);
      const found: Record<string, number> = {};
      for (const key of Object.keys(WANT) as Array<keyof typeof WANT>) {
        const idx = cells.findIndex(c => c && WANT[key].includes(c));
        if (idx >= 0) found[key] = idx;
      }
      // A usable header row must identify the RM plus at least one way to find the client.
      if (found.rm !== undefined && (found.pan !== undefined || found.name !== undefined)) {
        hdr = r; Object.assign(col, found); break;
      }
    }
    if (hdr < 0) {
      throw new Error('Could not find the columns. The sheet needs a header row with an "RM" column plus "PAN" and/or "Name". Download the template below to see the expected layout.');
    }
    const out: BulkRow[] = [];
    for (let r = hdr + 1; r < grid.length; r++) {
      const g = grid[r] || [];
      const cell = (k: string) => col[k] === undefined ? '' : String(g[col[k]] ?? '').trim();
      // Codes are shorter and cannot be misspelt as easily — prefer them when the
      // exported sheet carries them, and fall back to the typed name.
      const pick = (a: string, b: string) => cell(a) || cell(b);
      const row = { __row: r + 1, clientId: cell('clientId'), name: cell('name'), pan: cell('pan'), rm: cell('rm'), rmId: cell('rmId'), bm: cell('bm'), bmId: cell('bmId') };
      if (!row.clientId && !row.name && !row.pan && !row.rm) continue;      // blank line
      out.push(row);
    }
    if (!out.length) throw new Error('The file has headers but no data rows.');
    return out;
  };

  const handleBulkFile = async (file: File) => {
    setBulkBusy(true); setBulkMsg(null); setBulkResult(null); setBulkRows(null);
    try {
      const parsed = await parseBulkFile(file);
      setBulkRows(parsed); setBulkFileName(file.name);
      setBulkMsg(`Read ${parsed.length} rows — checking against the system…`);
      const r = await authFetch('/api/data', { method: 'POST', body: JSON.stringify({ action: 'bulk_map_clients', rows: parsed, dryRun: true }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setBulkResult(j); setBulkMsg(null);
    } catch (e: any) {
      setBulkMsg(`✗ ${e.message || 'Could not read the file'}`);
    } finally { setBulkBusy(false); }
  };

  const applyBulkMapping = async () => {
    if (!bulkRows) return;
    setBulkBusy(true); setBulkMsg('Applying…');
    try {
      const r = await authFetch('/api/data', { method: 'POST', body: JSON.stringify({ action: 'bulk_map_clients', rows: bulkRows, dryRun: false }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setBulkResult(j);
      setBulkMsg(`✓ ${j.summary.willUpdate} client(s) re-mapped. Payouts are recalculating — refresh in a minute or two.`);
      setBulkRows(null);
    } catch (e: any) {
      setBulkMsg(`✗ ${e.message || 'Failed to apply'}`);
    } finally { setBulkBusy(false); }
  };

  // Export EVERY client with a hidden-in-plain-sight Client ID plus their current
  // RM/BM. The operator edits only the RM/BM columns and re-uploads — no client
  // name is ever typed, so a spelling mistake cannot break the match. This is the
  // recommended path; the blank template stays for sheets built from scratch.
  const downloadCurrentMapping = async () => {
    const XLSX = await import('xlsx');
    const byId = new Map(team.map(t => [t.id, t]));
    const ownerOf = (c: Client) => {
      const h: any = c.hierarchy || {};
      for (let l = 1; l <= 7; l++) if (h[`level${l}Id`]) return byId.get(h[`level${l}Id`]);
      return undefined;
    };
    const upperOf = (c: Client, rmLevel?: number) => {
      const h: any = c.hierarchy || {};
      for (let l = (rmLevel || 0) + 1; l <= 7; l++) if (h[`level${l}Id`]) return byId.get(h[`level${l}Id`]);
      return undefined;
    };
    const rows = clients
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(c => {
        const rm = ownerOf(c);
        const bm = upperOf(c, rm?.level);
        return {
          'Client ID': c.id,                       // do not edit — this is the match key
          'Client Name': c.name,
          'PAN': c.pan || '',
          'RM Name': rm?.name || '',
          'RM ID': rm?.id || '',      // paste a different ID here to re-assign — never ambiguous
          'BM Name': bm?.name || '',
          'BM ID': bm?.id || '',
        };
      });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 26 }, { wch: 32 }, { wch: 13 }, { wch: 28 }, { wch: 26 }, { wch: 28 }, { wch: 26 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Mapping');

    const roster = team
      .slice()
      .sort((a, b) => a.level - b.level || (a.name || '').localeCompare(b.name || ''))
      .map(t => ({ 'Name': t.name, 'ID (paste this — always exact)': t.id, 'Code': t.code || '', 'Level': `L${t.level}`, 'Role': t.role }));
    const ws2 = XLSX.utils.json_to_sheet(roster);
    ws2['!cols'] = [{ wch: 34 }, { wch: 30 }, { wch: 16 }, { wch: 8 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Team names');

    const help = [
      { Step: '1', Instruction: 'Edit ONLY the "RM Name" (or "RM Code") and "BM Name" columns. Leave Client ID untouched — it is how each row is matched.' },
      { Step: '2', Instruction: 'To change an RM or BM, paste their ID from the "Team names" sheet into the RM ID / BM ID column. That is always exact. Typing the name also works, and small spelling mistakes are corrected automatically.' },
      { Step: '3', Instruction: 'Delete any rows you do not want to change. Rows left as-is are reported as "already correct" and skipped.' },
      { Step: '4', Instruction: 'Upload the file. You will see a full preview of what changes BEFORE anything is saved.' },
      { Step: '5', Instruction: 'Note: the ARN code is NOT unique here (ARN-270604 is on 119 members), so use the ID or the name — not the code.' },
    ];
    const ws3 = XLSX.utils.json_to_sheet(help);
    ws3['!cols'] = [{ wch: 6 }, { wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'How to use');

    XLSX.writeFile(wb, `client-mapping-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // Template carries the real RM/BM names so the operator can copy exact spellings.
  const downloadBulkTemplate = async () => {
    const XLSX = await import('xlsx');
    const sample = clients.slice(0, 3);
    const rows = sample.length ? sample.map(c => ({
      'Client Name': c.name, 'PAN': c.pan, 'RM Name': '', 'BM Name': '',
    })) : [{ 'Client Name': 'RAMESH KUMAR', 'PAN': 'ABCDE1234F', 'RM Name': '', 'BM Name': '' }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Mapping');
    const roster = team
      .slice()
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      .map(t => ({ 'Name (copy exactly)': t.name, 'Code': t.code || '', 'Level': `L${t.level}`, 'Role': t.role }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(roster), 'Team names');
    XLSX.writeFile(wb, 'client-mapping-template.xlsx');
  };

  // ── One-click monthly reconciliation workbook ──────────────────────────
  //   Sheet 1: per-RM gross, net, % of gross (+ prior-month delta when a single
  //            period is selected). Sheet 2: the unmapped folios going to house.
  const [reconExporting, setReconExporting] = useState(false);
  // ── Exceptions report ──────────────────────────────────────────────────
  // Everything an import could not resolve, in one place: brokerage that
  // reaches nobody, clients with no RM, folios two records both claim, folios
  // Excel destroyed, and rows whose investor is not the client they landed on.
  // Read-only — safe to run immediately after any import.
  const [excBusy, setExcBusy] = useState(false);
  const [excPeriod, setExcPeriod] = useState('');
  const [excData, setExcData] = useState<any>(null);
  // Which bucket is expanded, what the operator picked on each row, and whether
  // a fix has landed that the payout figures have not caught up with yet.
  const [excOpen, setExcOpen] = useState<string | null>(null);
  const [excPick, setExcPick] = useState<Record<string, string>>({});
  const [excFixing, setExcFixing] = useState<string | null>(null);
  const [excNeedsRecalc, setExcNeedsRecalc] = useState(false);

  const EXC_TABS: { key: string; label: string; money: boolean; help: string }[] = [
    { key: 'unmappedTx', label: 'Brokerage with no client', money: true,
      help: 'Nobody is credited for this brokerage. Send the folio to the right client — or create that client first on Clients & Map.' },
    { key: 'noRmTx', label: 'Client has no RM', money: true,
      help: 'The investor exists but nobody owns them, so this brokerage goes to house. Assign an RM in the Clients with no RM tab.' },
    { key: 'orphanTx', label: 'Mapped to deleted client', money: true,
      help: 'These rows point at a client id that no longer exists — usually a delete or a merge that did not move its transactions. Send the folio to the surviving record.' },
    { key: 'nameDrift', label: 'Investor ≠ client name', money: true,
      help: 'The row was mapped to somebody whose name is not this investor. A minor under a guardian is normal and can be left alone; a stranger is not. ★ marks the client whose name matches exactly.' },
    { key: 'truncatedFolios', label: 'Folio broken by Excel', money: false,
      help: 'Excel saved a 12-digit folio as "4.77396E+11" and the real digits are gone from the FILE, so nothing here can recover them. Re-download that source file as .xlsx and import it again — never open and re-save it as CSV.' },
    { key: 'ambiguousFolios', label: 'Folio claimed by 2+ clients', money: false,
      help: 'This is what makes mapping jump between months: folio lookup keeps only one winner, and which one changes as records are added. Pick the real owner — ★ the record with the most transactions — and the folio is removed from the rest. No transaction moves.' },
    { key: 'unassignedClients', label: 'Clients with no RM', money: false,
      help: 'Assign an RM here. The hierarchy is copied from a client that RM already owns, so the L4 surplus lands where it does for the rest of their book.' },
  ];

  const applyExcFix = async (rowKey: string, payload: any) => {
    setExcFixing(rowKey);
    try {
      const r = await authFetch('/api/data', { method: 'POST', body: JSON.stringify({ action: 'exception_fix', ...payload }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { showToast(j.error || 'Fix failed — nothing was changed.', 'error'); return; }
      showToast(j.message || 'Fixed.', j.ok === false ? 'warning' : 'success');
      if (j.needsRecalc) setExcNeedsRecalc(true);
      await runExceptions();            // re-read so the list reflects what just changed
    } catch {
      showToast('Fix failed — nothing was changed.', 'error');
    } finally {
      setExcFixing(null);
    }
  };

  const runExcRecalc = async () => {
    setExcBusy(true);
    try {
      // recalc_all is a GET action on the server (same call DataContext makes).
      // Sending it as a POST fell through to the write path and came back as an
      // error, so the button reported "could not be started" every time.
      const r = await authFetch('/api/data?action=recalc_all');
      if (!r.ok) { showToast('Recalculation could not be started.', 'error'); return; }
      setExcNeedsRecalc(false);
      showToast('Recalculation started. Payout figures update once it finishes.', 'success');
    } catch {
      showToast('Recalculation could not be started.', 'error');
    } finally {
      setExcBusy(false);
    }
  };



  const runExceptions = async () => {
    setExcBusy(true);
    try {
      const qs = excPeriod ? `&period=${encodeURIComponent(excPeriod)}` : '';
      const r = await authFetch(`/api/data?action=exceptions_report${qs}&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { showToast('Could not build the exceptions report.', 'error'); return; }
      const j = await r.json();
      setExcData(j);
      const total = Object.values(j.summary || {}).reduce((s: number, v: any) => s + (v?.count || 0), 0);
      showToast(total === 0
        ? `No exceptions for ${j.period}. Everything is mapped.`
        : `${total} exception${total === 1 ? '' : 's'} found for ${j.period}. Download the sheet to work through them.`,
        total === 0 ? 'success' : 'warning');
    } catch {
      showToast('Could not build the exceptions report.', 'error');
    } finally {
      setExcBusy(false);
    }
  };

  const downloadExceptions = async () => {
    if (!excData) return;
    // xlsx is 429 kB — load it only when someone actually asks for the file,
    // exactly as downloadCurrentMapping() does.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const add = (name: string, rows: any[], cols: number[]) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'Nothing to fix here — this check passed.' }]);
      ws['!cols'] = cols.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    const s = excData.summary || {};
    add('Summary', [
      { Check: 'Brokerage mapped to NO client', Rows: s.unmappedTx?.count || 0, Gross: s.unmappedTx?.gross || 0, 'What to do': 'Add the folio to the right client, or create the client. This money currently reaches nobody.' },
      { Check: 'Client has no RM', Rows: s.noRmTx?.count || 0, Gross: s.noRmTx?.gross || 0, 'What to do': 'Assign an RM on Clients & Map. Until then this brokerage goes to house.' },
      { Check: 'Mapped to a deleted client', Rows: s.orphanTx?.count || 0, Gross: s.orphanTx?.gross || 0, 'What to do': 'Re-map to the surviving client record.' },
      { Check: 'Investor name does not match client', Rows: s.nameDrift?.count || 0, Gross: s.nameDrift?.gross || 0, 'What to do': 'Check each one — a minor under a guardian is fine, a stranger is not.' },
      { Check: 'Folio destroyed by Excel', Rows: s.truncatedFolios?.count || 0, Gross: s.truncatedFolios?.gross || 0, 'What to do': 'Re-download that source file as .xlsx. Do not open and re-save it as CSV.' },
      { Check: 'Folio claimed by 2+ clients', Rows: s.ambiguousFolios?.count || 0, Gross: 0, 'What to do': 'Leave the folio on ONE client only. While two claim it, mapping flips between months.' },
      { Check: 'Client with no RM at all', Rows: s.unassignedClients?.count || 0, Gross: 0, 'What to do': 'Assign an RM, or delete the record if it is a duplicate.' },
    ], [38, 8, 12, 95]);
    add('No client', excData.unmappedTx || [], [10, 18, 32, 13, 26, 8, 11]);
    add('No RM', excData.noRmTx || [], [10, 18, 32, 8, 11, 30, 30]);
    add('Deleted client', excData.orphanTx || [], [10, 18, 32, 8, 11, 34]);
    add('Name mismatch', excData.nameDrift || [], [10, 18, 32, 32, 30, 26, 8, 11]);
    add('Broken folios', excData.truncatedFolios || [], [10, 18, 32, 8, 11, 70]);
    add('Folio claimed twice', excData.ambiguousFolios || [], [18, 12, 110, 50]);
    add('Clients with no RM', excData.unassignedClients || [], [34, 32, 13, 60]);
    XLSX.writeFile(wb, `exceptions-${excData.period}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };


  // Invoice review step — holds the fully-computed draft awaiting explicit
  // confirmation. Nothing is persisted while this is set.
  const [invoiceDraft, setInvoiceDraft] = useState<{ invoice: PayoutInvoice; isEdit: boolean; gross: number } | null>(null);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const handleExportReconciliation = async () => {
    if (isLoadingServerPayouts || serverPayoutsError) {
      showToast('This month’s figures have not finished loading, so the export would carry the wrong numbers. Wait for them, or press Retry.', 'warning');
      return;
    }
    setReconExporting(true);
    try {
      const periodKnown = filters.year !== 'All' && filters.month !== 'All';

      // Best-effort prior-month gross for a month-over-month column.
      const priorGross = new Map<string, number>();
      let priorLabel = '';
      if (periodKnown) {
        const y = parseInt(filters.year, 10);
        const m = parseInt(filters.month, 10);
        let py = y, pm = m - 1;
        if (pm < 1) { pm = 12; py = y - 1; }
        priorLabel = `${py}-${String(pm).padStart(2, '0')}`;
        try {
          const r = await authFetch(`/api/data?action=team_payouts&year=${py}&month=${String(pm).padStart(2, '0')}`);
          if (r.ok) {
            const b = await r.json();
            for (const p of (b.payouts || [])) priorGross.set(p.userId, p.grossTotal || 0);
          }
        } catch { /* prior month is optional — skip the delta if it fails */ }
      }

      const payoutRows = teamWithPayouts.map(({ member, userOwnTotal, grossTotal }) => {
        const rate = (member as any).customLevels?.[member.level];
        // Role is derived from how the member actually holds business, not from
        // their level badge: "RM" = owns clients directly; "BM / Upline" = only
        // sits above other people's clients. Summing "Own Book Gross" across the
        // RM rows equals total gross exactly, so RM-wise and BM-wise reconcile.
        const ownBook = serverOwnerGrossByUser.get(member.id) || 0;
        const row: Record<string, any> = {
          'RM Name': member.name,
          'Code': member.code || '',
          'Level': `L${member.level}`,
          'Role': ownBook > 0 ? 'RM (own clients)' : 'BM / Upline',
          'Own Book Gross (Rs.)': Math.round(ownBook * 100) / 100,
          'BM Gross - AdvisorKhoj basis (Rs.)': Math.round((serverBmGrossByUser.get(member.id) || 0) * 100) / 100,
          'Sharing % (set)': typeof rate === 'number' ? rate : '',
          'Gross Brokerage (Rs.)': Math.round(grossTotal * 100) / 100,
          'Their Earnings (Rs.)': Math.round(userOwnTotal * 100) / 100,
          '% of Gross': grossTotal > 0 ? Math.round((userOwnTotal / grossTotal * 100) * 100) / 100 : 0,
        };
        if (periodKnown) {
          const pg = priorGross.get(member.id) || 0;
          row[`Prior Gross ${priorLabel} (Rs.)`] = Math.round(pg * 100) / 100;
          row['MoM Change (Rs.)'] = Math.round((grossTotal - pg) * 100) / 100;
        }
        return row;
      });

      const unmappedRows = (unmapped?.groups || []).map(g => ({
        'Investor': g.name || 'unknown',
        'PAN': g.pan || '',
        'Folio': g.folio || '',
        'Transactions': g.n,
        'Unattributed Gross (Rs.)': Math.round(g.gross * 100) / 100,
      }));

      await exportSheetsToExcel(
        [
          { name: 'Per-RM Payouts', rows: payoutRows },
          { name: 'Unmapped (to house)', rows: unmappedRows },
        ],
        `WealthflowReconciliation_${periodKnown ? `${filters.year}_${filters.month}` : 'AllPeriods'}`
      );
    } finally {
      setReconExporting(false);
    }
  };

  // Every team member who is assigned to at least one client, at any level.
  // Used so an RM with clients but ZERO earnings this period still appears in the
  // Team Payouts list (showing ₹0) instead of silently vanishing — a missing row
  // reads as "the user is gone", when the real signal is "this RM earned nothing
  // this month", which is exactly what you want to notice (e.g. a registrar file
  // that was never imported).
  const membersWithClients = useMemo(() => {
    const s = new Set<string>();
    for (const c of clients) {
      const h: any = c.hierarchy || {};
      for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) s.add(u); }
    }
    return s;
  }, [clients]);

  // Heavy aggregation step — independent of search term / pagination.
  // Recomputes only when transactions/clients/team/config change.
  const teamWithPayouts = useMemo(() => {
    const memberTotals: Record<string, { userOwnTotal: number; myOverrideTotal: number; grossTotal: number }> = {};
    const clientMap = new Map();
    clients.forEach(c => clientMap.set(c.id, c));
    const teamMap = new Map();
    team.forEach(t => teamMap.set(t.id, t));

    visibleTransactions.forEach(tx => {
      const client = clientMap.get(tx.mappedClientId || '');
      if (!client || !client.hierarchy) return;

      const levels = [0, 1, 2, 3, 4, 5, 6] as const;
      let myOverrideAmt: number | null = null;

      levels.forEach(level => {
        const memberId = client.hierarchy[`level${level}Id`];
        if (!memberId) return;

        if (!memberTotals[memberId]) {
          memberTotals[memberId] = { userOwnTotal: 0, myOverrideTotal: 0, grossTotal: 0 };
        }

        const member = teamMap.get(memberId);
        if (member) {
          memberTotals[memberId].grossTotal += tx.grossAmount;
          memberTotals[memberId].userOwnTotal += calculateUserShare(tx, member, globalConfig);

          if (!isAdmin) {
            if (myOverrideAmt === null) {
              myOverrideAmt = calculateUserShare(tx, currentUser, globalConfig);
            }
            memberTotals[memberId].myOverrideTotal += myOverrideAmt;
          }
        }
      });
    });

    return team
      .filter(m => {
        // ── System logins are NOT payout recipients ────────────────────────
        // The ADMIN account sits in `level6Id` of 1,293 clients as a structural
        // placeholder, so it accumulated ₹2,65,733.29 of gross for August while
        // earning ₹0. That produced a row in this table — and in its Excel
        // export — that looks like a branch manager holding 94% of the month.
        // Sorted by name it lands between "Sunita Satapathy" and "VARALAXMI",
        // so anyone pasting the export beside an AdvisorKhoj list had every row
        // from V onwards shifted down by one and chased phantom differences.
        // Gross for a login that cannot earn is meaningless; leave it out.
        if (m.role === Role.ADMIN || m.role === Role.FINANCE) return false;
        if (!isAdmin && m.parentId !== currentUser.id) return false;
        const totals = memberTotals[m.id];
        // Include member if EITHER client side detected activity OR the server
        // sees a non-zero gross total for this user/period. The server is the
        // source of truth — relying solely on the cached `transactions` slice
        // would silently undercount when the cap drops some rows.
        const serverGross = serverGrossByUser.get(m.id) || 0;
        // Keep an RM who owns clients even when they earned ₹0 this period — the
        // zero itself is the useful signal (missing registrar file, inactive book).
        if (membersWithClients.has(m.id)) return true;
        if (!totals && serverGross <= 0) return false;
        if (totals && (totals.userOwnTotal > 0 || totals.myOverrideTotal > 0)) return true;
        return serverGross > 0;
      })
      .map(member => {
        const totals = memberTotals[member.id] || { userOwnTotal: 0, myOverrideTotal: 0, grossTotal: 0 };
        // Authoritative values from server override client-side ones.
        //   • grossTotal — escapes the 200k row cap
        //   • userOwnTotal — escapes stale stored tx.breakdown blobs
        const serverGross = serverGrossByUser.get(member.id);
        const serverEarn  = serverEarningsByUser.get(member.id);
        return {
          member,
          userOwnTotal: serverEarn !== undefined ? serverEarn : totals.userOwnTotal,
          myOverrideTotal: totals.myOverrideTotal,
          grossTotal: serverGross !== undefined ? serverGross : totals.grossTotal,
        };
      })
      .sort((a, b) => b.member.level - a.member.level);
  }, [team, isAdmin, currentUser, visibleTransactions, clients, globalConfig, serverGrossByUser, serverEarningsByUser, membersWithClients]);

  // Lightweight filter on top — only re-runs when search term changes,
  // not on every pagination event.
  const filteredTeamWithPayouts = useMemo(() => {
    const q = userSearchTerm.toLowerCase();
    if (!q) return teamWithPayouts;
    return teamWithPayouts.filter(({ member }) =>
      member.name.toLowerCase().includes(q) ||
      member.code.toLowerCase().includes(q)
    );
  }, [teamWithPayouts, userSearchTerm]);

  // Memoized invoice slices — avoids re-filtering on every unrelated render
  // (pagination, search, theme changes etc.).
  // Finance & Admin see EVERY RM's invoices in the Invoices tab (they process
  // payouts for the whole team); a regular RM sees only their own.
  const myInvoices = useMemo(
    () => isSuperUser ? invoices : invoices.filter(i => i.userId === currentUser.id),
    [invoices, currentUser.id, isSuperUser]
  );
  const myInvoicesFiltered = useMemo(
    () => invoiceStatusFilter === 'ALL'
      ? myInvoices
      : myInvoices.filter(i => i.status === invoiceStatusFilter),
    [myInvoices, invoiceStatusFilter]
  );
  const pendingApprovalInvoices = useMemo(
    () => invoices.filter(i => i.status === InvoiceStatus.SUBMITTED || i.status === InvoiceStatus.APPROVED),
    [invoices]
  );

  // ── Growth tab: derive comparison period date ranges ───────────────────────
  const growthPeriods = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const endOfMonth = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;

    const now = new Date();
    const monthInt = filters.month === 'All' ? (now.getMonth() + 1) : parseInt(filters.month);
    const yearInt = filters.year === 'All' ? now.getFullYear() : parseInt(filters.year);

    if (growthMode === 'mom') {
      const prevY = monthInt === 1 ? yearInt - 1 : yearInt;
      const prevM = monthInt === 1 ? 12 : monthInt - 1;
      return {
        currStart: `${yearInt}-${pad(monthInt)}-01`, currEnd: endOfMonth(yearInt, monthInt),
        prevStart: `${prevY}-${pad(prevM)}-01`, prevEnd: endOfMonth(prevY, prevM),
        currLabel: `${yearInt}-${pad(monthInt)}`, prevLabel: `${prevY}-${pad(prevM)}`,
        valid: true,
      };
    }
    if (growthMode === 'qoq') {
      const currQ = Math.ceil(monthInt / 3);
      const currQStartM = (currQ - 1) * 3 + 1;
      const prevQ = currQ === 1 ? 4 : currQ - 1;
      const prevY = currQ === 1 ? yearInt - 1 : yearInt;
      const prevQStartM = (prevQ - 1) * 3 + 1;
      return {
        currStart: `${yearInt}-${pad(currQStartM)}-01`, currEnd: endOfMonth(yearInt, currQStartM + 2),
        prevStart: `${prevY}-${pad(prevQStartM)}-01`, prevEnd: endOfMonth(prevY, prevQStartM + 2),
        currLabel: `Q${currQ} ${yearInt}`, prevLabel: `Q${prevQ} ${prevY}`,
        valid: true,
      };
    }
    if (growthMode === 'yoy') {
      return {
        currStart: `${yearInt}-01-01`, currEnd: `${yearInt}-12-31`,
        prevStart: `${yearInt - 1}-01-01`, prevEnd: `${yearInt - 1}-12-31`,
        currLabel: String(yearInt), prevLabel: String(yearInt - 1),
        valid: true,
      };
    }
    // custom
    const valid = !!(customRangeA.start && customRangeA.end && customRangeB.start && customRangeB.end);
    return {
      currStart: customRangeA.start, currEnd: customRangeA.end,
      prevStart: customRangeB.start, prevEnd: customRangeB.end,
      currLabel: valid ? `${customRangeA.start} → ${customRangeA.end}` : 'Period A',
      prevLabel: valid ? `${customRangeB.start} → ${customRangeB.end}` : 'Period B',
      valid,
    };
  }, [growthMode, filters.month, filters.year, customRangeA, customRangeB]);

  // ── Growth tab: which brokers do we show rows for ──────────────────────────
  const brokerScope = useMemo(
    () => isAdmin ? team : [currentUser],
    [isAdmin, team, currentUser]
  );

  // ── Growth tab: per-broker rows with Avg AUM, Snapshot AUM, Brokerage share ─
  const growthRows = useMemo(() => {
    const { currStart, currEnd, prevStart, prevEnd, valid } = growthPeriods;
    if (!valid) return [];

    const clientMap = new Map(clients.map(c => [c.id, c]));

    // growthPeriods hands out full dates ("2026-07-01".."2026-07-31") but a row's
    // period is its brokeragePeriod — "2026-07", seven characters. Compared as
    // strings, "2026-07" >= "2026-07-01" is FALSE: a prefix sorts before the longer
    // string. So this test never once returned true, and Avg AUM and Brokerage Share
    // read ₹0 for every member in every month. (Snapshot AUM escaped it because its
    // bound is one-sided — "2026-07" <= "2026-07-31" is true — which is exactly why
    // that one card showed a number while the two beside it sat at zero.)
    // A brokerage period has no day component, so the honest comparison is by month.
    const monthOf = (d: string) => String(d || '').slice(0, 7);
    const inRange = (d: string, s: string, e: string) => {
      const m = monthOf(d);
      return m >= monthOf(s) && m <= monthOf(e);
    };

    type Snap = Record<string, { date: string; value: number }>;
    const upsertSnap = (snap: Snap, key: string, date: string, value: number) => {
      const cur = snap[key];
      if (!cur || date > cur.date) snap[key] = { date, value };
    };

    // ── Pre-index transactions by (broker.id, level) — turns the original
    //    O(brokers × transactions) loop into O(transactions × maxLevels).
    //    For each transaction, we look up its client once and bucket the tx
    //    against every level in that client's hierarchy. Then per-broker
    //    aggregation is just a Map lookup, not a full transactions scan.
    const txByBrokerId = new Map<string, typeof transactions>();
    for (const tx of transactions) {
      if (!tx.mappedClientId) continue;
      const client = clientMap.get(tx.mappedClientId);
      if (!client) continue;
      for (let lvl = 1; lvl <= 7; lvl++) {
        const memberId = client.hierarchy[`level${lvl}Id` as keyof Client['hierarchy']];
        if (!memberId) continue;
        let bucket = txByBrokerId.get(memberId);
        if (!bucket) { bucket = []; txByBrokerId.set(memberId, bucket); }
        bucket.push(tx);
      }
    }

    const rows = brokerScope.filter(b => b.level >= 1 && b.level <= 7).map(broker => {
      let avgAUMCurr = 0, avgAUMPrev = 0, brokerageCurr = 0, brokeragePrev = 0;
      let aumRowsCurr = 0, aumRowsPrev = 0;
      // Transactions in each window, regardless of whether they carry an AUM. A month
      // that has none at all is not a month that fell 100% — it is a month that has
      // not been imported yet, and it must not be drawn as a collapse.
      let txCurr = 0, txPrev = 0;
      const snapCurr: Snap = {};
      const snapPrev: Snap = {};

      const brokerTxs = txByBrokerId.get(broker.id) || [];
      for (const tx of brokerTxs) {
        const period = tx.brokeragePeriod || tx.transactionDate;
        const txDate = tx.transactionDate;
        const folioKey = `${tx.folio}|${tx.schemeName}`;

        // Bound the snapshot by the BROKERAGE PERIOD, not the transaction date.
        // CAMS writes the original investment date into transactionDate, so a July
        // row routinely carries a date from March. Both windows then picked the very
        // same rows and month-over-month growth came out 0.00% for everyone.
        // Order within a window by period first, then date, so the latest month wins.
        // A ZERO is an import that carried no AUM, not a folio worth nothing. June
        // 2026 has 32,937 such rows, and because they rank latest they were
        // overwriting April and May's real snapshots with nothing.
        const aum = Number(tx.currentValue) || 0;
        if (aum > 0) {
          const rank = `${period}|${txDate}`;
          // Compared by month for the same reason as inRange above — relying on
          // "2026-07" <= "2026-07-31" happening to be true is luck, not intent.
          if (monthOf(period) <= monthOf(currEnd)) upsertSnap(snapCurr, folioKey, rank, aum);
          if (monthOf(period) <= monthOf(prevEnd)) upsertSnap(snapPrev, folioKey, rank, aum);
        }

        if (inRange(period, currStart, currEnd)) {
          txCurr++;
          // Count rows that actually CARRY an AUM. Testing for non-null counted the
          // zeros too, so a month with no AUM at all looked fully covered and the
          // guard below never fired — June read as a 100% collapse.
          if (aum > 0) { avgAUMCurr += aum; aumRowsCurr++; }
          brokerageCurr += calculateUserShare(tx, broker, globalConfig);
        }
        if (inRange(period, prevStart, prevEnd)) {
          txPrev++;
          if (aum > 0) { avgAUMPrev += aum; aumRowsPrev++; }
          brokeragePrev += calculateUserShare(tx, broker, globalConfig);
        }
      }

      const snapAUMCurr = Object.values(snapCurr).reduce((s, v) => s + v.value, 0);
      const snapAUMPrev = Object.values(snapPrev).reduce((s, v) => s + v.value, 0);

      const pct = (c: number, p: number): number | null => {
        if (p === 0) return c === 0 ? 0 : null;
        return ((c - p) / p) * 100;
      };
      // A window with no transactions at all cannot be compared — August 2026 showed
      // "-100%" against July purely because August has not been imported. And a window
      // whose rows all lack an AUM (June 2026: 40 transactions, none carrying
      // avg_assets) is a gap in the import, not a portfolio that vanished.
      const noData = txCurr === 0 || txPrev === 0;
      // Comparing AUM only means something when both months are covered to a similar
      // degree. June 2026 carries an AUM on 47% of its rows against 100% in May,
      // because the CAMS half of that import arrived without avg_assets — so an RM
      // whose clients are CAMS-only read −100% and a mixed book read −65%. Neither
      // book shrank; the figure is missing on one side. More than 20 points apart and
      // the two are not like-for-like, so no percentage is offered.
      const covCurr = txCurr ? aumRowsCurr / txCurr : 0;
      const covPrev = txPrev ? aumRowsPrev / txPrev : 0;
      const aumGap = !noData && (aumRowsCurr === 0 || aumRowsPrev === 0 || Math.abs(covCurr - covPrev) > 0.2);

      return {
        member: broker,
        avgAUMCurr, avgAUMPrev,
        avgAUMGrowth: (noData || aumGap) ? null : pct(avgAUMCurr, avgAUMPrev),
        aumIncomplete: aumRowsCurr === 0 && aumRowsPrev === 0,
        noData, aumGap, txCurr, txPrev, aumRowsCurr, aumRowsPrev,
        snapAUMCurr, snapAUMPrev, snapAUMGrowth: noData ? null : pct(snapAUMCurr, snapAUMPrev),
        brokerageCurr, brokeragePrev,
        brokerageGrowth: noData ? null : pct(brokerageCurr, brokeragePrev),
      };
    });

    // Hide brokers with no activity in either period
    const active = rows.filter(r =>
      r.brokerageCurr > 0 || r.brokeragePrev > 0 ||
      r.avgAUMCurr > 0 || r.avgAUMPrev > 0 ||
      r.snapAUMCurr > 0 || r.snapAUMPrev > 0
    );

    const keyOf = (r: typeof active[number]) =>
      growthSortKey === 'avgAum' ? r.avgAUMGrowth :
      growthSortKey === 'snapAum' ? r.snapAUMGrowth :
      r.brokerageGrowth;

    return active.sort((a, b) => {
      const av = keyOf(a), bv = keyOf(b);
      // null (no prior data) sorts to bottom
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }, [growthPeriods, brokerScope, transactions, clients, globalConfig, growthSortKey]);

  // ── Growth tab: aggregate totals for summary cards ─────────────────────────
  const growthTotals = useMemo(() => {
    const t = growthRows.reduce((a, r) => ({
      avgAumCurr: a.avgAumCurr + r.avgAUMCurr, avgAumPrev: a.avgAumPrev + r.avgAUMPrev,
      snapAumCurr: a.snapAumCurr + r.snapAUMCurr, snapAumPrev: a.snapAumPrev + r.snapAUMPrev,
      brokerCurr: a.brokerCurr + r.brokerageCurr, brokerPrev: a.brokerPrev + r.brokeragePrev,
    }), { avgAumCurr: 0, avgAumPrev: 0, snapAumCurr: 0, snapAumPrev: 0, brokerCurr: 0, brokerPrev: 0 });
    const pct = (c: number, p: number): number | null => p === 0 ? (c === 0 ? 0 : null) : ((c - p) / p) * 100;
    // If NO member has a transaction on one side, the month itself is missing — the
    // headline cards must say so rather than print a 100% fall.
    const anyCurr = growthRows.some(r => r.txCurr > 0);
    const anyPrev = growthRows.some(r => r.txPrev > 0);
    const noData = growthRows.length > 0 && (!anyCurr || !anyPrev);
    // Judge the headline on the WHOLE book's coverage, not on every member having a
    // gap — with one month covered 47% and the other 100%, the total is as misleading
    // as any single row.
    const sum = (f: (r: typeof growthRows[number]) => number) => growthRows.reduce((a, r) => a + f(r), 0);
    const covCurr = sum(r => r.txCurr) ? sum(r => r.aumRowsCurr) / sum(r => r.txCurr) : 0;
    const covPrev = sum(r => r.txPrev) ? sum(r => r.aumRowsPrev) / sum(r => r.txPrev) : 0;
    const aumGap = !noData && (covCurr === 0 || covPrev === 0 || Math.abs(covCurr - covPrev) > 0.2);
    return {
      ...t,
      noData, aumGap,
      avgAumGrowth: (noData || aumGap) ? null : pct(t.avgAumCurr, t.avgAumPrev),
      snapAumGrowth: noData ? null : pct(t.snapAumCurr, t.snapAumPrev),
      brokerGrowth: noData ? null : pct(t.brokerCurr, t.brokerPrev),
    };
  }, [growthRows]);

  // `existing` set => the user is MODIFYING an invoice they already submitted.
  // Only possible while it is still SUBMITTED (the server enforces this too);
  // the amount is re-pulled from current payouts so an edit picks up any recalc.
  const handleRaiseInvoice = async (monthItem: any, existing?: PayoutInvoice) => {
    if (!currentUser.bankDetails || !currentUser.bankDetails.accountNumber) {
      showToast("Please update your bank details in Profile settings before raising an invoice.", 'warning');
      return;
    }
    const roleName = globalConfig.levelNames[currentUser.level as keyof typeof globalConfig.levelNames] || `Level ${currentUser.level}`;

    const cfg = globalConfig as any;
    // Use proper rounding to avoid precision loss
    const baseAmount = Math.round(monthItem.myShare * 100) / 100;
    // GST applies ONLY when the RM has a GSTIN (they can't legally charge it
    // otherwise). Rate + intra/inter split come from config vs the RM's state.
    const gstOn = !!(currentUser.gstNumber && String(currentUser.gstNumber).trim());
    const gstRate = Number(cfg.defaultGstRate) || taxConfig.gstRate || 18;
    const gstBreakdown = gstOn
      ? computeGstSplit(baseAmount, gstRate, globalConfig.firmState, currentUser.address?.state)
      : null;
    const gstAmount = gstBreakdown?.gstAmount ?? 0;
    // TDS defaults to 2% (194H). Applied whenever the toggle is on.
    const tdsOn = !!taxConfig.tdsEnabled;
    const tdsRate = Number(cfg.defaultTdsRate) || taxConfig.tdsRate || 2;
    const tdsAmount = tdsOn ? Math.round(baseAmount * tdsRate) / 100 : 0;
    // Round the payable to the nearest whole rupee (Tally style) and record the diff.
    const rawNet = baseAmount + gstAmount - tdsAmount;
    const netPayable = Math.round(rawNet);
    const roundOff = Math.round((netPayable - rawNet) * 100) / 100;
    const invoiceNumber = existing?.invoiceNumber
      || `INV-${monthItem.month.replace('-', '')}-${String(Date.now()).slice(-6)}`;

    const newInvoice: PayoutInvoice = {
      id: existing?.id || `inv_${monthItem.month}_${currentUser.id}`, // deterministic → re-raising overwrites, never duplicates
      invoiceNumber,
      invoiceDate: existing?.invoiceDate || new Date().toISOString().split('T')[0],
      userId: currentUser.id,
      userName: currentUser.name,
      userRole: roleName,
      month: monthItem.month,
      amount: baseAmount,
      status: InvoiceStatus.SUBMITTED,
      submittedDate: new Date().toISOString().split('T')[0],
      transactionCount: monthItem.count,
      bankSnapshot: currentUser.bankDetails,
      addressSnapshot: currentUser.address,
      gstEnabled: gstOn,
      gstRate: gstOn ? gstRate : undefined,
      gstAmount: gstOn ? gstAmount : undefined,
      gstSplit: gstBreakdown?.split,
      cgstRate: gstBreakdown?.cgstRate,
      cgstAmount: gstBreakdown?.cgstAmount,
      sgstRate: gstBreakdown?.sgstRate,
      sgstAmount: gstBreakdown?.sgstAmount,
      igstRate: gstBreakdown?.igstRate,
      igstAmount: gstBreakdown?.igstAmount,
      tdsEnabled: tdsOn,
      tdsRate: tdsOn ? tdsRate : undefined,
      tdsAmount: tdsOn ? tdsAmount : undefined,
      netPayable,
      roundOff,
      gstNumber: currentUser.gstNumber,
      hsnSac: cfg.defaultHsnSac || '997152',
      sellerGstin: currentUser.gstNumber,
      sellerPan: (currentUser as any).pan,
      sellerState: currentUser.address?.state,
      signatureSnapshot: (currentUser as any).signature,
    };
    // Do NOT save yet. Raising an invoice is a money action, so it goes through a
    // review step: the user sees every figure (base, GST split, TDS, round-off,
    // net payable), the bank account it will be paid into, and can correct the
    // invoice number — then explicitly confirms. Nothing is written until then.
    setInvoiceDraft({ invoice: newInvoice, isEdit: !!existing, gross: monthItem.gross ?? 0 });
  };

  // Persist the reviewed draft. Only reached from the review dialog's Confirm.
  const confirmRaiseInvoice = async () => {
    if (!invoiceDraft || savingInvoice) return;
    const num = (invoiceDraft.invoice.invoiceNumber || '').trim();
    if (!num) { showToast('Enter an invoice number before confirming.', 'warning'); return; }
    setSavingInvoice(true);
    try {
      const ok = await addInvoice({ ...invoiceDraft.invoice, invoiceNumber: num });
      if (ok) {
        showToast(invoiceDraft.isEdit ? `Invoice ${num} updated.` : `Invoice ${num} raised successfully.`, 'success');
        setInvoiceDraft(null);
      }
    } finally {
      setSavingInvoice(false);
    }
  };

  const handleApproveInvoice = async (inv: PayoutInvoice) => {
    if (!canApproveInvoices) {
      showToast('Only admins can approve invoices.', 'warning');
      return;
    }
    const confirmed = await showConfirm({
      title: 'Approve invoice for settlement?',
      message: `Approve ${inv.userName}'s invoice ${inv.id} for ₹${(inv.netPayable ?? inv.amount).toLocaleString()}? It will move to the payment queue but is not yet paid out.`,
      confirmText: 'Approve',
      variant: 'info'
    });
    if (!confirmed) return;
    updateInvoice({
      ...inv,
      status: InvoiceStatus.APPROVED,
      approvedDate: new Date().toISOString().split('T')[0],
      approvedBy: currentUser.id,
      approvedByName: currentUser.name,
    });
    showToast(`Invoice approved. It is now in the payment queue.`, 'success');
  };

  const handleSettleInvoice = async (inv: PayoutInvoice) => {
    if (!canSettleInvoices) {
      showToast('Only Finance or Admin can release payments.', 'warning');
      return;
    }
    if (inv.status !== InvoiceStatus.APPROVED) {
      showToast('Invoice must be approved before it can be settled.', 'warning');
      return;
    }
    const confirmed = await showConfirm({
      title: 'Confirm Payment',
      message: `Mark ${inv.userName}'s invoice ${inv.id} for ₹${(inv.netPayable ?? inv.amount).toLocaleString()} as PAID? Record this only after the bank transfer is complete.`,
      confirmText: 'Mark Paid',
      variant: 'info'
    });
    if (!confirmed) return;
    updateInvoice({ ...inv, status: InvoiceStatus.PAID, paidDate: new Date().toISOString().split('T')[0] });
    showToast('Invoice settled successfully.', 'success');
  };

  const handleRejectInvoice = async (inv: PayoutInvoice) => {
    if (!canRejectInvoices) {
      showToast('Only Admin or Finance can reject invoices.', 'warning');
      return;
    }
    const reason = window.prompt(`Reject invoice ${inv.id} — provide a reason (visible to ${inv.userName}):`);
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('A rejection reason is required.', 'warning');
      return;
    }
    updateInvoice({
      ...inv,
      status: InvoiceStatus.REJECTED,
      rejectedDate: new Date().toISOString().split('T')[0],
      rejectedBy: currentUser.id,
      rejectedByName: currentUser.name,
      rejectionReason: reason.trim(),
    });
    showToast('Invoice rejected. Payee will be notified.', 'success');
  };

  const generateInvoicePDF = async (inv: PayoutInvoice) => {
    // Dynamic-import keeps jsPDF (~50KB gzipped) out of the main Reports bundle.
    const [{ jsPDF }, autoTableMod] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = autoTableMod.default;
    const doc = new jsPDF();
    // jsPDF ships with Helvetica which lacks the Unicode rupee glyph (₹ → renders as ¹).
    // Use the standard "Rs." abbreviation inside PDFs.
    const RS = 'Rs.';

    // Helper: Number to Words (Indian System), with paise — e.g.
    // "One Hundred Ninety Two Rupees and Thirty Four Paise Only".
    const numberToWords = (num: number): string => {
      const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
      const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
      const format = (n: number) => {
        if (n < 20) return a[n];
        return b[Math.floor(n / 10)] + (n % 10 !== 0 ? '-' + a[n % 10] : '');
      };
      const convert = (n: number): string => {
        if (n === 0) return '';
        if (n < 100) return format(n);
        if (n < 1000) return a[Math.floor(n / 100)] + 'Hundred ' + (n % 100 !== 0 ? convert(n % 100) : '');
        if (n < 100000) return convert(Math.floor(n / 1000)) + 'Thousand ' + (n % 1000 !== 0 ? convert(n % 1000) : '');
        if (n < 10000000) return convert(Math.floor(n / 100000)) + 'Lakh ' + (n % 100000 !== 0 ? convert(n % 100000) : '');
        return convert(Math.floor(n / 10000000)) + 'Crore ' + (n % 10000000 !== 0 ? convert(n % 10000000) : '');
      };
      const rupees = Math.floor(num);
      const paise = Math.round((num - rupees) * 100);
      const rWords = convert(rupees).trim();
      let out = 'INR ' + (rWords || 'Zero') + ' Rupees';
      if (paise > 0) out += ' and ' + convert(paise).trim() + ' Paise';
      return out + ' Only';
    };

    // ── Values: seller = the RM, buyer = the company (config). GST only when the
    //    RM has a GSTIN; TDS/round-off from the stored invoice snapshot. ──────────
    const seller = team.find(t => t.id === inv.userId);
    const cfg = globalConfig as any;
    const base = inv.amount;
    const cgst = inv.gstEnabled ? (inv.cgstAmount || 0) : 0;
    const sgst = inv.gstEnabled ? (inv.sgstAmount || 0) : 0;
    const igst = inv.gstEnabled ? (inv.igstAmount || 0) : 0;
    const tds = inv.tdsEnabled ? (inv.tdsAmount || 0) : 0;
    const roundOff = inv.roundOff || 0;
    const grandTotal = inv.netPayable ?? (base + cgst + sgst + igst - tds + roundOff);
    const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── Outer frame ──────────────────────────────────────────────────────────
    const L = 12, Rt = 198, W = Rt - L;
    doc.setDrawColor(30, 41, 59);
    doc.setLineWidth(0.3);

    // Indian display formats: date 24-Jul-2026, month May-2026.
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmtDate = (iso?: string) => {
      if (!iso) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
      if (!m) return iso;
      return `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}`;
    };
    const fmtMonth = (ym?: string) => {
      const m = /^(\d{4})-(\d{2})/.exec(ym || '');
      return m ? `${MON[Number(m[2]) - 1]}-${m[1]}` : (ym || '');
    };

    // Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(30, 41, 59);
    doc.text('TAX INVOICE', 105, 16, { align: 'center' });

    let y = 22;
    doc.rect(L, y, W, 40); // seller / invoice-meta band
    doc.line(130, y, 130, y + 40); // vertical split

    // Seller (left)
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text((inv.userName || '').toUpperCase(), L + 3, y + 7);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    let sy = y + 12;
    const addr = inv.addressSnapshot;
    if (addr) { doc.text([`${addr.street || ''}`, `${addr.city || ''}${addr.pincode ? ' - ' + addr.pincode : ''}`].filter(Boolean).join(', '), L + 3, sy); sy += 5; }
    doc.text('GSTIN/UIN      : ' + (inv.sellerGstin || seller?.gstNumber || '-'), L + 3, sy); sy += 5;
    doc.text('PAN             : ' + (inv.sellerPan || seller?.pan || '-'), L + 3, sy); sy += 5;
    doc.text('State Name   : ' + (inv.sellerState || addr?.state || '-'), L + 3, sy);

    // Invoice meta (right)
    doc.setFontSize(9);
    const metaRows: [string, string][] = [
      ['Invoice No.', inv.invoiceNumber || inv.id],
      ['Invoice Month', fmtMonth(inv.month)],
      ['Dated', fmtDate(inv.invoiceDate || inv.submittedDate)],
    ];
    let my = y + 7;
    for (const [k, v] of metaRows) {
      doc.setFont('helvetica', 'normal'); doc.text(k, 133, my);
      doc.setFont('helvetica', 'bold'); doc.text(String(v), 196, my, { align: 'right' });
      my += 8;
    }

    // ── "To" (company) band ──────────────────────────────────────────────────
    y += 40;
    const toH = 34;
    doc.rect(L, y, W, toH);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('To', L + 3, y + 5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text((cfg.firmName || 'NEXTFREEDOM LIFEX PRIVATE LIMITED').toUpperCase(), L + 3, y + 11);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    let ty = y + 16;
    if (cfg.firmAddressLine1) { doc.text(String(cfg.firmAddressLine1), L + 3, ty); ty += 5; }
    if (cfg.firmAddressLine2) { doc.text(String(cfg.firmAddressLine2), L + 3, ty); ty += 5; }
    doc.text('State Name : ' + (cfg.firmState || '-') + (cfg.firmStateCode ? ', Code : ' + cfg.firmStateCode : ''), L + 3, ty); ty += 5;
    doc.text('GSTIN : ' + (cfg.firmGstin || '-'), L + 3, ty);

    // ── Line-item table ──────────────────────────────────────────────────────
    y += toH + 2;
    autoTable(doc, {
      startY: y,
      head: [['Sl\nNo', 'Description of Services', 'HSN/SAC', 'Amount (Rs.)']],
      body: [['1', 'Brokerage Commission of Distributor', inv.hsnSac || cfg.defaultHsnSac || '', RS + ' ' + money(base)]],
      theme: 'grid',
      headStyles: { fillColor: [235, 238, 245], textColor: [30, 41, 59], fontStyle: 'bold', fontSize: 9, lineColor: [30, 41, 59], lineWidth: 0.2, halign: 'center' },
      bodyStyles: { fontSize: 9, textColor: [30, 41, 59], lineColor: [30, 41, 59], lineWidth: 0.2, minCellHeight: 14 },
      columnStyles: { 0: { cellWidth: 12, halign: 'center' }, 1: { cellWidth: 108 }, 2: { cellWidth: 26, halign: 'center' }, 3: { cellWidth: W - 12 - 108 - 26, halign: 'right' } },
      margin: { left: L, right: 12 },
    });
    let ay = (doc as any).lastAutoTable.finalY;

    // Totals block (right-aligned rows under the table). GST is always shown as
    // CGST + SGST (intra-state); IGST is never used in this system, so its row is
    // omitted. When IGST somehow carries a value, fold it into the CGST/SGST halves.
    const totalRows: [string, string][] = [['Total', RS + ' ' + money(base)]];
    if (inv.gstEnabled) {
      const half = igst > 0 ? igst / 2 : 0;
      const cg = cgst || half, sg = sgst || half;
      const rate = inv.cgstRate ?? ((inv.gstRate ?? cfg.defaultGstRate ?? 18) / 2);
      totalRows.push([`CGST @ ${rate}%`, RS + ' ' + money(cg)]);
      totalRows.push([`SGST @ ${rate}%`, RS + ' ' + money(sg)]);
    }
    if (tds > 0) totalRows.push([`TDS Deduction @ ${inv.tdsRate ?? cfg.defaultTdsRate ?? 2}%`, '(' + RS + ' ' + money(tds) + ')']);
    if (Math.abs(roundOff) >= 0.005) totalRows.push(['Round Off', (roundOff < 0 ? '(-)' : '') + RS + ' ' + money(Math.abs(roundOff))]);

    doc.setFontSize(9);
    for (const [k, v] of totalRows) {
      ay += 6;
      doc.setFont('helvetica', 'normal'); doc.text(k, 120, ay, { align: 'right' });
      doc.text(v, 196, ay, { align: 'right' });
    }
    ay += 8;
    doc.setDrawColor(30, 41, 59); doc.line(120, ay - 4, Rt, ay - 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Total Payable Amount', 120, ay, { align: 'right' });
    doc.text(RS + ' ' + money(grandTotal), 196, ay, { align: 'right' });

    // Amount in words
    ay += 8;
    doc.setDrawColor(30, 41, 59); doc.rect(L, ay - 5, W, 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Amount Chargeable (in words)', L + 3, ay - 1);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text(numberToWords(grandTotal), L + 3, ay + 4);

    // ── Bank details + declaration + signature ───────────────────────────────
    ay += 14;
    const boxH = 48;
    doc.rect(L, ay, W, boxH);
    doc.line(120, ay, 120, ay + boxH);
    // Bank (left) — where the company pays the RM
    const bank = inv.bankSnapshot;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('Bank Details for Payment', L + 3, ay + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Bank Name : ' + (bank?.bankName || cfg.firmBankName || '-'), L + 3, ay + 13);
    doc.text('A/C Name  : ' + (bank?.accountName || inv.userName || '-'), L + 3, ay + 18);
    doc.text('A/C No.     : ' + (bank?.accountNumber || cfg.firmBankAccount || '-'), L + 3, ay + 23);
    doc.text('IFSC Code : ' + (bank?.ifscCode || cfg.firmBankIfsc || '-'), L + 3, ay + 28);
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(90, 90, 90);
    doc.text(doc.splitTextToSize('Declaration: We declare that this invoice shows the actual price of the services described and that all particulars are true and correct.', 100), L + 3, ay + 36);
    doc.setTextColor(30, 41, 59);
    // Signatory (right) — only the signature image + "Authorised Signatory" (no
    // "for <name>" line, per the requested format).
    const sig = inv.signatureSnapshot || seller?.signature;
    if (sig && /^data:image\//i.test(sig)) {
      try {
        const fmt = /png/i.test(sig) ? 'PNG' : 'JPEG';
        doc.addImage(sig, fmt, 140, ay + 9, 40, 18);
      } catch { /* ignore malformed image */ }
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Authorised Signatory', 196, ay + boxH - 3, { align: 'right' });

    // Footer
    doc.setFontSize(7); doc.setTextColor(120, 120, 120);
    doc.text('This is a Computer Generated Invoice', 105, ay + boxH + 6, { align: 'center' });

    doc.save(`Invoice_${inv.invoiceNumber || inv.id}.pdf`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Brokerage Settlements</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1 font-medium">Financial audit and payout management.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={filters.month} onChange={e => setFilters({ ...filters, month: e.target.value })} className="border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-slate-100 font-bold">
            <option value="All">All Months</option>
            {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map(m => (
              <option key={m} value={m}>{new Date(2000, parseInt(m) - 1).toLocaleString('default', { month: 'long' })}</option>
            ))}
          </select>
          <select value={filters.year} onChange={e => setFilters({ ...filters, year: e.target.value })} className="border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-slate-100 font-bold">
            {yearsList.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => setActiveTab('invoices')} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 px-4 py-1.5 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center">
            <Landmark className="w-3 h-3 mr-2 text-blue-600" /> Payouts
          </button>
        </div>
      </div>

      <div className="border-b border-slate-200 dark:border-slate-700">
        <nav className="-mb-px flex space-x-6 overflow-x-auto">
          {[
            { id: 'overview', label: 'Summary', icon: Layers },
            { id: 'monthly', label: 'Monthly Payouts', icon: Clock },
            { id: 'client-summary', label: 'Client-wise', icon: Briefcase },
            { id: 'transactions', label: 'Logs', icon: FileText },
            (isAdmin || useData().team.some(m => m.parentId === currentUser.id)) && { id: 'team-payouts', label: 'Team Payouts', icon: Users },
            { id: 'growth', label: 'Growth', icon: TrendingUp },
            (isAdmin || isFinance) && { id: 'approvals', label: 'Approvals Queue', icon: ShieldCheck },
            (isAdmin || isFinance) && { id: 'reconciliation', label: 'Reconciliation', icon: AlertTriangle },
          ].filter(Boolean).map((tab: any) => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); setCurrentPage(1); }} className={`whitespace-nowrap py-4 px-1 border-b-2 font-black uppercase tracking-widest text-[10px] flex items-center transition-all ${activeTab === tab.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}>
              <tab.icon className="w-3.5 h-3.5 mr-2" /> {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {txTruncated && !isAllPeriod && (isAdmin || !myServerPeriodStats) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2.5 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
              Showing the most recent {transactions.length.toLocaleString()} of {serverSummary!.totalTx.toLocaleString()} transactions. Figures for this period are based on that subset — clear the period filter for server-authoritative totals, or use Team Payouts.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in slide-in-from-bottom-2">
            {isAdmin && (
              <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <h3 className="text-slate-500 dark:text-slate-400 font-bold uppercase text-[10px] tracking-widest">System Gross</h3>
                <p className="text-3xl font-black text-slate-900 dark:text-slate-100 mt-2">₹{overviewGross.toLocaleString()}</p>
              </div>
            )}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <h3 className="text-slate-500 dark:text-slate-400 font-bold uppercase text-[10px] tracking-widest">My Net Payout</h3>
              <p className="text-3xl font-black text-emerald-600 mt-2">₹{(myServerPeriodStats ? myServerPeriodStats.net : totalMyNetAllTime).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <h3 className="text-slate-500 dark:text-slate-400 font-bold uppercase text-[10px] tracking-widest">Transactions</h3>
              {/* Non-admin: their OWN ledger tx count (server). Admin keeps the
                  system-wide overview count (uncapped for the all-period view). */}
              <p className="text-3xl font-black text-slate-900 dark:text-slate-100 mt-2">{(!isAdmin && myServerPeriodStats ? myServerPeriodStats.count : overviewTxCount).toLocaleString()}</p>
            </div>
          </div>

          {isAdmin && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in">
              <div className="p-4 bg-slate-50 border-b border-slate-200">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">Month-wise Gross Breakdown</h3>
              </div>
              <table className="w-full text-sm text-left">
                <thead className="bg-white text-slate-400 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
                  <tr>
                    <th className="px-6 py-4">Month</th>
                    <th className="px-6 py-4 text-center">Volume</th>
                    <th className="px-6 py-4 text-right">Gross Brokerage (₹)</th>
                    <th className="px-6 py-4 text-right">Payout Pool (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(periodTotals ? visiblePeriods : monthlySummary.map(m => ({
                    period: m.month, rows: m.count, gross: m.gross, distributed: null,
                  }))).map(p => (
                    <tr key={p.period} className="hover:bg-slate-50">
                      <td className="px-6 py-4 font-bold">{p.period}</td>
                      <td className="px-6 py-4 text-center font-medium">{p.rows.toLocaleString()}</td>
                      <td className="px-6 py-4 text-right font-bold">₹{p.gross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4 text-right font-black text-blue-600">
                        {/* What payout_ledger actually holds — the same figure Team
                            Payouts reports. Only when a month has no ledger rows yet
                            do we fall back to the company-expense split, and say so. */}
                        ₹{(p.distributed ?? (p.gross * (1 - (globalConfig.companyExpensePct / 100)))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {p.distributed === null && (
                          <span className="block text-[9px] font-black uppercase tracking-widest text-amber-600">not recalculated yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'monthly' && (
        <div className="space-y-4 animate-in fade-in">
          {/* GST/TDS Configuration Panel */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mb-3">Tax Settings for Invoice</h3>
            <div className="flex flex-wrap gap-6">
              {/* GST Toggle */}
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={taxConfig.gstEnabled} onChange={e => saveTaxConfig({ ...taxConfig, gstEnabled: e.target.checked })} />
                  <div className="w-9 h-5 bg-slate-200 dark:bg-slate-600 peer-checked:bg-blue-600 rounded-full transition peer-focus:ring-2 peer-focus:ring-blue-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4"></div>
                </label>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">GST</span>
                {taxConfig.gstEnabled && (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={taxConfig.gstRate}
                      onChange={e => saveTaxConfig({ ...taxConfig, gstRate: parseFloat(e.target.value) || 18 })}
                      className="w-14 text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-1 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                      min={0} max={100} step={0.5}
                    />
                    <span className="text-xs text-slate-500 dark:text-slate-400">%</span>
                  </div>
                )}
                {taxConfig.gstEnabled && <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold">Will add GST on invoice</span>}
              </div>

              {/* TDS Toggle */}
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={taxConfig.tdsEnabled} onChange={e => saveTaxConfig({ ...taxConfig, tdsEnabled: e.target.checked })} />
                  <div className="w-9 h-5 bg-slate-200 dark:bg-slate-600 peer-checked:bg-amber-500 rounded-full transition peer-focus:ring-2 peer-focus:ring-amber-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4"></div>
                </label>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">TDS Deduction</span>
                {taxConfig.tdsEnabled && (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={taxConfig.tdsRate}
                      onChange={e => saveTaxConfig({ ...taxConfig, tdsRate: parseFloat(e.target.value) || 10 })}
                      className="w-14 text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-1 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                      min={0} max={100} step={0.5}
                    />
                    <span className="text-xs text-slate-500 dark:text-slate-400">%</span>
                  </div>
                )}
                {taxConfig.tdsEnabled && <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold">Will deduct TDS from net payable</span>}
              </div>
            </div>
          </div>

          {/* Monthly table */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700 flex justify-end">
              <button
                onClick={() => {
                  const rows = monthlySummary.map(m => {
                    const base = Math.round(m.myShare * 100) / 100;
                    const gst = taxConfig.gstEnabled ? Math.round(base * taxConfig.gstRate) / 100 : 0;
                    const tds = taxConfig.tdsEnabled ? Math.round(base * taxConfig.tdsRate) / 100 : 0;
                    return { Period: m.month, Transactions: m.count, 'My Share (Rs.)': base, 'GST (Rs.)': gst, 'TDS (Rs.)': tds, 'Net Payable (Rs.)': Math.round((base + gst - tds) * 100) / 100 };
                  });
                  exportToExcel(rows, `WealthflowPayouts_${new Date().toISOString().slice(0,7)}`, 'Monthly Payouts');
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition"
              >
                <Download className="w-3.5 h-3.5" /> Export Excel
              </button>
            </div>
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-black border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[9px]">
                <tr>
                  <th className="px-6 py-4">Settlement Period</th>
                  <th className="px-6 py-4 text-center">Txs</th>
                  <th className="px-6 py-4 text-right">My Share (₹)</th>
                  {(taxConfig.gstEnabled || taxConfig.tdsEnabled) && <th className="px-6 py-4 text-right">Net Payable (₹)</th>}
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {monthlySummary.map(m => {
                  // Use proper rounding for display calculations
                  const baseAmount = Math.round(m.myShare * 100) / 100;
                  const gstAmt = taxConfig.gstEnabled ? Math.round(baseAmount * taxConfig.gstRate) / 100 : 0;
                  const tdsAmt = taxConfig.tdsEnabled ? Math.round(baseAmount * taxConfig.tdsRate) / 100 : 0;
                  const netPayable = Math.round((baseAmount + gstAmt - tdsAmt) * 100) / 100;
                  return (
                    <tr key={m.month} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition">
                      <td className="px-6 py-4 font-bold text-slate-700 dark:text-slate-300">{m.month}</td>
                      <td className="px-6 py-4 text-center text-slate-500 dark:text-slate-400 font-bold">{m.count}</td>
                      <td className="px-6 py-4 text-right font-black text-emerald-600 dark:text-emerald-400 text-base">₹{m.myShare.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      {(taxConfig.gstEnabled || taxConfig.tdsEnabled) && (
                        <td className="px-6 py-4 text-right font-black text-blue-600 dark:text-blue-400">
                          ₹{netPayable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          <div className="text-[9px] text-slate-400 font-normal">
                            {taxConfig.gstEnabled && `+GST ₹${gstAmt.toFixed(0)}`}
                            {taxConfig.gstEnabled && taxConfig.tdsEnabled && ' · '}
                            {taxConfig.tdsEnabled && `-TDS ₹${tdsAmt.toFixed(0)}`}
                          </div>
                        </td>
                      )}
                      <td className="px-6 py-4 text-center">
                        {m.invoice ? (
                          <div className="flex items-center justify-center gap-2">
                            <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase border ${m.invoice.status === 'PAID' ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800' : m.invoice.status === 'REJECTED' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800'}`}>{m.invoice.status}</span>
                            {/* An invoice can be edited only while it is still SUBMITTED —
                                once Finance approves or pays it, it is locked. */}
                            {m.invoice.status === 'SUBMITTED' ? (
                              <button onClick={() => handleRaiseInvoice(m, m.invoice)} className="text-blue-600 dark:text-blue-400 hover:bg-blue-600 hover:text-white transition font-black text-[10px] border border-blue-200 dark:border-blue-700 px-3 py-1.5 rounded-lg uppercase tracking-widest" title="Change the invoice number and refresh the amount">Modify</button>
                            ) : (
                              <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wide" title={`Locked — the invoice has been ${String(m.invoice.status).toLowerCase()} and can no longer be edited.`}>Locked</span>
                            )}
                          </div>
                        ) : (
                          <button onClick={() => handleRaiseInvoice(m)} className="text-blue-600 dark:text-blue-400 hover:bg-blue-600 hover:text-white transition font-black text-[10px] border border-blue-200 dark:border-blue-700 px-4 py-1.5 rounded-lg uppercase tracking-widest shadow-sm">Raise Invoice</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'client-summary' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-4 w-full md:w-auto">
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-900 whitespace-nowrap">Investor Breakdown</h3>
              <div className="relative w-full md:w-64">
                <Search className="absolute left-3 top-2.5 text-slate-400 w-3 h-3" />
                <input
                  type="text"
                  placeholder="Search investor or PAN..."
                  value={clientSearchTerm}
                  onChange={(e) => {
                    setClientSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-9 pr-4 py-2 w-full border border-slate-200 rounded-xl text-[10px] font-bold focus:ring-2 focus:ring-blue-500 bg-white uppercase transition-all"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] bg-blue-100 text-blue-700 font-black px-2 py-1 rounded-full whitespace-nowrap">{filteredClientWiseSummary.length} Investors Found</span>
              <button
                onClick={() => {
                  const rows = filteredClientWiseSummary.map(c => ({
                    Investor: c.name,
                    PAN: c.pan,
                    Transactions: c.count,
                    ...(isAdmin ? { 'Gross Amount (Rs.)': c.gross.toFixed(2) } : {}),
                    'My Share (Rs.)': c.myShare.toFixed(2),
                    'AUM (Rs.)': c.aum ? Math.round(c.aum) : '',
                    'AUM As Of': c.aumAsOf,
                  }));
                  exportToExcel(rows, `WealthflowClients_${new Date().toISOString().slice(0,7)}`, 'Client Summary');
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition"
              >
                <Download className="w-3.5 h-3.5" /> Export Excel
              </button>
            </div>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-500 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">Investor Name</th>
                <th className="px-6 py-4">PAN</th>
                <th className="px-6 py-4 text-center">Txs</th>
                {isAdmin && <th className="px-6 py-4 text-right">Gross (₹)</th>}
                <th className="px-6 py-4 text-right">AUM</th>
                <th className="px-6 py-4 text-right">My Share (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredClientWiseSummary.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(c => (
                <tr key={c.id} className="hover:bg-slate-50 transition">
                  <td className="px-6 py-4 font-bold text-slate-700">{c.name}</td>
                  <td className="px-6 py-4 font-mono text-[10px] text-slate-400">{c.pan}</td>
                  <td className="px-6 py-4 text-center text-slate-500 font-bold">{c.count}</td>
                  {isAdmin && <td className="px-6 py-4 text-right font-medium text-slate-900">₹{c.gross.toLocaleString()}</td>}
                  <td className="px-6 py-4 text-right">
                    {c.aum > 0 ? (
                      <>
                        <div className="font-black text-emerald-600">{formatCompactINR(c.aum)}</div>
                        <div className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{c.aumAsOf}</div>
                      </>
                    ) : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                  <td className="px-6 py-4 text-right font-black text-emerald-600 text-base">₹{c.myShare.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            currentPage={currentPage}
            totalItems={filteredClientWiseSummary.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
          />
        </div>
      )}

      {activeTab === 'transactions' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in">
          <div className="px-4 py-2 border-b border-slate-100 flex justify-end">
            <button
              onClick={() => {
                const rows = visibleTransactions.map(tx => {
                  const myShare = calculateUserShare(tx, currentUser, globalConfig);
                  const effectiveRate = tx.grossAmount > 0 ? ((myShare / tx.grossAmount) * (tx.brokerageRate || 0)).toFixed(4) : '0';
                  return {
                    Date: tx.transactionDate,
                    Period: tx.brokeragePeriod || '',
                    Investor: tx.investorName || '',
                    AMC: tx.amcName || '',
                    Scheme: tx.schemeName || '',
                    Category: tx.category || '',
                    ...(isAdmin ? { 'Gross Amount (Rs.)': tx.grossAmount } : {}),
                    'Effective Rate (%)': effectiveRate,
                    'My Share (Rs.)': myShare.toFixed(2),
                  };
                });
                exportToExcel(rows, `WealthflowTransactions_${new Date().toISOString().slice(0,10)}`, 'Transactions');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition"
            >
              <Download className="w-3.5 h-3.5" /> Export Excel
            </button>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-500 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">Date</th>
                <th className="px-6 py-4">Investor / Scheme</th>
                <th className="px-6 py-4 text-center">My Rate (%)</th>
                <th className="px-6 py-4 text-right">My Share (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleTransactions.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(tx => {
                const myShare = calculateUserShare(tx, currentUser, globalConfig);
                // Calculate effective rate for user
                const myRate = tx.grossAmount > 0 ? (myShare / tx.grossAmount) * (tx.brokerageRate || 0) : 0;
                return (
                  <tr key={tx.id} className="hover:bg-slate-50 transition text-[11px]">
                    <td className="px-6 py-4 text-slate-500">{tx.transactionDate}</td>
                    <td className="px-6 py-4">
                      <div className="font-bold text-slate-900">{tx.investorName}</div>
                      <div className="text-[10px] text-slate-400 font-medium">{tx.schemeName}</div>
                    </td>
                    <td className="px-6 py-4 text-center font-bold text-indigo-600">
                      {myRate > 0 ? `${parseFloat(myRate.toFixed(4))}%` : '-'}
                    </td>
                    <td className="px-6 py-4 text-right font-black text-emerald-600">
                      ₹{myShare.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination
            currentPage={currentPage}
            totalItems={visibleTransactions.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
          />
        </div>
      )}

      {activeTab === 'invoices' && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden animate-in fade-in">
          <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
            <select
              value={invoiceStatusFilter}
              onChange={e => setInvoiceStatusFilter(e.target.value as typeof invoiceStatusFilter)}
              className="text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="PAID">Paid</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-black border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">Invoice No.</th>
                {isSuperUser && <th className="px-6 py-4">Distributor / RM</th>}
                <th className="px-6 py-4">Period</th>
                <th className="px-6 py-4 text-right">Base Amount (₹)</th>
                <th className="px-6 py-4 text-right">Net Payable (₹)</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {myInvoicesFiltered.map(inv => (
                <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition">
                  <td className="px-6 py-4 font-mono text-[10px] text-slate-400 dark:text-slate-500">{inv.invoiceNumber || inv.id}</td>
                  {isSuperUser && <td className="px-6 py-4 font-bold text-slate-700 dark:text-slate-300">{inv.userName}</td>}
                  <td className="px-6 py-4 font-bold text-slate-900 dark:text-slate-100">{inv.month}</td>
                  <td className="px-6 py-4 text-right font-bold text-slate-600 dark:text-slate-400">₹{inv.amount.toLocaleString()}</td>
                  <td className="px-6 py-4 text-right">
                    <span className="font-black text-emerald-600 dark:text-emerald-400">₹{(inv.netPayable ?? inv.amount).toLocaleString()}</span>
                    {(inv.gstEnabled || inv.tdsEnabled) && (
                      <div className="text-[9px] text-slate-400 font-normal mt-0.5">
                        {inv.gstEnabled && `+GST ${inv.gstRate}%`}
                        {inv.gstEnabled && inv.tdsEnabled && ' · '}
                        {inv.tdsEnabled && `-TDS ${inv.tdsRate}%`}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase border ${
                      inv.status === 'PAID' ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800'
                      : inv.status === 'APPROVED' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                      : inv.status === 'REJECTED' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800'
                      : inv.status === 'SUBMITTED' ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                      : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800'
                    }`} title={inv.status === 'REJECTED' && inv.rejectionReason ? `Reason: ${inv.rejectionReason}` : undefined}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button onClick={() => generateInvoicePDF(inv)} className="p-2 text-slate-400 hover:text-blue-600 bg-slate-50 dark:bg-slate-700 rounded-lg transition" title="Download PDF"><Download className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'approvals' && (isAdmin || isFinance) && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden animate-in fade-in">
          <div className="p-4 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-100 dark:border-blue-800 flex items-center justify-between">
            <div>
              <h3 className="font-black text-blue-900 dark:text-blue-300 uppercase tracking-tighter">Settlement Queue</h3>
              <p className="text-[10px] text-blue-700 dark:text-blue-400 uppercase font-bold tracking-widest">Admin Authorization Hub</p>
            </div>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-black border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">Payee</th>
                <th className="px-6 py-4">Period</th>
                <th className="px-6 py-4 text-right">Base (₹)</th>
                <th className="px-6 py-4 text-right">Net Payable (₹)</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Authorization</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {pendingApprovalInvoices.map(inv => {
                const isApproved = inv.status === InvoiceStatus.APPROVED;
                return (
                <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-900 dark:text-slate-100">{inv.userName}</div>
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-black">{inv.userRole}</div>
                    {isApproved && inv.approvedByName && (
                      <div className="text-[9px] text-emerald-600 dark:text-emerald-400 font-bold mt-1">✓ Approved by {inv.approvedByName} on {inv.approvedDate}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 font-medium text-slate-600 dark:text-slate-400">{inv.month}</td>
                  <td className="px-6 py-4 text-right font-bold text-slate-500 dark:text-slate-400">₹{inv.amount.toLocaleString()}</td>
                  <td className="px-6 py-4 text-right font-black text-blue-600 dark:text-blue-400">
                    ₹{(inv.netPayable ?? inv.amount).toLocaleString()}
                    {(inv.gstEnabled || inv.tdsEnabled) && (
                      <div className="text-[9px] text-slate-400 font-normal">
                        {inv.gstEnabled && `+GST ${inv.gstRate}%`}{inv.gstEnabled && inv.tdsEnabled && ' · '}{inv.tdsEnabled && `-TDS ${inv.tdsRate}%`}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    {isApproved ? (
                      <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase border bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">Approved</span>
                    ) : (
                      <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase border bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800 animate-pulse">Pending Approval</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end space-x-2">
                      <button onClick={() => generateInvoicePDF(inv)} className="p-2 text-slate-400 hover:text-blue-600 bg-slate-50 dark:bg-slate-700 rounded-lg transition" title="Download PDF"><Download className="w-4 h-4" /></button>
                      {isApproved ? (
                        canSettleInvoices ? (
                          <button
                            onClick={() => handleSettleInvoice(inv)}
                            className="bg-emerald-600 text-white px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 transition shadow-lg shadow-emerald-50"
                            title={isFinance ? 'Release payment (Finance)' : 'Mark as paid'}
                          >
                            Mark Paid
                          </button>
                        ) : (
                          <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 px-2">Awaiting Finance payment release</span>
                        )
                      ) : (
                        canApproveInvoices ? (
                          <button
                            onClick={() => handleApproveInvoice(inv)}
                            className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-blue-700 transition shadow-lg shadow-blue-50"
                          >
                            Approve
                          </button>
                        ) : (
                          <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 px-2">Awaiting Admin approval</span>
                        )
                      )}
                      {canRejectInvoices && (
                        <button
                          onClick={() => handleRejectInvoice(inv)}
                          className="border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition"
                        >
                          Reject
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'team-payouts' && (isAdmin || useData().team.some(m => m.parentId === currentUser.id)) && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-4 w-full md:w-auto">
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-900 whitespace-nowrap">
                {isAdmin ? 'System-wide Distribution' : 'My Team Distribution'}
              </h3>
              <div className="relative w-full md:w-64">
                <Filter className="absolute left-3 top-2.5 text-slate-400 w-3 h-3" />
                <input
                  type="text"
                  placeholder="Search user name..."
                  value={userSearchTerm}
                  onChange={(e) => setUserSearchTerm(e.target.value)}
                  className="pl-9 pr-4 py-2 w-full border border-slate-200 rounded-xl text-[10px] font-bold focus:ring-2 focus:ring-blue-500 bg-white uppercase transition-all"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 w-full md:w-auto justify-end">
              <button
                onClick={() => {
                  const rows = filteredTeamWithPayouts.map(({ member, userOwnTotal, myOverrideTotal, grossTotal }) => {
                    const row: Record<string, string | number> = {
                      'User': member.name,
                      'Code': member.code,
                      'Role': globalConfig.levelNames[member.level as keyof typeof globalConfig.levelNames],
                      'Level': member.level,
                    };
                    if (isAdmin) row['Gross Brokerage (Rs.)'] = Math.round(grossTotal * 100) / 100;
                    row['Their Earnings (Rs.)'] = Math.round(userOwnTotal * 100) / 100;
                    if (isAdmin) row['% of Gross'] = grossTotal > 0 ? Math.round((userOwnTotal / grossTotal * 100) * 100) / 100 : 0;
                    if (!isAdmin) row['My Overriding (Rs.)'] = Math.round(myOverrideTotal * 100) / 100;
                    row['Status'] = 'Calculated';
                    return row;
                  });
                  exportToExcel(rows, `WealthflowTeamPayouts_${filters.year}_${filters.month}`, 'Team Payouts');
                }}
                disabled={filteredTeamWithPayouts.length === 0 || isLoadingServerPayouts || !!serverPayoutsError}
                title={isLoadingServerPayouts ? 'Wait for this month’s figures to finish loading' : serverPayoutsError ? 'This month’s figures failed to load' : undefined}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-3.5 h-3.5" /> Export Excel
              </button>
              <span className="text-[10px] bg-blue-100 text-blue-700 font-black px-2 py-1 rounded-full whitespace-nowrap">{filters.month === 'All' ? 'Full Year' : new Date(2000, parseInt(filters.month) - 1).toLocaleString('default', { month: 'long' })} {filters.year}</span>
            </div>
          </div>
          {(isLoadingServerPayouts || serverPayoutsError) && (
            <div className={`mx-6 mb-3 px-4 py-2.5 rounded-lg text-xs font-bold flex items-center justify-between gap-3 ${serverPayoutsError ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
              <span>
                {serverPayoutsError
                  ? `The figures for this month could not be loaded (${serverPayoutsError}). What is shown below is only a partial local estimate — do not export or compare it.`
                  : 'Loading this month’s figures… the numbers below are not final yet.'}
              </span>
              {serverPayoutsError && (
                <button onClick={() => setPayoutsRetry(n => n + 1)} className="px-3 py-1 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">Retry</button>
              )}
            </div>
          )}
          <table className="w-full text-sm text-left">
            <thead className="bg-white text-slate-400 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">User Details</th>
                <th className="px-6 py-4">Role / Level</th>
                {isAdmin && <th className="px-6 py-4 text-right">Gross Brokerage (₹)</th>}
                <th className="px-6 py-4 text-right">Their Earnings (₹)</th>
                {isAdmin && <th className="px-6 py-4 text-right">% of Gross</th>}
                {!isAdmin && <th className="px-6 py-4 text-right bg-blue-50/50">My Overriding (₹)</th>}
                <th className="px-6 py-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTeamWithPayouts.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(({ member, userOwnTotal, myOverrideTotal, grossTotal }) => (
                <tr key={member.id} className="hover:bg-slate-50 transition">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-900">{member.name}</div>
                    <div className="text-[10px] text-slate-400 font-medium uppercase tracking-tighter">{member.code}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{globalConfig.levelNames[member.level as keyof typeof globalConfig.levelNames]}</span>
                    <div className="text-[9px] text-slate-300 font-bold uppercase">Level {member.level}</div>
                  </td>
                  {isAdmin && (
                    <td className="px-6 py-4 text-right font-medium text-slate-500">
                      ₹{grossTotal.toLocaleString()}
                    </td>
                  )}
                  <td className="px-6 py-4 text-right font-black text-slate-600">
                    ₹{userOwnTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  {isAdmin && (
                    <td className="px-6 py-4 text-right font-black text-indigo-600">
                      {(() => {
                        const exact = serverPctByUser.get(member.id);
                        if (typeof exact === 'number') return `${exact.toFixed(2)}%`;
                        return grossTotal > 0 ? `${(userOwnTotal / grossTotal * 100).toFixed(2)}%` : '—';
                      })()}
                    </td>
                  )}
                  {!isAdmin && (
                    <td className="px-6 py-4 text-right font-black text-blue-600 bg-blue-50/20">
                      ₹{myOverrideTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  )}
                  <td className="px-6 py-4 text-center">
                    <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 mr-2 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                    <span className="text-[10px] font-bold text-slate-600 uppercase">Calculated</span>
                  </td>
                </tr>
              ))}
              {filteredTeamWithPayouts.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} className="py-12 text-center text-slate-400 font-bold uppercase text-[10px] tracking-widest italic">
                    No team payout data found for this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pagination
            currentPage={currentPage}
            totalItems={filteredTeamWithPayouts.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
          />
          {!isAdmin && (
            <div className="p-4 bg-blue-600 text-white flex justify-between items-center rounded-b-xl px-8">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-80">Total Indirect Earnings for Period</span>
              <span className="text-xl font-black">
                ₹{filteredTeamWithPayouts
                  .reduce((sum, item) => sum + item.myOverrideTotal, 0)
                  .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          {isAdmin && (
            <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
              <div className="text-right">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Total Team Payout Pool</p>
                <p className="text-2xl font-black text-slate-900">₹{visibleTransactions.reduce((acc, tx) => acc + (tx.grossAmount * (1 - (globalConfig.companyExpensePct / 100))), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'growth' && (
        <div className="space-y-4 animate-in fade-in">
          {/* Mode selector */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">Comparison Mode</h3>
                <p className="text-[10px] font-bold text-slate-400 mt-1">
                  Comparing <span className="text-blue-600 font-black">{growthPeriods.currLabel}</span> vs <span className="text-slate-500 font-black">{growthPeriods.prevLabel}</span>
                  {growthMode !== 'custom' && <span className="ml-2 text-slate-400">(uses Year/Month filter above)</span>}
                </p>
              </div>
              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden">
                {(['mom', 'qoq', 'yoy', 'custom'] as const).map(key => (
                  <button
                    key={key}
                    onClick={() => { setGrowthMode(key); setCurrentPage(1); }}
                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${growthMode === key ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-600'}`}
                  >
                    {key === 'mom' ? 'Month-over-Month' : key === 'qoq' ? 'Quarter-over-Quarter' : key === 'yoy' ? 'Year-over-Year' : 'Custom'}
                  </button>
                ))}
              </div>
            </div>

            {growthMode === 'custom' && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="border border-blue-200 bg-blue-50/30 rounded-lg p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-blue-700 mb-2">Period A (Current)</div>
                  <div className="flex gap-2">
                    <input type="date" value={customRangeA.start} onChange={e => setCustomRangeA({ ...customRangeA, start: e.target.value })} className="flex-1 px-2 py-1.5 text-xs border border-slate-200 rounded" />
                    <span className="self-center text-slate-400 text-xs">→</span>
                    <input type="date" value={customRangeA.end} onChange={e => setCustomRangeA({ ...customRangeA, end: e.target.value })} className="flex-1 px-2 py-1.5 text-xs border border-slate-200 rounded" />
                  </div>
                </div>
                <div className="border border-slate-200 bg-slate-50/40 rounded-lg p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-600 mb-2">Period B (Previous)</div>
                  <div className="flex gap-2">
                    <input type="date" value={customRangeB.start} onChange={e => setCustomRangeB({ ...customRangeB, start: e.target.value })} className="flex-1 px-2 py-1.5 text-xs border border-slate-200 rounded" />
                    <span className="self-center text-slate-400 text-xs">→</span>
                    <input type="date" value={customRangeB.end} onChange={e => setCustomRangeB({ ...customRangeB, end: e.target.value })} className="flex-1 px-2 py-1.5 text-xs border border-slate-200 rounded" />
                  </div>
                </div>
              </div>
            )}

            {growthMode === 'custom' && !growthPeriods.valid && (
              <p className="mt-3 text-[10px] font-bold text-amber-600 uppercase tracking-widest">Fill in both date ranges to see results</p>
            )}
          </div>

          {/* Why the cards below read "—" instead of a percentage. Without this the page
              simply printed -100% and left the reader to guess whether their book had
              collapsed or the month had never been imported. */}
          {growthPeriods.valid && (growthTotals.noData || growthTotals.aumGap) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2.5 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
              {growthTotals.noData
                ? `No brokerage has been imported for ${growthRows.some(r => r.txCurr > 0) ? growthPeriods.prevLabel : growthPeriods.currLabel} yet, so there is nothing to compare — this is not a fall to zero.`
                : `Those months are imported, but one of them carries no AUM figures, so the Avg AUM comparison is left blank. The brokerage figures beside it are unaffected.`}
            </div>
          )}

          {/* Summary cards */}
          {growthPeriods.valid && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { label: 'Avg AUM Growth', curr: growthTotals.avgAumCurr, prev: growthTotals.avgAumPrev, pct: growthTotals.avgAumGrowth, hint: 'Sum of avg_assets per transaction' },
                { label: 'Snapshot AUM Growth', curr: growthTotals.snapAumCurr, prev: growthTotals.snapAumPrev, pct: growthTotals.snapAumGrowth, hint: 'Latest currentValue per folio at period end' },
                { label: 'Brokerage Share Growth', curr: growthTotals.brokerCurr, prev: growthTotals.brokerPrev, pct: growthTotals.brokerGrowth, hint: 'Their actual payout from calculateUserShare', highlight: true },
              ].map(card => (
                <div key={card.label} className={`p-5 rounded-xl border shadow-sm ${card.highlight ? 'bg-blue-50/50 border-blue-200' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className={`font-black uppercase text-[10px] tracking-widest ${card.highlight ? 'text-blue-700' : 'text-slate-500'}`}>{card.label}</h4>
                      <p className="text-[9px] text-slate-400 mt-0.5">{card.hint}</p>
                    </div>
                    <span className={`text-xs font-black px-2 py-0.5 rounded-full ${card.pct === null ? 'bg-slate-100 text-slate-400' : card.pct > 0 ? 'bg-emerald-100 text-emerald-700' : card.pct < 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>
                      {card.pct === null ? '—' : `${card.pct > 0 ? '+' : ''}${card.pct.toFixed(2)}%`}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-[9px] text-slate-400 uppercase font-bold">Previous</p>
                      <p className="font-black text-slate-600">₹{card.prev.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-400 uppercase font-bold">Current</p>
                      <p className={`font-black ${card.highlight ? 'text-blue-700' : 'text-slate-900'}`}>₹{card.curr.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Per-member table */}
          {growthPeriods.valid && (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
              <div className="p-4 bg-slate-50 dark:bg-slate-900/40 border-b border-slate-200 dark:border-slate-700 flex flex-wrap justify-between items-center gap-3">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-900 dark:text-slate-100">
                  {isAdmin ? `Per-Member Growth (${growthRows.length})` : 'My Growth'}
                </h3>
                <button
                  onClick={() => exportToExcel(growthRows.map(r => ({
                    Member: r.member.name,
                    Code: r.member.code,
                    Level: r.member.level,
                    'Avg AUM (Prev)': Math.round(r.avgAUMPrev),
                    'Avg AUM (Curr)': Math.round(r.avgAUMCurr),
                    'Avg AUM Growth %': r.avgAUMGrowth === null ? '' : Number(r.avgAUMGrowth.toFixed(2)),
                    'Snap AUM (Prev)': Math.round(r.snapAUMPrev),
                    'Snap AUM (Curr)': Math.round(r.snapAUMCurr),
                    'Snap AUM Growth %': r.snapAUMGrowth === null ? '' : Number(r.snapAUMGrowth.toFixed(2)),
                    'Brokerage Share (Prev)': Math.round(r.brokeragePrev * 100) / 100,
                    'Brokerage Share (Curr)': Math.round(r.brokerageCurr * 100) / 100,
                    'Brokerage Growth %': r.brokerageGrowth === null ? '' : Number(r.brokerageGrowth.toFixed(2)),
                  })), `growth_${growthPeriods.currLabel}_vs_${growthPeriods.prevLabel}`.replace(/[^A-Za-z0-9_-]/g, '_'), 'Growth')}
                  disabled={growthRows.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-widest flex items-center gap-1"
                >
                  <Download className="w-3 h-3" /> Export Growth Report
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white dark:bg-slate-800 text-slate-400 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
                    <tr>
                      <th className="px-4 py-3">Member</th>
                      <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-slate-600" onClick={() => setGrowthSortKey('avgAum')}>
                        Avg AUM {growthSortKey === 'avgAum' && '↓'}
                      </th>
                      <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-slate-600" onClick={() => setGrowthSortKey('snapAum')}>
                        Snapshot AUM {growthSortKey === 'snapAum' && '↓'}
                      </th>
                      <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-slate-600 bg-blue-50/40" onClick={() => setGrowthSortKey('brokerage')}>
                        Brokerage Share {growthSortKey === 'brokerage' && '↓'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {growthRows.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(r => {
                      const renderCell = (prev: number, curr: number, pct: number | null, highlight = false) => {
                        const pctClass = pct === null
                          ? 'bg-slate-100 text-slate-400'
                          : pct > 0 ? 'bg-emerald-100 text-emerald-700'
                          : pct < 0 ? 'bg-rose-100 text-rose-700'
                          : 'bg-slate-100 text-slate-500';
                        return (
                          <td className={`px-4 py-3 text-right ${highlight ? 'bg-blue-50/30' : ''}`}>
                            <div className="flex items-center justify-end gap-2">
                              <div className="text-right">
                                <div className="text-[9px] text-slate-400 uppercase">Prev</div>
                                <div className="font-medium text-slate-500">₹{prev.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                              </div>
                              <span className="text-slate-300">→</span>
                              <div className="text-right">
                                <div className="text-[9px] text-slate-400 uppercase">Curr</div>
                                <div className={`font-black ${highlight ? 'text-blue-700' : 'text-slate-900'}`}>₹{curr.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                              </div>
                              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap ${pctClass}`}>
                                {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                              </span>
                            </div>
                          </td>
                        );
                      };
                      return (
                        <tr key={r.member.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3">
                            <div className="font-bold text-slate-900">{r.member.name}</div>
                            <div className="text-[10px] text-slate-400 uppercase tracking-tighter">{r.member.code} · L{r.member.level}</div>
                            {r.aumIncomplete && (
                              <div className="text-[9px] text-amber-600 font-bold mt-0.5" title="No avg_assets / currentValue data in either period">⚠ AUM data missing</div>
                            )}
                          </td>
                          {renderCell(r.avgAUMPrev, r.avgAUMCurr, r.avgAUMGrowth)}
                          {renderCell(r.snapAUMPrev, r.snapAUMCurr, r.snapAUMGrowth)}
                          {renderCell(r.brokeragePrev, r.brokerageCurr, r.brokerageGrowth, true)}
                        </tr>
                      );
                    })}
                    {growthRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-12 text-center text-slate-400 font-bold uppercase text-[10px] tracking-widest italic">
                          No activity for this comparison period
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {growthRows.length > pageSize && (
                <Pagination currentPage={currentPage} totalItems={growthRows.length} pageSize={pageSize} onPageChange={setCurrentPage} />
              )}
            </div>
          )}

          {/* Chart */}
          {growthPeriods.valid && growthRows.length > 0 && (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">Growth Comparison (Top 20)</h3>
                <span className="text-[9px] text-slate-400 font-bold uppercase">Blue = Avg AUM · Green = Brokerage Share</span>
              </div>
              <Suspense fallback={<div className="h-80 flex items-center justify-center text-xs text-slate-400">Loading chart…</div>}>
                <ReportsCharts
                  data={growthRows.slice(0, 20).map(r => ({
                    name: r.member.name.length > 14 ? r.member.name.slice(0, 14) + '…' : r.member.name,
                    'Avg AUM %': r.avgAUMGrowth === null ? 0 : Number(r.avgAUMGrowth.toFixed(2)),
                    'Brokerage %': r.brokerageGrowth === null ? 0 : Number(r.brokerageGrowth.toFixed(2)),
                  }))}
                />
              </Suspense>
            </div>
          )}
        </div>
      )}

      {activeTab === 'reconciliation' && (isAdmin || isFinance) && (
        <div className="space-y-4 animate-in fade-in">
          {/* ── Header + one-click reconciliation export ── */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-100">Monthly Reconciliation</h2>
              <p className="text-[11px] font-semibold text-slate-500">
                Per-RM gross &amp; net plus the unmapped (house) folios for{' '}
                <span className="font-black">{filters.year !== 'All' && filters.month !== 'All' ? `${filters.year}-${filters.month}` : 'all periods'}</span>.
              </p>
            </div>
            <button
              onClick={handleExportReconciliation}
              disabled={reconExporting || isLoadingServerPayouts}
              className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-700 transition disabled:opacity-50 inline-flex items-center gap-2 whitespace-nowrap"
            >
              <Download className="w-4 h-4" />{reconExporting ? 'Preparing…' : 'Download Reconciliation (Excel)'}
            </button>
          </div>

          {/* ── Exceptions: everything an import could not resolve ── */}
          <div className="bg-amber-50/60 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-2xl p-5 mb-6 space-y-3">
            <h3 className="text-sm font-black uppercase tracking-widest text-amber-800 dark:text-amber-300 flex items-center">
              <AlertTriangle className="w-4 h-4 mr-2" />Exceptions — what the import could not map
            </h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
              Run this straight after an import. It lists every folio, client and RM that still needs a human:
              brokerage that reaches nobody, clients with no RM, folios two records both claim, and rows whose
              investor is not the client they landed on. It only reads — nothing is changed.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={excPeriod}
                onChange={e => setExcPeriod(e.target.value.trim())}
                placeholder="Period e.g. 2026-07 (blank = all)"
                className="px-4 py-2.5 rounded-xl border border-amber-200 dark:border-amber-700 bg-white dark:bg-slate-800 text-xs font-bold outline-none w-64"
              />
              <button
                onClick={runExceptions}
                disabled={excBusy}
                className="px-5 py-2.5 rounded-xl bg-amber-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-amber-700 disabled:opacity-50 transition"
              >
                {excBusy ? 'Checking…' : 'Run Check'}
              </button>
              {excData && (
                <button
                  onClick={downloadExceptions}
                  className="px-5 py-2.5 rounded-xl bg-white dark:bg-slate-800 border-2 border-amber-300 dark:border-amber-600 text-amber-800 dark:text-amber-200 text-[10px] font-black uppercase tracking-widest hover:bg-amber-50 dark:hover:bg-amber-900/30 transition flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />Download Exceptions (Excel)
                </button>
              )}
            </div>
            {excData && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1">
                {EXC_TABS.map(t => {
                  const v = excData.summary?.[t.key];
                  const n = v?.count ?? 0;
                  const active = excOpen === t.key;
                  return (
                    <button
                      key={t.key}
                      onClick={() => { setExcOpen(active ? null : t.key); setExcPick({}); }}
                      title={n > 0 ? 'Click to see every row and fix it here' : 'This check passed'}
                      className={`text-left rounded-xl p-3 border transition ${active
                        ? 'bg-amber-100 dark:bg-amber-900/40 border-amber-500 ring-2 ring-amber-400'
                        : n > 0
                          ? 'bg-white dark:bg-slate-800 border-amber-300 dark:border-amber-700 hover:border-amber-500'
                          : 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800'}`}
                    >
                      <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">{t.label}</div>
                      <div className={`text-lg font-black tracking-tighter ${n > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{n}</div>
                      {t.money && (v?.gross || 0) !== 0 && (
                        <div className="text-[10px] font-bold text-slate-500">₹{Number(v.gross).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      )}
                      {n > 0 && <div className="text-[9px] font-black uppercase tracking-widest text-amber-600 mt-0.5">{active ? 'Hide' : 'Open & fix'}</div>}
                    </button>
                  );
                })}
              </div>
            )}
            {excData && excOpen && (
              <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-300">
                    {EXC_TABS.find(t => t.key === excOpen)?.label} — {(excData[excOpen] || []).length} shown
                  </div>
                  <button onClick={() => setExcOpen(null)} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600">Close</button>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-2">{EXC_TABS.find(t => t.key === excOpen)?.help}</p>
                <div className="overflow-x-auto max-h-[26rem] overflow-y-auto rounded-xl border border-amber-200 dark:border-amber-800 bg-white dark:bg-slate-900">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-amber-50 dark:bg-amber-900/30">
                      <tr className="text-left text-[9px] font-black uppercase tracking-widest text-slate-500">
                        {excOpen === 'unassignedClients' ? (
                          <><th className="p-2">Client</th><th className="p-2">PAN</th><th className="p-2">Folios</th><th className="p-2 w-72">Fix</th></>
                        ) : excOpen === 'ambiguousFolios' ? (
                          <><th className="p-2">Folio</th><th className="p-2">Claimed by</th><th className="p-2">Records</th><th className="p-2 w-72">Keep it on</th></>
                        ) : (
                          <><th className="p-2">Period</th><th className="p-2">Folio</th><th className="p-2">Investor</th><th className="p-2">Mapped to</th><th className="p-2 text-right">Rows</th><th className="p-2 text-right">Gross</th><th className="p-2 w-72">Fix</th></>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {(excData[excOpen] || []).slice(0, 400).map((r: any, i: number) => {
                        const key = `${excOpen}-${i}`;
                        const busy = excFixing === key;
                        return (
                          <tr key={key} className="hover:bg-amber-50/40 dark:hover:bg-amber-900/10">
                            {excOpen === 'unassignedClients' ? (
                              <>
                                <td className="p-2 font-bold">{r.name}</td>
                                <td className="p-2 font-mono">{r.pan || '—'}</td>
                                <td className="p-2 font-mono text-slate-500 max-w-xs truncate" title={r.folios}>{r.folios || '—'}</td>
                                <td className="p-2">
                                  <div className="flex gap-1">
                                    <select
                                      value={excPick[key] || ''}
                                      onChange={e => setExcPick({ ...excPick, [key]: e.target.value })}
                                      className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-[11px] font-bold"
                                    >
                                      <option value="">— pick an RM —</option>
                                      {team.slice().sort((a, b) => a.level - b.level || (a.name || '').localeCompare(b.name || ''))
                                        .map(t => <option key={t.id} value={t.id}>{t.name} (L{t.level})</option>)}
                                    </select>
                                    <button
                                      disabled={busy || !excPick[key]}
                                      onClick={() => applyExcFix(key, { op: 'assign_rm', clientId: r.clientId, rmId: excPick[key] })}
                                      className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[10px] font-black uppercase disabled:opacity-40"
                                    >{busy ? '…' : 'Assign'}</button>
                                  </div>
                                </td>
                              </>
                            ) : excOpen === 'ambiguousFolios' ? (
                              <>
                                <td className="p-2 font-mono font-bold">{r.folio}</td>
                                <td className="p-2 font-black text-amber-700">{r.claimedBy}</td>
                                <td className="p-2 text-slate-500 max-w-md truncate" title={r.clients}>{r.clients}</td>
                                <td className="p-2">
                                  <div className="flex gap-1">
                                    <select
                                      value={excPick[key] ?? (r.suggestClientId || '')}
                                      onChange={e => setExcPick({ ...excPick, [key]: e.target.value })}
                                      className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-[11px] font-bold"
                                    >
                                      <option value="">— pick the owner —</option>
                                      {(r.candidates || []).map((c: any) => (
                                        <option key={c.id} value={c.id}>{c.name} — {c.tx} tx — {c.rm}</option>
                                      ))}
                                    </select>
                                    <button
                                      disabled={busy || !(excPick[key] ?? r.suggestClientId)}
                                      onClick={() => applyExcFix(key, { op: 'resolve_folio', folio: r.folio, keepClientId: excPick[key] ?? r.suggestClientId })}
                                      className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[10px] font-black uppercase disabled:opacity-40"
                                    >{busy ? '…' : 'Keep'}</button>
                                  </div>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="p-2 font-mono">{r.period}</td>
                                <td className="p-2 font-mono font-bold">{r.folio || '—'}</td>
                                <td className="p-2">{r.investorName}</td>
                                <td className="p-2 text-slate-500">{r.mappedTo || r.client || r.missingClientId || '—'}</td>
                                <td className="p-2 text-right font-bold">{r.rows}</td>
                                <td className="p-2 text-right font-bold">₹{Number(r.gross || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                <td className="p-2">
                                  {excOpen === 'truncatedFolios' ? (
                                    <span className="text-[10px] text-slate-500">Re-download that source file as .xlsx — the digits are gone from the file itself.</span>
                                  ) : !r.folio ? (
                                    <span className="text-[10px] text-slate-500">No folio on this row — fix it on Clients &amp; Map.</span>
                                  ) : (
                                    <div className="flex gap-1">
                                      <select
                                        value={excPick[key] ?? (r.suggestClientId || '')}
                                        onChange={e => setExcPick({ ...excPick, [key]: e.target.value })}
                                        className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-[11px] font-bold"
                                      >
                                        <option value="">— send this folio to —</option>
                                        {r.suggestClientId && <option value={r.suggestClientId}>★ {r.suggestClient} — {r.suggestRm}</option>}
                                        {clients.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                                          .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                      </select>
                                      <button
                                        disabled={busy || !(excPick[key] ?? r.suggestClientId)}
                                        onClick={() => applyExcFix(key, { op: 'repoint', folio: r.folio, toClientId: excPick[key] ?? r.suggestClientId })}
                                        className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[10px] font-black uppercase disabled:opacity-40"
                                      >{busy ? '…' : 'Move'}</button>
                                    </div>
                                  )}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {(excData[excOpen] || []).length > 400 && (
                  <p className="text-[10px] text-slate-500 mt-2">Showing the first 400 of {(excData[excOpen] || []).length}. Use the Excel download for the full list.</p>
                )}
                {excNeedsRecalc && (
                  <div className="mt-3 flex items-center gap-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 p-3">
                    <span className="text-[11px] font-bold text-amber-800 dark:text-amber-300">
                      Mappings changed. Payouts still show the old figures until you recalculate.
                    </span>
                    <button
                      onClick={runExcRecalc}
                      disabled={excBusy}
                      className="px-4 py-2 rounded-lg bg-amber-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-amber-700 disabled:opacity-50"
                    >{excBusy ? 'Recalculating…' : 'Recalculate Now'}</button>
                  </div>
                )}
              </div>
            )}

          </div>

          {/* ── Bulk client mapping from a spreadsheet ── */}
          <div className="bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800 rounded-2xl p-5 mb-6 space-y-3">
            <h3 className="text-sm font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 flex items-center"><Users className="w-4 h-4 mr-2" />Bulk Client Mapping from Excel</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
              Upload a sheet with <span className="font-black">Client Name, PAN, RM Name, BM Name</span> — one row per client, many RMs at once.
              You will see exactly what changes <span className="font-black">before</span> anything is saved. No folio column needed.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <label className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition ${bulkBusy ? 'bg-slate-300 text-slate-500 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer shadow-lg shadow-emerald-100'}`}>
                {bulkBusy ? 'Working…' : 'Choose Excel / CSV'}
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={bulkBusy}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleBulkFile(f); e.currentTarget.value = ''; }} />
              </label>
              <button onClick={downloadCurrentMapping} className="px-4 py-2.5 rounded-xl bg-white dark:bg-slate-800 border-2 border-emerald-300 dark:border-emerald-600 text-emerald-800 dark:text-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition">
                ⬇ Download Current Mapping
              </button>
              <button onClick={downloadBulkTemplate} className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 text-slate-500 text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition">
                Blank Template
              </button>
              {bulkFileName && <span className="text-[10px] text-slate-500 font-bold">{bulkFileName}</span>}
            </div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-800 border border-emerald-100 dark:border-emerald-800 rounded-lg p-3 space-y-1">
              <p><span className="font-black text-emerald-700 dark:text-emerald-300">Recommended:</span> click <span className="font-black">Download Current Mapping</span>. It contains every client with a <span className="font-black">Client ID</span> and their current RM/BM.</p>
              <p>Edit <span className="font-black">only the RM / BM columns</span> and upload it back — you never type a client name, so a spelling mistake cannot break the match.</p>
              <p>For RM and BM you can type the <span className="font-black">name or the ARN code</span>. Small spelling mistakes are corrected automatically, and the preview shows you exactly which name it read. If two people share a name, it asks for the code instead of guessing.</p>
            </div>

            {bulkMsg && (
              <div className={`text-[11px] font-bold px-3 py-2 rounded-lg border ${bulkMsg.startsWith('✗') ? 'text-red-700 bg-red-50 border-red-200' : bulkMsg.startsWith('✓') ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-slate-600 bg-white border-slate-200'}`}>
                {bulkMsg}
              </div>
            )}

            {bulkResult && (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="flex flex-wrap gap-4 p-3 border-b border-slate-100 dark:border-slate-700 text-[11px] font-bold">
                  <span className="text-slate-500">Rows read: <span className="text-slate-900 dark:text-slate-100">{bulkResult.summary.total}</span></span>
                  <span className="text-emerald-700">Will change: <span className="font-black">{bulkResult.summary.willUpdate}</span></span>
                  <span className="text-slate-500">Already correct: {bulkResult.summary.unchanged}</span>
                  <span className={bulkResult.summary.errors ? 'text-red-600' : 'text-slate-400'}>Problems: <span className="font-black">{bulkResult.summary.errors}</span></span>
                </div>

                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-900/40 sticky top-0">
                      <tr className="text-left text-slate-400 uppercase tracking-widest text-[9px] font-black">
                        <th className="px-3 py-2">Row</th>
                        <th className="px-3 py-2">Client</th>
                        <th className="px-3 py-2">PAN</th>
                        <th className="px-3 py-2">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-700">
                      {bulkResult.rows.map((r, i) => (
                        <tr key={i} className={r.status === 'error' ? 'bg-red-50/60 dark:bg-red-900/10' : r.status === 'unchanged' ? 'opacity-50' : ''}>
                          <td className="px-3 py-1.5 text-slate-400 font-mono">{r.row}</td>
                          <td className="px-3 py-1.5 font-bold text-slate-800 dark:text-slate-200">{r.clientName || r.name || '—'}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-500">{r.pan || '—'}</td>
                          <td className={`px-3 py-1.5 ${r.status === 'error' ? 'text-red-700 font-bold' : r.status === 'ok' ? 'text-emerald-700 font-bold' : 'text-slate-400'}`}>{r.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bulkResult.truncated && <div className="px-3 py-2 text-[10px] text-slate-400 border-t border-slate-100">Showing the first 500 rows — every row in the file is still processed.</div>}

                {bulkResult.dryRun && bulkResult.summary.willUpdate > 0 && (
                  <div className="p-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3">
                    <span className="text-[10px] text-slate-500">
                      Nothing has been saved yet. Applying re-maps {bulkResult.summary.willUpdate} client(s) and recalculates payouts.
                      {bulkResult.summary.errors > 0 && <span className="text-red-600 font-bold"> The {bulkResult.summary.errors} problem row(s) will be skipped.</span>}
                    </span>
                    <button onClick={applyBulkMapping} disabled={bulkBusy}
                      className="px-5 py-2 rounded-xl bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap">
                      {bulkBusy ? 'Applying…' : `Apply ${bulkResult.summary.willUpdate} change(s)`}
                    </button>
                  </div>
                )}
                {bulkResult.dryRun && bulkResult.summary.willUpdate === 0 && (
                  <div className="p-3 border-t border-slate-100 text-[10px] text-slate-500">Nothing to change — every row is either already mapped correctly or could not be matched.</div>
                )}
              </div>
            )}
          </div>

          {/* ── Map RM from Registrar File ── */}
          <div className="bg-white dark:bg-slate-800 border-2 border-blue-200 dark:border-blue-800 rounded-xl p-5">
            <h3 className="text-sm font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 flex items-center"><Users className="w-4 h-4 mr-2" />Map RM from Registrar File</h3>
            <p className="text-[11px] font-semibold text-slate-500 mt-1 mb-4 max-w-3xl">
              Upload an RM&apos;s <span className="font-black">&quot;RM-wise / Investor-wise Brokerage&quot;</span> Excel. Every folio in it is mapped to the selected RM (using their standard hierarchy), then payouts recalculate automatically. This is the one-click monthly reconciliation — do it per RM after importing the brokerage files.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <select value={mapRmId} onChange={e => { setMapRmId(e.target.value); setMapMsg(null); }} disabled={mapBusy}
                className="border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-sm font-bold bg-slate-50 dark:bg-slate-700 outline-none min-w-[240px]">
                <option value="">— Select RM —</option>
                {[...team].sort((a,b)=>a.name.localeCompare(b.name)).map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.code}) · L{t.level}</option>
                ))}
              </select>
              <label className={`px-4 py-2 rounded-lg text-sm font-bold cursor-pointer ${mapRmId && !mapBusy ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
                {mapBusy ? 'Working…' : 'Upload RM File'}
                <input type="file" accept=".xlsx,.xls" disabled={!mapRmId || mapBusy} className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleMapRmFile(f); e.currentTarget.value=''; }} />
              </label>
            </div>
            {mapMsg && <p className={`mt-3 text-xs font-bold ${mapMsg.startsWith('✓') ? 'text-emerald-600' : mapMsg.startsWith('✗') ? 'text-red-500' : 'text-slate-500'}`}>{mapMsg}</p>}
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-xs font-black uppercase tracking-widest text-amber-800 dark:text-amber-300">Unmapped Transactions</h3>
                <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 mt-1">
                  These investor accounts have brokerage in the system but are <span className="font-black">not mapped to any team member</span>, so 100% of their brokerage currently goes to company retention. Map them in <span className="font-black">Clients &amp; Map</span> to credit the right RM.
                  {filters.year !== 'All' && filters.month !== 'All'
                    ? <> Showing period <span className="font-black">{filters.year}-{filters.month}</span>.</>
                    : <> Showing <span className="font-black">all periods</span> (set Year + Month above to narrow).</>}
                </p>
              </div>
            </div>
          </div>

          {isLoadingUnmapped ? (
            <div className="text-center py-12 text-slate-400 text-xs font-bold">Loading reconciliation data…</div>
          ) : !unmapped ? (
            <div className="text-center py-12 text-slate-400 text-xs font-bold">No data.</div>
          ) : unmapped.totalRows === 0 ? (
            <div className="text-center py-12 text-emerald-500 text-xs font-black uppercase tracking-widest">✓ All transactions are mapped — nothing to reconcile.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Unmapped Accounts</div>
                  <div className="text-2xl font-black text-slate-800 dark:text-slate-100 mt-1">{unmapped.groups.length}</div>
                  <div className="text-[10px] font-bold text-slate-400 mt-1">{unmapped.totalRows.toLocaleString()} transactions</div>
                </div>
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Unattributed Gross</div>
                  <div className="text-2xl font-black text-amber-600 mt-1">₹{unmapped.totalGross.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  <div className="text-[10px] font-bold text-slate-400 mt-1">currently → company retention</div>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="overflow-x-auto max-h-[60vh]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-900/40 sticky top-0">
                      <tr>
                        <th scope="col" className="px-4 py-3 font-black uppercase tracking-widest text-[10px] text-slate-500">Investor</th>
                        <th scope="col" className="px-4 py-3 font-black uppercase tracking-widest text-[10px] text-slate-500">PAN</th>
                        <th scope="col" className="px-4 py-3 font-black uppercase tracking-widest text-[10px] text-slate-500">Folio</th>
                        <th scope="col" className="px-4 py-3 font-black uppercase tracking-widest text-[10px] text-slate-500 text-right">Txns</th>
                        <th scope="col" className="px-4 py-3 font-black uppercase tracking-widest text-[10px] text-slate-500 text-right">Gross (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {unmapped.groups.map((g, i) => (
                        <tr key={`${g.pan}-${g.folio}-${i}`} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                          <td className="px-4 py-2.5 font-bold text-slate-700 dark:text-slate-200">{g.name || <span className="text-slate-400 italic">unknown</span>}</td>
                          <td className="px-4 py-2.5 font-mono text-slate-500">{g.pan || '—'}</td>
                          <td className="px-4 py-2.5 font-mono text-slate-500">{g.folio || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-500">{g.n}</td>
                          <td className="px-4 py-2.5 text-right font-black text-amber-600">{g.gross.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {unmapped.groups.length >= 1000 && (
                  <div className="px-4 py-2 text-[10px] font-bold text-slate-400 border-t border-slate-100 dark:border-slate-700">Showing top 1,000 accounts by gross. Narrow by period to see the rest.</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Invoice review — shown before anything is saved ─────────────────── */}
      {invoiceDraft && (() => {
        const inv = invoiceDraft.invoice;
        const money = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const cfg = globalConfig as any;
        const line = (label: string, value: string, strong = false, muted = false) => (
          <div className="flex justify-between items-baseline py-1.5">
            <span className={`text-[12px] ${muted ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}>{label}</span>
            <span className={`tabular-nums ${strong ? 'font-black text-slate-900 dark:text-slate-100 text-base' : 'font-bold text-slate-700 dark:text-slate-300 text-[13px]'}`}>{value}</span>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto">
              <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
                <h3 className="font-black text-lg text-slate-900 dark:text-slate-100">{invoiceDraft.isEdit ? 'Review changes' : 'Review invoice'}</h3>
                <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">Check the details below. Nothing is saved until you confirm.</p>
              </div>

              <div className="px-6 py-4 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice Number</label>
                  <input
                    type="text"
                    value={inv.invoiceNumber || ''}
                    onChange={e => setInvoiceDraft({ ...invoiceDraft, invoice: { ...inv, invoiceNumber: e.target.value } })}
                    className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-2.5 rounded-xl mt-1 font-bold text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                  {line('Billed to', String(cfg.firmName || 'Company'))}
                  {line('Period', inv.month)}
                  {line('Transactions', String(inv.transactionCount ?? 0))}
                  {line('Invoice date', inv.invoiceDate || '')}
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                  {invoiceDraft.gross > 0 && line('Gross brokerage', money(invoiceDraft.gross), false, true)}
                  {line('Your share (base)', money(inv.amount))}
                  {inv.gstEnabled
                    ? <>
                        {line(`CGST @ ${inv.cgstRate ?? 9}%`, money(inv.cgstAmount || (inv.gstAmount || 0) / 2))}
                        {line(`SGST @ ${inv.sgstRate ?? 9}%`, money(inv.sgstAmount || (inv.gstAmount || 0) / 2))}
                      </>
                    : line('GST', 'Not applicable — no GSTIN on your profile', false, true)}
                  {inv.tdsEnabled && line(`Less: TDS @ ${inv.tdsRate}%`, `− ${money(inv.tdsAmount || 0)}`)}
                  {!!inv.roundOff && Math.abs(inv.roundOff) >= 0.005 && line('Round off', money(inv.roundOff))}
                  <div className="border-t border-slate-200 dark:border-slate-600 mt-2 pt-2">
                    {line('Total payable', money(inv.netPayable ?? inv.amount), true)}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                  <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Paid into</div>
                  <div className="text-[13px] font-bold text-slate-700 dark:text-slate-300">{inv.bankSnapshot?.bankName || '—'}</div>
                  <div className="text-[12px] text-slate-500 dark:text-slate-400">
                    A/C {inv.bankSnapshot?.accountNumber || '—'} · IFSC {inv.bankSnapshot?.ifscCode || '—'}
                  </div>
                  {!inv.signatureSnapshot && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mt-2">
                      No signature on file — the invoice will print without one. Add it in Settings → Profile.
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-3">
                <button onClick={() => setInvoiceDraft(null)} disabled={savingInvoice}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={confirmRaiseInvoice} disabled={savingInvoice}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 transition shadow-lg shadow-blue-100 dark:shadow-none disabled:opacity-60">
                  {savingInvoice ? 'Saving…' : invoiceDraft.isEdit ? 'Save changes' : 'Confirm & raise'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
