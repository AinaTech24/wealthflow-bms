// Tests for the monthly RTA file checklist.
//
//   node src/lib/rtaChecklist.test.mjs
import { buildChecklist, fileKeyOf, prevPeriod } from './rtaChecklist.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const f = (period, key, rows = 10) => ({ period, key, rows, gross: 100 });
const st = (m, key) => m.files.find(x => x.key === key).status;

ok(fileKeyOf({ source: 'CAMS', sif: 0 }) === 'CAMS' && fileKeyOf({ source: 'CAMS', sif: 1 }) === 'SIF', 'a CAMS row is the SIF file only when it is flagged SIF');
ok(fileKeyOf({ source: 'KARVY' }) === 'KFIN' && fileKeyOf({ source: 'KFINTECH' }) === 'KFIN', 'both Kfin spellings are the Kfin brokerage file');
ok(fileKeyOf({ source: 'CAMS_WBR2' }) === 'WBR2' && fileKeyOf({ source: 'KARVY_MFSD201' }) === 'MFSD201' && fileKeyOf({ source: 'X' }) === null, 'transaction files and unknown sources');
ok(prevPeriod('2026-01') === '2025-12' && prevPeriod('2026-09') === '2026-08', 'previous month, across a year end');

// September: everything but the SIF file, which August had (the real case)
const found = [
  f('2026-07', 'WBR2'), f('2026-07', 'MFSD201'), f('2026-07', 'CAMS'), f('2026-07', 'KFIN'), f('2026-07', 'SIF', 1),
  f('2026-08', 'WBR2'), f('2026-08', 'MFSD201'), f('2026-08', 'CAMS'), f('2026-08', 'KFIN'), f('2026-08', 'SIF', 1),
  f('2026-09', 'WBR2'), f('2026-09', 'MFSD201'), f('2026-09', 'CAMS'), f('2026-09', 'KFIN'),
];
let m = buildChecklist({ found, logged: [], periods: ['2026-07', '2026-08', '2026-09'] });
const sep = m[2];
ok(sep.started && st(sep, 'SIF') === 'missing' && eq(sep.missing, ['SIF']), 'September: only the SIF file is missing');
ok(st(sep, 'WBR9') === 'unverified' && st(sep, 'MFSD211') === 'unverified', 'folio masters never logged are unverified, not missing');
ok(eq(m[1].missing, []), 'August is complete');
ok(st(m[0], 'WBR2') === 'done' && m[0].files.find(x => x.key === 'WBR2').rows === 10, 'a found file carries its row count');

// a file never seen before is not expected (a month from before WBR2 was part of the routine)
m = buildChecklist({ found: [f('2026-04', 'CAMS'), f('2026-05', 'CAMS'), f('2026-05', 'WBR2')], logged: [], periods: ['2026-04', '2026-05'] });
ok(st(m[0], 'WBR2') === 'not_expected' && st(m[1], 'WBR2') === 'done', 'a file is expected only after it has been imported once');
ok(st(m[0], 'KFIN') === 'not_expected', 'Kfin never imported yet: not expected');

// SIF: expected only when one of the last three months had it
m = buildChecklist({ found: [f('2026-03', 'SIF', 1), f('2026-04', 'CAMS'), f('2026-05', 'CAMS'), f('2026-06', 'CAMS'), f('2026-07', 'CAMS')], logged: [], periods: ['2026-04', '2026-06', '2026-07'] });
ok(st(m[0], 'SIF') === 'missing' && st(m[1], 'SIF') === 'missing', 'SIF seen one to three months back is expected');
ok(st(m[2], 'SIF') === 'not_expected', 'SIF four months back is no longer expected');

// folio masters: logged months are done, later months without a log are missing, earlier ones unverified
m = buildChecklist({ found: [f('2026-09', 'CAMS'), f('2026-10', 'CAMS'), f('2026-11', 'CAMS')], logged: [{ period: '2026-10', key: 'WBR9', fileName: 'wbr9.xls', rows: 50 }], periods: ['2026-09', '2026-10', '2026-11'] });
ok(st(m[0], 'WBR9') === 'unverified' && st(m[1], 'WBR9') === 'done' && st(m[2], 'WBR9') === 'missing', 'folio master: before the log unverified, logged done, after it missing');
ok(m[1].files.find(x => x.key === 'WBR9').fileName === 'wbr9.xls', 'a logged master carries its file name');
ok(st(m[2], 'MFSD211') === 'unverified', 'the other master was never logged, so still unverified');

// a month with nothing imported is not "started"
m = buildChecklist({ found: [f('2026-09', 'CAMS')], logged: [], periods: ['2026-09', '2026-10'] });
ok(m[0].started && !m[1].started, 'a month with no files has not started');

console.log(`rtaChecklist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
