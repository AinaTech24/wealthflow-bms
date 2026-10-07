// Regression tests for the brokerage-structure parser.
//
//   node src/lib/extractor.test.mjs
//
// WHY THIS EXISTS
// The parser silently dropped "Bajaj FinServ Balance Advantage Fund" for months:
// a boilerplate stripper cut every scheme name at the word "balance", and because
// the sibling schemes parsed fine nothing looked wrong. Missing schemes were only
// found by reading the PDF by hand. Each case below is a shape that has broken (or
// could plausibly break) in production — run this before shipping any change to
// brokerageExtractor.js. A scheme that must parse, and boilerplate that must NOT.
import { extractBrokerageRowsFromText, extractTenureGridRows, looksLikeScheme } from './brokerageExtractor.js';

let pass = 0, fail = 0;

/** A line that MUST yield a scheme, optionally asserting name fragment + rate. */
const shouldParse = (line, { amc = 'Test', nameHas, rate } = {}) => {
  const rows = extractBrokerageRowsFromText(line, amc, 'test.pdf');
  if (!rows.length) { console.log(`  FAIL  no row parsed: "${line}"`); fail++; return; }
  const r = rows[0];
  if (nameHas && !r.schemeName.toLowerCase().includes(nameHas.toLowerCase())) {
    console.log(`  FAIL  name "${r.schemeName}" missing "${nameHas}"  <- "${line}"`); fail++; return;
  }
  if (rate !== undefined && Math.abs(Number(r.trailRate) - rate) > 0.001) {
    console.log(`  FAIL  rate ${r.trailRate} != ${rate}  <- "${line}"`); fail++; return;
  }
  pass++;
};

/** A line that must NOT be treated as a scheme (headers, notes, exit-load text). */
const shouldSkip = (line, amc = 'Test') => {
  const rows = extractBrokerageRowsFromText(line, amc, 'test.pdf');
  if (rows.length) { console.log(`  FAIL  should NOT have parsed: "${line}" -> "${rows[0].schemeName}"`); fail++; return; }
  pass++;
};

console.log('brokerageExtractor regression tests\n');

// ── The "balance" truncation bug (real production miss) ────────────────────
shouldParse('Bajaj FinServ Balance Advantage Fund1.151.35', { nameHas: 'Balance Advantage', rate: 1.15 });
shouldParse('HDFC Balanced Advantage Fund1.101.30',         { nameHas: 'Balanced Advantage', rate: 1.10 });
shouldParse('ICICI Prudential Balanced Advantage Fund 1.25', { nameHas: 'Balanced Advantage' });

// ── Concatenated name+rate (Bajaj/Axis style, no separator) ────────────────
shouldParse('Bajaj FinServ ELSS Fund1.321.55',       { nameHas: 'ELSS', rate: 1.32 });
shouldParse('Bajaj FinServ Large Cap Fund1.151.35',  { nameHas: 'Large Cap', rate: 1.15 });

// ── Ordinary spaced rows ───────────────────────────────────────────────────
shouldParse('SBI Bluechip Fund 1.05',        { nameHas: 'Bluechip' });
// Note: the parser standardises "Flexicap" -> "FLEXI CAP", so assert the stem.
shouldParse('Kotak Flexicap Fund   0.85 %',  { nameHas: 'Flexi' });

// ── Junk names must never be produced ──────────────────────────────────────
// 25 rows had reached the database with the CATEGORY column glued onto the
// scheme name, a table header leaked in, or a phrase repeated. Whatever a row
// parses to, the NAME itself must be clean.
const nameMustBeClean = (line, amc = 'Test') => {
  const rows = extractBrokerageRowsFromText(line, amc, 'test.pdf');
  for (const r of rows) {
    const s = String(r.schemeName || '');
    const problems = [];
    if (/([A-Za-z]{5,})\1/i.test(s.replace(/\s+/g, ''))) problems.push('doubled substring');
    if (/\b(EQUITY|DEBT|HYBRID|LIQUID)(EQUITY|DEBT|HYBRID|LIQUID|CORE)/i.test(s)) problems.push('category glued twice');
    if (/^(sr\.?\s*no|duration|category|scheme name|slab|total)\b/i.test(s)) problems.push('header prefix');
    if (/\s-\s*\d+\s*$/.test(s)) problems.push('trailing sequence number');
    if (problems.length) { console.log(`  FAIL  junk name "${s}" [${problems.join(', ')}]  <- "${line}"`); fail++; return; }
  }
  pass++;
};

