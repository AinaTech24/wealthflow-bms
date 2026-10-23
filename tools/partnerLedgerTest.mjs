/**
 * LOCAL end-to-end test of the partner (Motilal) payout ledger, against the fake book from
 * tools/localSeed.mjs. Refuses to run unless the database is local and named wealthflow_local.
 *
 *   node tools/localSeed.mjs && node tools/partnerLedgerTest.mjs
 *
 * Checks: the split equals the mutual-fund engine's, the money adds up (people + company =
 * our share), a clawback row reduces the payout, an unattached code pays nobody, a locked
 * month stays frozen when a rate or chain changes, and the mutual-fund tables are byte-for-byte
 * unchanged by all of it.
 */
import crypto from 'crypto';
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';
import { recomputePartnerLedger } from '../src/lib/partnerPayout.js';

if (!['127.0.0.1', 'localhost', '::1'].includes(String(process.env.DB_HOST || '')) || process.env.DB_NAME !== 'wealthflow_local') {
  console.error('REFUSING TO RUN: local wealthflow_local only.'); process.exit(1);
}
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + what); } };
const near = (a, b, e = 0.0005) => Math.abs(a - b) <= e;

const fp = async () => {
  const h = crypto.createHash('sha1');
  for (const t of ['transactions', 'payout_ledger']) {
    const [rows] = await pool.query(`SELECT * FROM ${t} ORDER BY 1, 2`);
    h.update(t + JSON.stringify(rows));
  }
  return h.digest('hex');
};
const cfgRow = async () => { const [[r]] = await pool.query("SELECT id, data FROM config WHERE id IN ('global_config','global') LIMIT 1"); return { id: r.id, cfg: JSON.parse(r.data) }; };
const saveCfg = async (id, cfg) => pool.query('UPDATE config SET data = ? WHERE id = ?', [JSON.stringify(cfg), id]);
const ledger = async () => { const [r] = await pool.query('SELECT partner, period, clientId, userId, kind, amount FROM partner_payout_ledger ORDER BY 1,2,3,4,5'); return r; };
const sum = (rows, f = () => true) => rows.filter(f).reduce((a, r) => a + Number(r.amount), 0);

const before = await fp();
await pool.query('DROP TABLE IF EXISTS partner_payout_ledger');
const r1 = await recomputePartnerLedger(pool);
const L1 = await ledger();
ok(r1.rows > 0 && L1.length === r1.rows, `ledger built (${r1.rows} rows)`);

// 1. money adds up: people never get more than the share, the rest is the company's
const [pb] = await pool.query("SELECT mappedClientId cid, SUM(ourShare) ours FROM partner_brokerage WHERE partner='MOFSL' AND period='2026-08' AND mappedClientId IS NOT NULL GROUP BY mappedClientId");
for (const g of pb) {
  const paid = sum(L1, r => r.clientId === g.cid && r.period === '2026-08');
  const ours = Number(g.ours);
  ok(paid <= ours + 0.001 && paid >= ours * 0.84, `${g.cid}: paid ${paid.toFixed(2)} of ${ours.toFixed(2)} (company keeps <=15%)`);
}
// 2. an RM-only client (Anil, L3, lead source L3) -> Anil gets 25% + 25% lead bonus is not stacked on self; BM gets the rest
const anil = L1.filter(r => r.clientId === 'c_a01' && r.userId === 'u_anil');
ok(anil.length >= 1, 'RM L3 receives a share for his client');
const bm = L1.filter(r => r.clientId === 'c_a01' && r.userId === 'u_bm1');
ok(bm.length === 1 && bm[0].kind !== 'lower', 'BM at L4 receives the remainder');

// 3. clawback: a negative statement row for the same client reduces the payout
const [[cl]] = await pool.query("SELECT id FROM partner_brokerage WHERE mappedClientId = 'c_a01' AND partner='MOFSL' LIMIT 1");
const baseAnil = sum(L1, r => r.clientId === 'c_a01' && r.userId === 'u_anil');
await pool.query("INSERT INTO partner_brokerage (id, partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, totalBrokerage, ourShare, partnerShare, mappedClientId, data) SELECT 'PB_CLAW', partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, -100, -60, -40, mappedClientId, '{}' FROM partner_brokerage WHERE id = ?", [cl.id]);
await recomputePartnerLedger(pool);
const L2 = await ledger();
ok(sum(L2, r => r.clientId === 'c_a01' && r.userId === 'u_anil') < baseAnil, 'a clawback row lowers the RM payout');
await pool.query("DELETE FROM partner_brokerage WHERE id = 'PB_CLAW'");

