// Tests for changing a client's RM/BM by hand from a chosen month (the Clients & Map screen).
//
//   node src/lib/chainChange.test.mjs
import { planChainChange, chainAsOf } from './hierarchyHistory.js';
import { residualSplit, breakdownFromShares } from './payoutEngine.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const slot = (h, l) => (h && h[`level${l}Id`]) || '';
const apply = (client, plan) => ({ ...client, hierarchy: plan.hierarchy, hierarchyHistory: plan.hierarchyHistory, leadSourceLevel: plan.leadSourceLevel });

// Firm-wide card: L1-L3 25%, company 15%, L4 takes what is left.
const cfg = { globalLevels: { 1: 25, 2: 25, 3: 25, 4: 10, 5: 5, 6: 10, 7: 5 }, leadSourcePct: 25, companyExpensePct: 15, residualLevel: 4 };
const teamMap = new Map(['OLD', 'NEW', 'BM1', 'BM2'].map(id => [id, { level: id.startsWith('BM') ? 4 : 2 }]));
const earn = (c, period, gross = 1000) => { const ch = chainAsOf(c, period); return breakdownFromShares(gross, residualSplit({ gross, h: ch.hierarchy, lsl: ch.leadSourceLevel, period, teamMap, cfg })).userPayouts; };

const client = { id: 'c1', hierarchy: { level2Id: 'OLD', level4Id: 'BM1' }, leadSourceLevel: 2 };

// ── nothing changed: no new history, no change reported ──
const same = planChainChange({ client, hierarchy: { level2Id: 'OLD', level4Id: 'BM1' }, leadSourceLevel: 2, effectiveFrom: '2026-11' });
ok(same.changed === false && !same.hierarchyHistory, 'the same people and lead source is not a change');
ok(planChainChange({ client, hierarchy: { ...client.hierarchy }, leadSourceLevel: '2', effectiveFrom: '2026-11' }).changed === false, 'a lead source typed as text "2" is the same as 2');

// ── RM changed from November: October is paid to the old RM, November on to the new one ──
let p = planChainChange({ client, hierarchy: { level2Id: 'NEW', level4Id: 'BM1' }, leadSourceLevel: 2, effectiveFrom: '2026-11' });
ok(p.changed && slot(p.hierarchy, 2) === 'NEW', 'the current chain is the new one');
ok(p.hierarchyHistory.length === 1 && p.hierarchyHistory[0].before === '2026-11' && slot(p.hierarchyHistory[0].hierarchy, 2) === 'OLD', 'the old chain is kept as "valid before 2026-11"');
let c2 = apply(client, p);
ok(earn(c2, '2026-10').OLD === 500 && !earn(c2, '2026-10').NEW, 'October (before the change) still pays the old RM (25% lead 25% = 500)');
ok(earn(c2, '2026-11').NEW === 500 && !earn(c2, '2026-11').OLD, 'November pays the new RM');
ok(earn(c2, '2027-03').NEW === 500, 'every later month pays the new RM');
ok(JSON.stringify(earn(c2, '2026-09')) === JSON.stringify(earn(client, '2026-09')), 'September is exactly what it was before the change');

// ── a second change, from December: November keeps the first change ──
p = planChainChange({ client: c2, hierarchy: { level2Id: 'NEW', level4Id: 'BM2' }, leadSourceLevel: 2, effectiveFrom: '2026-12' });
let c3 = apply(c2, p);
ok(slot(chainAsOf(c3, '2026-10').hierarchy, 2) === 'OLD' && slot(chainAsOf(c3, '2026-10').hierarchy, 4) === 'BM1', 'October: old RM, old BM');
ok(slot(chainAsOf(c3, '2026-11').hierarchy, 2) === 'NEW' && slot(chainAsOf(c3, '2026-11').hierarchy, 4) === 'BM1', 'November: new RM, still the old BM');
ok(slot(chainAsOf(c3, '2026-12').hierarchy, 4) === 'BM2' && slot(chainAsOf(c3, '2027-06').hierarchy, 4) === 'BM2', 'December on: the new BM');
ok(c3.hierarchyHistory.length === 2, 'two snapshots, one per earlier arrangement');

// ── a change dated EARLIER than the last one replaces the later snapshot ──
p = planChainChange({ client: c3, hierarchy: { level2Id: 'NEW', level4Id: 'BM2' }, leadSourceLevel: 2, effectiveFrom: '2026-11' });
let c4 = apply(c3, p);
ok(slot(chainAsOf(c4, '2026-11').hierarchy, 4) === 'BM2', 'moved back to November: BM2 now applies from November');
ok(slot(chainAsOf(c4, '2026-10').hierarchy, 4) === 'BM1' && slot(chainAsOf(c4, '2026-10').hierarchy, 2) === 'OLD', 'October is still the original chain');

// ── changing back to what an earlier month had leaves no pointless history ──
p = planChainChange({ client: c2, hierarchy: client.hierarchy, leadSourceLevel: 2, effectiveFrom: '2026-11' });
ok(p.hierarchyHistory === undefined && slot(p.hierarchy, 2) === 'OLD', 'putting the old chain back from the same month leaves no history');

// ── "all months" is a correction: the whole timeline is replaced ──
p = planChainChange({ client: c3, hierarchy: { level2Id: 'NEW', level4Id: 'BM2' }, leadSourceLevel: 2, effectiveFrom: '0000-01' });
ok(p.hierarchyHistory === undefined, 'all months: no history is kept');
const fixed = apply(c3, p);
ok(slot(chainAsOf(fixed, '2026-01').hierarchy, 2) === 'NEW' && slot(chainAsOf(fixed, '2026-12').hierarchy, 4) === 'BM2', 'all months: every month uses the new chain');
ok(planChainChange({ client, hierarchy: { level2Id: 'NEW', level4Id: 'BM1' }, leadSourceLevel: 2, effectiveFrom: '' }).hierarchyHistory === undefined, 'a blank month means all months');
ok(planChainChange({ client, hierarchy: { level2Id: 'NEW', level4Id: 'BM1' }, leadSourceLevel: 2, effectiveFrom: 'November' }).hierarchyHistory === undefined, 'a malformed month means all months, never "some month"');

// ── lead source is part of the snapshot ──
p = planChainChange({ client, hierarchy: { ...client.hierarchy }, leadSourceLevel: '', effectiveFrom: '2026-11' });
let c5 = apply(client, p);
ok(chainAsOf(c5, '2026-10').leadSourceLevel === 2 && chainAsOf(c5, '2026-11').leadSourceLevel === undefined, 'a lead source dropped from November still counts before it');
ok(earn(c5, '2026-10').OLD === 500 && earn(c5, '2026-11').OLD === 250, 'October pays the lead bonus, November does not (25% only)');

// ── the money is conserved in every month, and the input is never mutated ──
const frozen = JSON.stringify(client);
planChainChange({ client, hierarchy: { level2Id: 'NEW', level4Id: 'BM2' }, leadSourceLevel: 2, effectiveFrom: '2026-11' });
ok(JSON.stringify(client) === frozen, 'the client passed in is left untouched');
for (const m of ['2026-09', '2026-10', '2026-11', '2026-12']) {
  const paid = Object.values(earn(c3, m)).reduce((a, b) => a + b, 0);
  ok(Math.abs(paid - 850) < 1e-6, `${m}: 85% paid out, the company keeps its 15%`);
}

console.log(`chainChange: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
