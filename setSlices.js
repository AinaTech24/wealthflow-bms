// Force the payout engine back to per-RM SLICES (Cumulative ignores customLevels
// and flattens everyone). Backs up the current config first.
//   cd /home/u477139614/domains/nflx.in/nodejs && node setSlices.js
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';

const [rows] = await pool.query("SELECT id,data FROM config LIMIT 1");
if (!rows.length) { console.log('no config row found'); process.exit(1); }
const cfgRow = rows[0];
const cfg = JSON.parse(cfgRow.data || '{}');
fs.writeFileSync(`./config_backup_${Date.now()}.json`, JSON.stringify(cfg));

const before = cfg.leadSharingModel;
cfg.leadSharingModel = 'SLICES';
cfg.leadSourceMatrix = null;
cfg.leadSourcePct = 0;
await pool.query("UPDATE config SET data=? WHERE id=?", [JSON.stringify(cfg), cfgRow.id]);
console.log(`config id=${cfgRow.id} | leadSharingModel: ${before} -> SLICES (matrix=null, leadSourcePct=0)`);
process.exit(0);
