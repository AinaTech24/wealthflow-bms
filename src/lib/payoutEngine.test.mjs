// Tests for the shared payout engine.
//
//   node src/lib/payoutEngine.test.mjs
//
// Part 1 is a DIFFERENTIAL test: the engine's output must be identical to a verbatim
// copy of the code that produced every payout to date (server.js calcResidual and the
// residual block of accumulatePayoutTotals), on thousands of random clients, whenever
// no upper-level rate is set (today's configuration). If this part passes, moving the
// maths into one module changed nobody's money.
// Part 2 checks the new upper-level (L5/L6) rule on worked examples.
import { memberAsOf, residualSplit, breakdownFromShares } from './payoutEngine.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── Reference: the code as it stood in server.js before the shared engine ─────────
function refCalcResidual(gross, h, lsl, period, ctx) {
  const { teamMap, residualLevel, globalLevels, leadPct, companyExpensePct } = ctx;
  const lp = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, up = {};
  let oCL; for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) { oCL = memberAsOf(teamMap.get(u), period)?.customLevels; break; } }
  const rl = residualLevel; const paid = new Set(); let lowerSum = 0, dist = 0;
  for (let l = 1; l < rl; l++) { const u = h[`level${l}Id`]; if (!u || paid.has(u)) continue; paid.add(u);
    const info = memberAsOf(teamMap.get(u), period); const cl = info?.customLevels, uL = info?.level;
    const pct = Math.max(0, cl && cl[uL] !== undefined ? cl[uL] : (cl && cl[l] !== undefined ? cl[l] : (oCL?.[l] !== undefined ? oCL[l] : (globalLevels[l] || 0))));
    const p = Math.round(gross * pct / 100 * 10000) / 10000; lp[l] = p; if (p !== 0) up[u] = (up[u] || 0) + p; lowerSum += pct; dist += p; }
  if (leadPct > 0 && lsl && lsl < rl) {
    const su = h[`level${lsl}Id`];
    if (su) { const p = Math.round(gross * leadPct / 100 * 10000) / 10000; lp[lsl] = (lp[lsl] || 0) + p; if (p !== 0) up[su] = (up[su] || 0) + p; lowerSum += leadPct; dist += p; }
  }
  let ru = null, ruL = rl; for (let l = rl; l <= 7; l++) { if (h[`level${l}Id`]) { ru = h[`level${l}Id`]; ruL = l; break; } }
  if (ru && !paid.has(ru)) { const surplus = Math.max(0, 100 - companyExpensePct - lowerSum);
    const p = Math.round(gross * surplus / 100 * 10000) / 10000; lp[ruL] = (lp[ruL] || 0) + p; if (p !== 0) up[ru] = (up[ru] || 0) + p; dist += p; }
  const exp = Math.round((gross - dist) * 100) / 100;
  return { gross, expenseAmount: exp, netPool: Math.round((gross - exp) * 100) / 100, levelPayouts: lp, userPayouts: up };
}

