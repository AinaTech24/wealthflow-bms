/**
 * Apply Motilal Oswal's client sheet (client code -> client name, branch, products).
 *
 *   node tools/motilalSheet.mjs dry   <sheet.json>     reads only, prints the plan
 *   node tools/motilalSheet.mjs apply <sheet.json>     backs up, then writes in ONE transaction
 *
 * sheet.json = [{ code, name, branch, products:[...] }, ...]  (built from the .xlsx)
 *
 * What it does, in this order, and nothing else:
 *   1. Stores every row in partner_client_info (who each code is). No money moves.
 *   2. A code that already has a client in partner_client_map keeps it; only an empty
 *      label is filled with the sheet's name.
 *   3. A code with no client whose NAME matches exactly one client (case, spaces and
 *      punctuation ignored) is mapped to it and its statement rows are re-attributed.
 *      A name that matches several clients is left alone and reported.
 *   4. A code that HAS statement rows but still no client gets a new client record
 *      (the person trades with Motilal but is not a mutual-fund client), placed in the
 *      chain most of that branch's clients already have. Inactive codes (no rows) do
 *      NOT get a client record; they are known by name only until they trade.
 */
import fs from 'fs';
import os from 'os';
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';

const MODE = process.argv[2];
const sheet = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const PARTNER = 'MOFSL';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const code = (s) => String(s || '').replace(/^'/, '').trim().toUpperCase();
const slotIds = (h) => [1, 2, 3, 4, 5, 6, 7].map(l => h['level' + l + 'Id'] || '');

const [clientRows] = await pool.query('SELECT id, name, data FROM clients');
const byName = new Map();
for (const c of clientRows) { const k = norm(c.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(c); }
const [maps] = await pool.query('SELECT clientCode, clientId, label FROM partner_client_map WHERE partner = ?', [PARTNER]);
const mapOf = new Map(maps.map(m => [code(m.clientCode), m]));
const [pbCodes] = await pool.query('SELECT clientCode, MAX(mappedClientId) mid, ROUND(SUM(ourShare),2) ours FROM partner_brokerage WHERE partner = ? GROUP BY clientCode', [PARTNER]);
const traded = new Map(pbCodes.map(p => [code(p.clientCode), p]));

// The chain most of a branch's already-matched clients have.
const chainsByBranch = new Map();
for (const s of sheet) {
  const m = mapOf.get(code(s.code)); const hit = (m && m.clientId && clientRows.find(c => c.id === m.clientId)) || (byName.get(norm(s.name)) || [])[0];
  if (!hit) continue;
  let d = {}; try { d = JSON.parse(hit.data || '{}'); } catch {}
  if (!d.hierarchy || !slotIds(d.hierarchy).some(Boolean)) continue;
  const key = String(s.branch || '').trim().toUpperCase(), sig = JSON.stringify(slotIds(d.hierarchy));
  const e = chainsByBranch.get(key) || new Map(); e.set(sig, (e.get(sig) || 0) + 1); chainsByBranch.set(key, e);
}
const topChain = (branch) => { const e = chainsByBranch.get(String(branch || '').trim().toUpperCase()); if (!e) return null; return JSON.parse([...e.entries()].sort((a, b) => b[1] - a[1])[0][0]); };

const plan = { info: sheet.length, keep: 0, labelFill: [], mapByName: [], ambiguous: [], newClients: [], unmatchedInactive: 0, activeNoChain: [] };
for (const s of sheet) {
  const k = code(s.code), m = mapOf.get(k), t = traded.get(k);
  if (m && m.clientId) { plan.keep++; if (!m.label) plan.labelFill.push({ code: k, name: s.name }); continue; }
  const hits = byName.get(norm(s.name)) || [];
  if (hits.length === 1) { plan.mapByName.push({ code: k, name: s.name, clientId: hits[0].id }); continue; }
  if (hits.length > 1) { plan.ambiguous.push({ code: k, name: s.name, ids: hits.map(h => h.id) }); continue; }
  if (t) {
    const chain = topChain(s.branch);
    if (!chain) { plan.activeNoChain.push({ code: k, name: s.name, branch: s.branch }); continue; }
    plan.newClients.push({ code: k, name: s.name, branch: s.branch, chain, ours: Number(t.ours) || 0 });
  } else plan.unmatchedInactive++;
}
const [tm] = await pool.query('SELECT id, name, level FROM team'); const nm = new Map(tm.map(t => [t.id, String(t.name).trim() + ' L' + t.level]));
console.log(`sheet rows ${plan.info}`);
console.log(`  already mapped to a client (kept): ${plan.keep}  (empty label filled: ${plan.labelFill.length})`);
console.log(`  mapped now by exact name: ${plan.mapByName.length}`);
console.log(`  name matches several clients (left alone): ${plan.ambiguous.length}`, plan.ambiguous.map(a => a.name).join(' | '));
console.log(`  traded but no client -> new client record: ${plan.newClients.length}`);
for (const n of plan.newClients) console.log(`     ${n.code} ${n.name} (${n.branch}) our share ${n.ours} -> chain ${slotIds.length && n.chain.map((id, i) => id ? 'L' + (i + 1) + ':' + nm.get(id) : '').filter(Boolean).join(' > ')}`);
console.log(`  traded, no client and no branch chain to copy: ${plan.activeNoChain.length}`, plan.activeNoChain.map(a => a.name + '/' + a.branch).join(' | '));
console.log(`  inactive and unknown to the book (name only): ${plan.unmatchedInactive}`);
if (MODE !== 'apply') { await pool.end(); process.exit(0); }

const dir = os.homedir() + '/backups'; fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/before-motilal-sheet-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const [oldInfo] = await pool.query('SELECT * FROM partner_client_info WHERE partner = ?', [PARTNER]);
fs.writeFileSync(file, JSON.stringify({ map: maps, info: oldInfo, plan }));
console.log('backup written:', file);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  for (const s of sheet) {
    await conn.query(
      `INSERT INTO partner_client_info (partner, clientCode, clientName, branch, products, source) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE clientName=VALUES(clientName), branch=VALUES(branch), products=VALUES(products), source=VALUES(source)`,
      [PARTNER, code(s.code), s.name, String(s.branch || '').trim(), (s.products || []).join(', '), 'Motilal client sheet 07-10-2026']);
  }
  for (const l of plan.labelFill) await conn.query('UPDATE partner_client_map SET label=? WHERE partner=? AND clientCode=? AND (label IS NULL OR label="")', [l.name, PARTNER, l.code]);
  const attach = async (k, clientId, label) => {
    await conn.query(`INSERT INTO partner_client_map (partner, clientCode, clientId, label) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE clientId=VALUES(clientId), label=VALUES(label)`, [PARTNER, k, clientId, label]);
    await conn.query('UPDATE partner_brokerage SET mappedClientId=? WHERE partner=? AND clientCode=?', [clientId, PARTNER, k]);
  };
  for (const m of plan.mapByName) await attach(m.code, m.clientId, m.name);
  for (const n of plan.newClients) {
    const id = 'c_mo_' + n.code.toLowerCase();
    const hierarchy = Object.fromEntries(n.chain.map((u, i) => ['level' + (i + 1) + 'Id', u]));
    const owner = n.chain.find(Boolean) || null;
    const data = { id, name: n.name, folios: [], hierarchy, source: 'MOTILAL_SHEET', note: 'Created from the Motilal client sheet 07-10-2026 (trades with Motilal, not a mutual-fund client yet).', updatedAt: new Date().toISOString() };
    await conn.query('INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [id, owner, null, n.name, JSON.stringify(data)]);
    await attach(n.code, id, n.name);
  }
  await conn.query('INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)',
    ['admin_root', 'Maintenance (requested by Pritesh)', 'partner_info_import',
     `MOFSL client sheet: ${sheet.length} codes stored, ${plan.mapByName.length} mapped by name, ${plan.newClients.length} new client record(s). Backup: ${file}`]);
  await conn.commit(); console.log('applied');
} catch (e) { await conn.rollback(); console.error('ROLLED BACK', e.message); process.exitCode = 1; }
finally { conn.release(); }
await pool.end();
