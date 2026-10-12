// Tests for scopePayoutOverview.
//
//   node src/lib/payoutScope.test.mjs
import { scopePayoutOverview } from './payoutScope.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };

const body = {
  generatedAt: '2026-10-12T00:00:00Z',
  periods: ['2026-07', '2026-08'],
  sources: ['MF', 'MOFSL'],
  people: [
    { userId: 'rm1', name: 'RM One', months: [{ period: '2026-08', earned: 100 }] },
    { userId: 'bm1', name: 'BM One', months: [{ period: '2026-08', earned: 400 }] },
    { userId: 'rm2', name: 'RM Two', months: [{ period: '2026-08', earned: 50 }] },
  ],
};

// ADMIN / FINANCE read everything, unchanged.
const all = scopePayoutOverview(body, { id: 'fin' }, true);
ok(all === body, 'a writer gets the body untouched');
ok(all.people.length === 3, 'a writer sees all three people');

// An RM sees only their own row.
const rm = scopePayoutOverview(body, { id: 'rm1' }, false);
ok(rm.people.length === 1 && rm.people[0].userId === 'rm1', 'an RM sees only their own row');
ok(!JSON.stringify(rm).includes('RM Two') && !JSON.stringify(rm).includes('BM One'), "no colleague's name or figures leak");
ok(rm.periods === body.periods && rm.sources === body.sources, 'the month and product lists stay, so the filters work');

// A BM likewise: their row, not the RMs under them.
const bm = scopePayoutOverview(body, { id: 'bm1' }, false);
ok(bm.people.length === 1 && bm.people[0].userId === 'bm1', 'a BM sees only their own row');

// Someone with no earnings gets an empty list, not the firm.
const none = scopePayoutOverview(body, { id: 'nobody' }, false);
ok(none.people.length === 0, 'a member with no earnings gets an empty list');

// No identity at all must never fall through to "everything".
ok(scopePayoutOverview(body, null, false).people.length === 0, 'no user means no rows');
ok(scopePayoutOverview(body, {}, false).people.length === 0, 'a user without an id means no rows');

// The cached body must not be altered by scoping.
ok(body.people.length === 3, 'the shared cached body is not mutated');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
