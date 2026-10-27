/**
 * Updating the BASIC details of RMs and BMs from an Excel sheet: ARN, EUIN, email, GSTIN, PAN, office address, bank.
 *
 * What this never touches: the sharing %, role, level, parent or password. Those decide what people are PAID and stay
 * with the Edit User screen. The only fields that can be written are the ones in FIELDS below, and the server checks
 * the same list again before it writes (it imports this file), so a hand-made request cannot widen it.
 *
 * Empty cells are ignored: a blank never erases what is on file.
 */

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// ── The fields that may change ─────────────────────────────────────────────────────────────────────────────────────
export const FIELDS = [
  { key: 'email',         label: 'Email',            group: 'Contact' },
  { key: 'pan',           label: 'PAN',              group: 'Registration' },
  { key: 'gstNumber',     label: 'GSTIN',            group: 'Registration' },
  { key: 'arnNumber',     label: 'ARN',              group: 'Registration' },
  { key: 'arnValidTill',  label: 'ARN valid till',   group: 'Registration' },
  { key: 'euinNumber',    label: 'EUIN',             group: 'Registration' },
  { key: 'euinValidTill', label: 'EUIN valid till',  group: 'Registration' },
  { key: 'street',        label: 'Office address',   group: 'Address' },
  { key: 'city',          label: 'City',             group: 'Address' },
  { key: 'state',         label: 'State',            group: 'Address' },
  { key: 'pincode',       label: 'Pincode',          group: 'Address' },
  { key: 'country',       label: 'Country',          group: 'Address' },
  { key: 'accountName',   label: 'Account holder',   group: 'Bank' },
  { key: 'accountNumber', label: 'Account number',   group: 'Bank' },
  { key: 'ifscCode',      label: 'IFSC',             group: 'Bank' },
  { key: 'bankName',      label: 'Bank name',        group: 'Bank' },
  { key: 'branch',        label: 'Branch',           group: 'Bank' },
];
export const FIELD_KEYS = FIELDS.map(f => f.key);
export const labelOf = (key) => (FIELDS.find(f => f.key === key) || {}).label || key;

// ── Normalising what a cell says ───────────────────────────────────────────────────────────────────────────────────
const ISO = (y, m, d) => {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  return t.getUTCMonth() === mm - 1 ? `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` : null;
};
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "24-11-2028", "24/11/2028", "2028-11-24", "24 Nov 2028", "11/24/28" (a sheet reader's US form), or an Excel serial -> "2028-11-24". */
export function parseDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ISO(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]+(\d{2,4})$/);
  if (m && MON[m[2].toLowerCase()]) return ISO(m[3].length === 2 ? '20' + m[3] : m[3], MON[m[2].toLowerCase()], m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    // Indian order (day first) unless that is impossible and month-first works (a reader's "11/24/28")
    if (a <= 31 && b <= 12) return ISO(year, b, a);
    if (b <= 31 && a <= 12) return ISO(year, a, b);
    return null;
  }
  if (/^\d{5}$/.test(s)) { const t = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return ISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  return null;
}

/** Each returns { value } (cleaned) or { error }. An empty cell is { value: '' }, which callers skip. */
export const NORMALIZE = {
  email: (v) => { const s = clean(v).toLowerCase(); if (!s) return { value: '' }; return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? { value: s } : { error: 'not an email address' }; },
  pan: (v) => { const s = clean(v).toUpperCase().replace(/\s/g, ''); if (!s) return { value: '' }; return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? { value: s } : { error: 'PAN should look like ABCDE1234F' }; },
  gstNumber: (v) => { const s = clean(v).toUpperCase().replace(/\s/g, ''); if (!s) return { value: '' }; return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s) ? { value: s } : { error: 'GSTIN should be 15 characters, like 22AAAAA0000A1Z5' }; },
  arnNumber: (v) => { const s = clean(v).toUpperCase(); if (!s) return { value: '' }; const d = s.replace(/^ARN[-\s]*/, '').replace(/\s/g, ''); return /^\d{3,8}$/.test(d) ? { value: 'ARN-' + d } : { error: 'ARN should look like ARN-123456' }; },
  euinNumber: (v) => { const s = clean(v).toUpperCase().replace(/\s/g, ''); if (!s) return { value: '' }; return /^E\d{4,8}$/.test(s) ? { value: s } : { error: 'EUIN should look like E123456' }; },
  arnValidTill: (v) => { if (!clean(v)) return { value: '' }; const d = parseDate(v); return d ? { value: d } : { error: 'not a date' }; },
  euinValidTill: (v) => { if (!clean(v)) return { value: '' }; const d = parseDate(v); return d ? { value: d } : { error: 'not a date' }; },
  street: (v) => ({ value: clean(v).slice(0, 200) }),
  city: (v) => ({ value: clean(v).slice(0, 80) }),
  state: (v) => ({ value: clean(v).slice(0, 80) }),
  country: (v) => ({ value: clean(v).slice(0, 80) }),
  pincode: (v) => { const s = clean(v).replace(/\.0+$/, '').replace(/\s/g, ''); if (!s) return { value: '' }; return /^\d{6}$/.test(s) ? { value: s } : { error: 'pincode should be 6 digits' }; },
  accountName: (v) => ({ value: clean(v).slice(0, 120) }),
  accountNumber: (v) => { const s = clean(v).replace(/[\s-]/g, '').replace(/\.0+$/, ''); if (!s) return { value: '' }; return /^\d{6,20}$/.test(s) ? { value: s } : { error: 'account number should be 6 to 20 digits (is the cell in scientific notation?)' }; },
  ifscCode: (v) => { const s = clean(v).toUpperCase().replace(/\s/g, ''); if (!s) return { value: '' }; return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s) ? { value: s } : { error: 'IFSC should look like HDFC0001234' }; },
  bankName: (v) => ({ value: clean(v).slice(0, 120) }),
  branch: (v) => ({ value: clean(v).slice(0, 120) }),
};