nameMustBeClean('ADITYA BIRLA SUN LIFE MULTI-ASSET OMNI FOF EQUITYEQUITY - 2 0.80');
nameMustBeClean('ADITYA BIRLA SUN LIFE CRISIL IBX GILT APRIL 2033 INDEX FUND-DEBTDEBT - 1 0.12');
nameMustBeClean('Sr No Duration Bajaj Fin Serv ELSS Fund 1.32');
nameMustBeClean('Bandhan Banking and PSU Fund Banking and PSU Fund 0.25');

// ── Must NOT parse: boilerplate the stripper legitimately removes ──────────
shouldSkip('Some Fund on the balance units 1.20');
shouldSkip('Exit load 1.00% if redeemed within 12 months');
shouldSkip('Scheme Name Trail (%)');
shouldSkip('Total T30 Payout 1.50');

// ── Exit load on the SAME line as the scheme and its rates ─────────────────
// isNoiseLine() drops any line mentioning an exit load next to a number. That is
// right for a standalone note, but several AMCs put the scheme, its exit load and
// its trail rates all on one line — and the whole row went. Edelweiss lost every
// scheme it has this way; Canara lost seven.
shouldParse('Edelweiss Multi cap Fund Exit load of 1% if redeemed within 90 Days 0.98% 0.98% 0.98%',
  { nameHas: 'Multi cap', rate: 0.98 });
shouldParse('Edelweiss Altiva Hybrid Long-Short Fund Exit load of 0.50% if redeemed within 30 Days 0.60% 0.60% 0.60%',
  { nameHas: 'Long-Short', rate: 0.60 });
// The clause can end in "thereafter Nil" before the rates resume.
shouldParse('Edelweiss Silver ETF Fund of Fund Exit load of 0.10% if redeemed within 15 Days, thereafter Nil 0.35% 0.35%',
  { nameHas: 'Silver', rate: 0.35 });
// Canara writes the load with no "exit load" words at all — just a rate, a
// redemption condition, and the trail glued on after "allotment".
shouldParse('Canara Robeco Value Fund1.00% - if redeemed/switched out within 365 days from the date of allotment.1.25 1.25',
  { nameHas: 'Value Fund', rate: 1.25 });
shouldParse('Canara Robeco Small Cap Fund1.00% if redeemed / switched-out within 1 year from the date of allotment. 0.90 0.90',
  { nameHas: 'Small Cap', rate: 0.90 });
// A line that is ONLY an exit-load note has no trailing rates, so nothing is cut
// and it is still discarded.
shouldSkip('Exit load 1.00% if redeemed within 12 months');
shouldSkip('1% if redeemed or switched out within 365 days from the date of allotment');

// ── "Balanced <something> Fund" is a scheme, not boilerplate ───────────────
// The stripper cuts a name at "balance/balanced" to kill "… on the balance units".
// It exempted "Balanced Advantage" only, so "Balanced Hybrid Fund" — a real SEBI
// category — was truncated to the brand alone and then dropped as too short.
shouldParse('Hybrid360 ONE Balanced Hybrid Fund0.80%', { nameHas: 'Balanced Hybrid', rate: 0.80 });
shouldParse('Kotak Balanced Hybrid Fund 0.95%', { nameHas: 'Balanced Hybrid', rate: 0.95 });
shouldParse('HDFC Balanced Advantage Fund 1.10%', { nameHas: 'Balanced Advantage', rate: 1.10 });
shouldSkip('Some Fund on the balance units 1.20');


