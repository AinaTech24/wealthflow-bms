
import React, { useState, useRef, useEffect } from 'react';
import { UploadCloud, FileSpreadsheet, CheckCircle, ArrowRight, RefreshCw, Trash2, Settings as SettingsIcon, FileArchive, Database, Lock, Key, TableProperties, ArrowRightCircle, List, AlertTriangle, Calendar, Loader2, Copy, ShieldAlert, UserX, Filter, Inbox } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { BrokerageTransaction, TransactionStatus, TransactionSource, TeamMember, Role, ImportBatch, Client, ClientHolding, MappingEntry, ImportFlag, TransactionType, MASTER_SOURCES } from '../types';
// xlsx parsing now runs in a Web Worker (workers/xlsxParser.worker.ts) so the
// main thread stays responsive on large files — previously a synchronous
// XLSX.read() of a multi-MB CAMS file could trigger Chrome's "Page Unresponsive".
import XlsxWorker from '../workers/xlsxParser.worker?worker';
import { useData, authFetch } from '../contexts/DataContext';
import { runBatchCalculation } from '../services/calculationService';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';

import { nameContradicts, bestNameMatches } from '../../src/lib/nameMatch.js';
interface ImportsProps {
  currentUser: TeamMember;
}

// Master list of all possible mappable fields. Specific source types pick which
// are required vs optional via `getSystemFields(source)` below.
const ALL_FIELDS = [
  { key: 'folio',           label: 'Folio Number' },
  { key: 'pan',             label: 'PAN' },
  { key: 'investorName',    label: 'Investor Name' },
  { key: 'amcName',         label: 'AMC Name' },
  { key: 'schemeName',      label: 'Scheme Name' },
  { key: 'transactionDate', label: 'Transaction Date' },
  { key: 'grossAmount',     label: 'Gross Brokerage' },
  { key: 'currentValue',    label: 'Current Value (AUM)' },
  { key: 'brokerageRate',   label: 'Brokerage Rate (%)' },
  { key: 'remarks',         label: 'Transaction Type' },
] as const;

type FieldKey = typeof ALL_FIELDS[number]['key'];

/**
 * Deterministic 53-bit content hash (cyrb53) — used to derive each transaction's
 * primary-key ID from its business fields so that re-importing the same CAMS /
 * Kfintech file is naturally idempotent (server's ON DUPLICATE KEY UPDATE on
 * `id` becomes a true upsert, no duplicates). Collisions are astronomically
 * unlikely (~2^26.5 birthday limit ≈ 95 million rows).
 */
const cyrb53 = (str: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = (h2 >>> 0).toString(16).padStart(8, '0');
  const hi = (2097151 & h1).toString(16).padStart(6, '0');
  return hi + lo; // 14 hex chars = 56 bits
};

/**
 * Build the deterministic ID for one parsed brokerage row. Two re-imports of
 * the exact same source-row produce identical IDs; any genuine difference
 * (date, units, AUM snapshot, rate, scheme) produces a different ID.
 */
const makeTxId = (src: TransactionSource, fields: {
  period: string; folio: string; pan: string; scheme: string;
  amc: string; date: string; gross: number; curVal: number;
  rate: number; remarks: string;
}): string => {
  const key = [
    src, fields.period, fields.folio, fields.pan, fields.amc, fields.scheme,
    fields.date, fields.gross, fields.curVal, fields.rate, fields.remarks,
  ].join('|');
  return `${src}_${fields.period}_${cyrb53(key)}`;
};

/**
 * Per-source-type required-field rules.
 *  - Brokerage Statement: full data including grossAmount (commission column).
 *  - Transactions (WBR2 / MFSD201): grossAmount/AMC/scheme stay OPTIONAL since
 *    these files capture every investor activity, not just commissions — many
 *    rows have no brokerage attached.
 *  - Folio Master (WBR9 / MFSD211): financial fields are not present at all.
 */
const getSystemFields = (source: TransactionSource | null): Array<{ key: FieldKey; label: string; required: boolean }> => {
  const REQ: Record<FieldKey, boolean> = {
    folio: true, pan: false, investorName: true,
    amcName: false, schemeName: false, transactionDate: false,
    grossAmount: false, currentValue: false, brokerageRate: false, remarks: false,
  };

  if (source === TransactionSource.CAMS || source === TransactionSource.KARVY || source === TransactionSource.KFINTECH) {
    // Brokerage statements — these always carry commission amounts
    REQ.amcName = true; REQ.schemeName = true; REQ.transactionDate = true; REQ.grossAmount = true;
  } else if (source === TransactionSource.CAMS_WBR2 || source === TransactionSource.KARVY_MFSD201) {
    // Transaction files — date + scheme matter; brokerage is optional
    REQ.schemeName = true; REQ.transactionDate = true; REQ.pan = true;
  } else if (source === TransactionSource.CAMS_WBR9 || source === TransactionSource.KARVY_MFSD211) {
    // Folio master — investor identity only
    REQ.pan = true; REQ.schemeName = true;
  } else {
    // Unknown source — keep historic defaults so legacy templates still work
    REQ.amcName = true; REQ.schemeName = true; REQ.transactionDate = true; REQ.grossAmount = true;
  }

  return ALL_FIELDS.map(f => ({ ...f, required: REQ[f.key] }));
};

// Legacy alias — many call sites just need the field list, not the required flag.
const SYSTEM_FIELDS = ALL_FIELDS.map(f => ({ ...f, required: false }));

// ─── The brokerage window the FILE itself declares ──────────────────────────
// The worst incident this system has had: a CAMS statement named "July- 26"
// actually carried brkage_from 01-Jun-2026 .. brkage_to 30-Jun-2026. It was
// filed under 2026-07 on top of June's own copy, so July reported June's money
// twice — Rs 1.51 lakh wrong across every RM — and the attempt to undo it
// purged the real data. The file said what month it was the whole time; the
// screen just never showed it.
//
// CAMS statements carry brkage_from / brkage_to, KFintech carries From/To Date.
// Transaction files (WBR2 / MFSD201) and folio masters (WBR9 / MFSD211) have no
// brokerage window — those return null and are simply not checked.
type FilePeriod = {
  period: string;      // YYYY-MM most rows fall in
  fromLabel: string;   // exactly as written in the file
  toLabel: string;
  column: string;
  coverage: number;    // share of rows agreeing, 0-1
  spread: string[];
};

