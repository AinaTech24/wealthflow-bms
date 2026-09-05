// Corrective: restore each user's rate from the setupOverrides backup, then reduce
// customLevels to the level(s) the user is actually REFERENCED at in client
// hierarchies (not their possibly-corrupted team.level). RMs (ref level 1-3) keep
// their rate; managers (ref level 4+) reset to 0. Clears other levels so the
// owner's rate never blocks a manager's own override.
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';

const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };
const bfiles = fs.readdirSync('.').filter(f => f.startsWith('overrides_backup_team_')).sort();
const bfile = bfiles[bfiles.length - 1];
const backup = JSON.parse(fs.readFileSync(bfile, 'utf8')); // [{id,data}] pre-reduction
const origById = new Map(backup.map(t => [t.id, parse(t.data)]));

const [clients] = await pool.query("SELECT data FROM clients");
const refLevels = new Map(); // team id -> Set(hierarchy levels referenced at)
for (const c of clients) {
  const h = (parse(c.data).hierarchy) || {};
  for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) { if (!refLevels.has(u)) refLevels.set(u, new Set()); refLevels.get(u).add(l); } }
}

const [team] = await pool.query("SELECT id,name,data FROM team");
let n = 0; const sample = [];
for (const t of team) {
  const orig = origById.get(t.id) || parse(t.data);
  const origCL = orig.customLevels || {};
  const refs = refLevels.get(t.id);
  let newCL;
  if (refs && refs.size) {
    newCL = {};
    for (const L of refs) newCL[L] = (L >= 4 ? 0 : (origCL[L] !== undefined ? origCL[L] : 0));
  } else {
    newCL = origCL; // not referenced anywhere → leave as-is (no payout impact)
  }
  const cur = parse(t.data);
  cur.customLevels = newCL;
  await pool.query("UPDATE team SET data=? WHERE id=?", [JSON.stringify(cur), t.id]);
  n++;
  if (['aarthi dhareshwar', 'shachi mishra', 'atharwits eduworld llp'].includes(String(t.name).toLowerCase().replace(/\s+/g, ' ').trim()))
    sample.push(`${t.name}: refLevels=${refs ? [...refs].join(',') : 'none'} -> customLevels=${JSON.stringify(newCL)}`);
}
console.log(`fixed ${n} team records from backup ${bfile}`);
sample.forEach(s => console.log('  ' + s));
process.exit(0);