// ── Basis-point tables (Motilal Oswal) ────────────────────────────────────
// The whole structure is bare integers in bps: "70 13 83" = Trail, GST, Total.
// extractPercentages() needs a "%" or a decimal point, so every one of these
// rows scored zero rates and the upload came back empty with no error. The bps
// reader only engages when the document says "bps", and only trusts a trailing
// run of integers whose every (Trail, GST, Total) triplet balances.
const BPS_HEADER = 'Trail commission (in bps per annum)\n';
const bpsParse = (line, opts) => shouldParse(BPS_HEADER + line, opts);
const bpsSkip = (line) => shouldSkip(BPS_HEADER + line);

// One tenure band, three bands, and the "Total 3 Year Payout" tail that must
// never be mistaken for the rate (213 bps would read as 2.13%).
bpsParse('Motilal Oswal Flexi Cap Fund 70 13 83 70 13 83 210 39 249', { nameHas: 'Flexi Cap', rate: 0.70 });
bpsParse('Motilal Oswal Large and Midcap Fund 71 13 84 71 13 84 213 39 252', { rate: 0.71 });
bpsParse('Motilal Oswal Arbitrage Fund 90 16 106 50 9 59', { nameHas: 'Arbitrage', rate: 0.90 });
bpsParse('Motilal Oswal Liquid Fund 15 3 18 15 3 18 45 9 54', { nameHas: 'Liquid', rate: 0.15 });
// Sub-1-bps-per-column rows still have to survive the balance check (7+1=8).
bpsParse('Motilal Oswal 5 Year G-Sec Fund of Fund 7 1 8 7 1 8 21 3 24', { rate: 0.07 });
// Digits INSIDE the scheme name must not be read as rates — they are followed
// by words, so they never land in the trailing run.
bpsParse('Motilal Oswal Nifty 500 Index Fund 70 13 83 70 13 83 210 39 249', { nameHas: '500', rate: 0.70 });
bpsParse('Motilal Oswal Nifty 200 Momentum 30 Index Fund 64 12 76 64 12 76 192 36 228', { rate: 0.64 });
// Column padding from the PASSIVE table survives normalizeSpaces().
bpsParse('Motilal Oswal Nifty Bank Index Fund 74   13   87 74   13   87 222 39 261', { rate: 0.74 });

// Guards. A trailing run that does not balance is not a rate table, and a
// document with no "bps" anywhere must never have bare integers read as rates.
bpsSkip('Motilal Oswal Random Fund 70 13 99 70 13 99');
bpsSkip('Motilal Oswal Partial Fund 70 13');
shouldSkip('Motilal Oswal Flexi Cap Fund 70 13 83 70 13 83 210 39 249');
// 600 bps = 6% p.a., past the 5% ceiling extractPercentages() enforces.
bpsSkip('Motilal Oswal Impossible Fund 600 108 708');



// ── Tenure-grid cards (qsif) ────────────────────────────────────────────────
// Verbatim from qsif.pdf as pdf-parse reads it: the scheme name over three
// lines, then a row per holding period carrying nine figures — three AUM slabs
// times (without GST, GST, total). The ordinals arrive in pieces, "1" / "st" /
// "Year 0.97 …", which is why the line reader found three fragments in a
// five-scheme card and offered "Long Short Fund qsif Equity Ex-Top Fund (".
const QSIF = `Category BASE PLUS BASE OPEN
Investment
Strategy
Period
Without
GST
GST
Amt
Total
qsif Equity
Long Short Fund
(Equity)
1
st
 Year 0.97 0.18 1.15 0.78 0.14 0.92 0.63 0.11 0.74
2
nd
 Years 0.97 0.18 1.15 0.78 0.14 0.92 0.63 0.11 0.74
3
rd
 Years
onwards*
0.89 0.16 1.05 0.69 0.13 0.82 0.54 0.10 0.64
qsif Equity Ex-Top
100 Long Short
Fund (Equity)
1
st
 Year 1.23 0.22 1.45 0.98 0.18 1.16 0.80 0.14 0.94
2
nd
 Years 1.23 0.22 1.45 0.98 0.18 1.16 0.80 0.14 0.94
3
rd
 Years
onwards*
1.14 0.21 1.35 0.90 0.16 1.06 0.71 0.13 0.84
qsif Hybrid
Long Short Fund
(Hybrid)
1
st
 Year 1.06 0.19 1.25 0.85 0.15 1.00 0.68 0.12 0.80
2
nd
 Years 1.06 0.19 1.25 0.85 0.15 1.00 0.68 0.12 0.80
3
rd
 Years
onwards*
0.97 0.18 1.15 0.76 0.14 0.9 0.59 0.11 0.70`;

