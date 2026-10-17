/**
 * Import Motilal Oswal "TurnBrok Summary" brokerage (one file per month) into
 * partner_brokerage, ONLY for client codes that are attached to a WealthFlow client
 * with at least one RM or BM (levels 1-4) in their chain. Everything else is skipped
 * and listed, never imported.
 *
 *   node tools/importTurnBrok.mjs dry   <turnbrok.json>
 *   node tools/importTurnBrok.mjs apply <turnbrok.json>
 *
 * turnbrok.json = { "2026-08": [{ code, name, trading, delivery, total }], "2026-09": [...] }
 *   trading  = trading buy + sell brokerage;  delivery = delivery buy + sell brokerage.
 *
 * These files carry TOTAL brokerage only (no "our share"). Our share is derived from the
 * partner's July statement: for a code that traded in July, its own ourShare/total ratio
 * that month; for any other code, DEFAULT_RATIO. The ratio used is written on every row
 * (data.ratioFrom) so it can be seen and corrected later.
 *
 * Re-running replaces that month's TurnBrok rows (same ids), so it is safe to repeat.
 */
import fs from 'fs';
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';

const MODE = process.argv[2];
const files = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const PARTNER = 'MOFSL', DEFAULT_RATIO = 0.45, RATIO_MONTH = '2026-07';
const code = (s) => String(s || '').replace(/^'/, '').trim().toUpperCase();
const r4 = (x) => Math.round(x * 10000) / 10000;
const lastDay = (p) => { const [y, m] = p.split('-').map(Number); return `${p}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

const [maps] = await pool.query('SELECT clientCode, clientId FROM partner_client_map WHERE partner = ?', [PARTNER]);
const clientOf = new Map(maps.filter(m => m.clientId).map(m => [code(m.clientCode), m.clientId]));
const [clients] = await pool.query('SELECT id, name, data FROM clients');
const chain = new Map();
for (const c of clients) { let d = {}; try { d = JSON.parse(c.data || '{}'); } catch {} chain.set(c.id, { name: c.name, h: d.hierarchy || {} }); }
const hasRmBm = (cid) => { const c = chain.get(cid); return !!c && [1, 2, 3, 4].some(l => c.h['level' + l + 'Id']); };

const [july] = await pool.query('SELECT clientCode, SUM(ourShare) ours, SUM(totalBrokerage) tot FROM partner_brokerage WHERE partner = ? AND period = ? GROUP BY clientCode', [PARTNER, RATIO_MONTH]);
const julyRatio = new Map(july.filter(r => Number(r.tot) > 0).map(r => [code(r.clientCode), Number(r.ours) / Number(r.tot)]));

const plan = [];
for (const [period, list] of Object.entries(files)) {
  const out = { period, rows: [], skipped: [], mismatch: [] };
  for (const f of list) {
    const k = code(f.code), total = Number(f.total) || 0;
    if (!total) { out.skipped.push({ k, name: f.name, total: 0, why: 'no brokerage' }); continue; }
    const cid = clientOf.get(k);
    if (!cid) { out.skipped.push({ k, name: f.name, total, why: 'not attached to a WealthFlow client' }); continue; }
    if (!hasRmBm(cid)) { out.skipped.push({ k, name: f.name, total, why: 'client has no RM/BM' }); continue; }
    if (Math.abs((Number(f.trading) || 0) + (Number(f.delivery) || 0) - total) > 0.01) out.mismatch.push(k);
    const ratio = julyRatio.has(k) ? julyRatio.get(k) : DEFAULT_RATIO;
    const from = julyRatio.has(k) ? `${RATIO_MONTH} statement` : `default ${DEFAULT_RATIO * 100}%`;
    const parts = [['TRD', Number(f.trading) || 0], ['DEL', Number(f.delivery) || 0]].filter(([, v]) => Math.abs(v) > 0);
    if (!parts.length) parts.push(['DEL', total]);
    for (const [cat, amt] of parts) out.rows.push({
      id: `${PARTNER}_${period}_TB_${k}_${cat}`, period, code: f.code ? String(f.code).replace(/^'/, '').trim() : k, cat, cid,
      total: r4(amt), ours: r4(amt * ratio), partner: r4(amt - amt * ratio), ratio, from, name: f.name,
    });
  }
  plan.push(out);
}
for (const p of plan) {
  const t = p.rows.reduce((a, r) => a + r.total, 0), o = p.rows.reduce((a, r) => a + r.ours, 0);
  console.log(`\n${p.period}: ${p.rows.length} rows from ${new Set(p.rows.map(r => r.code)).size} codes | total brokerage ${t.toFixed(2)} | our share ${o.toFixed(2)} (${t ? (o / t * 100).toFixed(1) : 0}%)`);
  console.log(`   ratio source: ${p.rows.filter(r => r.from.startsWith(RATIO_MONTH)).length} rows from July, ${p.rows.filter(r => r.from.startsWith('default')).length} rows at the ${DEFAULT_RATIO * 100}% default`);
  if (p.mismatch.length) console.log('   trading+delivery != total for:', p.mismatch.join(','));
  const sk = p.skipped.filter(s => s.total);
  console.log(`   NOT imported: ${sk.length} codes, brokerage ${sk.reduce((a, s) => a + s.total, 0).toFixed(2)}`);
  sk.forEach(s => console.log(`      ${s.k.padEnd(10)} ${String(s.name).padEnd(34)} ${s.total.toFixed(2).padStart(10)}  ${s.why}`));
}
if (MODE !== 'apply') { await pool.end(); process.exit(0); }

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  for (const p of plan) {
    const batchId = `PB_${PARTNER}_TB_${p.period}`;
    await conn.query('DELETE FROM partner_brokerage WHERE partner = ? AND batchId = ?', [PARTNER, batchId]);
    await conn.query('INSERT INTO batches (id, fileName, data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE fileName=VALUES(fileName), data=VALUES(data)',
      [batchId, `TurnBrok_Summary_RFINOWISEL_${p.period}.csv`, JSON.stringify({ partner: PARTNER, kind: 'partner_brokerage', rowCount: p.rows.length })]);
    for (const r of p.rows) {
      await conn.query(
        `INSERT INTO partner_brokerage (id, partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, totalBrokerage, ourShare, partnerShare, mappedClientId, data)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE batchId=VALUES(batchId), totalBrokerage=VALUES(totalBrokerage), ourShare=VALUES(ourShare), partnerShare=VALUES(partnerShare), mappedClientId=VALUES(mappedClientId), data=VALUES(data)`,
        [r.id, PARTNER, batchId, lastDay(p.period), p.period, r.code, 'EQ', r.cat, r.total, r.ours, r.partner, r.cid,
         JSON.stringify({ source: 'TurnBrok Summary', ratio: r4(r.ratio), ratioFrom: r.from, clientName: r.name })]);
    }
    await conn.query('INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)',
      ['admin_root', 'Maintenance (requested by Pritesh)', 'partner_import',
       `MOFSL ${p.period}: ${p.rows.length} row(s) from the TurnBrok Summary, only codes attached to a client with an RM/BM. Our share derived (July ratio, else ${DEFAULT_RATIO * 100}%). Undo: delete batch ${batchId}.`]);
  }
  await conn.commit(); console.log('\napplied');
} catch (e) { await conn.rollback(); console.error('ROLLED BACK', e.message); process.exitCode = 1; }
finally { conn.release(); }
await pool.end();