const PG_FROM_COLS = ['brkage_from', 'From Date', 'from_date', 'FROM DATE'];
const PG_TO_COLS = ['brkage_to', 'To Date', 'to_date', 'TO DATE'];
const pgYear = (y: string) => { const n = Number(y); return n < 100 ? 2000 + n : n; };
const pgLastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const pgParts = (v: any): any => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{5}$/.test(s)) {
    const d = new Date((Number(s) - 25569) * 86400 * 1000);
    return { iso: true, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { iso: true, y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) return { iso: false, a: Number(m[1]), b: Number(m[2]), y: pgYear(m[3]) };
  return null;
};

// CAMS writes M/D/Y and KFintech writes D/M/Y, and a single date cannot tell you
// which. The PAIR can: the true reading is the one where `from` is the 1st and
// `to` is the last day of that same month.
const pgPairMonth = (fromRaw: any, toRaw: any): string | null => {
  const F = pgParts(fromRaw), T = pgParts(toRaw);
  if (!F) return null;
  if (F.iso) return `${F.y}-${String(F.m).padStart(2, '0')}`;
  const tries = [
    { m: F.b, d: F.a, tm: T && !T.iso ? T.b : null, td: T && !T.iso ? T.a : null },   // D/M/Y
    { m: F.a, d: F.b, tm: T && !T.iso ? T.a : null, td: T && !T.iso ? T.b : null },   // M/D/Y
  ];
  const clean = tries.filter(t => t.m >= 1 && t.m <= 12 && t.d === 1 && t.tm === t.m && t.td === pgLastDay(F.y, t.m));
  if (clean.length === 1) return `${F.y}-${String(clean[0].m).padStart(2, '0')}`;
  const valid = tries.filter(t => t.m >= 1 && t.m <= 12);
  if (valid.length === 1) return `${F.y}-${String(valid[0].m).padStart(2, '0')}`;
  return `${F.y}-${String(tries[0].m).padStart(2, '0')}`;   // fall back to D/M/Y
};

const detectFilePeriod = (headers: any[], rows: any[][], headerIdx: number): FilePeriod | null => {
  const h = headers.map(x => String(x || '').trim());
  const fi = PG_FROM_COLS.map(c => h.indexOf(c)).find(i => i >= 0);
  const ti = PG_TO_COLS.map(c => h.indexOf(c)).find(i => i >= 0);
  if (fi === undefined) return null;
  const counts = new Map<string, number>();
  let ff = '', ft = '', seen = 0;
  const lim = Math.min(rows.length, headerIdx + 1 + 5000);   // a sample is plenty and is instant
  for (let i = headerIdx + 1; i < lim; i++) {
    const fr = rows[i]?.[fi], to = ti !== undefined ? rows[i]?.[ti] : null;
    const ym = pgPairMonth(fr, to);
    if (!ym) continue;
    if (!ff) { ff = String(fr).trim(); ft = String(to ?? '').trim(); }
    counts.set(ym, (counts.get(ym) || 0) + 1);
    seen++;
  }
  if (!seen) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { period: ranked[0][0], fromLabel: ff, toLabel: ft, column: h[fi],
           coverage: ranked[0][1] / seen, spread: ranked.map(r => r[0]) };
};

const prettyPeriod = (p: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(p || '');
  if (!m) return p || '—';
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
};

// ─── Preset column maps for known CSV formats ───────────────────────────────
const CAMS_PRESET_MAPPING: Record<string, string> = {
  folio:           'folio_no',
  pan:             '',            // CAMS brokerage reports do not include investor PAN
  investorName:    'inv_name',
  amcName:         'amc_code',
  schemeName:      'scheme_code',
  transactionDate: 'post_date',
  grossAmount:     'brkage_amt',
  currentValue:    'avg_assets',
  brokerageRate:   'brkage_rate',
  remarks:         'trxn_desc',
};

const KFINTECH_PRESET_MAPPING: Record<string, string> = {
  folio:           'Account Number',
  pan:             'InvPAN',
  investorName:    'Investor Name',
  amcName:         'Fund',
  schemeName:      'Fund Description',
  transactionDate: 'Transaction Date',
  grossAmount:     'Brokerage (in Rs.)',
  currentValue:    'Average Assets',
  brokerageRate:   'Percentage (%)',
  remarks:         'Transaction Description',
};

// CAMS WBR2 — Transaction file with brokerage. PAN + full scheme name + brokerage all present.
const CAMS_WBR2_PRESET_MAPPING: Record<string, string> = {
  folio:           'folio_no',
  pan:             'pan',
  investorName:    'inv_name',
  amcName:         'amc_code',         // still a code in WBR2; deriver / enrichment handles it
  schemeName:      'scheme',           // full descriptive name
  transactionDate: 'traddate',
  grossAmount:     'brokcomm',         // actual brokerage commission column
  currentValue:    '',                 // WBR2 doesn't have AUM per row
  brokerageRate:   'brokperc',
  remarks:         'trxn_nature',
};

// KFintech MFSD201 — Transaction file with brokerage. PAN + full scheme name.
const KARVY_MFSD201_PRESET_MAPPING: Record<string, string> = {
  folio:           'Folio Number',
  pan:             'PAN1',
  investorName:    'Investor Name',
  amcName:         '',                       // no AMC column — derive from Fund Description
  schemeName:      'Fund Description',
  transactionDate: 'Transaction Date',
  grossAmount:     'Commission',
  currentValue:    '',
  brokerageRate:   'Brokerage Percentage',
  remarks:         'Transaction Description',
};

// CAMS WBR9 — Folio Master. No transactions; populates clients only.
const CAMS_WBR9_PRESET_MAPPING: Record<string, string> = {
  folio:           'foliochk',
  pan:             'pan_no',
  investorName:    'inv_name',
  amcName:         'amc_code',
  schemeName:      'sch_name',
  transactionDate: '',
  grossAmount:     '',                       // no transaction amount
  currentValue:    'rupee_bal',              // current AUM in rupees (snapshot)
  brokerageRate:   '',
  remarks:         '',
};

// KFintech MFSD211 — Folio Master. No transactions; populates clients only.
const KARVY_MFSD211_PRESET_MAPPING: Record<string, string> = {
  folio:           'Folio',
  pan:             'PAN Number',
  investorName:    'Investor Name',
  amcName:         '',
  schemeName:      'Fund Description',
  transactionDate: '',
  grossAmount:     '',
  currentValue:    '',
  brokerageRate:   '',
  remarks:         '',
};

const KARVY_PRESET_MAPPING: Record<string, string> = {
  folio:           'Account Number',
  pan:             'InvPAN',
  investorName:    'Investor Name',
  // Karvy files don't carry a dedicated AMC column — the AMC is the first words of
  // the scheme description (e.g. "Mirae Asset Large and Midcap Fund - ..."). Leave
  // amcName unmapped and let deriveAmcFromScheme() extract it from schemeName below.
  amcName:         '',
  schemeName:      'Fund Description',
  transactionDate: 'Transaction Date',
  grossAmount:     'Brokerage (in Rs.)',
  currentValue:    'Average Assets',
  brokerageRate:   'Percentage (%)',
  remarks:         'Transaction Description',
};

// AMC brand list — long-form names first so they win over their shorter prefixes
// (e.g. "ADITYA BIRLA SUN LIFE" before "ADITYA BIRLA"). Used to derive AMC from
// a scheme name when the source file doesn't provide it explicitly (Karvy CSVs).
const KNOWN_AMC_BRANDS = [
  'ADITYA BIRLA SUN LIFE', 'ADITYA BIRLA', 'ABSL',
  'PARAG PARIKH', 'PPFAS',
  'MIRAE ASSET', 'MIRAE',
  'MOTILAL OSWAL', 'MOTILAL',
  'BANK OF INDIA', 'BOI',
  'MAHINDRA MANULIFE', 'MAHINDRA',
  'FRANKLIN TEMPLETON', 'FRANKLIN', 'TEMPLETON',
  'WHITE OAK', 'WHITEOAK',
  'BAJAJ FINSERV', 'BAJAJ',
  'HDFC', 'KOTAK', 'SBI', 'ICICI PRUDENTIAL', 'ICICI', 'AXIS',
  'NIPPON INDIA', 'NIPPON', 'TATA', 'DSP', 'UTI', 'LIC MF', 'LICMF',
  'HELIOS', 'BANDHAN', 'IDFC', 'INVESCO', 'CANARA ROBECO', 'CANARA',
  'EDELWEISS', 'HSBC', 'TRUST', 'UNION', 'QUANT', 'PGIM',
  'JM FINANCIAL', 'JM', 'BARODA BNP PARIBAS', 'BARODA', 'BNP PARIBAS', 'BNP',
  'TAURUS', 'ITI', 'SAMCO', 'GROWW', 'NAVI', 'QUANTUM',
  'OLD BRIDGE', 'NJ', 'SHRIRAM', '360 ONE', 'ZERODHA',
];

const deriveAmcFromScheme = (schemeName: string): string => {
  if (!schemeName) return '';
  const up = schemeName.toUpperCase();
  for (const brand of KNOWN_AMC_BRANDS) {
    if (up.includes(brand)) return brand
      .toLowerCase()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  // Fallback — take the first 2-3 words before "Fund/Scheme/Mutual"
  const m = schemeName.match(/^(.+?)\s+(Fund|Scheme|Mutual|Mutual Fund)/i);
  return m ? m[1].trim() : '';
};

// Every known registrar format with the header signature that uniquely identifies
// it and the column mapping to apply. Order matters: the most specific / brokerage
// formats are listed first so a real brokerage file never falls through to a master
// format. `signature` columns must ALL be present for a match.
const FORMAT_SIGNATURES: Array<{ source: TransactionSource; signature: string[]; mapping: Record<string, string> }> = [
  // ── Brokerage / commission files (carry grossAmount) ──
  { source: TransactionSource.CAMS,          signature: ['folio_no', 'brkage_amt', 'post_date'],                       mapping: CAMS_PRESET_MAPPING },
  { source: TransactionSource.KARVY,         signature: ['Account Number', 'Brokerage (in Rs.)', 'Fund Description', 'Scheme'], mapping: KARVY_PRESET_MAPPING },
  { source: TransactionSource.KFINTECH,      signature: ['Account Number', 'Brokerage (in Rs.)', 'Fund Description'],  mapping: KFINTECH_PRESET_MAPPING },
  { source: TransactionSource.CAMS_WBR2,     signature: ['folio_no', 'brokcomm', 'traddate'],                          mapping: CAMS_WBR2_PRESET_MAPPING },
  { source: TransactionSource.KARVY_MFSD201, signature: ['Folio Number', 'Commission', 'Transaction Date'],            mapping: KARVY_MFSD201_PRESET_MAPPING },
  // ── Folio master files (no grossAmount) ──
  { source: TransactionSource.CAMS_WBR9,     signature: ['foliochk', 'sch_name', 'pan_no'],                            mapping: CAMS_WBR9_PRESET_MAPPING },
  { source: TransactionSource.KARVY_MFSD211, signature: ['Folio', 'Fund Description', 'PAN Number'],                   mapping: KARVY_MFSD211_PRESET_MAPPING },
];

/**
 * Returns the correct preset mapping by INSPECTING THE FILE HEADERS, not by trusting
 * the source button the user pressed. This makes imports robust: if a user picks
 * "KFintech MFSD201" but actually uploads a WBBRR brokerage file (different columns),
 * we still detect the real format and map the brokerage column correctly — instead of
 * silently importing everything as ₹0 (the bug that under-counted gross).
 *
 * Resolution order:
 *   1. If the selected source's own signature matches → use it (honours explicit choice).
 *   2. Otherwise auto-detect across ALL known formats and use the first that matches.
 *   3. If nothing matches → null (user maps columns manually).
 */
const getPresetMapping = (
  source: TransactionSource | null,
  headers: string[]
): Record<string, string> | null => {
  const has = (cols: string[]) => cols.every(k => headers.includes(k));

  // 1. Honour the explicit selection when its signature genuinely matches the file.
  if (source) {
    const sel = FORMAT_SIGNATURES.find(f => f.source === source);
    if (sel && has(sel.signature)) return sel.mapping;
  }
  // 2. Auto-detect: the file's columns decide, not the button.
  for (const f of FORMAT_SIGNATURES) {
    if (has(f.signature)) return f.mapping;
  }
  // 3. No known format.
  return null;
};
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const YEARS = Array.from({ length: 5 }, (_, i) => (new Date().getFullYear() - 2 + i).toString());

// SEBI/AMC reasonable monthly-brokerage thresholds, as % of average assets.
// Effective rate above these is unusual and usually signals data error or TER overflow risk.
// These are conservative defaults — adjust in Settings if your firm's blended rates differ.
const SEBI_MONTHLY_BROKERAGE_CAPS: Record<string, number> = {
  Equity:    0.10,  // 1.20% p.a.
  Hybrid:    0.08,  // ~0.96% p.a.
  Arbitrage: 0.04,  // ~0.48% p.a.
  Debt:      0.05,  // 0.60% p.a.
  Liquid:    0.02,  // ~0.24% p.a.
};

const computeEffectiveRate = (grossAmount: number, currentValue?: number): number | null => {
  if (!currentValue || currentValue <= 0) return null;
  return (grossAmount / currentValue) * 100; // monthly %
};

const exceedsSebiCap = (category: string, grossAmount: number, currentValue?: number): boolean => {
  const rate = computeEffectiveRate(grossAmount, currentValue);
  if (rate === null) return false;
  const cap = SEBI_MONTHLY_BROKERAGE_CAPS[category] ?? SEBI_MONTHLY_BROKERAGE_CAPS.Equity;
  return rate > cap;
};

const dedupeKey = (t: { pan?: string; folio?: string; schemeName: string; transactionDate: string; grossAmount: number }) => {
  const ident = (t.pan || t.folio || '').toUpperCase().trim();
  return `${ident}|${t.schemeName.trim().toUpperCase()}|${t.transactionDate}|${Math.round(t.grossAmount * 100)}`;
};

/**
 * Classify a transaction by parsing CAMS/Karvy remark codes.
 * Patterns derived from common registrar txn descriptions.
 */
const classifyTransaction = (remarks: string): TransactionType => {
  const r = (remarks || '').toUpperCase();
  if (!r) return 'OTHER';
  // Order matters — check most specific first.
  if (/\b(SWITCH[\s_-]*OUT|SW[\s_-]*OUT|SOUT)\b/.test(r)) return 'SWITCH_OUT';
  if (/\b(SWITCH[\s_-]*IN|SW[\s_-]*IN|SIN)\b/.test(r)) return 'SWITCH_IN';
  if (/\b(REDEM|REDMP|REDEMPTION|REDEEM|SELL|SALE|WITHDRAW)\b/.test(r)) return 'REDEMPTION';
  if (/\b(SWP)\b/.test(r)) return 'SWP';
  if (/\b(STP)\b/.test(r)) return 'STP';
  if (/\b(SIP|SYSTEMATIC INVESTMENT)\b/.test(r)) return 'SIP';
  if (/\b(DIVIDEND|DIV[\s_-]*(RE|PAY)|IDCW)\b/.test(r)) return 'DIVIDEND';
  if (/\b(BONUS)\b/.test(r)) return 'BONUS';
  if (/\b(PURCHASE|LUMPSUM|FRESH|ADDL?|ADDITIONAL)\b/.test(r)) return 'LUMPSUM';
  return 'OTHER';
};

export const Imports: React.FC<ImportsProps> = ({ currentUser }) => {
  const {
    addTransactions,
    addBatch,
    clients,
    upsertClients,
    team,
    batches,
    transactions: existingTransactions,
    amcMappings,
    schemeMappings,
    updateAmcMappings,
    updateSchemeMappings,
    globalConfig,
    deleteBatch,
    restoreBatch,
    purgeBatch,
    recalculateAllTransactions,
  } = useData();
  const { showToast, showConfirm } = useToast();

  const [activeTab, setActiveTab] = useState<'import' | 'history' | 'trash'>('import');
  // Actual persisted transaction count per batchId (from the server), so Batch
  // History can flag any batch whose rows didn't fully persist as INCOMPLETE
  // rather than showing a misleading green "Live".
  const [batchCounts, setBatchCounts] = useState<Record<string, number> | null>(null);
  // The gross the batch ACTUALLY holds right now, not what it declared when it
  // ran. Two batches of the same file look identical on declared figures even
  // when one of them is an empty shell.
  const [batchGross, setBatchGross] = useState<Record<string, number> | null>(null);
  const [remapping, setRemapping] = useState(false);
  useEffect(() => {
    if (activeTab !== 'history') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch('/api/data?action=batch_counts');
        if (r.ok && !cancelled) { const d = await r.json(); setBatchCounts(d.counts || {}); setBatchGross(d.gross || {}); }
      } catch (_) { /* leave null → badges default to Live */ }
    })();
    return () => { cancelled = true; };
  }, [activeTab, batches.length]);
  const [isRestoringId, setIsRestoringId] = useState<string | null>(null);
  const [importStage, setImportStage] = useState<'UPLOAD' | 'HEADER_SELECTION' | 'MAPPING' | 'PREVIEW'>('UPLOAD');

  const [processing, setProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<string>('');
  // Real parse outcome — so the status chip can't show a misleading green
  // "File Validated" after a parse that actually failed (e.g. a large .xls that
  // exhausted browser memory). null = ok/idle, string = failure reason.
  const [parseError, setParseError] = useState<string | null>(null);
  // The brokerage window found inside the file, and the operator's explicit
  // acknowledgement when it does not match the Settlement Month they picked.
  const [filePeriod, setFilePeriod] = useState<FilePeriod | null>(null);
  const [periodAck, setPeriodAck] = useState(false);
  const [previewData, setPreviewData] = useState<BrokerageTransaction[] | null>(null);
  const [newClientsFound, setNewClientsFound] = useState<Client[]>([]);

  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);

  // Track new mappings discovered in the current file
  const [discoveredAmcMappings, setDiscoveredAmcMappings] = useState<MappingEntry[]>([]);
  const [discoveredSchemeMappings, setDiscoveredSchemeMappings] = useState<MappingEntry[]>([]);
  const [autoMapStats, setAutoMapStats] = useState({ mapped: 0, total: 0, enriched: 0, autoInherited: 0 });

  const [selectedSource, setSelectedSource] = useState<TransactionSource | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>((new Date().getMonth() + 1).toString().padStart(2, '0'));
  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());

  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [rawFileContent, setRawFileContent] = useState<any[][]>([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});

  const [historyPage, setHistoryPage] = useState(1);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewFilter, setPreviewFilter] = useState<ImportFlag | 'ALL'>('ALL');
  const pageSize = 50;

  // Column mapping templates
  const [mappingTemplates, setMappingTemplates] = useState<Record<string, Record<string, string>>>(() => {
    try {
      const stored = localStorage.getItem('wf_mapping_templates');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  const [newTemplateName, setNewTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);

  const saveTemplate = () => {
    const name = newTemplateName.trim();
    if (!name) return;
    const updated = { ...mappingTemplates, [name]: columnMapping };
    setMappingTemplates(updated);
    localStorage.setItem('wf_mapping_templates', JSON.stringify(updated));
    setNewTemplateName('');
    setShowSaveTemplate(false);
    showToast(`Template "${name}" saved.`, 'success');
  };

  const loadTemplate = (name: string) => {
    if (mappingTemplates[name]) {
      setColumnMapping(mappingTemplates[name]);
      showToast(`Template "${name}" loaded.`, 'success');
    }
  };

  const deleteTemplate = (name: string) => {
    const updated = { ...mappingTemplates };
    delete updated[name];
    setMappingTemplates(updated);
    localStorage.setItem('wf_mapping_templates', JSON.stringify(updated));
    showToast(`Template "${name}" deleted.`, 'info');
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseDate = (val: any): string => {
    if (!val) return new Date().toISOString().split('T')[0];
    const str = String(val).trim();

    if (!isNaN(val) && typeof val === 'number') {
      const date = new Date((val - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }

    const dmyMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dmyMatch) {
      const [_, d, m, y] = dmyMatch;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }

    return str;
  };

  const handleSourceSelect = (source: TransactionSource) => {
    setSelectedSource(source);
    setImportStage('UPLOAD');
    setUploadedFile(null);
    setPreviewData(null);
    setRawFileContent([]);
    setColumnMapping({});
  };

  const handleBoxClick = () => {
    if (!selectedSource) {
      showToast("Please select a source (CAMS or Karvy) first.", 'warning');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) readFileContent(file);
  };

  // Parse a spreadsheet on the SERVER. Node has none of the browser's memory
  // limits, so the 45-50 MB legacy .xls CAMS ships every month parses fine here.
  // Returns the same row array the local worker would have produced.
  const parseOnServer = async (file: File): Promise<any[][]> => {
    const form = new FormData();
    form.append('file', file);
    const res = await authFetch('/api/parse-sheet', { method: 'POST', body: form });
    if (!res.ok) {
      let msg = `Server parse failed (HTTP ${res.status})`;
      try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* keep default */ }
      throw new Error(msg);
    }
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error || 'Server parse failed');
    return body.jsonData as any[][];
  };

  const readFileContent = (file: File) => {
    setUploadedFile(file);
    setProcessing(true);
    setParseError(null);
    setProcessingStep('Reading data...');

    // Large legacy .xls files (CAMS ships 40-50 MB binary .xls) expand into a huge
    // in-memory workbook that exhausts the browser tab. Send those straight to the
    // server rather than attempting a parse that is known to fail — no more
    // "FILE TOO LARGE, USE CSV" and no monthly Save-As-CSV chore.
    const isBinaryXls = /\.xls$/i.test(file.name);
    const bigMb = file.size / 1024 / 1024;
    const serverFirst = isBinaryXls && bigMb > 20;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const fileMb = (buffer.byteLength / 1024 / 1024).toFixed(1);
        // Offload parsing to a Web Worker so the UI stays responsive even for
        // multi-MB files. Without this, Chrome shows "Page Unresponsive".
        setProcessingStep(`Parsing ${fileMb} MB spreadsheet (background)…`);
        // Worker pushes progress events for slow .xls files (45 MB takes
        // ~9 s on a fast PC, can be 60+ s on older laptops).
        type ParsedOk = { ok: true; jsonData: any[][]; sheetName: string; rowCount: number; ms: number };
        type ParsedErr = { ok: false; error: string };
        type Progress = { type: 'progress'; stage: string; msg: string };

        const parseInBrowser = (): Promise<any[][]> => {
        const worker = new XlsxWorker();
        return new Promise((resolve, reject) => {
          // 3-minute hard ceiling. Generous so 100 MB+ CAMS files can finish on
          // slower machines; faster files still resolve quickly via onmessage.
          const HARD_TIMEOUT_MS = 180_000;
          const timeout = window.setTimeout(() => {
            worker.terminate();
            reject(new Error(`Parser still running after ${HARD_TIMEOUT_MS / 1000}s — the file may be corrupt or unusually large.`));
          }, HARD_TIMEOUT_MS);
          worker.onmessage = (ev: MessageEvent<ParsedOk | ParsedErr | Progress>) => {
            const d = ev.data as any;
            if (d.type === 'progress') {
              setProcessingStep(`${d.msg} (${fileMb} MB)`);
              return;
            }
            window.clearTimeout(timeout);
            worker.terminate();
            if (d.ok) {
              setProcessingStep(`Parsed ${d.rowCount.toLocaleString()} rows in ${(d.ms / 1000).toFixed(1)}s. Detecting headers…`);
              resolve(d.jsonData);
            } else {
              reject(new Error(d.error));
            }
          };
          worker.onerror = (err) => {
            window.clearTimeout(timeout);
            worker.terminate();
            reject(new Error(err.message || 'Worker error'));
          };
          // Transferable buffer — zero-copy hand-off to the worker.
          worker.postMessage({ buffer }, [buffer]);
        });
        };

        // Big legacy .xls → parse server-side directly. Everything else parses in
        // the browser, falling back to the server if that fails for any reason.
        let jsonData: any[][];
        if (serverFirst) {
          setProcessingStep(`Large ${fileMb} MB file — parsing on the server…`);
          jsonData = await parseOnServer(file);
        } else {
          try {
            jsonData = await parseInBrowser();
          } catch (browserErr: any) {
            console.warn('[import] browser parse failed, retrying on server:', browserErr?.message);
            setProcessingStep('Browser could not parse this file — parsing on the server…');
            jsonData = await parseOnServer(file);
          }
        }

        if (jsonData.length === 0) {
          showToast("File appears to be empty.", 'warning');
          setParseError('File appears to be empty');
          setProcessing(false);
          return;
        }

        setRawFileContent(jsonData);

        let detectedIndex = 0;
        const keywords = ['folio', 'pan', 'investor', 'brokerage', 'gross', 'scheme', 'date', 'amc'];
        for (let i = 0; i < Math.min(jsonData.length, 25); i++) {
          if (!jsonData[i]) continue;
          const rowStr = jsonData[i].map((c: any) => String(c).toLowerCase()).join(' ');
          if (keywords.filter(k => rowStr.includes(k)).length >= 3) {
            detectedIndex = i;
            break;
          }
        }
        setHeaderRowIndex(detectedIndex);

        // ── Auto-detect known CAMS / Karvy CSV format ─────────────────────
        const detectedHeaders = (jsonData[detectedIndex] || [])
          .map((h: any) => String(h || '').trim())
          .filter((h: string) => h);
        const presetMapping = getPresetMapping(selectedSource, detectedHeaders);

        if (presetMapping) {
          // Pre-fill mappings from the known preset BUT stop on the Mapping step so
          // the user can verify each system field is pointed at the right column
          // before any rows are processed.
          setFileHeaders(detectedHeaders);
          setColumnMapping(presetMapping);
          setFilePeriod(detectFilePeriod(jsonData[detectedIndex] || [], jsonData, detectedIndex));
          setPeriodAck(false);
          setProcessing(false);
          setImportStage('MAPPING');
          showToast(`Auto-detected ${selectedSource} format. Verify the column mapping before continuing.`, 'info');
        } else {
          setProcessing(false);
          setImportStage('HEADER_SELECTION');
        }
        // ─────────────────────────────────────────────────────────────────
      } catch (error: any) {
        // Both the browser AND the server parser failed — so it is the file, not
        // its size. Say what actually went wrong instead of blaming the size.
        const detail = error?.message ? ` (${error.message})` : '';
        showToast(`Could not parse this file${detail}. Accepted formats: .csv, .xlsx, .xls, .dbf.`, 'error');
        setParseError('Parse failed — check the file format');
        setProcessing(false);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const confirmHeaderRow = () => {
    const headers = rawFileContent[headerRowIndex].map(h => String(h || '').trim()).filter(h => h);
    setFileHeaders(headers);

    const initialMapping: Record<string, string> = {};
    SYSTEM_FIELDS.forEach(field => {
      const match = headers.find(h =>
        h.toLowerCase() === field.label.toLowerCase() ||
        h.toLowerCase().includes(field.key.toLowerCase()) ||
        (field.key === 'grossAmount' && (h.toLowerCase().includes('gross') || h.toLowerCase().includes('amount'))) ||
        (field.key === 'transactionDate' && h.toLowerCase().includes('date')) ||
        (field.key === 'amcName' && h.toLowerCase().includes('amc')) ||
        (field.key === 'currentValue' && (h.toLowerCase().includes('value') || h.toLowerCase().includes('aum')))
      );
      if (match) initialMapping[field.key] = match;
    });
    setColumnMapping(initialMapping);
    setImportStage('MAPPING');
  };

  const processData = (
    overrideMapping?: Record<string, string>,
    overrideHeaderIdx?: number,
    overrideRawData?: any[][]
  ) => {
    const activeMapping   = overrideMapping   ?? columnMapping;
    const activeHeaderIdx = overrideHeaderIdx ?? headerRowIndex;
    const activeRawData   = overrideRawData   ?? rawFileContent;

    setProcessing(true);
    const isMasterImport = selectedSource ? MASTER_SOURCES.includes(selectedSource) : false;
    setProcessingStep(isMasterImport ? 'Building investor master...' : 'Standardizing & Validating...');

    // Wrap in an async IIFE so we can `await` browser-yields between row chunks
    // — keeps the UI responsive even for 50k+ row files instead of a single
    // multi-second synchronous freeze.
    (async () => {
      const transactions: BrokerageTransaction[] = [];
      const foundNewClients: Record<string, Client> = {};
      const newAmcMappings: MappingEntry[] = [];
      const newSchemeMappings: MappingEntry[] = [];
      // Sets for O(1) dedup instead of `newAmcMappings.find(...)` per row.
      const newAmcSeen = new Set<string>();
      const newSchemeSeen = new Set<string>();

      const existingAmcDict: Record<string, string> = {};
      amcMappings.forEach(m => existingAmcDict[m.original] = m.standard);

      const existingSchemeDict: Record<string, string> = {};
      schemeMappings.forEach(m => existingSchemeDict[m.original] = m.standard);

      // ── O(1) client matching. Without these, `clients.find(...)` inside the
      //    row loop ran ~clients.length times per row — for a 10k row × 1057
      //    client import that's 10M+ ops (the cause of the long wait).
      const clientByPan = new Map<string, Client>();
      const clientByFolio = new Map<string, Client>();
      /** Every client record claiming a folio — see where it is filled. */
      const clientsByFolio = new Map<string, Client[]>();

      // ── Does this client's NAME agree with the investor on the row? ─────────
      // Folio is the strongest mapping key, but only when the record claiming it
      // is plausibly the same person. One record ("Amit Parshotam Menghani") had
      // collected ten folios belonging to six other investors, and because folio
      // is consulted first it quietly took ₹1,137.10 a month off RAVISANKAR K K
      // and Vinubhai Nathubhai Desai and gave it to Mahek Haresh Chugh.
      //
      // Tokens shorter than three letters and the words below carry no identity —
      // half the book shares "KUMAR" — so they are never evidence of a match.
      // Name index for auto-inheriting the RM on a brand-new folio: a folio not
      // yet on file, whose investor NAME uniquely matches one existing client,
      // is attached to that client so its brokerage follows the client's RM
      // instead of leaking to house. Ambiguous names (≥2 clients) map to `null`
      // and are skipped — we never guess when the name isn't unique.
      const normName = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      // Excel renders a 12-digit folio as "4.77396E+11". The worker's deScientify
      // pass recovers the full number whenever the cell still HOLDS it, but if the
      // file was saved (or exported as CSV) in that display form the digits are
      // already gone and the value reads back as six significant digits followed
      // by zeros. Such a value matches no transaction and must not be stored as
      // a folio — 201 of them reached production this way from one Karvy file.
      const isTruncatedFolio = (f: string) => /^\d{6}0{5,}$/.test(String(f || '').trim());
      const clientByName = new Map<string, Client | null>();
      // PAN is NOT a unique investor key in Indian mutual funds: a MINOR invests
      // under the guardian's PAN, so siblings legitimately share one (verified in
      // this book: Jiyanshi/Jisha Sodingara, Jiyan/Jyot Vaishnani, Tulsi/Dhyani
      // Aghara). A plain pan->client map keeps only the LAST client for a PAN, so
      // every sibling's transactions were being funnelled onto one record. Index
      // by PAN+NAME, and keep the full list per PAN so we can tell a lone holder
      // from a shared-PAN family.
      const nameKey = (s: string) => String(s || '').toUpperCase()
        // The honorific list must be anchored on a word boundary. An earlier edit
        // wrote a literal backspace byte here instead of the \b escape, so this
        // stripper matched nothing and the import stopped removing Mr./Mrs./Dr.
        // while ClientsAndHierarchy.tsx and server.js kept removing them -- the
        // import and the rest of the app then disagreed about who an investor is.
        // "Mrs. PATEL NITABEN CHIRAGKUMAR" is one of the duplicate records that
        // came from exactly this. (/s+/ had lost its backslash the same way and
        // was stripping the letter s rather than collapsing whitespace.)
        .replace(/\b(MR|MRS|MS|MISS|DR|SHRI|SMT|LATE)\b\.?/g, ' ')
        .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ').filter(Boolean).sort().join(' ');
      const clientsByPan = new Map<string, Client[]>();
      const clientByPanName = new Map<string, Client>();
      for (const c of clients) {
        if (c.pan) {
          const p = c.pan.toUpperCase();
          clientByPan.set(p, c);
          if (!clientsByPan.has(p)) clientsByPan.set(p, []);
          clientsByPan.get(p)!.push(c);
          const pk = p + '|' + nameKey(c.name);
          if (!clientByPanName.has(pk)) clientByPanName.set(pk, c);
        }
        // Keep EVERY record that claims a folio, not just the last one seen.
        //
        // `clientByFolio.set(f, c)` let the last writer win, and folio lists are
        // polluted: single folios are claimed by 80+ client records. So the winner
        // was whichever record happened to come last in `clients` — arbitrary, and
        // different between imports. That is why attribution moved on its own from
        // one month to the next, and why deleting a month and re-importing it
        // reproduced the same misattribution every time.
        for (const f of (c.folios || [])) {
          if (!clientsByFolio.has(f)) clientsByFolio.set(f, []);
          clientsByFolio.get(f)!.push(c);
          clientByFolio.set(f, c);          // kept for the enrichment paths below
        }
        const nn = normName(c.name);
        if (nn && nn !== 'unknown') {
          clientByName.set(nn, clientByName.has(nn) ? null : c);
        }
      }

      // ── Per-client holdings accumulator. Replaces the previous "spread the
      //    Client + copy the holdings array on every row" pattern which was
      //    O(rows × holdings_per_client) — i.e. up to N² array allocations
      //    and crashed the tab on big WBR9 master imports with "Out of Memory".
      //    Now: O(1) Map.set per row; final arrays materialised once at the end.
      const holdingsByClientId = new Map<string, Map<string, ClientHolding>>();

      // Hard row cap so a 200k-row file fails fast with a clear message instead
      // of trying its luck and crashing the tab halfway through.
      const ROW_CAP = 75_000;
      const dataRowCount = Math.max(0, activeRawData.length - activeHeaderIdx - 1);
      if (dataRowCount > ROW_CAP) {
        showToast(
          `File has ${dataRowCount.toLocaleString()} rows. Please split into chunks of ${ROW_CAP.toLocaleString()} or fewer to avoid memory limits.`,
          'error'
        );
        setProcessing(false);
        return;
      }

      const batchId = `${selectedSource}_${Date.now()}`;
      const mapIndices: Record<string, number> = {};
      const headerRow = activeRawData[activeHeaderIdx];

      SYSTEM_FIELDS.forEach(f => {
        if (activeMapping[f.key]) {
          mapIndices[f.key] = headerRow.findIndex((h: any) => String(h || '').trim() === activeMapping[f.key]);
        }
      });

      let mappedCount = 0;
      let autoInheritedCount = 0; // new folios attached to an existing client by unique name
      let truncatedFolioCount = 0; // folios Excel already flattened to 6 significant digits
      const period = `${selectedYear}-${selectedMonth}`;

      // Pre-build a Set of dedupe keys from already-imported transactions for O(1) duplicate lookup.
      const existingKeys = new Set<string>();
      // Folio enrichment index — bridges CAMS (codes only) ↔ Karvy (full names + PAN).
      // For each folio seen in any prior transaction, remember the best PAN / scheme / AMC names.
      type EnrichRecord = { pan?: string; folio?: string; investorName?: string; schemeName?: string; amcName?: string };
      const folioIndex = new Map<string, EnrichRecord>();
      // PAN index too, in case CAMS later provides PAN but Karvy didn't fill folio
      const panIndex = new Map<string, EnrichRecord>();
      const looksLikeCode = (s: string) => !!s && s.length <= 10 && /^[A-Z0-9_-]+$/.test(s);

      for (const t of existingTransactions) {
        if (t.folio) {
          const prev = folioIndex.get(t.folio) || {};
          folioIndex.set(t.folio, {
            pan:          prev.pan          || t.pan,
            investorName: prev.investorName || t.investorName,
            // Prefer descriptive (non-code) names already on file
            schemeName:   (prev.schemeName && !looksLikeCode(prev.schemeName)) ? prev.schemeName : (!looksLikeCode(t.schemeName) ? t.schemeName : prev.schemeName),
            amcName:      (prev.amcName    && !looksLikeCode(prev.amcName))    ? prev.amcName    : (!looksLikeCode(t.amcName)    ? t.amcName    : prev.amcName),
          });
        }
        if (t.pan) {
          const prev = panIndex.get(t.pan) || {};
          panIndex.set(t.pan, {
            folio:      prev.folio      || t.folio,
            schemeName: (prev.schemeName && !looksLikeCode(prev.schemeName)) ? prev.schemeName : (!looksLikeCode(t.schemeName) ? t.schemeName : prev.schemeName),
            amcName:    (prev.amcName    && !looksLikeCode(prev.amcName))    ? prev.amcName    : (!looksLikeCode(t.amcName)    ? t.amcName    : prev.amcName),
          });
        }
        existingKeys.add(dedupeKey(t));
      }
      let enrichedCount = 0;
      // Within-batch duplicate detection too — same key appearing twice in the same file.
      const seenInBatch = new Set<string>();

      // Chunked processing: every CHUNK_SIZE rows, yield to the browser so it
      // can paint, run animations, and stay responsive. Eliminates the multi-
      // second freeze on large files.
      const CHUNK_SIZE = 500;
      const yieldToBrowser = () => new Promise<void>(r => setTimeout(r, 0));
      const totalRows = activeRawData.length - (activeHeaderIdx + 1);

      for (let i = activeHeaderIdx + 1; i < activeRawData.length; i++) {
        if (i > activeHeaderIdx + 1 && (i - activeHeaderIdx - 1) % CHUNK_SIZE === 0) {
          const processed = i - activeHeaderIdx - 1;
          setProcessingStep(`Processing rows ${processed.toLocaleString()} of ${totalRows.toLocaleString()}…`);
          await yieldToBrowser();
        }
        const row = activeRawData[i];
        if (!row || row.length === 0) continue;

        const folio = String(row[mapIndices['folio']] || '');
        const pan = String(row[mapIndices['pan']] || '').toUpperCase().trim();
        const investorName = String(row[mapIndices['investorName']] || 'Unknown');

        const parseNum = (val: any) => {
          if (typeof val === 'number') return val;
          return parseFloat(String(val || '0').replace(/,/g, '')) || 0;
        };

        const gross = parseNum(row[mapIndices['grossAmount']]);
        const currentValue = parseNum(row[mapIndices['currentValue']]);
        const brokerageRate = parseNum(row[mapIndices['brokerageRate']]);

        // For brokerage/transaction imports require some financial signal; for master
        // imports just require any folio or PAN to identify the investor.
        if (isMasterImport) {
          if (!pan && !folio) continue;
        } else {
          if (!pan && !folio && gross === 0) continue;
        }

        const txDate = isMasterImport ? new Date().toISOString().split('T')[0] : parseDate(row[mapIndices['transactionDate']]);

        // AUTOMATIC STANDARDIZATION + CROSS-FILE ENRICHMENT
        // CAMS files only give scheme/AMC codes and no PAN. Bridge gaps from prior
        // imports keyed by folio (or PAN, if Karvy is loaded later).
        const enrichByFolio = folio ? folioIndex.get(folio) : undefined;
        const enrichByPan = pan ? panIndex.get(pan) : undefined;
        const enrich = enrichByFolio || enrichByPan;

        const rawSchemeFromFile = String(row[mapIndices['schemeName']] || '').trim();
        const rawAmcFromColumn  = mapIndices['amcName'] !== undefined
          ? String(row[mapIndices['amcName']] || '').trim()
          : '';

        // If the file gives a code, prefer the descriptive name from prior imports
        let rawScheme = rawSchemeFromFile;
        if ((!rawScheme || looksLikeCode(rawScheme)) && enrich?.schemeName) {
          rawScheme = enrich.schemeName;
        }
        if (!rawScheme) rawScheme = 'Unknown Scheme';

        let rawAmc = rawAmcFromColumn;
        if ((!rawAmc || looksLikeCode(rawAmc)) && enrich?.amcName) {
          rawAmc = enrich.amcName;
        }
        if (!rawAmc) rawAmc = deriveAmcFromScheme(rawScheme) || 'Unknown AMC';

        // Backfill PAN from prior Karvy imports when CAMS row doesn't carry one
        const effectivePan = pan || enrich?.pan || '';
        const wasEnriched = !!enrich && (
          (rawScheme !== rawSchemeFromFile) ||
          (rawAmc !== rawAmcFromColumn && !looksLikeCode(rawAmc)) ||
          (!pan && !!enrich?.pan)
        );
        if (wasEnriched) enrichedCount++;

        let standardizedAmc = existingAmcDict[rawAmc] || rawAmc;
        let standardizedScheme = existingSchemeDict[rawScheme] || rawScheme;

        // Track new mappings to be added to the dictionary automatically
        if (!existingAmcDict[rawAmc] && !newAmcSeen.has(rawAmc)) {
          newAmcSeen.add(rawAmc);
          newAmcMappings.push({ original: rawAmc, standard: rawAmc });
        }
        if (!existingSchemeDict[rawScheme] && !newSchemeSeen.has(rawScheme)) {
          newSchemeSeen.add(rawScheme);
          newSchemeMappings.push({ original: rawScheme, standard: rawScheme });
        }

        // O(1) lookup via pre-built indexes (was O(clients.length) per row).
        // FOLIO FIRST. A folio identifies one investor at one AMC, so it is the
        // strongest signal we have. PAN used to be tried first and unconditionally,
        // which is what mixed two siblings' holdings onto a single client record.
        // PAN is only trusted when the NAME also matches, or when that PAN has
        // exactly one client on file (no family sharing it).
        const panOwners = effectivePan ? (clientsByPan.get(effectivePan) || []) : [];

        // Resolve the folio against EVERY record claiming it, and let the investor
        // name break the tie. One claimant is used unless the name flatly
        // contradicts it; several claimants are only resolved when exactly one
        // agrees with the name. Anything still ambiguous yields no folio match, so
        // the row falls through to PAN/name and, failing that, stays unmapped.
        //
        // Unmapped is the right failure: it is visible on this page and reaches
        // nobody, whereas a confident wrong guess reaches the wrong person's payout
        // and nothing says so.
        const folioClaimants = folio ? (clientsByFolio.get(folio) || []) : [];
        let folioMatch: Client | undefined;
        if (folioClaimants.length === 1) {
          folioMatch = nameContradicts(folioClaimants[0].name, investorName) ? undefined : folioClaimants[0];
        } else if (folioClaimants.length > 1) {
          // RANK the claimants rather than ask "does anyone contradict?". Any record
          // sharing one word passed that test, so a folio claimed by Aaradhay Singh,
          // Dal Bahadur Singh and Manish Singh saw all three agree with the investor
          // "Aaradhay Singh" (they all contain SINGH), the importer could not choose,
          // and the row fell to the house account. The record sharing the MOST
          // identifying words wins; only a genuine tie is left to the check below.
          const top = bestNameMatches(folioClaimants.map(c => c.name), investorName).map(i => folioClaimants[i]);
          if (top.length === 1) {
            folioMatch = top[0];
          } else if (top.length > 1) {
            // Several records carry this investor's name equally well — the same
            // person filed more than once. When they all sit under the same RM and
            // BM it does not matter which one is used, so use the first rather than
            // leave the row unattached. When their RMs differ, WHICH RM owns this
            // investor is a business decision this importer must not make; settle it
            // once in Admin Console → System → Folio ownership.
            const sigOf = (c: Client) => `${c.hierarchy?.level3Id || ''}|${c.hierarchy?.level4Id || ''}`;
            if (new Set(top.map(sigOf)).size === 1) folioMatch = top[0];
          }
        }

        let matchedClient: Client | undefined =
          folioMatch ||
          (effectivePan ? clientByPanName.get(effectivePan + '|' + nameKey(investorName)) : undefined) ||
          (panOwners.length === 1 ? panOwners[0] : undefined);

        // Enrich the matched client: append a folio not yet on that record, and
        // (master imports only) backfill a missing PAN.
        //
        // This whole block used to be gated on isMasterImport, which is only
        // CAMS_WBR9 and KARVY_MFSD211. But CAMS_WBR2 and KARVY_MFSD201 — the two
        // files this page itself describes as "imported for PAN / full-name /
        // folio enrichment" — are NOT master sources, so the enrichment file
        // enriched nothing: a folio that first showed up in a monthly file was
        // never written back to the client.
        //
        // That matters because folio is the STRONGEST mapping key — clientByFolio
        // is consulted before PAN and before name. A client missing one of its own
        // folios silently falls through to PAN/name matching on the next import,
        // which is how one investor's rows drifted onto a namesake's record.
        if (matchedClient) {
          // Read back the ALREADY-accumulated version first — an investor commonly has
          // several folios across multiple rows; without this each row would start from
          // the original client and overwrite the prior row's addition, so only the LAST
          // new folio would survive. Accumulate onto foundNewClients so ALL folios attach.
          const live: Client = foundNewClients[matchedClient.id] || matchedClient;
          // A folio the source file already rendered in scientific notation comes
          // back as six significant digits and a run of zeros ("477396000000").
          // The precision is gone before we ever read the cell, so it is not a
          // real folio and must never be attached to a client record.
          const usable = folio && !isTruncatedFolio(folio) ? folio : '';
          // Null-guard: this block used to run for master imports only, where a
          // folios array was guaranteed. It now runs for EVERY row of every
          // import, so a client record without the field must not take the
          // whole import down with a TypeError.
          const held = live.folios || [];
          const enrichedFolios = usable && !held.includes(usable)
            ? [...held, usable]
            : held;
          const backfillPan = isMasterImport && effectivePan && !live.pan;
          if (enrichedFolios !== live.folios || backfillPan) {
            const updated: Client = {
              ...live,
              pan: backfillPan ? effectivePan : live.pan,
              folios: enrichedFolios,
            };
            foundNewClients[updated.id] = updated;
            matchedClient = updated;
          } else {
            matchedClient = live;
          }
        }
        if (folio && isTruncatedFolio(folio)) truncatedFolioCount++;

        // ── Attach a brand-new folio to the existing client whose investor NAME
        //    uniquely matches, so the brokerage follows that client's RM instead
        //    of leaking to house. Ambiguous names (≥2 clients) resolve to null
        //    above and are skipped — we never guess when the name isn't unique.
        //    Do NOT gate this on the client having an RM: a unique name match is
        //    a statement about IDENTITY, not about mapping. An existing client
        //    with no RM yet is still the same investor, and skipping them here
        //    drops through to the auto-create fallback below, which mints a
        //    duplicate `c_bkg_` record for someone who already exists.
        if (!matchedClient) {
          const byName = clientByName.get(normName(investorName));
          if (byName) {
            const live = foundNewClients[byName.id] || byName;
            const enrichedFolios = folio && !live.folios.includes(folio)
              ? [...live.folios, folio]
              : live.folios;
            const updated: Client = { ...live, pan: live.pan || effectivePan, folios: enrichedFolios };
            foundNewClients[updated.id] = updated;
            if (folio) clientByFolio.set(folio, updated);
            matchedClient = updated;
            autoInheritedCount++;
          }
        }

        if (!matchedClient && effectivePan) {
          const panNameKey = effectivePan + '|' + nameKey(investorName);
          if (foundNewClients[panNameKey]) {
            matchedClient = foundNewClients[panNameKey];
            if (folio && !matchedClient.folios.includes(folio)) {
              matchedClient.folios.push(folio);
            }
          } else {
            // Include the NAME in the id: two siblings on one guardian PAN must get
            // two records, not one. Keyed on PAN alone, the second sibling silently
            // collided with the first.
            const newClient: Client = {
              id: `c_auto_${effectivePan}_${nameKey(investorName).replace(/[^A-Z0-9]/g, '').slice(0, 24) || 'X'}`,
              pan: effectivePan,
              name: investorName,
              folios: folio ? [folio] : [],
              hierarchy: {
                level1Id: '',
                level2Id: '',
                level3Id: '',
                level4Id: '',
                level5Id: '',
                level6Id: '', // No owner yet. This used to hard-code 'tm1', a team id that
                //   does not exist — 239 clients ended up pointing at a ghost user,
                //   so their brokerage was credited to nobody while still LOOKING
                //   assigned. An empty slot shows honestly as "Unassigned".
                level7Id: ''
              }
            };
            foundNewClients[panNameKey] = newClient;
            matchedClient = newClient;
          }
        }

        // ── Final fallback (brokerage only): a genuinely-new investor with NO PAN in
        //    the file (CAMS/Karvy brokerage rarely carry PAN) that matched nothing
        //    above. Create a client straight from the brokerage row — keyed by
        //    normalized NAME so all of this investor's folios merge into ONE record,
        //    placed under House (no RM in a brokerage file), flagged for review. When
        //    a Folio Master later carries this investor's PAN it matches by folio and
        //    backfills the PAN into this same record (no duplicate). This guarantees
        //    no new investor is ever lost to "unmapped".
        if (!matchedClient && !isMasterImport && investorName && investorName.trim() && folio) {
          const nkey = `c_bkg_${normName(investorName)}`;
          if (foundNewClients[nkey]) {
            matchedClient = foundNewClients[nkey];
            if (folio && !matchedClient.folios.includes(folio)) matchedClient.folios.push(folio);
          } else {
            const newClient: Client = {
              id: nkey,
              pan: effectivePan || '',
              name: investorName.trim(),
              folios: folio ? [folio] : [],
              autoCreatedFromBrokerage: true,
              hierarchy: {
                level1Id: '', level2Id: '', level3Id: '', level4Id: '',
                level5Id: '', level6Id: '', level7Id: '' // House until an RM is assigned
              }
            } as any;
            foundNewClients[nkey] = newClient;
            if (folio) clientByFolio.set(folio, newClient);
            matchedClient = newClient;
          }
        }

        if (matchedClient) mappedCount++;

        // ── AUM aggregation: WBR9 carries authoritative rupee_bal (snapshot),
        //    brokerage statements carry avg_assets (estimated). Both funnel into
        //    client.holdings[], deduped by folio + scheme — latest snapshot wins.
        if (matchedClient && currentValue && currentValue > 0) {
          const isWbr9 = selectedSource === TransactionSource.CAMS_WBR9;
          const isAumBearing = isWbr9 ||
            selectedSource === TransactionSource.CAMS ||
            selectedSource === TransactionSource.KARVY ||
            selectedSource === TransactionSource.KFINTECH;

          if (isAumBearing) {
            const source: 'WBR9' | 'ESTIMATED' = isWbr9 ? 'WBR9' : 'ESTIMATED';
            const key = `${folio}|${standardizedScheme}`;

            // Lazily initialise this client's holdings Map (seeded with any
            // holdings already persisted on the client record).
            let cMap = holdingsByClientId.get(matchedClient.id);
            if (!cMap) {
              cMap = new Map<string, ClientHolding>();
              for (const h of (matchedClient.holdings || [])) {
                cMap.set(`${h.folio}|${h.schemeName}`, h);
              }
              holdingsByClientId.set(matchedClient.id, cMap);
            }

            // O(1) dedup: keep the more recent snapshot, but ESTIMATED → WBR9
            // upgrade always wins regardless of date.
            const existingH = cMap.get(key);
            if (!existingH ||
                (source === 'WBR9' && existingH.source === 'ESTIMATED') ||
                txDate >= existingH.asOfDate) {
              cMap.set(key, {
                folio,
                amcName: standardizedAmc,
                schemeName: standardizedScheme,
                aumValue: currentValue,
                asOfDate: txDate,
                source,
              });
            }
          }
        }

        const txCategory = (name: string) => {
          const low = name.toLowerCase();
          if (/\b(arbitrage)\b/i.test(low)) return 'Arbitrage';
          if (/\b(liquid|overnight|cash|money market)\b/i.test(low)) return 'Liquid';
          if (/\b(debt|bond|gilt|credit|duration|psu)\b/i.test(low)) return 'Debt';
          if (/\b(hybrid|balanced|allocation|savings)\b/i.test(low)) return 'Hybrid';
          return 'Equity';
        };

        const category = txCategory(standardizedScheme);

        // Compliance & quality flags — use enriched PAN so dedupe is consistent
        const flags: ImportFlag[] = [];
        const key = dedupeKey({ pan: effectivePan, folio, schemeName: standardizedScheme, transactionDate: txDate, grossAmount: gross });
        if (existingKeys.has(key) || seenInBatch.has(key)) flags.push('DUPLICATE');
        seenInBatch.add(key);
        if (exceedsSebiCap(category, gross, currentValue)) flags.push('SEBI_CAP_WARNING');
        if (!effectivePan) flags.push('MISSING_PAN');
        if (!matchedClient) flags.push('UNMAPPED_CLIENT');

        const remarksValue = mapIndices['remarks'] !== undefined ? String(row[mapIndices['remarks']] || '') : '';
        // Master imports populate clients only — skip creating transaction rows.
        if (!isMasterImport) {
          // Deterministic ID so re-importing the same CAMS / Kfin file is a
          // no-op upsert on the server (no duplicate rows in the DB).
          const txId = makeTxId(selectedSource!, {
            period, folio, pan: effectivePan,
            scheme: standardizedScheme, amc: standardizedAmc,
            date: txDate || '', gross, curVal: currentValue,
            rate: brokerageRate, remarks: remarksValue,
          });
          transactions.push({
            id: txId,
            batchId,
            source: selectedSource!,
            uploadDate: new Date().toISOString(),
            transactionDate: txDate,
            brokeragePeriod: period,
            folio,
            pan: effectivePan,
            investorName,
            amcName: standardizedAmc,
            schemeName: standardizedScheme,
            category,
            grossAmount: gross,
            currentValue,
            brokerageRate,
            remarks: remarksValue,
            transactionType: classifyTransaction(remarksValue),
            mappedClientId: matchedClient?.id,
            status: TransactionStatus.VALIDATED,
            _flags: flags.length > 0 ? flags : undefined,
          });
        }
      }

      // ── Finalize per-client holdings from the accumulator Map. This is the
      //    ONLY place we materialise the holdings arrays and recompute totalAum
      //    — once per affected client instead of once per row.
      for (const [clientId, cMap] of holdingsByClientId) {
        const holdings = Array.from(cMap.values());
        if (holdings.length === 0) continue;
        const totalAum = holdings.reduce((s, h) => s + (h.aumValue || 0), 0);
        const latestAsOf = holdings.reduce((m, h) => (h.asOfDate > m ? h.asOfDate : m), '');
        const aumSource: 'WBR9' | 'ESTIMATED' = holdings.some(h => h.source === 'WBR9') ? 'WBR9' : 'ESTIMATED';

        // Find the most-recent version of this client we've been mutating
        const base = foundNewClients[clientId]
          || clients.find(c => c.id === clientId);
        if (!base) continue;
        foundNewClients[clientId] = {
          ...base,
          holdings,
          totalAum,
          aumAsOf: latestAsOf || base.aumAsOf,
          aumSource,
        };
      }

      // Disambiguate genuinely-distinct rows that hash to the SAME content-based
      // ID — e.g. an investor's 3 identical SIP installments (same folio, scheme,
      // amount and date) are separate transactions in the registrar/AdvisorKhoj,
      // but makeTxId (content hash) would collapse them to one, so their brokerage
      // is lost on save (INSERT … ON DUPLICATE KEY). Append an occurrence index to
      // the 2nd+ collision. Deterministic by row order → re-import stays idempotent.
      const idSeen = new Map<string, number>();
      for (const tx of transactions) {
        const n = idSeen.get(tx.id) || 0;
        idSeen.set(tx.id, n + 1);
        if (n > 0) tx.id = `${tx.id}_${n}`;
      }

      // ── Orphan guard: every mappedClientId must belong to a client that either
      //    already exists or is about to be created by this import. A transaction
      //    pointing at a client id that is never persisted belongs to nobody, so
      //    no RM is ever paid for it and it does not show up as "unmapped" —
      //    the brokerage just silently vanishes. That happened for real (742 tx,
      //    ₹8,158) when the name-match above was gated on the client having an RM
      //    and dropped through to the `c_bkg_` fallback. Downgrade any survivor to
      //    plainly unmapped so it surfaces for review instead of disappearing.
      const knownClientIds = new Set<string>([
        ...clients.map(c => c.id),
        ...Object.values(foundNewClients).map(c => c.id),
      ]);
      let orphanGuardCount = 0;
      for (const tx of transactions) {
        if (tx.mappedClientId && !knownClientIds.has(tx.mappedClientId)) {
          tx.mappedClientId = '';
          orphanGuardCount++;
        }
      }
      if (orphanGuardCount > 0) {
        console.warn(`[import] orphan guard: ${orphanGuardCount} transaction(s) referenced a client id that will not exist; marked unmapped for review.`);
      }

      // Say it out loud. These rows import and look fine, but their folio can
      // never match a client, so they quietly fall back to PAN/name mapping.
      if (truncatedFolioCount > 0) {
        showToast(
          `${truncatedFolioCount.toLocaleString()} row${truncatedFolioCount !== 1 ? 's' : ''} have a folio Excel flattened to scientific notation (e.g. 477396000000) — the real digits are already lost in the file. Re-download it as .xlsx (do not open and re-save as CSV) so these folios map correctly.`,
          'warning'
        );
      }
      setPreviewData(transactions);
      setNewClientsFound(Object.values(foundNewClients));
      setDiscoveredAmcMappings(newAmcMappings);
      setDiscoveredSchemeMappings(newSchemeMappings);
      setAutoMapStats({
        mapped: mappedCount,
        // For master imports `transactions.length` is 0 — use folio-row count for stats instead
        total: isMasterImport ? Object.keys(foundNewClients).length : transactions.length,
        enriched: enrichedCount,
        autoInherited: autoInheritedCount,
      });
      setProcessing(false);
      setImportStage('PREVIEW');
    })();
  };

  // Link any orphan (unmapped) transactions to clients by folio, then recalc so
  // their brokerage flows. Shared by the auto-trigger after a Folio Master import
  // and the manual "Re-map Unmapped" button. Returns the number linked.
  const runRemapAndRecalc = async (): Promise<number> => {
    setRemapping(true);
    try {
      const r = await authFetch('/api/data?action=remap_unmapped');
      if (!r.ok) { showToast('Could not re-map unmapped transactions (server error). Please try again.', 'error'); return 0; }
      const d = await r.json();
      const n = Number(d.remapped) || 0;
      if (n > 0) {
        showToast(`${n.toLocaleString()} previously-unmapped transaction${n !== 1 ? 's' : ''} linked to clients. Recalculating payouts…`, 'info');
        await recalculateAllTransactions();
        showToast(`Done — ${n.toLocaleString()} transaction${n !== 1 ? 's' : ''} now flow to their clients/RMs.`, 'success');
      } else {
        showToast('No unmapped transactions matched a client folio — nothing to link.', 'info');
      }
      return n;
    } catch (_) {
      showToast('Could not re-map unmapped transactions. Please try again.', 'error');
      return 0;
    } finally {
      setRemapping(false);
    }
  };

  const handleConfirmImport = async () => {
    // Refuse a month the file itself contradicts. This is the last gate before
    // rows land, and it is the one that was missing when June's statement went
    // in as July. The operator can still override, but only deliberately.
    if (filePeriod && filePeriod.period !== `${selectedYear}-${selectedMonth}` && !periodAck) {
      showToast(
        `This file covers ${prettyPeriod(filePeriod.period)} (${filePeriod.column}: ${filePeriod.fromLabel} → ${filePeriod.toLabel}), ` +
        `not ${prettyPeriod(`${selectedYear}-${selectedMonth}`)}. Change the Settlement Month, or tick the box in step 1 to import it anyway.`,
        'error'
      );
      return;
    }
    const isMasterImport = selectedSource ? MASTER_SOURCES.includes(selectedSource) : false;

    // Save discovered AMC/Scheme mappings (useful for both flows so codes resolve later)
    if (discoveredAmcMappings.length > 0) {
      updateAmcMappings([...amcMappings, ...discoveredAmcMappings]);
    }
    if (discoveredSchemeMappings.length > 0) {
      updateSchemeMappings([...schemeMappings, ...discoveredSchemeMappings]);
    }

    if (isMasterImport) {
      // Master imports only enrich the clients table — no transactions or payout calc.
      // AWAIT the client save so the new records are on the server before we try to
      // re-map orphan transactions to them.
      if (newClientsFound.length > 0) await upsertClients(newClientsFound);
      showToast(`Master import complete. ${newClientsFound.length} client record${newClientsFound.length !== 1 ? 's' : ''} added or enriched.`, 'success');
      clearUpload();
      setSelectedSource(null);
      // Auto-link any brokerage rows that were previously unmapped but now match a
      // newly-created client by folio — makes the monthly flow hands-off.
      if (newClientsFound.length > 0) { await runRemapAndRecalc(); }
      return;
    }

    if (!previewData) return;

    // ── Zero-gross safety net ──────────────────────────────────────────────
    // On a BROKERAGE STATEMENT, every row being ₹0 means the gross column was
    // mis-mapped — block it rather than silently under-count everyone's earnings.
    //
    // But the TRANSACTION files (CAMS WBR2 / Karvy MFSD201) legitimately carry NO
    // brokerage: the registrars leave `brokcomm` at 0 there (verified — 0 of 1,334
    // rows non-zero in a real WBR2), because brokerage is only in the Brokerage
    // Statement. Those files are imported for PAN / full-name / folio enrichment,
    // so ₹0 is expected and must NOT block them (this used to block the monthly
    // WBR2 import with misleading "re-check the column mapping" advice).
    const isMasterImportNow = selectedSource ? MASTER_SOURCES.includes(selectedSource) : false;
    const isTxnEnrichmentFile = selectedSource === TransactionSource.CAMS_WBR2
                             || selectedSource === TransactionSource.KARVY_MFSD201;
    const grossSum = previewData.reduce((acc, curr) => acc + (curr.grossAmount || 0), 0);
    if (!isMasterImportNow && !isTxnEnrichmentFile && previewData.length > 0 && grossSum === 0) {
      showToast(
        'Import blocked: every row has ₹0 brokerage. On a Brokerage Statement the gross column should hold the commission amount — re-check the column mapping, or switch the file type above if this is a Transactions (WBR2/MFSD201) or Folio Master file.',
        'error'
      );
      return;
    }
    // Enrichment file with no brokerage — proceed, but be explicit about it so
    // nobody expects this import to credit anyone's earnings.
    if (isTxnEnrichmentFile && grossSum === 0 && previewData.length > 0) {
      showToast(
        `Importing ${previewData.length.toLocaleString()} transaction rows for folio/PAN enrichment. This file carries no brokerage (₹0) — earnings come from the Brokerage Statement import.`,
        'info'
      );
    }

    // ── Wrong-order guard ──────────────────────────────────────────────────
    // A brokerage statement has no PAN, and its AMC / scheme columns are codes. Both
    // are filled in from the Transactions file (WBR2 / MFSD201) already in the system,
    // and the transaction ID is a hash that includes them. So the SAME statement
    // imported before that file gets blank PANs, code-valued names and a different set
    // of IDs — and new investors, unmatched, are filed under House with no RM.
    // The Folio Master leaves no trace to check, so only the Transactions file can be
    // verified here; the message names both.
    const isBrokerageStatementNow = selectedSource === TransactionSource.CAMS
                                 || selectedSource === TransactionSource.KARVY
                                 || selectedSource === TransactionSource.KFINTECH;
    if (isBrokerageStatementNow) {
      const periodNow = `${selectedYear}-${selectedMonth}`;
      const haveTransactionsFile = existingTransactions.some(t =>
        t.brokeragePeriod === periodNow &&
        (t.source === TransactionSource.CAMS_WBR2 || t.source === TransactionSource.KARVY_MFSD201));
      if (!haveTransactionsFile) {
        const go = await showConfirm({
          title: 'Transactions file not imported for this month',
          message: `No Transactions file (WBR2 / MFSD201) has been imported for ${prettyPeriod(periodNow)}. The Brokerage Statement carries codes only; PAN, full investor names and scheme/AMC names come from that file. Imported first, this statement will be stored with blank PANs and code-valued names, will get different row IDs from a correct import, and new investors will land in House with no RM. Import step 1 (WBR2 / MFSD201) and step 2 (WBR9 / MFSD211) first.`,
          confirmText: 'Import anyway',
          variant: 'warning',
        });
        if (!go) return;
      }
    }

    if (newClientsFound.length > 0) {
      upsertClients(newClientsFound);
    }

    // Strip preview-only `_flags` before persisting.
    const sanitized = previewData.map(({ _flags, ...rest }) => rest);
    const calculatedTransactions = runBatchCalculation(sanitized, globalConfig, clients, team);

    const totalGross = previewData.reduce((acc, curr) => acc + curr.grossAmount, 0);

    // Persist and CONFIRM before claiming success. A failed save now shows the
    // real error (from saveToDb) instead of a misleading green "Success" toast.
    // Re-importing is idempotent (deterministic tx IDs upsert), so retry is safe.
    const batchId = previewData[0].batchId;
    const expectedRows = calculatedTransactions.length;                        // raw file rows
    // A CAMS/Karvy file legitimately contains duplicate lines that collapse to a
    // single row on the server (transactions share a deterministic id). So the
    // integrity check compares against the number of UNIQUE ids we send — NOT the
    // raw row count — otherwise every normal import with any duplicate row would
    // be wrongly flagged as incomplete.
    const expectedUnique = new Set(calculatedTransactions.map(t => t.id)).size;
    const mergedDupes = expectedRows - expectedUnique;

    // 1) Save the transactions FIRST.
    const okTx = await addTransactions(calculatedTransactions);
    if (!okTx) {
      // The batch is NOT recorded, so the optimistic rows (filtered by active
      // batches) stay hidden. Nothing half-finalized.
      showToast('Import failed: transactions were NOT saved (see the error above). Nothing was recorded — please retry.', 'error');
      return;
    }

    // 2) INTEGRITY GUARD — verify the server actually stored the rows before we
    //    record the batch as "Live". This is exactly what caught fire before:
    //    a DB constraint error rolled back the transaction insert while the
    //    (separate) batch write survived, leaving a "Live" batch with 0 rows and
    //    a report showing ₹0. We compare the server's count to expectedUnique, so
    //    only a REAL shortfall (rows genuinely missing) blocks the batch.
    let persisted: number | null = null;
    try {
      const r = await authFetch('/api/data?action=batch_counts');
      if (r.ok) { const d = await r.json(); persisted = Number(d.counts?.[batchId] ?? 0); }
    } catch (_) { /* verification unavailable — fall through, batch still recorded */ }
    if (persisted !== null && persisted < expectedUnique) {
      showToast(
        `Import incomplete: only ${persisted.toLocaleString()} of ${expectedUnique.toLocaleString()} unique transactions were saved to the server. ` +
        `The batch was NOT recorded (so it won't show as Live) — please retry.`,
        'error'
      );
      return;
    }

    // 3) Now it's safe to record the batch. verifiedCount (unique rows actually
    //    stored) is what the Batch History badge checks — so it reads Live only
    //    when the server truly holds the rows.
    const verified = persisted ?? expectedUnique;
    const okBatch = await addBatch({
      id: batchId,
      fileName: uploadedFile?.name || 'Import',
      uploadDate: new Date().toISOString(),
      status: TransactionStatus.APPROVED,
      totalLines: expectedRows,
      totalGross,
      unmappedCount: expectedRows - autoMapStats.mapped,
      verifiedCount: verified
    } as any);

    if (!okBatch) {
      showToast('Transactions were saved, but recording the batch failed — please retry (re-import is safe).', 'error');
      return;
    }

    showToast(
      `Success: ${verified.toLocaleString()} transactions imported & verified on server` +
      `${mergedDupes > 0 ? ` (${mergedDupes.toLocaleString()} duplicate row${mergedDupes !== 1 ? 's' : ''} merged)` : ''}. ` +
      `New AMCs/Schemes were auto-registered in the Standardizer.`,
      'success'
    );
    setHistoryPage(1);
    setActiveTab('history');
    clearUpload();
    setSelectedSource(null);
  };

  const clearUpload = () => {
    setUploadedFile(null);
    setPreviewData(null);
    setNewClientsFound([]);
    setDiscoveredAmcMappings([]);
    setDiscoveredSchemeMappings([]);
    setRawFileContent([]);
    setFilePeriod(null);
    setPeriodAck(false);
    setImportStage('UPLOAD');
  };

  const handleDeleteBatch = async (batchId: string) => {
    const confirmed = await showConfirm({
      title: 'Move Import to Trash?',
      message: 'The batch and its transactions will be hidden from reports. You can restore it from the Trash tab within 30 days.',
      confirmText: 'Move to Trash',
      variant: 'warning'
    });
    if (!confirmed) return;
    setIsDeletingId(batchId);
    try {
      await deleteBatch(batchId);
      showToast('Import moved to Trash. Restore within 30 days.', 'success');
    } catch (e) {
      console.error(e);
      showToast('Failed to delete batch. Please try again later.', 'error');
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleRestoreBatch = async (batchId: string) => {
    setIsRestoringId(batchId);
    try {
      await restoreBatch(batchId);
      showToast('Import restored. Reports will reflect it immediately.', 'success');
    } catch (e) {
      console.error(e);
      showToast('Failed to restore batch.', 'error');
    } finally {
      setIsRestoringId(null);
    }
  };

  const handlePurgeBatch = async (batchId: string) => {
    // Say what is about to be lost, in rows and in rupees. A purge here once
    // destroyed a month of CAMS brokerage — Rs 1.51 lakh — and left no batch
    // record to restore from, because the dialog only said "cannot be undone"
    // without ever naming the file or the money.
    const b: any = (batches || []).find((x: any) => x.id === batchId);
    const rows = batchCounts?.[batchId];
    const money = batchGross?.[batchId];
    const what = [
      b?.fileName ? `“${b.fileName}”` : `batch ${batchId}`,
      rows !== undefined ? `${rows.toLocaleString()} transaction${rows === 1 ? '' : 's'}` : null,
      money ? `₹${money.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of brokerage` : null,
    ].filter(Boolean).join(' — ');
    const confirmed = await showConfirm({
      title: 'Permanently delete this import?',
      message: rows === 0
        ? `${what}. This batch holds no transactions, so deleting it removes only the empty record — nothing else is affected.`
        : `${what} will be hard-deleted from the database. This CANNOT be undone and leaves nothing to restore from — ` +
          `you would have to import the original file again. If you only want it out of reports, use Move to Trash instead.`,
      confirmText: 'Delete Forever',
      variant: 'danger'
    });
    if (!confirmed) return;
    setIsDeletingId(batchId);
    try {
      await purgeBatch(batchId);
      showToast('Import permanently deleted.', 'success');
    } catch (e) {
      console.error(e);
      showToast('Failed to purge batch.', 'error');
    } finally {
      setIsDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Data Import</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Processing brokerage files with automated name standardization.</p>
        </div>
        <div className="flex space-x-2 bg-white dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm">
          <button onClick={() => { setActiveTab('import'); setHistoryPage(1); }} className={`px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'import' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}`}>New Upload</button>
          <button onClick={() => { setActiveTab('history'); setHistoryPage(1); }} className={`px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'history' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}`}>Batch History</button>
          <button onClick={() => { setActiveTab('trash'); setHistoryPage(1); }} className={`px-4 py-2 text-sm font-medium rounded-md transition flex items-center gap-1.5 ${activeTab === 'trash' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}`}>
            <Trash2 className="w-3 h-3" />
            Trash
            {batches.filter(b => b.deletedAt).length > 0 && (
              <span className="bg-amber-200 dark:bg-amber-800/60 text-amber-900 dark:text-amber-200 text-[10px] font-black px-1.5 py-0.5 rounded-full">
                {batches.filter(b => b.deletedAt).length}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === 'import' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className={`bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-opacity ${importStage !== 'UPLOAD' ? 'opacity-50 pointer-events-none' : ''}`}>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4 flex items-center"><span className="bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 w-6 h-6 rounded-full inline-flex items-center justify-center text-xs mr-2">1</span>Source & Period</h3>

              {/* Source matrix: RTA × file type. Brokerage-only = codes; Transactions/Master = full PAN+names. */}
              <div className="mb-4 space-y-3">
                {/* The ORDER is part of the data. A brokerage statement carries codes only: its PAN,
                    full investor name and scheme/AMC names are read from the Transactions file that is
                    already in the system, and a transaction's ID is built from them. Import the statement
                    first and the same file gets different IDs, blank PANs and House clients. */}
                {([
                  { label: '1 · Transactions (Full)', cams: TransactionSource.CAMS_WBR2,    karvy: TransactionSource.KARVY_MFSD201, hint: 'WBR2 / MFSD201 — PAN + full names' },
                  { label: '2 · Folio Master',        cams: TransactionSource.CAMS_WBR9,    karvy: TransactionSource.KARVY_MFSD211, hint: 'WBR9 / MFSD211 — investor master only' },
                  { label: '3 · Brokerage Statement', cams: TransactionSource.CAMS,         karvy: TransactionSource.KARVY,         hint: 'CAMS (normal, then SIF), then Karvy' },
                ] as const).map(row => (
                  <div key={row.label}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{row.label}</span>
                      <span className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">{row.hint}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {[row.cams, row.karvy].map(src => {
                        const isCams = src.startsWith('CAMS');
                        const label = isCams
                          ? (src === TransactionSource.CAMS ? 'CAMS' : src.replace('CAMS_', 'CAMS '))
                          : (src === TransactionSource.KARVY ? 'Karvy' : src.replace('KARVY_', 'Karvy '));
                        return (
                          <button
                            key={src}
                            onClick={() => handleSourceSelect(src)}
                            className={`px-3 py-2 border-2 rounded-lg transition text-xs font-bold ${selectedSource === src
                              ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
                              : 'border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center"><Calendar className="w-3 h-3 mr-1" /> Settlement Month</label>
                <div className="grid grid-cols-2 gap-2">
                  <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="border border-slate-200 dark:border-slate-600 rounded-lg p-2 text-sm bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 font-bold">
                    {MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)} className="border border-slate-200 dark:border-slate-600 rounded-lg p-2 text-sm bg-slate-50 dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 font-bold">
                    {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                {/* What month is actually INSIDE the file — the check that was missing */}
                {filePeriod && (
                  filePeriod.period === `${selectedYear}-${selectedMonth}` ? (
                    <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2">
                      <p className="text-[11px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
                        ✓ File covers {prettyPeriod(filePeriod.period)}
                      </p>
                      <p className="text-[10px] text-emerald-700/80 dark:text-emerald-300/80 mt-0.5">
                        {filePeriod.column}: {filePeriod.fromLabel} → {filePeriod.toLabel} — matches the month you selected.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg border-2 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-2.5">
                      <p className="text-[11px] font-black uppercase tracking-widest text-red-700 dark:text-red-300">
                        ⚠ Wrong month — stop and check
                      </p>
                      <p className="text-[11px] text-red-800 dark:text-red-200 mt-1 leading-relaxed">
                        This file's own brokerage period is <span className="font-black">{prettyPeriod(filePeriod.period)}</span>
                        {' '}({filePeriod.column}: {filePeriod.fromLabel} → {filePeriod.toLabel}), but you selected{' '}
                        <span className="font-black">{prettyPeriod(`${selectedYear}-${selectedMonth}`)}</span>.
                      </p>
                      <p className="text-[10px] text-red-700/90 dark:text-red-300/90 mt-1">
                        Importing it under the wrong month counts that month's brokerage twice and pays every RM the wrong amount.
                        Either switch the Settlement Month to {prettyPeriod(filePeriod.period)}, or download the right file.
                      </p>
                      <label className="flex items-start gap-2 mt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={periodAck}
                          onChange={e => setPeriodAck(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="text-[10px] font-bold text-red-800 dark:text-red-200">
                          I have checked this and the month is deliberate — let me import anyway
                        </span>
                      </label>
                    </div>
                  )
                )}

              </div>
            </div>

            <div className={`bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-opacity ${importStage !== 'UPLOAD' && importStage !== 'HEADER_SELECTION' ? 'opacity-50' : ''}`}>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4 flex items-center"><span className="bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 w-6 h-6 rounded-full inline-flex items-center justify-center text-xs mr-2">2</span>Select File</h3>
              <input type="file" ref={fileInputRef} className="hidden" accept=".csv,.xlsx,.xls,.dbf" onChange={handleFileChange} />
              {!uploadedFile ? (
                <div className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer ${!selectedSource ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 opacity-60' : 'border-slate-300 dark:border-slate-600 hover:border-blue-500 hover:bg-slate-50 dark:hover:bg-slate-700'}`} onClick={handleBoxClick}>
                  <UploadCloud className="w-10 h-10 text-slate-400 mx-auto mb-3" />
                  <p className="text-slate-600 dark:text-slate-400 font-medium text-sm">Upload Spreadsheet</p>
                </div>
              ) : (
                <div className="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-lg border border-slate-200 dark:border-slate-600">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold truncate max-w-[120px] dark:text-slate-200">{uploadedFile.name}</span>
                    <button onClick={clearUpload} className="text-slate-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  {processing
                    ? <div className="text-xs text-blue-600 animate-pulse font-black uppercase tracking-widest">{processingStep}</div>
                    : parseError
                      ? <div className="text-xs text-red-600 font-bold flex items-center uppercase tracking-widest"><ShieldAlert className="w-3 h-3 mr-1" /> {parseError}</div>
                      : <div className="text-xs text-green-600 font-bold flex items-center uppercase tracking-widest"><CheckCircle className="w-3 h-3 mr-1" /> File Validated</div>}
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-2 min-h-[400px]">
            {importStage === 'HEADER_SELECTION' && (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm h-full flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                  <h3 className="font-bold text-slate-900 dark:text-slate-100">Define Header Row</h3>
                  <button onClick={confirmHeaderRow} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-md shadow-blue-50 transition hover:bg-blue-700">Confirm Header Row <ArrowRight className="inline w-4 h-4 ml-1" /></button>
                </div>
                <div className="overflow-auto flex-1">
                  <table className="w-full text-xs text-left whitespace-nowrap">
                    <tbody>
                      {rawFileContent.slice(0, 15).map((row, idx) => (
                        <tr key={idx} onClick={() => setHeaderRowIndex(idx)} className={`cursor-pointer border-b border-slate-100 dark:border-slate-700 ${idx === headerRowIndex ? 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-inset ring-blue-500' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                          <td className="px-4 py-3 bg-slate-100 dark:bg-slate-700 border-r border-slate-200 dark:border-slate-600 text-slate-400 dark:text-slate-500 font-mono">{idx + 1}</td>
                          {row.map((cell: any, ci: number) => <td key={ci} className="px-4 py-3 truncate max-w-[120px] text-slate-700 dark:text-slate-300">{cell}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {importStage === 'MAPPING' && (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm h-full flex flex-col animate-in fade-in slide-in-from-right-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center gap-3">
                  <h3 className="font-bold text-slate-900 dark:text-slate-100">Column Mapping</h3>
                  <div className="flex items-center gap-2">
                    {/* Load template dropdown */}
                    {Object.keys(mappingTemplates).length > 0 && (
                      <select
                        defaultValue=""
                        onChange={e => { if (e.target.value) loadTemplate(e.target.value); e.target.value = ''; }}
                        className="text-xs font-bold border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                      >
                        <option value="" disabled>Load Template…</option>
                        {Object.keys(mappingTemplates).map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    )}
                    {/* Save template */}
                    {showSaveTemplate ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          placeholder="Template name…"
                          value={newTemplateName}
                          onChange={e => setNewTemplateName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveTemplate(); if (e.key === 'Escape') setShowSaveTemplate(false); }}
                          autoFocus
                          className="text-xs border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-700 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none w-32"
                        />
                        <button onClick={saveTemplate} className="text-xs bg-emerald-600 text-white px-2 py-2 rounded-lg font-bold hover:bg-emerald-700 transition">Save</button>
                        <button onClick={() => setShowSaveTemplate(false)} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 px-1">✕</button>
                      </div>
                    ) : (
                      <button onClick={() => setShowSaveTemplate(true)} className="text-xs border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 px-3 py-2 rounded-lg font-bold transition flex items-center gap-1">
                        <TableProperties className="w-3 h-3" /> Save Template
                      </button>
                    )}
                    <button onClick={() => processData()} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-md shadow-blue-50 transition hover:bg-blue-700 whitespace-nowrap">
                      Standardize <ArrowRightCircle className="inline w-4 h-4 ml-1" />
                    </button>
                  </div>
                </div>

                {/* Saved templates list */}
                {Object.keys(mappingTemplates).length > 0 && (
                  <div className="px-6 pt-3 flex flex-wrap gap-2">
                    {Object.keys(mappingTemplates).map(name => (
                      <span key={name} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-800 rounded-full text-[10px] font-bold">
                        {name}
                        <button onClick={() => deleteTemplate(name)} className="text-blue-400 hover:text-red-500 dark:hover:text-red-400 transition leading-none">✕</button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="p-6 space-y-3 overflow-y-auto flex-1">
                  {getSystemFields(selectedSource).map(field => (
                    <div key={field.key} className="flex items-center justify-between p-3 rounded-lg border border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                      <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                        {field.label} {field.required && <span className="text-red-500">*</span>}
                      </span>
                      <select
                        value={columnMapping[field.key] || ''}
                        onChange={e => setColumnMapping(prev => ({ ...prev, [field.key]: e.target.value }))}
                        className="w-1/2 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-700 dark:text-slate-100 font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                      >
                        <option value="">-- Unmapped --</option>
                        {fileHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {importStage === 'PREVIEW' && selectedSource && MASTER_SOURCES.includes(selectedSource) && (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm h-full flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-slate-100">Master Import Preview</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">{newClientsFound.length}</span> investor record{newClientsFound.length !== 1 ? 's' : ''} ready to add/enrich
                    </p>
                  </div>
                  <button onClick={handleConfirmImport} className="bg-emerald-600 text-white px-6 py-2 rounded-lg text-sm font-bold shadow-lg shadow-emerald-50 hover:bg-emerald-700 transition">
                    Finalize Master Import
                  </button>
                </div>
                <div className="bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-emerald-800 p-3 text-[11px] text-emerald-700 dark:text-emerald-400 font-medium flex items-center">
                  <CheckCircle className="w-3.5 h-3.5 mr-2 flex-shrink-0" />
                  Master files do not generate payouts. They populate PAN, folio, and scheme info so future brokerage imports auto-resolve.
                </div>
                <div className="overflow-auto flex-1">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-white dark:bg-slate-800 sticky top-0 border-b border-slate-200 dark:border-slate-700">
                      <tr>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">Investor</th>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">PAN</th>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">Folios</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {newClientsFound.slice((previewPage - 1) * pageSize, previewPage * pageSize).map(c => (
                        <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                          <td className="px-4 py-3 font-bold text-slate-900 dark:text-slate-100 truncate max-w-[220px]">{c.name}</td>
                          <td className="px-4 py-3 font-mono text-[11px] text-slate-700 dark:text-slate-300">{c.pan || <span className="text-slate-400 italic">—</span>}</td>
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{c.folios.length} folio{c.folios.length !== 1 ? 's' : ''}</td>
                        </tr>
                      ))}
                      {newClientsFound.length === 0 && (
                        <tr><td colSpan={3} className="py-12 text-center text-slate-400 dark:text-slate-500 text-xs">No new investor records found — all rows already exist in the system.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {newClientsFound.length > pageSize && (
                  <Pagination
                    currentPage={previewPage}
                    totalItems={newClientsFound.length}
                    pageSize={pageSize}
                    onPageChange={setPreviewPage}
                  />
                )}
              </div>
            )}

            {importStage === 'PREVIEW' && previewData && selectedSource && !MASTER_SOURCES.includes(selectedSource) && (() => {
              const counts = {
                DUPLICATE: 0,
                SEBI_CAP_WARNING: 0,
                MISSING_PAN: 0,
                UNMAPPED_CLIENT: 0,
              } as Record<ImportFlag, number>;
              for (const t of previewData) {
                if (t._flags) for (const f of t._flags) counts[f]++;
              }

              // ── Leakage check: any row whose resolved client has NO RM
              //    (level3Id) — or no client at all — pays 100% to house. This is
              //    the true "unattributed" figure (broader than the UNMAPPED flag,
              //    which only catches rows with no client record at all).
              const clientById = new Map<string, Client>();
              clients.forEach(c => clientById.set(c.id, c));
              newClientsFound.forEach(c => clientById.set(c.id, c));
              let houseCount = 0, houseGross = 0;
              const houseFolios = new Set<string>();
              for (const t of previewData) {
                const c = t.mappedClientId ? clientById.get(t.mappedClientId) : undefined;
                if (!c || !c.hierarchy || !c.hierarchy.level3Id) {
                  houseCount++;
                  houseGross += (t.grossAmount || 0);
                  if (t.folio) houseFolios.add(t.folio);
                }
              }

              const filteredPreview = previewFilter === 'ALL'
                ? previewData
                : previewData.filter(t => t._flags?.includes(previewFilter));
              const FLAG_META: Record<ImportFlag, { label: string; tone: string; Icon: any }> = {
                DUPLICATE:        { label: 'Duplicate',        tone: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800', Icon: Copy },
                SEBI_CAP_WARNING: { label: 'SEBI cap risk',    tone: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800', Icon: ShieldAlert },
                MISSING_PAN:      { label: 'No PAN',           tone: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600', Icon: UserX },
                UNMAPPED_CLIENT:  { label: 'Unmapped',         tone: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800', Icon: AlertTriangle },
              };
              const totalFlagged = Object.values(counts).reduce((a, b) => a + b, 0);
              const blockingDuplicates = counts.DUPLICATE > 0;

              // Transaction-type rollup
              const typeCounts = previewData.reduce<Record<string, number>>((acc, t) => {
                const k = t.transactionType || 'OTHER';
                acc[k] = (acc[k] || 0) + 1;
                return acc;
              }, {});
              const orderedTypes: Array<{ key: TransactionType; label: string; tone: string }> = [
                { key: 'SIP',         label: 'SIP',         tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
                { key: 'LUMPSUM',     label: 'Lumpsum',     tone: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
                { key: 'REDEMPTION',  label: 'Redemption',  tone: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
                { key: 'SWITCH_IN',   label: 'Switch In',   tone: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' },
                { key: 'SWITCH_OUT',  label: 'Switch Out',  tone: 'bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400' },
                { key: 'STP',         label: 'STP',         tone: 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
                { key: 'SWP',         label: 'SWP',         tone: 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
                { key: 'DIVIDEND',    label: 'Dividend',    tone: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' },
                { key: 'BONUS',       label: 'Bonus',       tone: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
                { key: 'OTHER',       label: 'Other',       tone: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300' },
              ];

              return (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm h-full flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-slate-100">Import Preview</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {previewData.length} records • {autoMapStats.mapped} mapped to clients
                      {autoMapStats.enriched > 0 && <> • <span className="text-emerald-600 dark:text-emerald-400 font-bold">{autoMapStats.enriched} enriched from prior imports</span></>}
                      {autoMapStats.autoInherited > 0 && <> • <span className="text-emerald-600 dark:text-emerald-400 font-bold">{autoMapStats.autoInherited} new folio{autoMapStats.autoInherited !== 1 ? 's' : ''} auto-matched to existing clients</span></>}
                      {totalFlagged > 0 && <> • <span className="text-amber-600 dark:text-amber-400 font-bold">{totalFlagged} flag{totalFlagged !== 1 ? 's' : ''}</span></>}
                    </p>
                  </div>
                  <button
                    onClick={handleConfirmImport}
                    className="bg-green-600 text-white px-6 py-2 rounded-lg text-sm font-bold shadow-lg shadow-green-50 hover:bg-green-700 transition disabled:opacity-50"
                  >
                    Finalize Import
                  </button>
                </div>

                {/* ── Unattributed-to-house banner ───────────────────────────
                    Surfaces brokerage that will flow 100% to company retention
                    because its folio isn't mapped to an RM. Impossible to miss,
                    and points to the one-click fix on the Reconciliation tab. */}
                {houseCount > 0 && (
                  <div className="border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 mt-0.5 text-red-600 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-bold text-red-800 dark:text-red-300">
                          ₹{houseGross.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} across {houseFolios.size || houseCount} folio{(houseFolios.size || houseCount) !== 1 ? 's' : ''} has no RM — it will go to the house, not a relationship manager.
                        </p>
                        <p className="text-[11px] text-red-700/90 dark:text-red-400/90 mt-1 max-w-3xl">
                          You can still finalize — the rest imports normally. To credit the right RM, go to <span className="font-black">Reports → Reconciliation</span> and upload that RM&apos;s folio file (one click maps every folio and recalculates). New investors who genuinely have no RM yet will keep showing here until they&apos;re mapped.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Compliance summary */}
                {totalFlagged > 0 && (
                  <div className={`border-b p-4 ${blockingDuplicates ? 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-800'}`}>
                    <div className="flex items-start gap-3">
                      <ShieldAlert className={`w-5 h-5 mt-0.5 ${blockingDuplicates ? 'text-red-600' : 'text-amber-600'}`} />
                      <div className="flex-1">
                        <p className={`text-sm font-bold ${blockingDuplicates ? 'text-red-800 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'}`}>
                          Compliance checks flagged {totalFlagged} row{totalFlagged !== 1 ? 's' : ''}
                        </p>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                          Review before finalizing. Duplicates will create double-payouts; SEBI cap warnings may indicate a TER overflow risk.
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-3">
                          <button
                            onClick={() => setPreviewFilter('ALL')}
                            className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border transition ${previewFilter === 'ALL' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-transparent' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:bg-slate-50'}`}
                          >
                            All • {previewData.length}
                          </button>
                          {(Object.keys(counts) as ImportFlag[]).filter(f => counts[f] > 0).map(f => {
                            const meta = FLAG_META[f];
                            const active = previewFilter === f;
                            return (
                              <button
                                key={f}
                                onClick={() => setPreviewFilter(active ? 'ALL' : f)}
                                className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border transition inline-flex items-center gap-1 ${active ? meta.tone + ' ring-2 ring-offset-1 ring-current/40' : meta.tone + ' opacity-80 hover:opacity-100'}`}
                              >
                                <meta.Icon className="w-3 h-3" />
                                {meta.label} • {counts[f]}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-800 p-3 text-[10px] text-blue-700 dark:text-blue-400 font-bold uppercase tracking-widest flex items-center">
                  <RefreshCw className="w-3 h-3 mr-2 animate-spin-slow" /> Standard names automatically applied from dictionary
                </div>

                {/* Transaction type rollup */}
                <div className="p-3 border-b border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-1.5 bg-white dark:bg-slate-800">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mr-1">By type:</span>
                  {orderedTypes.filter(t => typeCounts[t.key] > 0).map(t => (
                    <span key={t.key} className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${t.tone}`}>
                      {t.label} • {typeCounts[t.key]}
                    </span>
                  ))}
                </div>
                <div className="overflow-auto flex-1">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-white dark:bg-slate-800 sticky top-0 border-b border-slate-200 dark:border-slate-700">
                      <tr>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">Investor / AMC</th>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">Standard Scheme</th>
                        <th className="px-4 py-3 text-slate-600 dark:text-slate-400">Flags</th>
                        <th className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">Gross (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {filteredPreview.slice((previewPage - 1) * pageSize, previewPage * pageSize).map((row) => (
                        <tr key={row.id} className={`hover:bg-slate-50 dark:hover:bg-slate-700/50 ${row._flags?.includes('DUPLICATE') ? 'bg-red-50/40 dark:bg-red-900/10' : row._flags?.includes('SEBI_CAP_WARNING') ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-900 dark:text-slate-100 truncate max-w-[150px]">{row.investorName}</span>
                              <span className="text-[10px] text-blue-600 dark:text-blue-400 uppercase font-black tracking-tighter">{row.amcName}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400 truncate max-w-[180px] font-medium">{row.schemeName}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {row._flags?.map(f => {
                                const meta = FLAG_META[f];
                                return (
                                  <span key={f} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${meta.tone}`} title={meta.label}>
                                    <meta.Icon className="w-2.5 h-2.5" />
                                    {meta.label}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-black text-slate-900 dark:text-slate-100">₹{row.grossAmount.toLocaleString()}</td>
                        </tr>
                      ))}
                      {filteredPreview.length === 0 && (
                        <tr><td colSpan={4} className="py-12 text-center text-slate-400 dark:text-slate-500 text-xs">No rows match this filter.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  currentPage={previewPage}
                  totalItems={filteredPreview.length}
                  pageSize={pageSize}
                  onPageChange={setPreviewPage}
                />
              </div>
              );
            })()}

            {importStage === 'UPLOAD' && (
              <div className="h-full bg-slate-50 dark:bg-slate-800/50 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl flex flex-col items-center justify-center p-10 text-slate-400 dark:text-slate-500">
                <Database className="w-12 h-12 mb-4 opacity-30" />
                <p className="text-sm font-medium text-center">Upload spreadsheet to start automated processing.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'history' && (() => {
        const activeBatches = batches.filter(b => !b.deletedAt);
        const paginated = activeBatches.slice((historyPage - 1) * pageSize, historyPage * pageSize);
        return (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/30">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">After importing a Folio Master, use this to link any new investors' brokerage to their client.</p>
            <button
              onClick={runRemapAndRecalc}
              disabled={remapping}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap"
              title="Link unmapped transactions to clients by folio, then recalculate payouts"
            >
              {remapping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {remapping ? 'Re-mapping…' : 'Re-map Unmapped'}
            </button>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[10px]">
              <tr>
                <th className="px-6 py-4">Batch File</th>
                <th className="px-6 py-4">Import Date</th>
                <th className="px-6 py-4 text-center">Rows</th>
                <th className="px-6 py-4 text-right">Total Business</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {paginated.map(batch => (
                <tr key={batch.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                  <td className="px-6 py-4 font-bold text-slate-900 dark:text-slate-100">{batch.fileName}</td>
                  <td className="px-6 py-4 text-slate-500 dark:text-slate-400 font-medium">{new Date(batch.uploadDate).toLocaleDateString()}</td>
                  {/* What the batch HOLDS now, not what it declared at import time. */}
                  {(() => {
                    const aRows = batchCounts?.[batch.id];
                    const aGross = batchGross?.[batch.id];
                    const known = aRows !== undefined;
                    const rowsDiffer = known && aRows !== (batch.totalLines ?? 0);
                    const grossDiffer = aGross !== undefined && Math.abs(aGross - (batch.totalGross ?? 0)) > 0.5;
                    return (
                      <>
                        <td className="px-6 py-4 text-center font-bold">
                          <span className={known && aRows === 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}>
                            {known ? aRows.toLocaleString() : batch.totalLines}
                          </span>
                          {rowsDiffer && (
                            <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">
                              was {Number(batch.totalLines ?? 0).toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right font-black">
                          <span className={known && aRows === 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                            ₹ {(aGross !== undefined ? aGross : (batch.totalGross ?? 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          {grossDiffer && (
                            <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">
                              was ₹{Number(batch.totalGross ?? 0).toLocaleString()}
                            </span>
                          )}
                        </td>
                      </>
                    );
                  })()}
                  <td className="px-6 py-4 text-center">
                    {(() => {
                      const actual = batchCounts?.[batch.id];
                      if (batchCounts === null || actual === undefined) {
                        // counts not loaded yet → neutral "Live"
                        return <span className="inline-flex px-3 py-1 rounded-full text-[10px] font-black bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 uppercase tracking-widest">Live</span>;
                      }
                      // Prefer the verified (unique) count recorded at import; fall back to
                      // totalLines for older batches. A ~10% tolerance absorbs normal
                      // duplicate-row merging so only real shortfalls flag as Partial.
                      const expected = (batch as any).verifiedCount ?? batch.totalLines ?? 0;
                      if (actual === 0) {
                        return <span title={`0 rows persisted — this import did not save. Delete and re-import.`} className="inline-flex px-3 py-1 rounded-full text-[10px] font-black bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 uppercase tracking-widest">Failed · 0 rows</span>;
                      }
                      if (actual < expected * 0.9) {
                        return <span title={`Only ${actual.toLocaleString()} of ~${expected.toLocaleString()} rows persisted. Delete and re-import to fix.`} className="inline-flex px-3 py-1 rounded-full text-[10px] font-black bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 uppercase tracking-widest">Partial · {actual.toLocaleString()}</span>;
                      }
                      return <span title={`${actual.toLocaleString()} rows verified on server.`} className="inline-flex px-3 py-1 rounded-full text-[10px] font-black bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 uppercase tracking-widest">Live</span>;
                    })()}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => handleDeleteBatch(batch.id)}
                      disabled={isDeletingId === batch.id}
                      className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-50"
                      title="Move to Trash"
                    >
                      {isDeletingId === batch.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </td>
                </tr>
              ))}
              {activeBatches.length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState
                    icon={FileArchive}
                    title="No imports yet"
                    description="Upload your first CAMS or Karvy file to start tracking brokerage. Each import becomes a batch you can review here."
                    cta={{ label: 'New Upload', onClick: () => setActiveTab('import') }}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
          <Pagination
            currentPage={historyPage}
            totalItems={activeBatches.length}
            pageSize={pageSize}
            onPageChange={setHistoryPage}
          />
        </div>
        );
      })()}

      {activeTab === 'trash' && (() => {
        const deletedBatches = batches.filter(b => b.deletedAt);
        const paginated = deletedBatches.slice((historyPage - 1) * pageSize, historyPage * pageSize);
        return (
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
            <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800 p-3 text-[11px] text-amber-700 dark:text-amber-400 font-medium flex items-center">
              <AlertTriangle className="w-3.5 h-3.5 mr-2 flex-shrink-0" />
              Deleted batches are hidden from reports but kept for restoration. Permanently purge to free space.
            </div>
            {deletedBatches.length === 0 ? (
              <EmptyState
                icon={Trash2}
                title="Trash is empty"
                description="Deleted batches will appear here. You can restore them within 30 days before they're auto-purged."
              />
            ) : (
              <>
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700 uppercase tracking-widest text-[10px]">
                    <tr>
                      <th className="px-6 py-4">Batch File</th>
                      <th className="px-6 py-4">Deleted On</th>
                      <th className="px-6 py-4 text-center">Rows</th>
                      <th className="px-6 py-4 text-right">Total Business</th>
                      <th className="px-6 py-4 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {paginated.map(batch => (
                      <tr key={batch.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition opacity-70">
                        <td className="px-6 py-4 font-bold text-slate-700 dark:text-slate-300 line-through decoration-slate-400">{batch.fileName}</td>
                        <td className="px-6 py-4 text-slate-500 dark:text-slate-400 font-medium">{batch.deletedAt ? new Date(batch.deletedAt).toLocaleString() : '-'}</td>
                        <td className="px-6 py-4 text-center text-slate-600 dark:text-slate-400 font-bold">{batch.totalLines}</td>
                        <td className="px-6 py-4 text-right font-black text-slate-500 dark:text-slate-400">₹ {batch.totalGross.toLocaleString()}</td>
                        <td className="px-6 py-4 text-center space-x-2">
                          <button
                            onClick={() => handleRestoreBatch(batch.id)}
                            disabled={isRestoringId === batch.id}
                            className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-700 transition disabled:opacity-50"
                            title="Restore"
                          >
                            {isRestoringId === batch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Restore
                          </button>
                          <button
                            onClick={() => handlePurgeBatch(batch.id)}
                            disabled={isDeletingId === batch.id}
                            className="inline-flex items-center gap-1.5 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1.5 rounded-lg text-xs font-bold transition disabled:opacity-50"
                            title="Permanently delete"
                          >
                            {isDeletingId === batch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            Delete Forever
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination
                  currentPage={historyPage}
                  totalItems={deletedBatches.length}
                  pageSize={pageSize}
                  onPageChange={setHistoryPage}
                />
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
};