function refAccumulateEarnings(gross, h, lsl, period, ctx) {
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

// ── Part 1: differential test on random clients ───────────────────────────────────
let seed = 20261012;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
// Real chains: people with personal rate cards fill slots 1-4; slots 5-7 hold upper-level
// people (Freedom Lifex, the admin, a promoted BM) who carry no rate, or an explicit 0.
const LOW = Array.from({ length: 10 }, (_, i) => `p${i}`);
const HIGH = Array.from({ length: 4 }, (_, i) => `u${i}`);

function randomTeam() {
  const t = new Map();
  for (const id of LOW) {
    const level = 1 + Math.floor(rnd() * 4);
    const cards = {};
    for (let l = 1; l <= 4; l++) if (rnd() < 0.35) cards[l] = pick([0, 5, 15, 25, 25, 45, 50, 70, 75]);
    const rec = { level, customLevels: rnd() < 0.8 ? cards : undefined };
    if (rnd() < 0.3) {
      rec.rateHistory = [
        { effectiveFrom: '0000-01', level: 1 + Math.floor(rnd() * 4), customLevels: { [1 + Math.floor(rnd() * 4)]: pick([0, 25, 50]) } },
        { effectiveFrom: pick(['2026-04', '2026-07', '2026-09']), level, customLevels: cards },
      ];
    }
    t.set(id, rec);
  }
  for (const id of HIGH) {
    const level = 5 + Math.floor(rnd() * 3);
    t.set(id, { level, customLevels: rnd() < 0.5 ? undefined : { 4: 0, [level]: 0 } });
  }
  return t;
}

const LEGACY_GLOBALS = [
  { 1: 25, 2: 25, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 },   // the live configuration
  { 1: 25, 2: 25, 3: 25 },                             // L4+ keys absent
  { 1: 20, 2: 30, 3: 35, 4: 0, 5: 0, 6: 0, 7: 0 },
];

let mismatches = 0, cases = 0;
for (let n = 0; n < 20000; n++) {
  const teamMap = randomTeam();
  const globalLevels = pick(LEGACY_GLOBALS);
  const cfg = { globalLevels, leadSourcePct: pick([0, 25, 10]), companyExpensePct: pick([15, 15, 20, 0]), residualLevel: 4 };   // the live residual level
  const ctx = { teamMap, residualLevel: cfg.residualLevel, globalLevels, leadPct: cfg.leadSourcePct, companyExpensePct: cfg.companyExpensePct };
  const h = {};
  for (let l = 1; l <= 7; l++) if (rnd() < 0.5) h[`level${l}Id`] = l <= 4 ? pick(LOW) : pick(HIGH);   // duplicates across slots are possible, as in real data
  const lsl = rnd() < 0.5 ? 1 + Math.floor(rnd() * 7) : undefined;
  const period = pick(['2026-03', '2026-06', '2026-08', '2026-10']);
  const gross = pick([1000, 12345.67, 0.01, -250, 99999.99, 0]);
  cases++;

  const split = residualSplit({ gross, h, lsl, period, teamMap, cfg });
  const got = breakdownFromShares(gross, split);
  const ref = refCalcResidual(gross, h, lsl, period, ctx);
  const sameBreakdown =
    got.gross === ref.gross && got.expenseAmount === ref.expenseAmount && got.netPool === ref.netPool &&
    JSON.stringify(got.levelPayouts) === JSON.stringify(ref.levelPayouts) &&
    JSON.stringify(got.userPayouts) === JSON.stringify(ref.userPayouts);

  // report engine: earnings per person
  const refEarn = refAccumulateEarnings(gross, h, lsl, period, ctx);
  const gotEarn = {};
  for (const s of split.shares) gotEarn[s.uid] = (gotEarn[s.uid] || 0) + s.amount;
  const ids = new Set([...Object.keys(refEarn), ...Object.keys(gotEarn)]);
  let sameEarn = true;
  for (const id of ids) if (!near(refEarn[id] || 0, gotEarn[id] || 0)) sameEarn = false;

  if (!sameBreakdown || !sameEarn) {
    mismatches++;
    if (mismatches <= 3) console.log('  MISMATCH', JSON.stringify({ h, lsl, period, gross, cfg: { ...cfg, globalLevels }, sameBreakdown, sameEarn, got: got.userPayouts, ref: ref.userPayouts }));
  }
}
ok(mismatches === 0, `shared engine == production code on ${cases} random clients (mismatches: ${mismatches})`);

// ── Part 2: the upper-level rule ──────────────────────────────────────────────────
const team = new Map([
  ['rm',  { level: 3, customLevels: undefined }],
  ['bm',  { level: 4, customLevels: undefined }],
  ['p5',  { level: 5, customLevels: undefined }],
  ['p6',  { level: 6, customLevels: undefined }],
  ['hq',  { level: 7, customLevels: undefined }],
]);
const base = { leadSourcePct: 0, companyExpensePct: 15, residualLevel: 4 };
const G = (levels, extra = {}) => ({ ...base, globalLevels: { 1: 25, 2: 25, 3: 25, 4: 5, ...levels }, ...extra });
const total = (s) => s.shares.reduce((a, x) => a + x.amount, 0);
const by = (s) => Object.fromEntries(s.shares.map(x => [x.uid, x.amount]));
const chain = { level3Id: 'rm', level4Id: 'bm', level5Id: 'p5', level6Id: 'p6', level7Id: 'hq' };

// L5 and L6 rates set on the firm-wide card: they start earning, L4 keeps the rest.
let s = residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team, cfg: G({ 5: 5, 6: 3 }) });
ok(near(by(s).rm, 250) && near(by(s).p5, 50) && near(by(s).p6, 30), 'L3 25%, L5 5%, L6 3% of 1000');
ok(near(by(s).bm, 520), 'L4 keeps the rest: 100 - 15 - 25 - 5 - 3 = 52% = 520');
ok(near(total(s), 850) && near(1000 - total(s), 150), 'company retains exactly its 15%');
ok(!by(s).hq, 'L7 with no rate earns nothing');
ok(s.shares.find(x => x.uid === 'p5').kind === 'upper' && s.upperSum === 8, 'upper shares are tagged and summed');