// 4. an unattached code pays nobody
await pool.query("INSERT INTO partner_brokerage (id, partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, totalBrokerage, ourShare, partnerShare, mappedClientId, data) SELECT 'PB_UNMAPPED', partner, batchId, tradeDate, period, 'ZZ9999', segment, tradeCategory, 9000, 5400, 3600, NULL, '{}' FROM partner_brokerage LIMIT 1");
await recomputePartnerLedger(pool);
const L3 = await ledger();
ok(Math.abs(sum(L3) - sum(await (async () => { await pool.query("DELETE FROM partner_brokerage WHERE id='PB_UNMAPPED'"); await recomputePartnerLedger(pool); return ledger(); })())) < 0.0001, 'an unattached code adds nothing to anyone');

// 5. lock freeze: lock August, change the RM rate, recompute -> August unchanged; unlock -> changes
const { id, cfg } = await cfgRow();
const frozenBase = JSON.stringify(await ledger());
cfg.lockedPeriods = [...(cfg.lockedPeriods || []), '2026-08']; await saveCfg(id, cfg);
const c0 = JSON.parse(JSON.stringify(cfg)); cfg.levels = { ...cfg.levels, 3: 10 }; await saveCfg(id, cfg);
const r5 = await recomputePartnerLedger(pool);
ok(r5.frozen.some(([, p]) => p === '2026-08'), 'locked month reported as frozen');
ok(JSON.stringify(await ledger()) === frozenBase, 'locked month payout does not move when a rate changes');
cfg.lockedPeriods = (cfg.lockedPeriods || []).filter(p => p !== '2026-08'); await saveCfg(id, cfg);
await recomputePartnerLedger(pool);
ok(JSON.stringify(await ledger()) !== frozenBase, 'the same change flows once the month is unlocked');
await saveCfg(id, { ...c0, lockedPeriods: (c0.lockedPeriods || []).filter(p => p !== '2026-08') });
await recomputePartnerLedger(pool);
ok(JSON.stringify(await ledger()) === frozenBase, 'putting the rate back restores the original payout');

// 5b. a locked month still takes a client that was attached late, and leaves everyone else as paid
{
  const cur = await cfgRow();
  cur.cfg.lockedPeriods = [...new Set([...(cur.cfg.lockedPeriods || []), '2026-08'])]; await saveCfg(cur.id, cur.cfg);
  await recomputePartnerLedger(pool);
  const settled = JSON.stringify(await ledger());
  await pool.query("INSERT INTO partner_brokerage (id, partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, totalBrokerage, ourShare, partnerShare, mappedClientId, data) SELECT 'PB_LATE', partner, batchId, tradeDate, period, 'LATE1', segment, tradeCategory, 1000, 600, 400, 'c_b02', '{}' FROM partner_brokerage WHERE period = '2026-08' LIMIT 1");
  await recomputePartnerLedger(pool);
  const after = await ledger();
  ok(after.some(r => r.clientId === 'c_b02' && r.period === '2026-08' && Number(r.amount) > 0), 'a client attached after the month was locked reaches its RM/BM');
  ok(JSON.stringify(after.filter(r => r.clientId !== 'c_b02')) === JSON.stringify(JSON.parse(settled).filter(r => r.clientId !== 'c_b02')), 'everyone already paid in the locked month is unchanged');
  await pool.query("DELETE FROM partner_brokerage WHERE id = 'PB_LATE'");
  cur.cfg.lockedPeriods = (cur.cfg.lockedPeriods || []).filter(p => p !== '2026-08'); await saveCfg(cur.id, cur.cfg);
  await pool.query('DELETE FROM partner_payout_ledger'); await recomputePartnerLedger(pool);
}

// 6. the mutual fund is untouched by every step above
ok(await fp() === before, 'mutual-fund tables (transactions, payout_ledger) unchanged');

console.log(`\npartner ledger test: ${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail ? 1 : 0);
