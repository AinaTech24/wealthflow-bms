// Merge ONLY the duplicate team records that are safe (the duplicate has ZERO
// payout_ledger rows) — i.e. zero payout impact. For each such pair the script:
//   • repoints clients.primaryOwnerId  dup -> canonical
//   • replaces dup with canonical in every clients.data.hierarchy slot
//     (and clears the slot if canonical is already present elsewhere on that client)
//   • repoints team.parentId  dup -> canonical
//   • deletes the duplicate team row
// Canonical = the most structurally-embedded record (recomputed here). Any pair
// whose duplicate unexpectedly has payout rows is SKIPPED and reported.
//
//   node src/scripts/mergeTeamSafe.js            # dry-run
//   node src/scripts/mergeTeamSafe.js --apply     # writes (single transaction)

import pool from '../lib/db.js';

const APPLY = process.argv.slice(2).includes('--apply');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const [team] = await pool.query('SELECT id, name, level, parentId FROM team');
  const byName = new Map();
  for (const t of team) { const k = norm(t.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(t); }

  const [clients] = await pool.query('SELECT id, primaryOwnerId, pan, name, data FROM clients');
  const useHier = new Map(), useParent = new Map();
  const inc = (m, id) => id && m.set(id, (m.get(id) || 0) + 1);
  for (const c of clients) { const h = parse(c.data).hierarchy || {}; for (let l = 1; l <= 7; l++) inc(useHier, h[`level${l}Id`]); }
  for (const t of team) inc(useParent, t.parentId);
  const [pl] = await pool.query('SELECT userId, COUNT(*) c FROM payout_ledger GROUP BY userId');
  const payCnt = new Map(pl.map(r => [r.userId, r.c]));
  const score = id => (useHier.get(id) || 0) * 1e6 + (payCnt.get(id) || 0) * 10 + (useParent.get(id) || 0);

  // Build the safe merge map: dupId -> canonicalId
  const merges = [];      // { name, canonical, dup }
  const skipped = [];
  for (const arr of byName.values()) {
    if (arr.length < 2) continue;
    const ranked = [...arr].sort((a, b) => score(b.id) - score(a.id));
    const canonical = ranked[0];
    for (const dup of ranked.slice(1)) {
      if ((payCnt.get(dup.id) || 0) === 0) merges.push({ name: arr[0].name, canonical, dup });
      else skipped.push({ name: arr[0].name, dup, payRows: payCnt.get(dup.id) });
    }
  }
  const dupToCanon = new Map(merges.map(m => [m.dup.id, m.canonical.id]));

  console.log(`Safe pairs to merge: ${merges.length}`);
  for (const m of merges) console.log(`  ${m.name}: remove L${m.dup.level} ${m.dup.id}  ->  keep L${m.canonical.level} ${m.canonical.id}`);
  if (skipped.length) {
    console.log(`\nDeferred (duplicate has payouts — not touched): ${skipped.length}`);
    for (const s of skipped) console.log(`  ${s.name}: L${s.dup.level} ${s.dup.id} (${s.payRows} payout rows)`);
  }

  // Plan client rewrites
  const clientWrites = [];
  let primaryRepoints = 0, hierRepoints = 0, hierCollapsed = 0;
  for (const c of clients) {
    let changed = false;
    let newOwner = c.primaryOwnerId;
    if (newOwner && dupToCanon.has(newOwner)) { newOwner = dupToCanon.get(newOwner); primaryRepoints++; changed = true; }
    const d = parse(c.data);
    if (d.hierarchy) {
      for (let l = 1; l <= 7; l++) {
        const key = `level${l}Id`;
        const v = d.hierarchy[key];
        if (v && dupToCanon.has(v)) {
          const canon = dupToCanon.get(v);
          // If canonical already present in another slot, clear this one; else replace.
          const present = Object.entries(d.hierarchy).some(([k, val]) => k !== key && val === canon);
          d.hierarchy[key] = present ? '' : canon;
          if (present) hierCollapsed++; else hierRepoints++;
          changed = true;
        }
      }
    }
    if (changed) clientWrites.push([c.id, newOwner, c.pan || '', c.name || '', JSON.stringify(d)]);
  }

  // Plan team.parentId repoints
  const parentRepoints = team.filter(t => t.parentId && dupToCanon.has(t.parentId))
    .map(t => [t.id, dupToCanon.get(t.parentId)]);

  console.log(`\nClient rows to rewrite:     ${clientWrites.length}  (primaryOwner repoints=${primaryRepoints}, hierarchy repoints=${hierRepoints}, hierarchy collapsed=${hierCollapsed})`);
  console.log(`team.parentId repoints:     ${parentRepoints.length}`);
  console.log(`Team rows to delete:        ${merges.length}`);

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply.'); process.exit(0); }

  // Safety re-check inside apply: assert each dup still has 0 payout rows.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const m of merges) {
      const [[chk]] = await conn.query('SELECT COUNT(*) c FROM payout_ledger WHERE userId=?', [m.dup.id]);
      if (chk.c !== 0) throw new Error(`ABORT: ${m.dup.id} now has ${chk.c} payout rows — refusing to delete.`);
    }
    for (const w of clientWrites) {
      await conn.query(
        `INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE primaryOwnerId=VALUES(primaryOwnerId), data=VALUES(data)`, w);
    }
    for (const [childId, canon] of parentRepoints) {
      await conn.query('UPDATE team SET parentId=? WHERE id=?', [canon, childId]);
    }
    for (const m of merges) {
      await conn.query('DELETE FROM team WHERE id=?', [m.dup.id]);
    }
    await conn.commit();
    console.log(`\n✅ Done. Merged ${merges.length} duplicates; rewrote ${clientWrites.length} clients; repointed ${parentRepoints.length} sub-team rows.`);
  } catch (e) {
    await conn.rollback();
    console.error('ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    process.exit();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
