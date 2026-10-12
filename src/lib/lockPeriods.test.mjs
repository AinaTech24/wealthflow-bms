// Tests for monthsToLock and mergeLocks.
//
//   node src/lib/lockPeriods.test.mjs
import { monthsToLock, mergeLocks } from './lockPeriods.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const have = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
ok(eq(monthsToLock('2026-08', have, ['2026-02', '2026-03']), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08']),
  'lock through August: every month with data up to August that is not already locked');
ok(eq(monthsToLock('2026-06', have, []), ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06']), 'a middle month stops the list there');
ok(eq(monthsToLock('2026-08', have, have), []), 'nothing new when everything is already locked');
ok(eq(monthsToLock('2026-12', have, []), have), 'a month beyond the data locks only what exists');
ok(eq(monthsToLock('2025-01', have, []), []), 'before all data: nothing');
ok(eq(monthsToLock('soon', have, []), []) && eq(monthsToLock(undefined, have, []), []), 'a malformed month locks nothing');
ok(eq(monthsToLock('2026-08', ['2026-08', '2026-08', 'junk', '2026-07'], []), ['2026-07', '2026-08']), 'duplicates and junk are ignored');

// a save can add but never remove
ok(eq(mergeLocks(['2026-03', '2026-04'], ['2026-03']), ['2026-03', '2026-04']), 'a stale tab sending a shorter list does not unlock April');
ok(eq(mergeLocks(['2026-03'], ['2026-03', '2026-04']), ['2026-03', '2026-04']), 'a save can add a lock');
ok(eq(mergeLocks(undefined, undefined), []) && eq(mergeLocks(null, ['2026-01']), ['2026-01']), 'missing lists are handled');
ok(eq(mergeLocks(['2026-04', '2026-03'], ['2026-03', 'x', 7]), ['2026-03', '2026-04']), 'sorted, de-duplicated, junk dropped');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
