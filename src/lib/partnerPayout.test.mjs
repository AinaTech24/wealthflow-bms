// Tests for the pure part of the partner (Motilal) payout: it must be the mutual-fund split.
//
//   node src/lib/partnerPayout.test.mjs
import { partnerShares } from './partnerPayout.js';
import { residualSplit } from './payoutEngine.js';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + what); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const cfg = { globalLevels: { 1: 25, 2: 25, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 }, leadSourcePct: 25, companyExpensePct: 15, residualLevel: 4 };
const mk = (lvl) => ({ level: lvl });
const teamMap = new Map([['rm', mk(3)], ['bm', mk(4)], ['fw', mk(6)], ['msa', mk(5)]]);
const sum = (s, f = () => true) => s.filter(f).reduce((a, x) => a + x.amount, 0);

// RM (L3) + BM (L4): RM 25%, BM remainder 60%, company 15%
let s = partnerShares({ ours: 1000, h: { level3Id: 'rm', level4Id: 'bm' }, period: '2026-08', teamMap, cfg });
ok(near(sum(s, x => x.uid === 'rm'), 250), 'RM 25% of the share');
ok(near(sum(s, x => x.uid === 'bm'), 600), 'BM takes the remainder (60%)');

// identical to the mutual-fund engine for any input (it is the same function)
for (const h of [{ level3Id: 'rm', level4Id: 'bm' }, { level4Id: 'bm', level6Id: 'fw' }, { level3Id: 'rm', level4Id: 'bm', level5Id: 'msa', level6Id: 'fw' }]) {
  const a = partnerShares({ ours: 777.77, h, lsl: 3, period: '2026-08', teamMap, cfg });
  const b = residualSplit({ gross: 777.77, h, lsl: 3, period: '2026-08', teamMap, cfg }).shares.filter(x => x.amount !== 0);
  ok(JSON.stringify(a) === JSON.stringify(b), 'same split as the mutual fund for ' + Object.keys(h).join('+'));
}

// Finowise at L6: takes 5% out of the company's 15%
const sp = { ...cfg, globalLevels: { ...cfg.globalLevels, 6: 5 } };
s = partnerShares({ ours: 1000, h: { level4Id: 'bm', level6Id: 'fw' }, period: '2026-08', teamMap, cfg: sp });
ok(near(sum(s, x => x.uid === 'fw'), 50), 'L6 takes 5% of the share');
ok(near(sum(s, x => x.uid === 'bm'), 850 - 0), 'BM keeps the remainder (85%), L6 is funded by the company');

// a clawback (negative share) reverses the payout
s = partnerShares({ ours: -1000, h: { level3Id: 'rm', level4Id: 'bm' }, period: '2026-08', teamMap, cfg });
ok(near(sum(s, x => x.uid === 'rm'), -250), 'negative share is a clawback');

// nothing to split -> nothing returned
ok(partnerShares({ ours: 0, h: { level3Id: 'rm', level4Id: 'bm' }, period: '2026-08', teamMap, cfg }).length === 0, 'zero share pays nothing');

console.log(`partner payout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
