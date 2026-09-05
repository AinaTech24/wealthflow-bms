// READ-ONLY. For each duplicate team-name group, pick the canonical record
// (most structurally-embedded) and quantify the payout impact of merging each
// duplicate into it — specifically how many transactions are paid under BOTH
// ids (overlap), since that's where a merge changes real payout totals.

import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

async function main() {
  const [team] = await pool.query('SELECT id, name, level, parentId FROM team');
  const byName = new Map();
  for (const t of team) { const k = norm(t.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(t); }

  // usage counts
  const [clients] = await pool.query('SELECT primaryOwnerId, data FROM clients');
  const usePrimary = new Map(), useHier = new Map();
  const inc = (m, id) => id && m.set(id, (m.get(id) || 0) + 1);
  for (const c of clients) {
    inc(usePrimary, c.primaryOwnerId);
    const h = parse(c.data).hierarchy || {};
    for (let l = 1; l <= 7; l++) inc(useHier, h[`level${l}Id`]);
  }
  const useParent = new Map();
  for (const t of team) inc(useParent, t.parentId);
  const [pl] = await pool.query('SELECT userId, COUNT(*) c, COALESCE(SUM(amount),0) amt FROM payout_ledger GROUP BY userId');
  const payCnt = new Map(pl.map(r => [r.userId, r.c])), payAmt = new Map(pl.map(r => [r.userId, Number(r.amt)]));

  const score = id => (useHier.get(id) || 0) * 1e6 + (payCnt.get(id) || 0) * 10 + (useParent.get(id) || 0);

  const dupes = [...byName.values()].filter(a => a.length > 1);
  console.log(`Duplicate groups: ${dupes.length}\n`);
  let totalOverlapTx = 0, pairsWithOverlap = 0;

  for (const arr of dupes) {
    const ranked = [...arr].sort((a, b) => score(b.id) - score(a.id));
    const canonical = ranked[0];
    const dups = ranked.slice(1);
    console.log(`${arr[0].name}`);
    console.log(`   canonical: L${canonical.level} ${canonical.id}  (hier=${useHier.get(canonical.id)||0} pay=${payCnt.get(canonical.id)||0}/${(payAmt.get(canonical.id)||0).toFixed(0)} child=${useParent.get(canonical.id)||0})`);
    for (const d of dups) {
      const [[ov]] = await pool.query(
        'SELECT COUNT(*) c, COALESCE(SUM(b.amount),0) amt FROM payout_ledger a JOIN payout_ledger b ON a.transactionId=b.transactionId WHERE a.userId=? AND b.userId=?',
        [canonical.id, d.id]);
      const dupRows = payCnt.get(d.id) || 0;
      const cleanMove = dupRows - ov.c;
      if (ov.c > 0) { pairsWithOverlap++; totalOverlapTx += ov.c; }
      console.log(`   merge L${d.level} ${d.id}: payRows=${dupRows} clean-move=${cleanMove} OVERLAP=${ov.c} (₹${Number(ov.amt).toFixed(0)} on dup side)${ov.c ? '  ⚠' : ''}`);
    }
  }
  console.log(`\nPairs with payout overlap: ${pairsWithOverlap}; total overlapping payout rows: ${totalOverlapTx}`);
  console.log('Overlap = transactions already paying the canonical id that ALSO pay the duplicate id.');
  console.log('Under a SUM policy those amounts stay (combined); under a DEDUPE policy the duplicate row is dropped (payout reduced).');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
