// End-to-end test of a promotion: the planner, the dated chains and the payout engine
// working together, on the scenario this feature exists for.
//
//   node src/lib/promotionFlow.test.mjs
//
// Shakeel is an L2 RM with clients; from September he is an L3. His L4 does not
// change. His clients must move to L3 by themselves from September, August must stay
// exactly as it was paid, and September must pay at the L3 rate with no hand work.
import { residualSplit, breakdownFromShares } from './payoutEngine.js';
import { chainAsOf, planLevelMove } from './hierarchyHistory.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// Firm-wide card: L2 pays 20%, L3 pays 25%, company keeps 15%, L4 takes the rest.
const cfg = { globalLevels: { 1: 20, 2: 20, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 }, leadSourcePct: 0, companyExpensePct: 15, residualLevel: 4 };

// Shakeel's level history, exactly as the team save stamps it: L2 until August, L3 from September.
const teamMap = new Map([
  ['shakeel', { level: 3, customLevels: undefined, rateHistory: [
    { effectiveFrom: '0000-01', level: 2, customLevels: undefined },
    { effectiveFrom: '2026-09', level: 3, customLevels: undefined },
  ] }],
  ['yash',   { level: 3, customLevels: undefined }],      // an L3 manager over some of his clients
  ['llp',    { level: 4, customLevels: { 4: 0 } }],
]);

// 5 clients with Shakeel at L2 and nobody at L3; 2 clients where Yash holds L3 above him.
const clients = [
  ...Array.from({ length: 5 }, (_, i) => ({ id: `free${i}`, name: `Free ${i}`, hierarchy: { level2Id: 'shakeel', level4Id: 'llp' } })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `mgr${i}`, name: `Managed ${i}`, hierarchy: { level2Id: 'shakeel', level3Id: 'yash', level4Id: 'llp' } })),
];

const earn = (client, period, gross = 1000) => {
  const ch = chainAsOf(client, period);
  const split = residualSplit({ gross, h: ch.hierarchy, lsl: ch.leadSourceLevel, period, teamMap, cfg });
  return breakdownFromShares(gross, split).userPayouts;
};

// ── before the promotion is recorded: the figures that were paid for July and August ──
const paidAug = Object.fromEntries(clients.map(c => [c.id, earn(c, '2026-08')]));
ok(near(paidAug.free0.shakeel, 200) && near(paidAug.free0.llp, 650), 'Aug (as paid): L2 Shakeel 20% = 200, L4 takes 100-15-20 = 65% = 650');
ok(near(paidAug.mgr0.shakeel, 200) && near(paidAug.mgr0.yash, 250) && near(paidAug.mgr0.llp, 400), 'Aug (as paid), managed client: Shakeel 200, Yash 250, L4 400');

// ── promote Shakeel L2 -> L3 from September, keeping anyone already at L3 ─────────────
let plan = planLevelMove({ clients, personId: 'shakeel', from: 2, to: 3, effectiveFrom: '2026-09' });
ok(plan.counts.moved === 5 && plan.counts.blocked === 2, '5 clients move by themselves; the 2 with a manager at L3 are reported, not guessed');
const afterKeep = clients.map(c => { const m = plan.moves.find(x => x.id === c.id); return m ? { ...c, hierarchy: m.hierarchy, hierarchyHistory: m.hierarchyHistory, leadSourceLevel: m.leadSourceLevel } : c; });

for (const c of afterKeep) {
  const before = paidAug[c.id], now = earn(c, '2026-08');
  ok(JSON.stringify(before) === JSON.stringify(now), `${c.id}: August is exactly what it was`);
}
const sep = earn(afterKeep[0], '2026-09');
ok(near(sep.shakeel, 250), 'Sept: Shakeel is paid the L3 rate, 25% = 250, with nobody typing a rate');
ok(near(sep.llp, 600), 'Sept: L4 takes 100-15-25 = 60% = 600 (his upline is unchanged)');
ok(JSON.stringify(earn(afterKeep[0], '2026-12')) === JSON.stringify(sep), 'later months stay at the L3 rate');
ok(JSON.stringify(earn(afterKeep[5], '2026-09')) === JSON.stringify(paidAug.mgr0), 'a blocked client is untouched in September too, until you decide');

// ── the same promotion, replacing the manager at L3 ───────────────────────────────────
plan = planLevelMove({ clients, personId: 'shakeel', from: 2, to: 3, effectiveFrom: '2026-09', occupied: 'replace' });
ok(plan.counts.moved === 5 && plan.counts.replaced === 2 && plan.counts.blocked === 0, 'with "replace": all 7 clients move, 2 of them take over from Yash');
const afterReplace = clients.map(c => { const m = plan.moves.find(x => x.id === c.id); return { ...c, hierarchy: m.hierarchy, hierarchyHistory: m.hierarchyHistory, leadSourceLevel: m.leadSourceLevel }; });
const mgrAug = earn(afterReplace[5], '2026-08'), mgrSep = earn(afterReplace[5], '2026-09');
ok(near(mgrAug.yash, 250) && near(mgrAug.shakeel, 200), "Aug: Yash still earned his L3 share on that client, so his past is not rewritten");
ok(!mgrSep.yash && near(mgrSep.shakeel, 250) && near(mgrSep.llp, 600), 'Sept: Yash is out of that chain, Shakeel is L3, L4 unchanged');

// ── money is conserved in every month ─────────────────────────────────────────────────
for (const period of ['2026-07', '2026-08', '2026-09', '2027-01']) {
  for (const c of afterReplace) {
    const p = earn(c, period);
    const paid = Object.values(p).reduce((a, b) => a + b, 0);
    ok(near(paid, 850), `${c.id} ${period}: 85% paid out, the company keeps its 15%`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
