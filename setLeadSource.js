// Enable the 25% lead-source add-on: net = sharing slice + 25% for the RM.
// Sets config.leadSourcePct=25 (model stays SLICES) and leadSourceLevel=3 (the RM
// is the lead source) on every client. Backs up config + clients first.
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';
const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

const [cr] = await pool.query("SELECT id,data FROM config LIMIT 1");
const cfg = parse(cr[0].data);
fs.writeFileSync(`leadsrc_backup_config_${Date.now()}.json`, JSON.stringify(cfg));
cfg.leadSharingModel = 'SLICES';
cfg.leadSourceMatrix = null;
cfg.leadSourcePct = 25;
await pool.query("UPDATE config SET data=? WHERE id=?", [JSON.stringify(cfg), cr[0].id]);
console.log('config: model=SLICES leadSourcePct=25 matrix=null');

const [cl] = await pool.query("SELECT id,data FROM clients");
fs.writeFileSync(`leadsrc_backup_clients_${Date.now()}.json`, JSON.stringify(cl));
let n = 0;
for (const c of cl) {
  const d = parse(c.data);
  if (d.leadSourceLevel !== 3) { d.leadSourceLevel = 3; await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), c.id]); n++; }
}
console.log(`set leadSourceLevel=3 (RM is lead source) on ${n} clients`);
process.exit(0);
