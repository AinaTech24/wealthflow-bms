// Apply per-RM sharing rates from apply_rates.json (from RM_Sharing_Rates_To_Confirm).
// Sets customLevels[3] = rate for each matched L3 RM. SLICES model → that IS the
// RM's total % of gross. Dry-run by default; --apply commits (writes a backup).
//   cd /home/u477139614/domains/nflx.in/nodejs && node applyRates.js [--apply]
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const want = JSON.parse(fs.readFileSync('./apply_rates.json', 'utf8')); // [{name, rate}]

const [rows] = await pool.query("SELECT id,name,level,data FROM team");
const byNorm = new Map();
for (const r of rows) {
  const nn = norm(r.name);
  if (!byNorm.has(nn)) byNorm.set(nn, []);
  byNorm.get(nn).push(r);
}
const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

const matched = [], unmatched = [], ambiguous = [], unchanged = [];
const matchedIds = new Set();
for (const w of want) {
  const recs = byNorm.get(norm(w.name));
  let rec = null;
  if (!recs) { unmatched.push(w.name); continue; }
  if (recs.length === 1) rec = recs[0];
  else { const l3 = recs.filter(r => r.level === 3); if (l3.length === 1) rec = l3[0]; else { ambiguous.push(w.name); continue; } }
  const d = parse(rec.data);
  const cur = d.customLevels ? d.customLevels[3] : undefined;
  matchedIds.add(rec.id);
  if (Number(cur) === Number(w.rate)) unchanged.push({ name: rec.name, rate: w.rate });
  else matched.push({ rec, cur, rate: w.rate });
}

// L3 RMs that are NOT in the sheet (left untouched)
const notInSheet = rows.filter(r => r.level === 3 && !matchedIds.has(r.id) && !want.some(w => norm(w.name) === norm(r.name)));

console.log(`\n=== applyRates ${APPLY ? '(APPLY)' : '(DRY-RUN)'} ===`);
console.log(`Sheet rows: ${want.length} | will change: ${matched.length} | already correct: ${unchanged.length} | unmatched: ${unmatched.length} | ambiguous: ${ambiguous.length}`);
console.log(`L3 RMs NOT in sheet (kept as-is): ${notInSheet.length}`);
console.log('\n-- changes (current -> new) --');
for (const m of matched) console.log(`  ${String(m.rec.name).padEnd(34)} L${m.rec.level}  ${m.cur} -> ${m.rate}`);
if (unmatched.length) { console.log('\n-- UNMATCHED sheet names (NO team record — skipped) --'); unmatched.forEach(u => console.log('   - ' + JSON.stringify(u))); }
if (ambiguous.length) { console.log('\n-- AMBIGUOUS (dup name, no single L3 — skipped) --'); ambiguous.forEach(a => console.log('   - ' + a)); }

if (APPLY) {
  const backup = matched.map(m => ({ id: m.rec.id, name: m.rec.name, data: m.rec.data }));
  const bfile = `./applyRates_backup_${Date.now()}.json`;
  fs.writeFileSync(bfile, JSON.stringify(backup));
  let n = 0;
  for (const m of matched) {
    const d = parse(m.rec.data);
    d.customLevels = d.customLevels || {};
    d.customLevels[3] = Number(m.rate);
    await pool.query("UPDATE team SET data=? WHERE id=?", [JSON.stringify(d), m.rec.id]);
    n++;
  }
  console.log(`\n✅ APPLIED ${n} rate changes. Backup: ${bfile}`);
} else {
  console.log('\n(dry-run — no changes written. Re-run with --apply to commit.)');
}
process.exit(0);
