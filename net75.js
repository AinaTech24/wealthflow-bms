// Set the 57 RMs listed in "Net brokerage.xlsx" to 75% (customLevels[3]=75).
// Model stays SLICES, so customLevels[3] is the RM's TOTAL % of gross → net = 75%.
// Dry-run by default; pass --apply to commit (writes a JSON backup first).
//   cd /home/u477139614/domains/nflx.in/nodejs && node net75.js [--apply]
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const names = JSON.parse(fs.readFileSync('./net75_names.json', 'utf8'));
const want = new Map(names.map(n => [norm(n), n]));

const [rows] = await pool.query("SELECT id,name,level,data FROM team");
const byNorm = new Map();
for (const r of rows) {
  const nn = norm(r.name);
  if (!byNorm.has(nn)) byNorm.set(nn, []);
  byNorm.get(nn).push(r);
}

const matched = [], unmatched = [], ambiguous = [];
for (const [nn, orig] of want) {
  const recs = byNorm.get(nn);
  if (!recs) { unmatched.push(orig); continue; }
  if (recs.length === 1) { matched.push({ rec: recs[0], orig }); continue; }
  // Duplicate-name RMs are the legit L3 (own-clients) + L4 (downline) pattern.
  // The RM payout rate lives on the L3 record, so target the unique L3 one.
  const l3 = recs.filter(r => r.level === 3);
  if (l3.length === 1) matched.push({ rec: l3[0], orig });
  else ambiguous.push(orig);
}

const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

console.log(`\n=== net75 ${APPLY ? '(APPLY)' : '(DRY-RUN)'} ===`);
console.log(`Sheet names: ${names.length} | matched: ${matched.length} | unmatched: ${unmatched.length} | ambiguous: ${ambiguous.length}`);

let nonL3 = 0;
for (const { rec } of matched) {
  const d = parse(rec.data);
  const cur = d.customLevels ? d.customLevels[3] : undefined;
  const flag = rec.level !== 3 ? '  ⚠ NOT L3' : '';
  if (rec.level !== 3) nonL3++;
  console.log(`  ${String(rec.name).padEnd(32)} L${rec.level} cur=${cur} -> 75${flag}`);
}
if (unmatched.length) { console.log('\n  UNMATCHED (no team record — will be skipped):'); unmatched.forEach(u => console.log('   - ' + u)); }
if (ambiguous.length) { console.log('\n  AMBIGUOUS (>1 record with same name — skipped, needs manual):'); ambiguous.forEach(a => console.log('   - ' + a)); }
if (nonL3) console.log(`\n  NOTE: ${nonL3} matched record(s) are not level 3 — review above.`);

if (APPLY) {
  const backup = matched.map(({ rec }) => ({ id: rec.id, name: rec.name, data: rec.data }));
  const bfile = `./net75_backup_${Date.now()}.json`;
  fs.writeFileSync(bfile, JSON.stringify(backup, null, 0));
  let n = 0;
  for (const { rec } of matched) {
    const d = parse(rec.data);
    d.customLevels = d.customLevels || {};
    d.customLevels[3] = 75;
    await pool.query("UPDATE team SET data=? WHERE id=?", [JSON.stringify(d), rec.id]);
    n++;
  }
  console.log(`\n✅ APPLIED 75% to ${n} RMs. Backup: ${bfile}`);
  console.log('   Next: run the recompute + restart so reports/ledger update.');
} else {
  console.log('\n(dry-run only — no changes written. Re-run with --apply to commit.)');
}
process.exit(0);
