// Tests for planBranchRestructure.
//
//   node src/lib/branchRestructure.test.mjs
//
// The fixture is the MSA branch exactly as it stood in the 2 October snapshot:
// Manish Singh is L5, MSA FINANCIAL SERVICES LLP is the new L4 beneath him, 32
// clients carry Manish at L5 with the L4 slot empty, and two L3 RMs still report
// to Manish rather than to the LLP.
import { planBranchRestructure } from './branchRestructure.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };

const team = [
  { id: 'manish', name: 'MANISH SINGH', level: 5, parentId: 'house' },
  { id: 'llp', name: 'MSA FINANCIAL SERVICES LLP', level: 4, parentId: 'manish' },
  { id: 'msafs', name: 'MSA Financial Services', level: 3, parentId: 'manish' },
  { id: 'krittika', name: 'KRITTIKA DHARMENDRA GUPTA', level: 3, parentId: 'manish' },
  { id: 'shakeel', name: 'Shakeel Khan Mansuri', level: 2, parentId: 'llp' },   // already under the LLP
  { id: 'prem', name: 'PREM MANGTANI', level: 4, parentId: 'house' },
];
const mk = (n, h) => ({ id: `c${n}`, name: `Client ${n}`, hierarchy: h });
const clients = [
  ...Array.from({ length: 18 }, (_, i) => mk(i, { level3Id: 'msafs', level4Id: '', level5Id: 'manish' })),
  ...Array.from({ length: 7 },  (_, i) => mk(100 + i, { level2Id: 'shakeel', level4Id: '', level5Id: 'manish' })),
  mk(200, { level3Id: 'msafs', level4Id: 'prem', level5Id: 'manish' }),           // L4 already someone's
  mk(300, { level3Id: 'msafs', level4Id: 'llp', level5Id: 'manish' }),            // already correct
  mk(400, { level3Id: 'other', level4Id: 'prem', level5Id: '' }),                 // nothing to do with Manish
];

console.log('\nbranchRestructure — the MSA case');
const plan = planBranchRestructure({ clients, team, fromId: 'manish', toId: 'llp' });

ok(!plan.error, 'a valid request must not error');
ok(plan.slot === 'level4Id', 'the LLP is L4, so the slot filled is level4Id');
ok(plan.clientChanges.length === 25, `25 clients with an empty L4 get the LLP (got ${plan.clientChanges.length})`);
ok(plan.clientChanges.every(c => c.toId === 'llp' && c.slot === 'level4Id'), 'every change places the LLP at L4');

// Nobody else's decision is overwritten.
ok(plan.skipped.length === 1 && plan.skipped[0].id === 'c200' && plan.skipped[0].holder === 'prem',
   'a client whose L4 is already PREM is reported as skipped, not overwritten');
ok(!plan.clientChanges.some(c => c.id === 'c200'), 'the skipped client is not also changed');
ok(!plan.clientChanges.some(c => c.id === 'c300'), 'a client already under the LLP needs no change');
ok(!plan.clientChanges.some(c => c.id === 'c400'), 'a client with no link to Manish is left alone');

// The team: both L3 RMs follow, the LLP itself and existing reports do not move.
const moved = plan.teamChanges.map(t => t.id).sort();
ok(JSON.stringify(moved) === JSON.stringify(['krittika', 'msafs']), `both L3 RMs move under the LLP (got ${moved})`);
ok(!plan.teamChanges.some(t => t.id === 'llp'), 'the LLP must not be made to report to itself');
ok(!plan.teamChanges.some(t => t.id === 'shakeel'), 'someone already under the LLP is not touched');
ok(plan.teamChanges.every(t => t.toParent === 'llp'), 'every moved member reports to the LLP');

console.log('\nbranchRestructure — it must refuse nonsense');
ok(planBranchRestructure({ clients, team, fromId: 'manish', toId: 'manish' }).error, 'the same person twice is refused');
ok(planBranchRestructure({ clients, team, fromId: 'nobody', toId: 'llp' }).error, 'an unknown "from" is refused');
ok(planBranchRestructure({ clients, team, fromId: 'manish', toId: 'nobody' }).error, 'an unknown "to" is refused');

console.log('\nbranchRestructure — running it twice changes nothing the second time');
const after = clients.map(c => {
  const ch = plan.clientChanges.find(x => x.id === c.id);
  return ch ? { ...c, hierarchy: { ...c.hierarchy, [ch.slot]: ch.toId } } : c;
});
const afterTeam = team.map(t => (plan.teamChanges.some(x => x.id === t.id) ? { ...t, parentId: 'llp' } : t));
const again = planBranchRestructure({ clients: after, team: afterTeam, fromId: 'manish', toId: 'llp' });
ok(again.clientChanges.length === 0 && again.teamChanges.length === 0, 'a second run finds nothing left to do');
ok(again.skipped.length === 1, 'the one genuine conflict is still reported, not forgotten');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
