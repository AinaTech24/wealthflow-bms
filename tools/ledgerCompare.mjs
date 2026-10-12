/**
 * Read-only: what would a Recalculate change TODAY?
 *
 * For every month and person it compares the payout already stored in payout_ledger
 * with what src/lib/payoutEngine.js would produce from the current clients, team and
 * rates. If the two agree (to rounding), pressing Recalculate after a deploy moves no
 * money. Any real difference is data that changed since the last recalculation, not
 * the code.
 *
 * It also lists who sits ABOVE the residual receiver on any client (the people the
 * new L5/L6 rule applies to) and the rate each of them would be paid.
 *
 *   node tools/ledgerCompare.mjs
 */
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';
import { memberAsOf, residualSplit } from '../src/lib/payoutEngine.js';
import { chainAsOf } from '../src/lib/hierarchyHistory.js';

const [clientRows] = await pool.query('SELECT id, data FROM clients');
const clients = new Map();
for (const c of clientRows) {
  let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
  if (d.hierarchy) clients.set(c.id, { hierarchy: d.hierarchy, hierarchyHistory: d.hierarchyHistory, leadSourceLevel: d.leadSourceLevel ? Number(d.leadSourceLevel) : undefined });
}
const [teamRows] = await pool.query('SELECT id, name, level, data FROM team');
const teamMap = new Map(), names = new Map();
for (const t of teamRows) {
  let d = {}; try { d = JSON.parse(t.data || '{}'); } catch {}
  teamMap.set(t.id, { level: Number(t.level), customLevels: d.customLevels, rateHistory: d.rateHistory });
  names.set(t.id, String(t.name || '').trim());
}
const [[cfgRow]] = await pool.query('SELECT data FROM config LIMIT 1');
const cfg = JSON.parse(cfgRow?.data || '{}');
const engineCfg = { globalLevels: cfg.levels || {}, leadSourcePct: Number(cfg.leadSourcePct) || 0, companyExpensePct: Number(cfg.companyExpensePct) || 0, residualLevel: Number(cfg.residualLevel) || 4 };
const locked = new Set(cfg.lockedPeriods || []);
console.log(`rates: company ${engineCfg.companyExpensePct}%, lead ${engineCfg.leadSourcePct}%, residual L${engineCfg.residualLevel}, card ${JSON.stringify(engineCfg.globalLevels)}`);
console.log(`locked months: ${locked.size ? [...locked].sort().join(', ') : 'none'}`);

// What would the engine pay, per month and person?
const [groups] = await pool.query(
  `SELECT mappedClientId cid, brokeragePeriod period, SUM(grossAmount) g FROM transactions
    WHERE mappedClientId IS NOT NULL AND mappedClientId <> '' AND brokeragePeriod IS NOT NULL AND brokeragePeriod <> '' GROUP BY 1, 2`);
const engine = new Map();           // 'period|user' -> amount
const upperPaid = new Map();        // who the upper-level rule pays (should be nobody today)
for (const gr of groups) {
  const c = clients.get(gr.cid); if (!c) continue;
  const ch = chainAsOf(c, gr.period);
  if (!ch.hierarchy) continue;
  const split = residualSplit({ gross: Number(gr.g) || 0, h: ch.hierarchy, lsl: ch.leadSourceLevel, period: gr.period, teamMap, cfg: engineCfg });
  for (const s of split.shares) {
    const k = gr.period + '|' + s.uid;
    engine.set(k, (engine.get(k) || 0) + s.amount);
    if (s.kind === 'upper' && s.amount !== 0) upperPaid.set(s.uid, (upperPaid.get(s.uid) || 0) + 1);
  }
}

// What is stored?
const [stored] = await pool.query(
  `SELECT t.brokeragePeriod period, l.userId, SUM(l.amount) amt FROM payout_ledger l JOIN transactions t ON t.id = l.transactionId
    WHERE t.brokeragePeriod IS NOT NULL AND t.brokeragePeriod <> '' GROUP BY 1, 2`);
const store = new Map(stored.map(r => [r.period + '|' + r.userId, Number(r.amt) || 0]));

let compared = 0, over1 = 0, worst = 0, totalAbs = 0;
const byMonth = new Map(), samples = [];
for (const k of new Set([...engine.keys(), ...store.keys()])) {
  const a = engine.get(k) || 0, b = store.get(k) || 0, d = a - b;
  compared++; totalAbs += Math.abs(d);
  const period = k.split('|')[0];
  const m = byMonth.get(period) || { diff: 0, abs: 0, people: 0, stored: 0 };
  m.diff += d; m.abs += Math.abs(d); m.stored += b; if (Math.abs(d) > 1) m.people++;
  byMonth.set(period, m);
  if (Math.abs(d) > 1) { over1++; if (samples.length < 6) samples.push({ month: period, person: names.get(k.split('|')[1]) || k.split('|')[1], stored: Math.round(b * 100) / 100, engine: Math.round(a * 100) / 100 }); }
  worst = Math.max(worst, Math.abs(d));
}
console.log(`\ncompared ${compared} (month, person) figures`);
console.log(`differences above Rs 1: ${over1}; largest single difference: Rs ${worst.toFixed(2)}`);
console.log('\nmonth      stored total    engine minus stored   people differing by > Rs 1');
for (const p of [...byMonth.keys()].sort().slice(-8)) {
  const m = byMonth.get(p);
  console.log(`${p}  ${m.stored.toFixed(2).padStart(14)}  ${m.diff.toFixed(2).padStart(19)}  ${String(m.people).padStart(8)}${locked.has(p) ? '   (locked)' : ''}`);
}
for (const s of samples) console.log('  e.g.', JSON.stringify(s));

// Who sits above the residual receiver on a client, and what would they earn?
const rl = engineCfg.residualLevel, above = new Map();
for (const [, c] of clients) {
  const h = c.hierarchy; let receiverLevel = null;
  for (let l = rl; l <= 7; l++) if (h[`level${l}Id`]) { receiverLevel = l; break; }
  if (!receiverLevel) continue;
  for (let l = receiverLevel + 1; l <= 7; l++) {
    const u = h[`level${l}Id`]; if (!u) continue;
    const info = memberAsOf(teamMap.get(u), '9999-12'); const cl = info?.customLevels, uL = info?.level;
    const pct = Math.max(0, cl && cl[uL] !== undefined ? cl[uL] : cl && cl[l] !== undefined ? cl[l] : (engineCfg.globalLevels[l] || 0));
    const k = `${names.get(u) || u} (slot L${l})`;
    const e = above.get(k) || { clients: 0, pct };
    e.clients++; above.set(k, e);
  }
}
console.log('\npeople above the residual receiver (the new L5/L6 rule applies to them):');
for (const [k, e] of [...above.entries()].sort((a, b) => b[1].clients - a[1].clients)) console.log(`  ${k.padEnd(34)} on ${String(e.clients).padStart(5)} clients, rate that would be paid: ${e.pct}%`);
console.log(`\nupper-level amounts the engine would pay today: ${upperPaid.size === 0 ? 'none' : [...upperPaid.keys()].map(u => names.get(u) || u).join(', ')}`);
await pool.end();
