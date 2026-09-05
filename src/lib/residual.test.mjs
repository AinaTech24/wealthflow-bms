// Regression tests for the RESIDUAL payout model — the ONLY model as of 2026-08-18.
//
//   node src/lib/residual.test.mjs
//
// THE RULE (confirmed by the business owner):
//   Rs 100 received -> company takes 15% FIRST
//                   -> L1/L2/L3 take their level % (lead-source bonus included)
//                   -> WHATEVER IS LEFT goes to the L4 BM.
//
// WHY THIS EXISTS
// The system previously ran "Slices": every level took a fixed % and the COMPANY
// got the remainder. That let the levels sum past 100%. On PRADEEP KASHINATH
// CHAUDHARI's 53-client book in Jun-2026 it distributed 103.46% of gross —
// the firm paid out Rs 676.03 MORE than it received. It also meant no fixed BM
// percentage could ever match AdvisorKhoj, because a BM's share is an OUTCOME
// (100 - company - downline), not a setting.
//
// Keep this file in step with server.js calcResidual / recalcRun.js calcResidual /
// calculationService.ts. If you change one, change all and re-run.

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = Math.round(Number(got) * 10000) / 10000;
  const w = Math.round(Number(want) * 10000) / 10000;
  if (g === w) { pass++; return; }
  console.log(`  FAIL  ${label}\n        got ${g}  want ${w}`);
  fail++;
};

// Faithful copy of server.js recomputeAllBreakdowns.calcResidual
function calcResidual(gross, h, lsl, { teamMap, globalLevels, companyExpensePct, leadPct, residualLevel }) {
  const lp = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, up = {};
  let oCL;
  for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) { oCL = teamMap.get(u)?.customLevels; break; } }
  const rl = residualLevel; const paid = new Set(); let lowerSum = 0, dist = 0;
  for (let l = 1; l < rl; l++) {
    const u = h[`level${l}Id`]; if (!u || paid.has(u)) continue; paid.add(u);
    const info = teamMap.get(u); const cl = info?.customLevels, uL = info?.level;
    const pct = Math.max(0, cl && cl[uL] !== undefined ? cl[uL] : (cl && cl[l] !== undefined ? cl[l] : (oCL?.[l] !== undefined ? oCL[l] : (globalLevels[l] || 0))));
    const p = Math.round(gross * pct / 100 * 10000) / 10000;
    lp[l] = p; if (p !== 0) up[u] = (up[u] || 0) + p; lowerSum += pct; dist += p;
  }
  if (leadPct > 0 && lsl && lsl < rl) {
    const su = h[`level${lsl}Id`];
    if (su) { const p = Math.round(gross * leadPct / 100 * 10000) / 10000; lp[lsl] = (lp[lsl] || 0) + p; if (p !== 0) up[su] = (up[su] || 0) + p; lowerSum += leadPct; dist += p; }
  }
  let ru = null, ruL = rl;
  for (let l = rl; l <= 7; l++) { if (h[`level${l}Id`]) { ru = h[`level${l}Id`]; ruL = l; break; } }
  if (ru && !paid.has(ru)) {
    const surplus = Math.max(0, 100 - companyExpensePct - lowerSum);
    const p = Math.round(gross * surplus / 100 * 10000) / 10000;
    lp[ruL] = (lp[ruL] || 0) + p; if (p !== 0) up[ru] = (up[ru] || 0) + p; dist += p;
  }
  return { userPayouts: up, distributed: dist };
}

console.log('RESIDUAL payout model tests\n');

const RM = 'rm', BM = 'bm';
const ctx = (rmRate) => ({
  teamMap: new Map([[RM, { level: 3, customLevels: { 3: rmRate } }], [BM, { level: 4, customLevels: { 4: 99 } }]]),
  globalLevels: { 1: 25, 2: 25, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 },
  companyExpensePct: 15, leadPct: 25, residualLevel: 4,
});
const hier = { level3Id: RM, level4Id: BM };

// ── The owner's own example: Rs 100, company 15, RM 50+25 lead = 75, BM gets 10
const r = calcResidual(100, hier, 3, ctx(50));
eq('RM gets 50 + 25 lead',            r.userPayouts[RM], 75);
eq('BM gets the REMAINDER (100-15-75)', r.userPayouts[BM], 10);
eq('total distributed = 85 (company keeps 15)', r.distributed, 85);

// The BM's configured rate is IRRELEVANT — it is an outcome, not a setting.
// customLevels[4] is 99 above and must never be used.
if (r.userPayouts[BM] === 99) { console.log('  FAIL  BM paid its configured rate instead of the residual'); fail++; } else pass++;

// ── A cheaper downline leaves MORE for the BM
const r2 = calcResidual(100, hier, 3, ctx(25));
eq('RM 25 + 25 lead = 50',  r2.userPayouts[RM], 50);
eq('BM residual = 35',      r2.userPayouts[BM], 35);
eq('company still keeps 15', 100 - r2.distributed, 15);

// ── Over-configured downline. The engine cannot invent money, so it will still
// pay the RM their contracted 115% — but the BM residual must clamp at 0 (never
// negative) and the engines now COUNT this case and warn, so a bad rate is
// visible rather than silently over-distributing.
const r3 = calcResidual(100, hier, 3, ctx(90));
eq('over-configured downline -> BM residual clamps to 0', r3.userPayouts[BM] || 0, 0);
if (r3.distributed > 100) pass++;   // expected: this IS the config error the warning flags
else { console.log('  FAIL  expected the over-configured case to exceed 100%'); fail++; }

// With a SANE downline (<= 100 - company) the split is exact, every time.
for (const rate of [0, 10, 25, 40, 60]) {
  const x = calcResidual(100, hier, 3, ctx(rate));
  eq(`sane rate ${rate}: total distributed = 85`, x.distributed, 85);
}

// ── No lead source tagged: RM gets only its slice, BM absorbs the rest
const r4 = calcResidual(100, hier, undefined, ctx(50));
eq('no lead source: RM 50', r4.userPayouts[RM], 50);
eq('no lead source: BM 35', r4.userPayouts[BM], 35);

// ── Clawbacks must mirror exactly (negative gross)
const p1 = calcResidual(100, hier, 3, ctx(50)).userPayouts;
const n1 = calcResidual(-100, hier, 3, ctx(50)).userPayouts;
eq('clawback symmetry RM', p1[RM] + n1[RM], 0);
eq('clawback symmetry BM', p1[BM] + n1[BM], 0);

// ── No BM assigned: the residual stays with the company, not with the RM
const r5 = calcResidual(100, { level3Id: RM }, 3, ctx(50));
eq('no BM: RM still 75',        r5.userPayouts[RM], 75);
eq('no BM: nothing else paid',  Object.keys(r5.userPayouts).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
