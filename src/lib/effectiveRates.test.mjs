// Regression tests for effective-dated rates (memberAsOf).
//
//   node src/lib/effectiveRates.test.mjs
//
// WHY THIS EXISTS
// Re-grading an RM used to rewrite EVERY historical month at the new rate. On
// 2026-08-04 moving one RM from L2@25% to L3@35% silently restated Nov-2025 ..
// Jun-2026 from 50% to 60% of gross — months that had already been reported and
// in some cases invoiced. A promotion must apply from its effective month
// FORWARD and leave settled history alone.
//
// memberAsOf() is duplicated verbatim in server.js, recalcRun.js and (as
// teamGet) calculationService.ts because those files cannot share a module.
// If you change one, change all four AND re-run this file.

// ── the implementation under test (keep byte-identical to server.js) ────────
function memberAsOf(info, period) {
  if (!info) return info;
  const hist = info.rateHistory;
  if (!Array.isArray(hist) || hist.length === 0 || !period) return info;
  const p = String(period);
  let inForce = null, earliest = null;
  for (const h of hist) {
    if (!h || !h.effectiveFrom) continue;
    const ef = String(h.effectiveFrom);
    if (!earliest || ef < String(earliest.effectiveFrom)) earliest = h;
    if (ef <= p && (!inForce || ef > String(inForce.effectiveFrom))) inForce = h;
  }
  const pick = inForce || earliest;
  if (!pick) return info;
  return {
    level: (pick.level !== undefined && pick.level !== null) ? Number(pick.level) : info.level,
    customLevels: pick.customLevels || info.customLevels,
    rateHistory: hist,
  };
}

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  console.log(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  fail++;
};

console.log('effective-dated rate tests\n');

// The real Shakeel Khan Mansuri case that exposed the bug.
const shakeel = {
  level: 3,
  customLevels: { 2: 25, 3: 35 },
  rateHistory: [
    { effectiveFrom: '0000-01', level: 2, customLevels: { 2: 25, 3: 25 } },
    { effectiveFrom: '2026-08', level: 3, customLevels: { 2: 25, 3: 35 } },
  ],
};

// Months BEFORE the promotion keep the old level and old rate.
eq('2026-06 level',  memberAsOf(shakeel, '2026-06').level, 2);
eq('2026-06 rate',   memberAsOf(shakeel, '2026-06').customLevels, { 2: 25, 3: 25 });
eq('2025-11 rate',   memberAsOf(shakeel, '2025-11').customLevels, { 2: 25, 3: 25 });
// The effective month itself is INCLUSIVE — the new rate starts here.
eq('2026-08 level',  memberAsOf(shakeel, '2026-08').level, 3);
eq('2026-08 rate',   memberAsOf(shakeel, '2026-08').customLevels, { 2: 25, 3: 35 });
eq('2026-12 level',  memberAsOf(shakeel, '2026-12').level, 3);

// A member who has never been re-graded is untouched — this is what makes the
// change safe to deploy against 180+ existing members with no rateHistory.
const plain = { level: 4, customLevels: { 4: 5 } };
eq('no history',     memberAsOf(plain, '2026-06'), plain);
eq('null member',    memberAsOf(null, '2026-06'), null);
eq('empty history',  memberAsOf({ level: 1, rateHistory: [] }, '2026-06').level, 1);

// A missing period must NOT silently fall through to today's rate — that is the
// original bug. Callers that cannot supply a period get current values, so the
// engines are wired to always pass brokeragePeriod.
eq('no period',      memberAsOf(shakeel, undefined).level, 3);

// Out-of-order and multi-step timelines resolve by date, not array position.
const zigzag = {
  level: 5,
  customLevels: { 5: 10 },
  rateHistory: [
    { effectiveFrom: '2026-05', level: 3, customLevels: { 3: 30 } },
    { effectiveFrom: '0000-01', level: 1, customLevels: { 1: 15 } },
    { effectiveFrom: '2026-09', level: 5, customLevels: { 5: 10 } },
  ],
};
eq('zigzag 2026-01', memberAsOf(zigzag, '2026-01').level, 1);
eq('zigzag 2026-05', memberAsOf(zigzag, '2026-05').level, 3);
eq('zigzag 2026-07', memberAsOf(zigzag, '2026-07').level, 3);
eq('zigzag 2026-09', memberAsOf(zigzag, '2026-09').level, 5);

// A period older than every entry uses the EARLIEST rate, never the current one.
const late = {
  level: 2,
  customLevels: { 2: 40 },
  rateHistory: [{ effectiveFrom: '2026-03', level: 2, customLevels: { 2: 40 } }],
};
eq('pre-history',    memberAsOf(late, '2025-01').customLevels, { 2: 40 });

// String comparison on 'YYYY-MM' must order correctly across year boundaries.
eq('year boundary',  memberAsOf(zigzag, '2025-12').level, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
