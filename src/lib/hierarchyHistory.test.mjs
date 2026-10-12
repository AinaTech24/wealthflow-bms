// Tests for hierarchyAsOf and planLevelMove.
//
//   node src/lib/hierarchyHistory.test.mjs
import { hierarchyAsOf, chainAsOf, planLevelMove, monthBefore } from './hierarchyHistory.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const slot = (h, l) => (h && h[`level${l}Id`]) || '';
const chainOf = (h) => [1, 2, 3, 4, 5, 6, 7].map(l => slot(h, l)).join('|');

ok(monthBefore('2026-09') === '2026-08' && monthBefore('2026-01') === '2025-12', 'monthBefore, including the year boundary');

// ── a client with no history behaves exactly as before ───────────────────────────
const plain = { hierarchy: { level2Id: 'S', level4Id: 'Z' } };
ok(hierarchyAsOf(plain, '2024-01') === plain.hierarchy && hierarchyAsOf(plain, '2099-01') === plain.hierarchy, 'no history: the current chain for every month');
ok(hierarchyAsOf(plain, undefined) === plain.hierarchy, 'no period: the current chain');

// ── the headline case: S moves L2 -> L3 from September, L4 unchanged ──────────────
const fleet = [
  { id: 'c1', name: 'Client One', hierarchy: { level2Id: 'S', level4Id: 'Z' }, leadSourceLevel: 2 },
  { id: 'c2', name: 'Client Two', hierarchy: { level2Id: 'S', level4Id: 'Z' } },
  { id: 'c3', name: 'Someone Else', hierarchy: { level2Id: 'OTHER', level4Id: 'Z' } },
  { id: 'c4', name: 'Under a manager', hierarchy: { level2Id: 'S', level3Id: 'Y', level4Id: 'Z' } },
];
let plan = planLevelMove({ clients: fleet, personId: 'S', from: 2, to: 3, effectiveFrom: '2026-09' });
ok(plan.counts.moved === 2 && plan.counts.blocked === 1 && plan.counts.replaced === 0, 'two clients move, one is blocked (an L3 already sits there), the rest are untouched');
const m1 = plan.moves.find(m => m.id === 'c1');
ok(chainOf(m1.hierarchy) === '||S|Z|||', 'current chain: S at L3, L2 empty, L4 unchanged');
ok(m1.leadSourceLevel === 3, 'the lead-source level follows the person');
const c1 = { hierarchy: m1.hierarchy, hierarchyHistory: m1.hierarchyHistory };
ok(chainOf(hierarchyAsOf(c1, '2026-08')) === '|S||Z|||', 'August still has S at L2 (the old chain)');
const c1lead = { hierarchy: m1.hierarchy, hierarchyHistory: m1.hierarchyHistory, leadSourceLevel: m1.leadSourceLevel };
ok(chainAsOf(c1lead, '2026-08').leadSourceLevel === 2, 'August still pays the lead bonus at L2');
ok(chainAsOf(c1lead, '2026-09').leadSourceLevel === 3 && chainAsOf(c1lead, '2027-01').leadSourceLevel === 3, 'from September the lead bonus is at L3');
ok(chainOf(hierarchyAsOf(c1, '2026-09')) === '||S|Z|||', 'September has S at L3');
ok(chainOf(hierarchyAsOf(c1, '2027-03')) === '||S|Z|||', 'later months have S at L3');
ok(chainOf(hierarchyAsOf(c1, '2023-10')) === '|S||Z|||', 'the oldest months keep the old chain');
ok(plan.blocked[0].id === 'c4' && plan.blocked[0].heldBy === 'Y', 'the blocked client names who holds the slot');
ok(plan.moves.every(m => m.id !== 'c3'), 'a client with someone else at L2 is not touched');

// ── an occupied slot: keep (default) or replace ──────────────────────────────────
plan = planLevelMove({ clients: fleet, personId: 'S', from: 2, to: 3, effectiveFrom: '2026-09', occupied: 'replace' });
const m4 = plan.moves.find(m => m.id === 'c4');
ok(plan.counts.replaced === 1 && m4.status === 'replaced' && m4.replacedId === 'Y', 'replace puts S at L3 and removes the previous holder');
ok(chainOf(m4.hierarchy) === '||S|Z|||', 'after replacing: S at L3, Y gone, L4 unchanged');
const c4 = { hierarchy: m4.hierarchy, hierarchyHistory: m4.hierarchyHistory };
ok(chainOf(hierarchyAsOf(c4, '2026-08')) === '|S|Y|Z|||', "August keeps Y at L3 so Y's past earnings are not rewritten");

// ── "all months" is a correction: no history ─────────────────────────────────────
plan = planLevelMove({ clients: fleet, personId: 'S', from: 2, to: 3, effectiveFrom: '0000-01' });
ok(plan.moves[0].hierarchyHistory.length === 0, 'all-months: nothing is remembered, the chain simply changes');