/** Splits a request's raw values into the cleaned ones and the errors; a key outside FIELDS is an error, never ignored silently. */
export function normalizeChanges(raw) {
  const changes = {}, errors = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (!FIELD_KEYS.includes(k)) { errors.push(`${k}: not a field that can be imported`); continue; }
    const r = NORMALIZE[k](v);
    if (r.error) errors.push(`${labelOf(k)}: ${r.error}`);
    else if (r.value !== '') changes[k] = r.value;
  }
  return { changes, errors };
}

// ── Reading the sheet ──────────────────────────────────────────────────────────────────────────────────────────────
const NAME_H = /^(rm|bm|member|distributor|associate|partner)?\s*(\/\s*(rm|bm))?\s*(full\s*)?name$|^(rm|bm)\s*name$|^name of (the )?(rm|bm|member|distributor)|^(rm|bm|member|distributor|associate)$/i;
const DETECT = [
  ['accountName', /(account|a\/c|acc\.?)\s*(holder|name)|beneficiary|name as per bank/i],
  ['accountNumber', /(account|a\/c|acc\.?)\s*(no|number|num)\b|^account$|^a\/c$/i],
  ['ifscCode', /ifsc/i],
  ['bankName', /^bank(\s*name)?$/i],
  ['branch', /branch/i],
  ['arnValidTill', /arn.*(valid|expir|till|date)|(valid|expir).*arn/i],
  ['euinValidTill', /euin.*(valid|expir|till|date)|(valid|expir).*euin/i],
  ['arnNumber', /^arn\b|\barn\s*(no|number|code)?$/i],
  ['euinNumber', /euin/i],
  ['gstNumber', /gst/i],
  ['email', /e-?mail/i],
  ['pan', /\bpan\b/i],
  ['pincode', /pin\s*code|^pin$|zip/i],
  ['city', /^city|\bcity$/i],
  ['state', /^state|\bstate$/i],
  ['country', /^country/i],
  ['street', /address|street|office/i],
];

/** The header is the first of the top 15 rows that has a name column and at least one other recognised column. */
export function findHeaderRow(grid) {
  const top = (grid || []).slice(0, 15);
  for (let i = 0; i < top.length; i++) {
    const cells = (top[i] || []).map(clean);
    const hasName = cells.some(c => NAME_H.test(c));
    const others = DETECT.filter(([, re]) => cells.some(c => re.test(c))).length;
    if (hasName && others >= 1) return i;
  }
  for (let i = 0; i < top.length; i++) if ((top[i] || []).some(c => NAME_H.test(clean(c)))) return i;
  return 0;
}

/** Guess which column is which. Returns { headerRow, columns: { name, <field key>: columnIndex }, headers }. A column is used once. */
export function detectColumns(grid, forcedHeaderRow) {
  const headerRow = Number.isInteger(forcedHeaderRow) ? forcedHeaderRow : findHeaderRow(grid);
  const headers = (grid[headerRow] || []).map(clean);
  const used = new Set(); const columns = {};
  const take = (key, re) => { const i = headers.findIndex((h, c) => !used.has(c) && h && re.test(h)); if (i >= 0) { columns[key] = i; used.add(i); } };
  for (const [key, re] of DETECT) take(key, re);
  take('name', NAME_H);
  if (columns.name === undefined) { const i = headers.findIndex((h, c) => !used.has(c) && /name/i.test(h)); if (i >= 0) columns.name = i; }
  return { headerRow, columns, headers };
}

