// Re-point misrouted RMs to their correct BM (Level 4). Backs up affected clients.
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';
const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const moves = [
  { owner: 'Lalita Ramesh Banhatti', bm: 'Nanda Umarani' },
  { owner: 'GOPINATH M V',           bm: 'Abhiranjini B A' },
];

const [tm] = await pool.query("SELECT id,name,level FROM team");
const [clients] = await pool.query("SELECT id,data FROM clients");
fs.writeFileSync(`fixBM_backup_${Date.now()}.json`, JSON.stringify(clients));

for (const m of moves) {
  const owners = tm.filter(t => norm(t.name) === norm(m.owner));
  const bm = tm.filter(t => norm(t.name) === norm(m.bm) && t.level === 4)[0];
  if (!owners.length || !bm) { console.log(`SKIP ${m.owner} -> ${m.bm} (owner=${owners.length} bm=${bm ? 'ok' : 'missing'})`); continue; }
  const ownerIds = new Set(owners.map(o => o.id));
  let n = 0;
  for (const c of clients) {
    const d = parse(c.data); const h = d.hierarchy || {};
    if (ownerIds.has(h.level3Id) || ownerIds.has(h.level2Id)) {
      if (h.level4Id !== bm.id) { h.level4Id = bm.id; d.hierarchy = h; await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), c.id]); n++; }
    }
  }
  for (const o of owners) await pool.query("UPDATE team SET parentId=? WHERE id=?", [bm.id, o.id]);
  console.log(`${m.owner} -> BM ${m.bm}: ${n} clients relinked (+parentId updated)`);
}
process.exit(0);
