/**
 * Attach partner client codes that have a sheet NAME but no client yet, by matching the
 * name to one of our clients.
 *
 *   node tools/attachPartnerCodes.mjs dry
 *   node tools/attachPartnerCodes.mjs apply     (backs up partner_client_map first, one transaction)
 *
 * EXACT: the normalised name (case, spaces, punctuation ignored) equals exactly one client
 *        -> attached (partner_client_map + any statement rows of that code).
 * LIKELY: every word of one name is inside the other, and only one client fits. Printed for
 *        review, NEVER attached by this tool.
 * A name that fits several clients, or none, is left alone.
 */
import fs from 'fs';
import os from 'os';
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';

const MODE = process.argv[2];
const PARTNER = 'MOFSL';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);

const [clients] = await pool.query('SELECT id, name FROM clients');
const byNorm = new Map();
for (const c of clients) { const k = norm(c.name); if (!k) continue; byNorm.set(k, [...(byNorm.get(k) || []), c]); }
const [open] = await pool.query("SELECT clientCode, label FROM partner_client_map WHERE partner = ? AND (clientId IS NULL OR clientId = '') AND label IS NOT NULL AND label <> ''", [PARTNER]);
const [maps] = await pool.query('SELECT * FROM partner_client_map WHERE partner = ?', [PARTNER]);
const [rowsOf] = await pool.query('SELECT clientCode, COUNT(*) n, ROUND(SUM(ourShare),2) ours FROM partner_brokerage WHERE partner = ? GROUP BY clientCode', [PARTNER]);
const rowInfo = new Map(rowsOf.map(r => [r.clientCode, r]));

const exact = [], several = [], likely = [], none = [];
for (const o of open) {
  const hits = byNorm.get(norm(o.label)) || [];
  if (hits.length === 1) { exact.push({ code: o.clientCode, name: o.label, id: hits[0].id, clientName: hits[0].name }); continue; }
  if (hits.length > 1) { several.push({ code: o.clientCode, name: o.label, ids: hits.map(h => h.id) }); continue; }
  const w = words(o.label);
  const cand = w.length >= 2 ? clients.filter(c => { const cw = words(c.name); return cw.length >= 2 && (w.every(x => cw.includes(x)) || cw.every(x => w.includes(x))); }) : [];
  if (cand.length === 1) likely.push({ code: o.clientCode, name: o.label, id: cand[0].id, clientName: cand[0].name });
  else none.push({ code: o.clientCode, name: o.label, candidates: cand.length });
}
console.log(`codes with a name and no client: ${open.length}`);
console.log(`  EXACT unique name match (will attach): ${exact.length}`);
exact.forEach(e => console.log(`     ${e.code}  ${e.name}  ->  ${e.clientName} (${e.id})${rowInfo.get(e.code) ? '  [has statement rows: ' + rowInfo.get(e.code).n + ', our share ' + rowInfo.get(e.code).ours + ']' : ''}`));
console.log(`  name fits SEVERAL clients (left alone): ${several.length}`, several.map(s => s.name).join(' | '));
console.log(`  LIKELY (all words fit one client, NOT attached, for you to confirm): ${likely.length}`);
likely.forEach(l => console.log(`     ${l.code}  sheet: ${l.name}  ~  client: ${l.clientName} (${l.id})`));
console.log(`  no client found: ${none.length}`);
if (MODE !== 'apply') { await pool.end(); process.exit(0); }

const dir = os.homedir() + '/backups'; fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/before-attach-partner-codes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(file, JSON.stringify({ partner_client_map: maps }));
console.log('backup written:', file);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  let touched = 0;
  for (const e of exact) {
    await conn.query('UPDATE partner_client_map SET clientId = ? WHERE partner = ? AND clientCode = ?', [e.id, PARTNER, e.code]);
    const [r] = await conn.query('UPDATE partner_brokerage SET mappedClientId = ? WHERE partner = ? AND clientCode = ?', [e.id, PARTNER, e.code]);
    touched += r.affectedRows || 0;
  }
  await conn.query('INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)',
    ['admin_root', 'Maintenance (requested by Pritesh)', 'partner_map', `MOFSL: ${exact.length} client code(s) attached by exact name from the partner client sheet, ${touched} statement row(s) re-attributed. Backup: ${file}`]);
  await conn.commit(); console.log(`applied: ${exact.length} attached, ${touched} statement rows`);
} catch (e) { await conn.rollback(); console.error('ROLLED BACK', e.message); process.exitCode = 1; }
finally { conn.release(); }
await pool.end();