// With today's configuration (L5-L7 = 0) the upper levels earn nothing and L4 takes it all.
s = residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team, cfg: G({}) });
ok(near(by(s).bm, 600) && !by(s).p5 && !by(s).p6, 'with L5/L6 at 0 the L4 takes the whole 60% as before');

// A personal rate beats the firm-wide one; an explicit 0 stays 0.
const team2 = new Map(team); team2.set('p5', { level: 5, customLevels: { 5: 12 } }); team2.set('p6', { level: 6, customLevels: { 6: 0 } });
s = residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team2, cfg: G({ 5: 5, 6: 3 }) });
ok(near(by(s).p5, 120) && !by(s).p6, 'personal 12% beats the card; personal 0 beats the card');

// The client owner's legacy card must NOT feed upper levels (Akash-style 5:70, 6:15, 7:15).
const team3 = new Map(team); team3.set('rm', { level: 3, customLevels: { 3: 45, 5: 70, 6: 15, 7: 15 } });
s = residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team3, cfg: G({}) });
ok(near(by(s).rm, 450) && !by(s).p5 && !by(s).p6 && !by(s).hq, "owner's legacy L5/L6/L7 numbers are ignored");
ok(near(by(s).bm, 400), 'L4 still gets 100 - 15 - 45 = 40%');

// No L4 on the client: the L5 becomes the receiver and the L6 above it takes its own rate.
const noL4 = { level3Id: 'rm', level5Id: 'p5', level6Id: 'p6' };
s = residualSplit({ gross: 1000, h: noL4, period: '2026-09', teamMap: team, cfg: G({ 6: 4 }) });
ok(near(by(s).p6, 40) && near(by(s).p5, 1000 * (100 - 15 - 25 - 4) / 100), 'with no L4, L5 is the receiver and L6 takes 4% above it');

// Over-allocation: the receiver is clamped at zero and the client is flagged.
s = residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team, cfg: G({ 5: 40, 6: 40 }) });
ok(s.overDistributed === true && !by(s).bm, 'rates beyond 100% are flagged and the receiver is clamped to 0');

// A clawback reverses every share, including the upper ones.
s = residualSplit({ gross: -1000, h: chain, period: '2026-09', teamMap: team, cfg: G({ 5: 5, 6: 3 }) });
ok(near(by(s).p5, -50) && near(by(s).p6, -30) && near(by(s).bm, -520), 'a clawback deducts from upper levels too');

// The same person in two upper slots is paid once.
const dup = { level3Id: 'rm', level4Id: 'bm', level5Id: 'p5', level6Id: 'p5' };
s = residualSplit({ gross: 1000, h: dup, period: '2026-09', teamMap: team, cfg: G({ 5: 5, 6: 3 }) });
ok(near(by(s).p5, 50), 'one person in two upper slots earns once, at the first slot');

// breakdown shape the ledger stores
const bd = breakdownFromShares(1000, residualSplit({ gross: 1000, h: chain, period: '2026-09', teamMap: team, cfg: G({ 5: 5, 6: 3 }) }));
ok(near(bd.levelPayouts[5], 50) && near(bd.levelPayouts[6], 30) && near(bd.levelPayouts[4], 520), 'levelPayouts carry L5 and L6');
ok(near(bd.expenseAmount, 150) && near(bd.netPool, 850), 'expense and net pool add up');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
