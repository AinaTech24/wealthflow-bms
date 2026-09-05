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
import { extractBrokerageRowsFromText } from './brokerageExtractor.js';

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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
