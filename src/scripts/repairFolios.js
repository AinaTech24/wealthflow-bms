// Repair corrupted scientific-notation folios in clients.data.folios.
//
// Some folios were stored as floats and stringified to scientific notation
// (e.g. "4.77448E+11") by an earlier import, losing digits. This restores the
// correct full folio by cross-referencing, per client, against:
//   1. the client's own NON-corrupted folios,
//   2. transactions belonging to the client (matched by PAN, else investorName),
//   3. the source workbook (investor_mapping.json) for that investor.
//
// A corrupted folio is only repaired when EXACTLY ONE candidate full folio
// matches it at the corrupted string's own precision. Ambiguous (multiple
// candidates) or unmatched cases are left untouched and reported.
//
// Usage:
//   node src/scripts/repairFolios.js            # dry-run (default)
//   node src/scripts/repairFolios.js --apply    # write fixes
//
// Always make a backup before --apply.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(__dirname, '../../investor_mapping.json');
const APPLY = process.argv.slice(2).includes('--apply');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isSci = s => /[eE]\+?\d/.test(String(s));
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

// Canonical scientific form of a corrupted string, e.g. "4.77448E+11" -> "4.77448e+11".
// Also returns the number of mantissa fraction digits so candidates can be
// rendered at the same precision for comparison.
function canonSci(s) {
  const m = String(s).trim().toLowerCase().match(/^(\d+)(?:\.(\d+))?e\+?(\d+)$/);
  if (!m) return null;
  const frac = m[2] || '';
  return { frac: frac.length, canon: `${m[1]}${frac ? '.' + frac : ''}e+${parseInt(m[3], 10)}` };
}

// Render a numeric folio candidate at `fracDigits` precision in canonical form.
function renderSci(folio, fracDigits) {
  const n = Number(folio);
  if (!Number.isFinite(n)) return null;
  return n.toExponential(fracDigits).toLowerCase().replace('e+', 'e+');
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const mapping = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  // investor(normalized) -> Set of full numeric folios from the workbook
  const xlsxFoliosByInvestor = new Map();
  for (const sheet of mapping.rms) for (const e of sheet.entries) {
    const f = String(e.folio || '').trim();
    if (!f || isSci(f)) continue;
    const k = norm(e.investor);
    if (!xlsxFoliosByInvestor.has(k)) xlsxFoliosByInvestor.set(k, new Set());
    xlsxFoliosByInvestor.get(k).add(f);
  }

  // Build correct-folio pools from transactions: by PAN and by investor name.
  const [txRows] = await pool.query('SELECT pan, investorName, data FROM transactions');
  const foliosByPan = new Map(), foliosByInvestor = new Map();
  for (const t of txRows) {
    const d = parse(t.data);
    const f = String(d.folio || '').trim();
    if (!f || isSci(f)) continue;
    if (t.pan) { const k = t.pan.trim().toUpperCase(); (foliosByPan.get(k) || foliosByPan.set(k, new Set()).get(k)).add(f); }
    const ik = norm(t.investorName);
    if (ik) (foliosByInvestor.get(ik) || foliosByInvestor.set(ik, new Set()).get(ik)).add(f);
  }
  console.log(`Indexed folios — tx-by-PAN: ${foliosByPan.size}, tx-by-name: ${foliosByInvestor.size}, xlsx-by-name: ${xlsxFoliosByInvestor.size}`);

  const [clientRows] = await pool.query('SELECT id, pan, name, data FROM clients');

  const stats = { clientsScanned: 0, corruptTotal: 0, repaired: 0, droppedDup: 0, ambiguous: 0, unmatched: 0 };
  const writes = [];
  const ambiguousList = [], unmatchedList = [];

  for (const c of clientRows) {
    const d = parse(c.data);
    const folios = Array.isArray(d.folios) ? d.folios : [];
    const corrupt = folios.filter(isSci);
    if (!corrupt.length) continue;
    stats.clientsScanned++;

    // Candidate pool for THIS client (correct numeric folios only).
    const pool_ = new Set();
    for (const f of folios) if (!isSci(f) && Number.isFinite(Number(f))) pool_.add(String(f));
    const pan = (c.pan || '').trim().toUpperCase();
    if (pan && foliosByPan.has(pan)) for (const f of foliosByPan.get(pan)) pool_.add(f);
    const nk = norm(c.name);
    if (foliosByInvestor.has(nk)) for (const f of foliosByInvestor.get(nk)) pool_.add(f);
    if (xlsxFoliosByInvestor.has(nk)) for (const f of xlsxFoliosByInvestor.get(nk)) pool_.add(f);

    let changed = false;
    const newFolios = folios.filter(f => !isSci(f));   // keep all good ones
    const goodSet = new Set(newFolios.map(String));

    for (const bad of corrupt) {
      stats.corruptTotal++;
      const cs = canonSci(bad);
      if (!cs) { stats.unmatched++; unmatchedList.push(`${c.name}: ${bad} (unparseable)`); continue; }
      // Candidates whose value renders to the same canonical sci string.
      const matches = new Set();
      for (const cand of pool_) {
        const r = renderSci(cand, cs.frac);
        if (r === cs.canon) matches.add(String(cand));
      }
      if (matches.size === 1) {
        const correct = [...matches][0];
        if (goodSet.has(correct)) { stats.droppedDup++; }   // correct already present → just drop corrupt
        else { newFolios.push(correct); goodSet.add(correct); stats.repaired++; }
        changed = true;
      } else if (matches.size > 1) {
        stats.ambiguous++; newFolios.push(bad);   // keep corrupt until disambiguated
        if (ambiguousList.length < 30) ambiguousList.push(`${c.name}: ${bad} -> {${[...matches].join(', ')}}`);
      } else {
        stats.unmatched++; newFolios.push(bad);
        if (unmatchedList.length < 30) unmatchedList.push(`${c.name}: ${bad}`);
      }
    }

    if (changed) {
      d.folios = newFolios;
      writes.push([c.id, c.pan || '', c.name || '', JSON.stringify(d)]);
    }
  }

  console.log('\n── Repair summary ─────────────────────────────────────');
  console.log(`Clients with corrupt folios:   ${stats.clientsScanned}`);
  console.log(`Corrupt folio strings:         ${stats.corruptTotal}`);
  console.log(`  Repaired (replaced w/ full): ${stats.repaired}`);
  console.log(`  Dropped (full already there):${stats.droppedDup}`);
  console.log(`  Ambiguous (left as-is):      ${stats.ambiguous}`);
  console.log(`  Unmatched (left as-is):      ${stats.unmatched}`);
  console.log(`Client rows to write:          ${writes.length}`);
  if (ambiguousList.length) { console.log('\nAmbiguous samples:'); ambiguousList.forEach(x => console.log('  ' + x)); }
  if (unmatchedList.length) { console.log('\nUnmatched samples:'); unmatchedList.forEach(x => console.log('  ' + x)); }

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to write.'); process.exit(0); }

  const CHUNK = 500; let written = 0;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);
    await pool.query(
      `INSERT INTO clients (id, pan, name, data) VALUES ?
       ON DUPLICATE KEY UPDATE data=VALUES(data)`, [chunk]);
    written += chunk.length; console.log(`  ...wrote ${written}/${writes.length}`);
  }
  console.log(`\n✅ Done. ${written} client rows updated.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
