// Tests for reading the date column of a partner statement.
//
//   node src/lib/tradeDate.test.mjs
import { parseTradeDate, detectDateOrder, monthOfDate, findDateColumn } from './tradeDate.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };

// ── the layouts a sheet reader can hand over for the same day ──
const SEP1 = '2026-09-01';
for (const [raw, want] of [
  ['01 Sep 2026', SEP1], ['1 Sep 2026', SEP1], ['01 September 2026', SEP1], ['01-Sep-2026', SEP1], ['01-Sep-26', SEP1],
  ['1/Sep/2026', SEP1], ['01.Sep.2026', SEP1], ['Sep 1, 2026', SEP1], ['September 1 2026', SEP1],
  ['2026-09-01', SEP1], ['2026/09/01', SEP1], ['2026-09-01 00:00:00', SEP1], ['2026-09-01T10:30:00Z', SEP1],
  ['1st Sep 2026', SEP1], ['Sep 1st, 2026', SEP1], ['Tuesday, 01 Sep 2026', SEP1], ['Tue 01-Sep-2026', SEP1], ['Sept 1 2026', SEP1],
  ['01/09/2026', SEP1], ['01-09-2026', SEP1], ['1/9/2026', SEP1], ['01/09/2026 10:30:15', SEP1], ['01/09/2026 10:30 PM', SEP1],
]) ok(parseTradeDate(raw) === want, `${raw} reads as ${want}`);

// Excel serial 46266 = 2026-09-01
const serial = Math.round((Date.UTC(2026, 8, 1) - Date.UTC(1899, 11, 30)) / 86400000);
ok(parseTradeDate(String(serial)) === SEP1, `Excel serial ${serial} reads as 1 Sep 2026`);

// ── all-numeric dates depend on the order the column is written in ──
ok(parseTradeDate('9/1/26', 'mdy') === SEP1, '9/1/26 month-first is 1 Sep');
ok(parseTradeDate('9/1/26', 'dmy') === '2026-01-09', '9/1/26 day-first is 9 Jan');
ok(parseTradeDate('13/1/26', 'mdy') === '2026-01-13', 'a 13 can only be a day, so it is read day-first even when month-first was expected');
ok(parseTradeDate('1/13/26', 'dmy') === '2026-01-13', '...and the other way round');

ok(detectDateOrder(['13/09/2026', '01/09/2026']) === 'dmy', 'a first part above 12 proves day-first');
ok(detectDateOrder(['9/13/26', '9/1/26']) === 'mdy', 'a second part above 12 proves month-first');
ok(detectDateOrder(['9/1/26', '9/2/26', '9/30/26']) === 'mdy', 'short slashed years from a spreadsheet are month-first (30 proves it)');
ok(detectDateOrder(['9/1/26', '9/2/26']) === 'mdy', 'nothing decisive, all short slashed years: the sheet reader prints month-first');
ok(detectDateOrder(['01/09/2026', '02/09/2026']) === 'dmy', 'nothing decisive, 4-digit years: day-first, the way Indian dates are typed');
ok(detectDateOrder(['01-09-26', '02-09-26']) === 'dmy', 'nothing decisive, dashed short years: day-first');
ok(detectDateOrder(['01 Sep 2026', '']) === 'dmy', 'named months do not influence the order');

// ── things that are not dates stay unread rather than guessed ──
for (const raw of ['', null, undefined, 'abc', '31/02/2026', '2026-13-01', '00/00/0000', '12345678', '1995-01-01', 'Total', '1,25,000.50', '4']) {
  ok(parseTradeDate(raw) === null, `${JSON.stringify(raw)} is not a date`);
}
ok(parseTradeDate('99999') === null && parseTradeDate('100') === null, 'a plain amount is not an Excel date');

ok(monthOfDate('01-Sep-26') === '2026-09' && monthOfDate('30 Oct 2026') === '2026-10' && monthOfDate('nope') === null, 'monthOfDate');

// ── finding the date column by what is in it ──
const grid = [
  ['Client Code', 'Segment', 'Settle', 'Total Brok', 'Parent Sharing'],
  ['A100', 'EQ', '9/1/26', '120.50', '60.25'],
  ['A200', 'EQ', '9/2/26', '99000', '10.00'],
  ['A300', 'FO', '9/30/26', '55.00', '20.00'],
];
const f = findDateColumn(grid);
ok(f && f.index === 2 && f.order === 'mdy', 'the date column is found by content when its header says nothing');

const hinted = [
  ['Code', 'Booking Ref', 'Trade Date', 'Amount'],
  ['A1', '45001', '01-Sep-2026', '10'],
  ['A2', '45002', '02-Sep-2026', '20'],
];
ok(findDateColumn(hinted)?.index === 2, 'a header that says date wins over a column of 5-digit references');
ok(findDateColumn([['Code', 'Ref', 'Amount'], ['A1', '45001', '10'], ['A2', '45002', '20']]) === null, 'five-digit codes with no date header are not dates');
ok(findDateColumn([['Code', 'Trade Date'], ['A1', '01 Sep 2026'], ['A2', 'junk'], ['A3', 'junk']]) === null, 'a column that is mostly not dates is not the date column');
ok(findDateColumn([['Code', 'Amount'], ['A1', '10']]) === null, 'no date column at all');

console.log(`tradeDate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
