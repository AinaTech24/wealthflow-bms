// Tests for pickOwnerRecord.
//
//   node src/lib/folioOwner.test.mjs
//
// The fixture is Amit Parshotam Menghani as the 2 October snapshot held him: four
// records of one investor, two under Pankaj Dhameja and two under Mahek Chugh, all
// carrying the same folios. AdvisorKhoj splits him BY FOLIO between the two RMs, so
// the record that keeps a folio has to be one under the RM it is given to.
import { pickOwnerRecord } from './folioOwner.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };

const rec = (id, rm, nFolios, extra = {}) => ({
  id, folios: Array.from({ length: nFolios }, (_, i) => `f${i}`),
  hierarchy: { level3Id: rm, level4Id: 'prem', ...extra },
});
const amit = [
  rec('amit1', 'pankaj', 14),
  rec('amit2', 'pankaj', 14),
  rec('c_split', 'mahek', 13),
  rec('mqp3', 'mahek', 10),
];

console.log('\nfolioOwner — Amit, one folio at a time');
ok(pickOwnerRecord(amit, 'mahek')?.id === 'c_split', 'Mahek keeps it on her fuller record (13 folios, not 10)');
ok(['amit1', 'amit2'].includes(pickOwnerRecord(amit, 'pankaj')?.id), 'Pankaj keeps it on one of his records');
ok(pickOwnerRecord(amit, 'mahek')?.id !== 'amit1', 'giving it to Mahek never leaves it on a Pankaj record');

console.log('\nfolioOwner — it must be repeatable and safe');
ok(pickOwnerRecord(amit, 'pankaj')?.id === pickOwnerRecord([...amit].reverse(), 'pankaj')?.id,
   'the same record is chosen whatever order the records arrive in');
ok(pickOwnerRecord(amit, 'nobody') === null, 'an RM with no record claiming the folio gives null, not a guess');
ok(pickOwnerRecord([], 'mahek') === null, 'no claimants gives null');
ok(pickOwnerRecord(amit, '') === null, 'a blank RM gives null');

console.log('\nfolioOwner — an RM who is not at level 3');
// Pinky Srivastav is an L1; her clients carry her in the level-1 slot, not level 3.
const pinky = [
  { id: 'anjali', folios: ['a', 'b'], hierarchy: { level1Id: 'pinky', level3Id: 'varanasi', level4Id: 'freedom' } },
  { id: 'other', folios: ['a'], hierarchy: { level3Id: 'someoneelse' } },
];
ok(pickOwnerRecord(pinky, 'pinky')?.id === 'anjali', 'an RM found only in another slot can still own a folio');
ok(pickOwnerRecord(pinky, 'varanasi')?.id === 'anjali', 'level 3 is still found when it is the RM asked for');
// Level 3 wins over a mere mention in another slot.
const both = [
  { id: 'asBM', folios: Array(20).fill('x'), hierarchy: { level4Id: 'p' } },
  { id: 'asRM', folios: ['x'], hierarchy: { level3Id: 'p' } },
];
ok(pickOwnerRecord(both, 'p')?.id === 'asRM', 'a record where they are the RM beats a fuller one where they only sit above');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
