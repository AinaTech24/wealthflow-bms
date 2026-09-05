// Apply the 5 explicit Bucket-C RM reassignments decided with the user.
// Sets primaryOwnerId + hierarchy.level1Id (preserving levels 2..7), matching
// the convention used by importInvestorMapping.js. Dry-run by default.
//
//   node src/scripts/applyBucketC.js           # dry-run
//   node src/scripts/applyBucketC.js --apply

import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const APPLY = process.argv.slice(2).includes('--apply');
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };
const emptyHier = () => ({ level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: '', level7Id: '' });

// clientId -> { rmId, label }
const PLAN = {
  'c_auto_IFJPD0858B': { rmId: 'tm_1781692005737', label: 'Shreya Aarthi Dhareshwar -> Aarthi Dhareshwar' },
  'c_auto_BNUPA5905J': { rmId: 'tm_1769507944595', label: 'Abhiranjini B A -> Finowise Mumbai and Bangalore' },
  'c_auto_CAUPM1251K': { rmId: 'tm_1769510412166', label: 'AMIT PARSHOTAM MENGHANI -> PANKAJ SURESHLAL DHAMEJA' },
  'c_auto_EGYPS4794F': { rmId: 'tm_1769511965662', label: 'Deepak R Soni -> Sandesh Vasanth Shet' },
  'c_auto_JTPPK7138Q': { rmId: 'tm_1769513163376', label: 'SUMIT KUMAR (JTPPK7138Q, folio 30940194/76) -> UMAKANT RAWANI' },
};

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const [team] = await pool.query('SELECT id, name, level FROM team');
  const tn = new Map(team.map(t => [t.id, `${t.name} (L${t.level})`]));

  const writes = [];
  for (const [cid, { rmId, label }] of Object.entries(PLAN)) {
    const [[c]] = await pool.query('SELECT id, primaryOwnerId, pan, name, data FROM clients WHERE id=?', [cid]);
    if (!c) { console.log(`SKIP ${cid} — not found (${label})`); continue; }
    if (!tn.has(rmId)) { console.log(`SKIP ${cid} — target RM ${rmId} not in team`); continue; }
    const d = parse(c.data);
    d.hierarchy = { ...emptyHier(), ...(d.hierarchy || {}) };
    const before = c.primaryOwnerId;
    d.hierarchy.level1Id = rmId;
    console.log(`${label}`);
    console.log(`    ${c.name} [${cid}]  ${tn.get(before) || before || 'UNOWNED'}  ->  ${tn.get(rmId)}`);
    writes.push([c.id, rmId, c.pan || '', c.name || '', JSON.stringify(d)]);
  }

  if (!APPLY) { console.log(`\nDry-run only. ${writes.length} clients would change. Re-run with --apply.`); process.exit(0); }

  for (const w of writes) {
    await pool.query(
      `INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE primaryOwnerId=VALUES(primaryOwnerId), data=VALUES(data)`, w);
  }
  console.log(`\n✅ Done. ${writes.length} clients reassigned.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
