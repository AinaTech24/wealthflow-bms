/**
 * Add the partner's client sheet to the Partner Brokerage "Client codes" list.
 *
 *   node tools/addPartnerCodes.mjs dry   <sheet.json>
 *   node tools/addPartnerCodes.mjs apply <sheet.json>   (backs up partner_client_map first)
 *
 * sheet.json = [{ code, name }, ...]  (built from the partner's .xlsx; it holds real
 * client names, so keep it out of git).
 *
 * For every code that is not in partner_client_map yet, one row is added with the
 * sheet's NAME as its label and NO client. Nothing is attached to anyone and no
 * money or payout moves; the codes simply appear in the list (with their name) so the
 * client can be picked in the dropdown. Codes already in the map are left untouched.
 */
import fs from 'fs';
import os from 'os';
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';

const MODE = process.argv[2];
const sheet = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const PARTNER = 'MOFSL';
const code = (s) => String(s || '').replace(/^'/, '').trim().toUpperCase();

const [maps] = await pool.query('SELECT partner, clientCode, clientId, label, updatedAt FROM partner_client_map WHERE partner = ?', [PARTNER]);
const inMap = new Set(maps.map(m => code(m.clientCode)));
const [pb] = await pool.query('SELECT DISTINCT clientCode FROM partner_brokerage WHERE partner = ?', [PARTNER]);
const traded = new Set(pb.map(r => code(r.clientCode)));

const seen = new Set(), toAdd = [];
for (const s of sheet) {
  const k = code(s.code); if (!k || seen.has(k)) continue; seen.add(k);
  if (inMap.has(k)) continue;
  toAdd.push({ code: k, name: String(s.name || '').replace(/\s+/g, ' ').trim(), traded: traded.has(k) });
}
console.log(`sheet codes ${seen.size} | already in the list ${seen.size - toAdd.length} | to add ${toAdd.length} (of which traded in a statement: ${toAdd.filter(a => a.traded).length}, not traded yet: ${toAdd.filter(a => !a.traded).length})`);
toAdd.filter(a => a.traded).forEach(a => console.log(`  traded but not attached: ${a.code}  ${a.name}`));
if (MODE !== 'apply') { await pool.end(); process.exit(0); }

const dir = os.homedir() + '/backups'; fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/before-partner-codes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(file, JSON.stringify({ partner_client_map: maps }));
console.log('backup written:', file);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  for (const a of toAdd) await conn.query('INSERT IGNORE INTO partner_client_map (partner, clientCode, clientId, label) VALUES (?,?,NULL,?)', [PARTNER, a.code, a.name]);
  await conn.query('INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)',
    ['admin_root', 'Maintenance (requested by Pritesh)', 'partner_map', `MOFSL: ${toAdd.length} client code(s) from the partner client sheet added to the Client codes list (no client attached). Backup: ${file}`]);
  await conn.commit(); console.log('applied');
} catch (e) { await conn.rollback(); console.error('ROLLED BACK', e.message); process.exitCode = 1; }
finally { conn.release(); }
await pool.end();