// ── a second, later promotion stacks correctly ───────────────────────────────────
const afterFirst = { id: 'c1', name: 'Client One', hierarchy: m1.hierarchy, hierarchyHistory: m1.hierarchyHistory, leadSourceLevel: 3 };
plan = planLevelMove({ clients: [afterFirst], personId: 'S', from: 3, to: 4, effectiveFrom: '2027-01', occupied: 'replace' });
const m2 = plan.moves[0];
const c1b = { hierarchy: m2.hierarchy, hierarchyHistory: m2.hierarchyHistory };
ok(m2.hierarchyHistory.length === 2, 'two promotions leave two snapshots');
ok(chainOf(hierarchyAsOf(c1b, '2026-08')) === '|S||Z|||', 'Aug 2026: L2');
ok(chainOf(hierarchyAsOf(c1b, '2026-12')) === '||S|Z|||', 'Dec 2026: L3');
ok(chainOf(hierarchyAsOf(c1b, '2027-01')) === '|||S||||'.replace('|||S||||', '|||S|||'), 'Jan 2027: L4 (replacing Z)');

// ── correcting the month: undo, then redo from the right month ────────────────────
{
  const base = { id: 'c', name: 'C', hierarchy: { level2Id: 'S', level4Id: 'Z' } };
  const p1 = planLevelMove({ clients: [base], personId: 'S', from: 2, to: 3, effectiveFrom: '2026-09' }).moves[0];       // wrongly dated September
  const undo = planLevelMove({ clients: [{ ...base, hierarchy: p1.hierarchy, hierarchyHistory: p1.hierarchyHistory }], personId: 'S', from: 3, to: 2, effectiveFrom: '2026-09' }).moves[0];
  ok(undo.hierarchyHistory.length === 0, 'undoing the promotion in its own month clears the history');
  const redo = planLevelMove({ clients: [{ ...base, hierarchy: undo.hierarchy, hierarchyHistory: undo.hierarchyHistory }], personId: 'S', from: 2, to: 3, effectiveFrom: '2026-07' }).moves[0];
  const r = { hierarchy: redo.hierarchy, hierarchyHistory: redo.hierarchyHistory };
  ok(chainOf(hierarchyAsOf(r, '2026-06')) === '|S||Z|||', 'redone from July: June keeps L2');
  ok(chainOf(hierarchyAsOf(r, '2026-07')) === '||S|Z|||' && chainOf(hierarchyAsOf(r, '2026-08')) === '||S|Z|||', 'July and August are now L3');
}

// ── an older snapshot that clashes: report the client, never half-apply ────────────
{
  // P at L1, S at L2, Z at L4. S is promoted to L3 from September, then P is moved to L2 from July.
  const base = { id: 'c', name: 'C', hierarchy: { level1Id: 'P', level2Id: 'S', level4Id: 'Z' } };
  const s1 = planLevelMove({ clients: [base], personId: 'S', from: 2, to: 3, effectiveFrom: '2026-09' }).moves[0];
  const clash = planLevelMove({ clients: [{ ...base, hierarchy: s1.hierarchy, hierarchyHistory: s1.hierarchyHistory }], personId: 'P', from: 1, to: 2, effectiveFrom: '2026-07' });
  ok(clash.moves.length === 0 && clash.blocked.length === 1 && clash.blocked[0].heldBy === 'S', 'a clash with an older snapshot is reported and nothing is applied');
}

// ── promoting and then reversing in the same month leaves no trace ────────────────
plan = planLevelMove({ clients: [fleet[0]], personId: 'S', from: 2, to: 3, effectiveFrom: '2026-09' });
const up = plan.moves[0];
plan = planLevelMove({ clients: [{ ...fleet[0], hierarchy: up.hierarchy, hierarchyHistory: up.hierarchyHistory, leadSourceLevel: up.leadSourceLevel }], personId: 'S', from: 3, to: 2, effectiveFrom: '2026-09' });
ok(plan.moves[0].hierarchyHistory.length === 0, 'promote then undo in the same month: the history cancels out');
ok(chainOf(plan.moves[0].hierarchy) === '|S||Z|||', '... and the chain is back where it started');

// ── a manual edit of the current chain still takes effect from the promotion month ─
const edited = { hierarchy: { ...c1.hierarchy, level4Id: 'NEWBOSS' }, hierarchyHistory: c1.hierarchyHistory };
ok(slot(hierarchyAsOf(edited, '2026-10'), 4) === 'NEWBOSS', 'a manual edit applies to the months after the last promotion');
ok(slot(hierarchyAsOf(edited, '2026-08'), 4) === 'Z', 'and does not touch earlier months');

// ── nothing to do ────────────────────────────────────────────────────────────────
plan = planLevelMove({ clients: fleet, personId: 'NOBODY', from: 2, to: 3, effectiveFrom: '2026-09' });
ok(plan.moves.length === 0 && plan.counts.blocked === 0, 'a person with no clients at that level: an empty plan');

// ── inputs are never mutated ─────────────────────────────────────────────────────
ok(chainOf(fleet[0].hierarchy) === '|S||Z|||' && !fleet[0].hierarchyHistory, 'the planner does not change the clients it was given');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
