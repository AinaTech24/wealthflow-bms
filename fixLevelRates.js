// Misplaced L1/L2 users referenced at level3Id: the UI saved their rate edit to
// customLevels[team.level] but the payout reads customLevels[3]. Copy their edit
// (customLevels[team.level]) into customLevels[3] so it takes effect. With the 25%
// lead source, net = that value + 25.  Dry-run by default; --apply commits (backup).
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';
const APPLY = process.argv.includes('--apply');
const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

const [tm] = await pool.query("SELECT id,name,level,data FROM team");
const [cl] = await pool.query("SELECT data FROM clients");
const refAt = new Map(); // team id -> Set(levels referenced at)
for (const c of cl) { const h = parse(c.data).hierarchy || {}; for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) { if (!refAt.has(u)) refAt.set(u, new Set()); refAt.get(u).add(l); } } }

const changes = [];
for (const t of tm) {
  const lvl = Number(t.level);
  if (lvl !== 1 && lvl !== 2) continue;              // only L1/L2 users
  const refs = refAt.get(t.id);
  if (!refs || !refs.has(3)) continue;               // ...that are placed at the L3 slot
  const d = parse(t.data);
  const cl3 = d.customLevels || {};
  const edit = cl3[lvl];                             // their rate edit at their own level
  if (edit === undefined) continue;                  // nothing to copy
  if (cl3[3] === edit) continue;                     // already aligned
  changes.push({ id: t.id, name: t.name, lvl, edit, old3: cl3[3], data: t.data });
}

console.log(`\n=== fixLevelRates ${APPLY ? '(APPLY)' : '(DRY-RUN)'} — ${changes.length} users ===`);
for (const c of changes) console.log(`  ${String(c.name).padEnd(28)} L${c.lvl} edit=${c.edit} : customLevels[3] ${c.old3} -> ${c.edit}  (net ~${c.edit + 25}%)`);

if (APPLY) {
  fs.writeFileSync(`fixLevelRates_backup_${Date.now()}.json`, JSON.stringify(changes.map(c => ({ id: c.id, data: c.data }))));
  for (const c of changes) {
    const d = parse(c.data); d.customLevels = d.customLevels || {}; d.customLevels[3] = c.edit;
    await pool.query("UPDATE team SET data=? WHERE id=?", [JSON.stringify(d), c.id]);
  }
  console.log(`\n✅ APPLIED to ${changes.length} users.`);
} else console.log('\n(dry-run — re-run with --apply to commit.)');
process.exit(0);