/** One entry per data row: the person it names (name / pan) and the cleaned values it carries, with any cell that did not pass. */
export function readRows(grid, headerRow, columns) {
  const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const line = grid[r] || [];
    if (!line.some(c => clean(c))) continue;
    const name = columns.name !== undefined ? clean(line[columns.name]) : '';
    const rawPan = columns.pan !== undefined ? clean(line[columns.pan]) : '';
    const values = {}, problems = [];
    for (const key of FIELD_KEYS) {
      if (columns[key] === undefined) continue;
      const res = NORMALIZE[key](line[columns[key]]);
      if (res.error) problems.push({ key, label: labelOf(key), text: res.error, cell: clean(line[columns[key]]) });
      else if (res.value !== '') values[key] = res.value;
    }
    if (!name && !values.pan && !rawPan) continue;
    out.push({ rowNo: r + 1, name, pan: values.pan || '', values, problems });
  }
  return out;
}

// ── Finding the person ─────────────────────────────────────────────────────────────────────────────────────────────
export const nameKey = (s) => String(s || '').toUpperCase()
  .replace(/\b(MR|MRS|MS|MISS|DR|SHRI|SMT|M\/S|LLP|PVT|PRIVATE|LIMITED|LTD)\b\.?/g, ' ')
  .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');

/**
 * team: [{ id, name, level, role, pan, ... }]. Admin and Finance logins are not RMs or BMs and are never matched.
 * Returns one result per row: { row, status: 'matched' | 'not_found' | 'ambiguous' | 'duplicate', by, person, candidates }.
 */
export function matchRows(rows, team) {
  const people = (team || []).filter(t => String(t.role || '').toUpperCase() !== 'ADMIN' && String(t.role || '').toUpperCase() !== 'FINANCE');
  const byPan = new Map(), byName = new Map();
  for (const p of people) {
    const pan = String(p.pan || '').toUpperCase().trim();
    if (pan) { if (!byPan.has(pan)) byPan.set(pan, []); byPan.get(pan).push(p); }
    const k = nameKey(p.name); if (k) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
  }
  const seen = new Set(); const results = [];
  for (const row of rows) {
    let status = 'not_found', by = '', person = null, candidates = [];
    const nk = nameKey(row.name);
    const panHits = row.pan ? (byPan.get(row.pan) || []) : [];
    const nameHits = nk ? (byName.get(nk) || []) : [];
    if (panHits.length === 1) { status = 'matched'; by = 'PAN'; person = panHits[0]; }
    else if (panHits.length > 1) {
      const both = panHits.filter(p => nameHits.some(n => n.id === p.id));
      if (both.length === 1) { status = 'matched'; by = 'PAN + name'; person = both[0]; } else { status = 'ambiguous'; candidates = panHits; }
    } else if (nameHits.length === 1) { status = 'matched'; by = 'name'; person = nameHits[0]; }
    else if (nameHits.length > 1) { status = 'ambiguous'; candidates = nameHits; }
    if (status === 'matched') { if (seen.has(person.id)) status = 'duplicate'; else seen.add(person.id); }
    results.push({ row, status, by, person, candidates });
  }
  return results;
}

// ── What would change ──────────────────────────────────────────────────────────────────────────────────────────────
/** The value a team member currently has for a field, as a string. */
export function currentValue(person, key) {
  const a = person.address || {}, b = person.bankDetails || {};
  switch (key) {
    case 'email': return person.email || '';
    case 'street': case 'city': case 'state': case 'pincode': case 'country': return a[key] || '';
    case 'accountName': case 'accountNumber': case 'ifscCode': case 'bankName': case 'branch': return b[key] || '';
    default: return person[key] || '';
  }
}
const same = (key, a, b) => key === 'accountNumber' ? String(a).replace(/\D/g, '') === String(b).replace(/\D/g, '') : clean(a).toLowerCase() === clean(b).toLowerCase();

/** [{ key, label, from, to }] for every field the sheet gives that differs from what is on file. */
export function diffFor(person, values) {
  const out = [];
  for (const key of FIELD_KEYS) {
    if (values[key] === undefined) continue;
    const from = currentValue(person, key);
    if (!same(key, from, values[key])) out.push({ key, label: labelOf(key), from, to: values[key] });
  }
  return out;
}

/** A new `data` JSON and email for a team row with the (already normalized) changes applied. Nothing outside FIELDS is touched. */
export function applyChanges(data, email, changes) {
  const d = { ...(data || {}) };
  let e = email;
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'email') { e = v; continue; }
    if (['street', 'city', 'state', 'pincode', 'country'].includes(k)) { d.address = { street: '', city: '', state: '', pincode: '', country: 'India', ...(d.address || {}), [k]: v }; continue; }
    if (['accountName', 'accountNumber', 'ifscCode', 'bankName', 'branch'].includes(k)) { d.bankDetails = { accountName: '', accountNumber: '', bankName: '', ifscCode: '', ...(d.bankDetails || {}), [k]: v }; continue; }
    d[k] = v;
  }
  return { data: d, email: e };
}

/** "xxxx1234" for log lines, so an account number is never written out in full. */
export const maskAccount = (v) => { const s = String(v || '').replace(/\D/g, ''); return s ? 'xxxx' + s.slice(-4) : ''; };