{
  const rows = extractTenureGridRows(QSIF, 'QSIF', 'qsif.pdf');
  const want = [
    ['qsif equity long short fund', 0.97, 'Equity'],
    ['ex-top', 1.23, 'Equity'],
    ['qsif hybrid long short fund', 1.06, 'Hybrid'],
  ];
  if (rows.length !== want.length) {
    console.log(`  FAIL  tenure grid: ${rows.length} rows, expected ${want.length}`);
    for (const r of rows) console.log(`        got ${r.trailRate}% ${r.schemeName}`);
    fail++;
  } else {
    let ok = true;
    want.forEach(([frag, rate, cat], i) => {
      const r = rows[i];
      if (!r.schemeName.toLowerCase().includes(frag)) {
        console.log(`  FAIL  tenure grid row ${i}: "${r.schemeName}" missing "${frag}"`); ok = false;
      } else if (Math.abs(r.trailRate - rate) > 0.001) {
        console.log(`  FAIL  tenure grid row ${i}: rate ${r.trailRate} != ${rate}`); ok = false;
      } else if (r.category !== cat) {
        console.log(`  FAIL  tenure grid row ${i}: category ${r.category} != ${cat}`); ok = false;
      }
    });
    ok ? pass++ : fail++;
  }

  // The FIRST tenure's FIRST slab is the rate — never a later year, and never
  // the GST-inclusive total sitting beside it.
  const r0 = rows[0];
  if (r0 && (r0.trailRate === 0.89 || r0.trailRate === 1.15)) {
    console.log(`  FAIL  tenure grid took ${r0.trailRate} — that is a later year or the GST-inclusive total`); fail++;
  } else pass++;

  // A trailing "(Equity)" must not survive on some names and not others, or one
  // scheme files itself under two keys in the master.
  if (rows.some(r => /\((equity|hybrid|debt)\)\s*$/i.test(r.schemeName))) {
    console.log('  FAIL  tenure grid left an asset-class suffix on a scheme name'); fail++;
  } else pass++;
}

// One scheme priced over a grid is a coincidence, not this layout — the reader
// must stand aside so a better-suited one wins.
{
  const ONE = `Some Fund\n(Equity)\n1\nst\n Year 0.97 0.18 1.15`;
  if (extractTenureGridRows(ONE, 'X', 't.pdf').length !== 0) {
    console.log('  FAIL  tenure grid claimed a single-scheme document'); fail++;
  } else pass++;
}

// A card's footer and SEBI registration line must never be stored as a scheme.
for (const n of ['THE WEALTH COMPANY Flexi Cap Fund', 'Nippon India ETF Nifty BeES', 'HDFC ELSS Tax Saver', 'Axis Bluechip Fund', 'Kotak Nifty 50 Index Fund', 'SBI Liquid Fund']) {
  if (looksLikeScheme(n)) pass++; else { console.log('  FAIL  should keep ' + n); fail++; }
}
for (const n of ['Mutual Fundsaresubjecttomarketrisks For Mode- oftheamountoft', 'THE WEALTH COMPANY Mutual Fund -SEBI Regn.No:MF', 'Flexi Cap Fund Rs.2 lakh application', 'Fund']) {
  if (!looksLikeScheme(n)) pass++; else { console.log('  FAIL  should drop ' + n); fail++; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

