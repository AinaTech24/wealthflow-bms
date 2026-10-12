/**
 * Read-only check: does the shared payout engine pay exactly what the old code paid,
 * on the REAL book, for every client and every month?
 *
 * It reads clients, team, config and the brokerage totals per (client, month),
 * splits each with the old logic (a verbatim copy, below) and with
 * src/lib/payoutEngine.js, and compares every person's share. It writes nothing.
 *
 *   node tools/engineCompare.mjs            # run from the app folder, uses .env
 *
 * Shares are proportional to gross, so splitting each (client, month) TOTAL tests the
 * same structure as splitting every transaction, without 585,000 iterations.
 */
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';
import { memberAsOf, residualSplit } from '../src/lib/payoutEngine.js';

// ── the old code, verbatim ────────────────────────────────────────────────────────
function oldShares(gross, h, lsl, period, ctx) {
  const { teamMap, residualLevel, globalLevels, leadPct, companyExpensePct } = ctx;
  const earn = {};
  const add = (u, v) => { earn[u] = (earn[u] || 0) + v; };
  let ownerCustomLevels;
  for (let l = 1; l <= 7; l++) { const uid = h[`level${l}Id`]; if (uid) { ownerCustomLevels = memberAsOf(teamMap.get(uid), period)?.customLevels; break; } }
  const paidSet = new Set(); let lowerSum = 0; const rl = residualLevel || 4;
  for (let l = 1; l < rl; l++) {
    const uid = h[`level${l}Id`]; if (!uid || paidSet.has(uid)) continue; paidSet.add(uid);
    const info = memberAsOf(teamMap.get(uid), period); const cl = info?.customLevels; const uLvl = info?.level;
    const slicePct = (cl && cl[uLvl] !== undefined ? cl[uLvl] : cl && cl[l] !== undefined ? cl[l]
      : ownerCustomLevels?.[l] !== undefined ? ownerCustomLevels[l] : (globalLevels[l] || 0));
    if (slicePct > 0) { add(uid, Math.round(gross * slicePct / 100 * 10000) / 10000); lowerSum += slicePct; }
  }
  if (leadPct > 0 && lsl && lsl < rl) {
    const su = h[`level${lsl}Id`];
    if (su) { add(su, Math.round(gross * leadPct / 100 * 10000) / 10000); lowerSum += leadPct; }
  }
  let residualUid = null;
  for (let l = rl; l <= 7; l++) { if (h[`level${l}Id`]) { residualUid = h[`level${l}Id`]; break; } }
  if (residualUid && !paidSet.has(residualUid)) {
    const surplus = Math.max(0, 100 - (companyExpensePct || 0) - lowerSum);
    if (surplus > 0) add(residualUid, Math.round(gross * surplus / 100 * 10000) / 10000);
  }
  return earn;
}

const [clientRows] = await pool.query('SELECT id, data FROM clients');
const hier = new Map(), lead = new Map();
for (const c of clientRows) {
  let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
  if (d.hierarchy) hier.set(c.id, d.hierarchy);
  if (d.leadSourceLevel) lead.set(c.id, Number(d.leadSourceLevel));
}
const [teamRows] = await pool.query('SELECT id, level, data FROM team');
const teamMap = new Map();
for (const t of teamRows) {
  let d = {}; try { d = JSON.parse(t.data || '{}'); } catch {}
  teamMap.set(t.id, { level: Number(t.level), customLevels: d.customLevels, rateHistory: d.rateHistory });
}
const [[cfgRow]] = await pool.query("SELECT data FROM config LIMIT 1");
const cfg = JSON.parse(cfgRow?.data || '{}');
const ctx = {
  teamMap, globalLevels: cfg.levels || {}, leadPct: Number(cfg.leadSourcePct) || 0,
  companyExpensePct: Number(cfg.companyExpensePct) || 0, residualLevel: Number(cfg.residualLevel) || 4,
};
const engineCfg = { globalLevels: ctx.globalLevels, leadSourcePct: ctx.leadPct, companyExpensePct: ctx.companyExpensePct, residualLevel: ctx.residualLevel };
console.log(`config: company ${ctx.companyExpensePct}%, lead ${ctx.leadPct}%, residual level L${ctx.residualLevel}, card ${JSON.stringify(ctx.globalLevels)}`);

const [groups] = await pool.query(
  `SELECT mappedClientId cid, brokeragePeriod period, ROUND(SUM(grossAmount),4) g
     FROM transactions WHERE mappedClientId IS NOT NULL AND mappedClientId <> ''
      AND brokeragePeriod IS NOT NULL AND brokeragePeriod <> '' GROUP BY 1, 2`);

let compared = 0, mismatched = 0, noChain = 0, upperPaid = 0;
const periodsSeen = new Set(), sample = [];
const totalsOld = {}, totalsNew = {};
for (const gr of groups) {
  const h = hier.get(gr.cid);
  if (!h) { noChain++; continue; }
  const gross = Number(gr.g) || 0;
  const lsl = lead.get(gr.cid);
  const oldE = oldShares(gross, h, lsl, gr.period, ctx);
  const split = residualSplit({ gross, h, lsl, period: gr.period, teamMap, cfg: engineCfg });
  const newE = {};
  for (const s of split.shares) { newE[s.uid] = (newE[s.uid] || 0) + s.amount; if (s.kind === 'upper') upperPaid++; }
  let bad = false;
  for (const id of new Set([...Object.keys(oldE), ...Object.keys(newE)])) {
    const a = oldE[id] || 0, b = newE[id] || 0;
    if (Math.abs(a - b) > 1e-6) bad = true;
    totalsOld[gr.period] = (totalsOld[gr.period] || 0) + a;
    totalsNew[gr.period] = (totalsNew[gr.period] || 0) + b;
  }
  compared++; periodsSeen.add(gr.period);
  if (bad) { mismatched++; if (sample.length < 5) sample.push({ cid: gr.cid, period: gr.period, gross, old: oldE, now: newE }); }
}
console.log(`compared ${compared} (client, month) pairs over ${periodsSeen.size} months; ${noChain} had no chain (skipped)`);
console.log(`upper-level shares paid by the new engine: ${upperPaid}`);
console.log(`MISMATCHES: ${mismatched}`);
for (const s of sample) console.log('  sample', JSON.stringify(s));
const months = [...periodsSeen].sort();
const worst = months.map(p => Math.abs((totalsOld[p] || 0) - (totalsNew[p] || 0))).reduce((a, b) => Math.max(a, b), 0);
console.log(`largest month-total difference: ${worst.toFixed(6)}`);
console.log(`months: ${months[0]} .. ${months[months.length - 1]}`);
await pool.end();
process.exit(mismatched ? 1 : 0);
