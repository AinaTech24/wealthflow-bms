// Tests for reading an AMC rate card that arrives as a spreadsheet.
//
//   node src/lib/amcSheet.test.mjs
import { parseRate, detectLayout, rowsFromGrid, layoutToNames, layoutFromNames, sheetSignature, inferCategory } from './amcSheet.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };

ok(parseRate('1.05%') === 1.05 && parseRate(' 0.30 % ') === 0.3 && parseRate(1.1) === 1.1 && parseRate('') === null && parseRate('NA') === null && parseRate('abc') === null, 'rates are read from %, plain numbers; blanks are not rates');

// 1. a title block above the header, a section line, percent strings, several rate columns (the Groww card, as a sheet)
const groww = [
  ['Commission Structure ARN-270604', '', '', ''],
  ['1st October 2026 to 31st October 2026', '', '', ''],
  ['Scheme Name', 'Trail 1st year', 'Trail 2nd & 3rd year', 'Trail 4th year onwards'],
  ['Equity Schemes', '', '', ''],
  ['Groww Large Cap Fund', '1.05%', '1.05%', '1.00%'],
  ['Groww Small Cap Fund', '1.00%', '1.00%', '0.95%'],
  ['Groww Nifty 50 Index Fund', '0.30%', '0.30%', '0.30%'],
  ['Groww Liquid Fund', '0.06%', '0.06%', '0.06%'],
];
let L = detectLayout(groww);
ok(L.headerRow === 2 && L.schemeCol === 0 && L.rateCol === 1 && L.unit === 'percent', 'header found under a title block; scheme column; first trail column; percent');
let { rows, skipped } = rowsFromGrid(groww, L, { amcName: 'Groww Mutual Fund', sourceFile: 'g.xlsx' });
ok(rows.length === 4 && rows[0].schemeName === 'Groww Large Cap Fund' && rows[0].trailRate === 1.05, 'four schemes, the section line is not one');
ok(rows[2].category === 'Index' && rows[3].category === 'Liquid' && rows[0].category === 'Equity', 'category is inferred from the scheme name');
ok(rows.every(r => r.amcName === 'Groww Mutual Fund' && r.sourceFile === 'g.xlsx'), 'AMC and file name are carried');
L = { ...L, rateCol: 3 };
ok(rowsFromGrid(groww, L).rows[0].trailRate === 1.0, 'another rate column can be chosen');

// 2. fractions (0.0105 = 1.05%)
const frac = [['Scheme', 'Trail'], ['Alpha Fund', 0.0105], ['Beta Fund', 0.0075]];
L = detectLayout(frac);
ok(L.unit === 'fraction', 'values all under 0.1 with no % sign are fractions');
rows = rowsFromGrid(frac, L).rows;
ok(rows[0].trailRate === 1.05 && rows[1].trailRate === 0.75, 'fractions become percent');

// 3. a category and an AMC column, no header words for the rate
const wide = [['AMC', 'Scheme Name', 'Category', 'Brokerage (%)'], ['XYZ MF', 'XYZ Bluechip Fund', 'Large Cap', '0.85'], ['XYZ MF', 'XYZ Gilt Fund', 'Debt', '0.40']];
L = detectLayout(wide);
rows = rowsFromGrid(wide, L, { amcName: 'ignored' }).rows;
ok(L.amcCol === 0 && L.categoryCol === 2 && L.rateCol === 3, 'amc, category and rate columns found by their headers');
ok(rows[0].amcName === 'XYZ MF' && rows[0].category === 'Large Cap' && rows[1].trailRate === 0.4, 'the sheet\'s own AMC and category win');

// 4. no header words at all: the longest text column is the scheme, the numeric one the rate
const bare = [['a', 'b'], ['Some Long Scheme Name Fund', '1.1'], ['Another Long Scheme Name Fund', '0.9'], ['Third Long Scheme Name Fund', '0.5']];
L = detectLayout(bare);
ok(L.schemeCol === 0 && L.rateCol === 1, 'with no recognisable headers the shape of the data decides');

// 5. remembering by header names, then applying to a sheet whose columns moved
const names = layoutToNames(groww, detectLayout(groww));
const moved = [['Notes', 'Scheme Name', 'Trail 1st year'], ['x', 'Groww Value Fund', '1.05%']];
const again = layoutFromNames(moved, names);
ok(again && again.schemeCol === 1 && again.rateCol === 2 && rowsFromGrid(moved, again).rows[0].trailRate === 1.05, 'a saved layout follows its header names when columns move');
ok(layoutFromNames([['Foo', 'Bar'], ['a', '1']], names) === null, 'a sheet without those headers is not matched');
ok(sheetSignature(groww, detectLayout(groww)).startsWith('scheme name|trail 1st year'), 'the signature is the header names');

// 6. junk
ok(rowsFromGrid([['Scheme', 'Rate'], ['Zero Fund', '0'], ['Neg Fund', '-1'], ['', '1.0']], detectLayout([['Scheme', 'Rate'], ['Zero Fund', '0'], ['Neg Fund', '-1'], ['', '1.0']])).rows.length === 0, 'zero, negative and nameless rows are dropped');
ok(inferCategory('XYZ Nifty 50 ETF') === 'ETF' && inferCategory('Corporate Bond Fund') === 'Debt' && inferCategory('Aggressive Hybrid Fund') === 'Hybrid', 'category rules');

console.log(`amcSheet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
