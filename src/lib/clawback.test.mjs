// Regression tests for CLAWBACK (negative-gross) payout handling.
//
//   node src/lib/clawback.test.mjs
//
// WHY THIS EXISTS
// The ledger engines guarded each payout with `if (p > 0)`. That tests the
// AMOUNT, not the rate — so on a negative-gross row (a registrar clawback or
// reversal) the RM's slice was silently discarded, while the lead-source add-on
// (which had no such guard) was still deducted. A reversal therefore took back
// only the 25% bonus and never the RM's own share.
//
// The report engine guards on the RATE (`slicePct > 0`) and was always correct,
// so the two disagreed on every month containing a clawback — the true cause of
// the recurring "net brokerage mismatched every time" complaint, not rounding.
// Measured on production 2026-08-08: 1,400 negative rows, Rs 473.16 over-paid
// across 28 RMs (deducted -156.64 where -629.80 was due).
//
// These tests pin the CONTRACT the four engines must share.

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = Math.round(Number(got) * 10000) / 10000;
  const w = Math.round(Number(want) * 10000) / 10000;
  if (g === w) { pass++; return; }
  console.log(`  FAIL  ${label}\n        got ${g}  want ${w}`);
  fail++;
};

// Faithful reproduction of server.js recomputeAllBreakdowns.calcSlices —
// keep in step with server.js / recalcRun.js if either changes.
function calcSlices(gross, h, lsl, { teamMap, globalLevels, leadPct }) {
  const lp = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, up = {};
  let oCL, oLvl;
  for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u) { oCL = teamMap.get(u)?.customLevels; oLvl = l; break; } }
  let dist = 0; const paid = new Set();
  for (let l = 1; l <= 7; l++) {
    const u = h[`level${l}Id`]; if (!u || paid.has(u)) continue; paid.add(u);
    const info = teamMap.get(u); const cl = info?.customLevels, uL = info?.level;
    const pct = Math.max(0, cl && cl[uL] !== undefined ? cl[uL] : (cl && cl[l] !== undefined ? cl[l] : (oCL?.[l] !== undefined ? oCL[l] : (globalLevels[l] || 0))));
    const p = Math.round(gross * pct / 100 * 10000) / 10000;
    lp[l] = p; if (p !== 0) up[u] = (up[u] || 0) + p; dist += p;
  }
  if (leadPct > 0) {
    const sL = (lsl && h[`level${lsl}Id`]) ? lsl : oLvl; const su = sL ? h[`level${sL}Id`] : null;
    if (su) { const p = Math.round(gross * leadPct / 100 * 10000) / 10000; lp[sL] = (lp[sL] || 0) + p; if (p !== 0) up[su] = (up[su] || 0) + p; dist += p; }
  }
  return { levelPayouts: lp, userPayouts: up };
}

console.log('clawback / negative-gross payout tests\n');

const RM = 'rm1', MGR = 'mgr1';
const teamMap = new Map([
  [RM,  { level: 3, customLevels: { 3: 50 } }],
  [MGR, { level: 4, customLevels: { 4: 5 } }],
]);
const ctx = { teamMap, globalLevels: { 1: 25, 2: 25, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 }, leadPct: 25 };
const hier = { level3Id: RM, level4Id: MGR };

// ── Positive gross: baseline the maths ─────────────────────────────────────
const pos = calcSlices(10, hier, 3, ctx);
eq('positive: RM = 50% slice + 25% lead', pos.userPayouts[RM], 7.5);
eq('positive: manager = 5%',              pos.userPayouts[MGR], 0.5);

// ── Negative gross: the actual bug ─────────────────────────────────────────
// The production row that exposed it: gross -0.56, RM at L3 @50% + 25% lead.
// Ledger recorded -0.14 (lead only). Correct is -0.42.
const neg = calcSlices(-0.56, hier, 3, ctx);
eq('CLAWBACK: RM loses slice AND lead (75%)', neg.userPayouts[RM], -0.42);
eq('CLAWBACK: manager slice deducted too',    neg.userPayouts[MGR], -0.028);

// A clawback must never be silently dropped.
if (neg.userPayouts[RM] === undefined) { console.log('  FAIL  RM missing from userPayouts on a clawback'); fail++; } else pass++;
if (neg.userPayouts[MGR] === undefined) { console.log('  FAIL  manager missing from userPayouts on a clawback'); fail++; } else pass++;

// Symmetry: reversing a transaction must exactly undo it, to the paisa.
const g = 12.34;
const up1 = calcSlices(g,  hier, 3, ctx).userPayouts;
const up2 = calcSlices(-g, hier, 3, ctx).userPayouts;
eq('symmetry RM',      up1[RM] + up2[RM], 0);
eq('symmetry manager', up1[MGR] + up2[MGR], 0);

// A ZERO rate must still contribute nothing (the guard must not become `!== 0`
// on the RATE — only on the amount).
const zeroRate = new Map([[RM, { level: 3, customLevels: { 3: 0 } }]]);
const z = calcSlices(-5, { level3Id: RM }, undefined, { ...ctx, teamMap: zeroRate, leadPct: 0 });
eq('zero rate contributes nothing', z.userPayouts[RM] || 0, 0);

// Zero gross must produce no entries at all.
const zg = calcSlices(0, hier, 3, ctx);
if (Object.keys(zg.userPayouts).length === 0) pass++;
else { console.log(`  FAIL  zero gross produced entries: ${JSON.stringify(zg.userPayouts)}`); fail++; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
