// Standalone recompute runner — mirrors server.js recomputeAllBreakdowns()
// (atomic staging-table + RENAME swap). Rebuilds tx.breakdown + payout_ledger
// from CURRENT config + per-RM customLevels. Run after a rate change.
//   cd /home/u477139614/domains/nflx.in/nodejs && node recalcRun.js
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import { residualSplit, breakdownFromShares } from './src/lib/payoutEngine.js';
import { chainAsOf } from './src/lib/hierarchyHistory.js';

(async () => {
  const [cfgRows] = await pool.query("SELECT data FROM config LIMIT 1");
  const cfg = JSON.parse(cfgRows[0]?.data || '{}');
  // RESIDUAL is the only supported model — see server.js. The config value is
  // read only so a stale 'SLICES' setting is visible in the log, never obeyed.
  const model = cfg.leadSharingModel || 'RESIDUAL';
  const cum = cfg.designationCumulative || {};
  const leadPct = Number(cfg.leadSourcePct) || 0;
  const globalLevels = cfg.levels || {};
  const companyExpensePct = Number(cfg.companyExpensePct) || 0;
  const residualLevel = Number(cfg.residualLevel) || 4;
  // Settled months are FROZEN. A rate/level/mapping change must never rewrite a
  // period that has already been reconciled and invoiced — for a locked period we
  // keep the stored breakdown and re-emit its EXISTING ledger rows unchanged, so
  // a paid invoice can never stop matching the ledger behind it.
  const lockedPeriods = new Set(cfg.lockedPeriods || []);
  if (lockedPeriods.size) console.log('locked (frozen) periods:', [...lockedPeriods].join(', '));
  const useCum = model === 'CUMULATIVE' && cum && Object.keys(cum).length > 0;
  const useResidual = model === 'RESIDUAL';
  console.log(`model=${model} useCum=${useCum} useResidual=${useResidual}`);

  const [clients] = await pool.query("SELECT id,data FROM clients");
  const hier = new Map(), lead = new Map(), withHistory = new Map();
  for (const c of clients) {
    let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
    if (d.hierarchy) hier.set(c.id, d.hierarchy);
    if (d.leadSourceLevel) lead.set(c.id, Number(d.leadSourceLevel));
    if (Array.isArray(d.hierarchyHistory) && d.hierarchyHistory.length) withHistory.set(c.id, { hierarchy: d.hierarchy, hierarchyHistory: d.hierarchyHistory, leadSourceLevel: d.leadSourceLevel ? Number(d.leadSourceLevel) : undefined });
  }
  const [teamRows] = await pool.query("SELECT id,level,data FROM team");
  const teamMap = new Map();
  for (const t of teamRows) { let cl, rh; try { const d = JSON.parse(t.data || '{}'); cl = d.customLevels; rh = d.rateHistory; } catch {} teamMap.set(t.id, { level: Number(t.level), customLevels: cl, rateHistory: rh }); }

  // The payout maths is src/lib/payoutEngine.js, shared with server.js and the
  // reports, so this script can never disagree with the app.
  let overDistributed = 0;   // clients whose lower + upper rates alone exceed (100 - company%)
  const engineCfg = { globalLevels, leadSourcePct: leadPct, companyExpensePct, residualLevel };
  const calcResidual = (gross, h, lsl, period) => {
    const split = residualSplit({ gross, h, lsl, period, teamMap, cfg: engineCfg });
    if (split.overDistributed) overDistributed++;
    return breakdownFromShares(gross, split);
  };

  // Take the SAME firm-wide lock server.js recomputeAllBreakdowns() uses. Without
  // it this script and an in-app recompute run concurrently and race the staging
  // swap — which silently produced a ledger with NO rows for a client whose
  // hierarchy had just been rewritten by a merge.
  const [[lockRow]] = await pool.query("SELECT GET_LOCK('wf_recalc', 120) AS got");
  if (!Number(lockRow?.got)) {
    console.error('another recalculation is already running — aborting so the two do not race');
    await pool.end();
    process.exit(1);
  }

  const [[{ n: total }]] = await pool.query("SELECT COUNT(*) n FROM transactions");
  console.log('total tx:', total);
  await pool.query("DROP TABLE IF EXISTS payout_ledger_stage");
  await pool.query("CREATE TABLE payout_ledger_stage LIKE payout_ledger");

  const PAGE = 20000; let lastId = ''; let processed = 0; let ledgerCount = 0;
  while (true) {
    const [rows] = await pool.query("SELECT id, grossAmount, brokeragePeriod, data FROM transactions WHERE id>? ORDER BY id LIMIT ?", [lastId, PAGE]);
    if (!rows.length) break;
    const upserts = [], ledgerRows = [];
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch { processed++; continue; }
      // Locked period → preserve exactly: no recalculation, and the existing
      // payout rows are copied forward into the staging ledger untouched.
      if (lockedPeriods.has(r.brokeragePeriod)) {
        const keep = d.breakdown;
        if (keep && keep.userPayouts) {
          for (const [uid, amt] of Object.entries(keep.userPayouts)) {
            if (Math.abs(Number(amt) || 0) > 0.0001) ledgerRows.push([r.id, uid, Number(amt), 0]);
          }
        }
        processed++; continue;
      }
      const gross = Number(r.grossAmount) || 0;
      const hc = withHistory.get(d.mappedClientId);
      const asOf = hc ? chainAsOf(hc, r.brokeragePeriod) : null;
      const h = asOf ? asOf.hierarchy : hier.get(d.mappedClientId);
      const leadHere = asOf ? asOf.leadSourceLevel : lead.get(d.mappedClientId);
      const bd = !h ? { gross, expenseAmount: gross, netPool: 0, levelPayouts:{1:0,2:0,3:0,4:0,5:0,6:0,7:0}, userPayouts:{} }
                    // RESIDUAL is the ONLY model (Slices/Cumulative removed 2026-08-18).
                    : calcResidual(gross, h, leadHere, r.brokeragePeriod);
      d.breakdown = bd; upserts.push([r.id, JSON.stringify(d)]);
      for (const [uid, amt] of Object.entries(bd.userPayouts)) if (Math.abs(amt) > 0.0001) ledgerRows.push([r.id, uid, amt, 0]);
      processed++;
    }
    for (let i=0;i<upserts.length;i+=500){ const ch=upserts.slice(i,i+500); await pool.query("INSERT INTO transactions (id,data) VALUES ? ON DUPLICATE KEY UPDATE data=VALUES(data)", [ch]); }
    for (let i=0;i<ledgerRows.length;i+=1000){ const ch=ledgerRows.slice(i,i+1000); await pool.query("INSERT INTO payout_ledger_stage (transactionId,userId,amount,level) VALUES ?", [ch]); ledgerCount += ch.length; }
    lastId = rows[rows.length-1].id;
    if (processed % 100000 < PAGE) console.log('  processed', processed);
  }
  // Keep the previous ledger as payout_ledger_prev — identical to server.js
  // recomputeAllBreakdowns. Dropping it made every rebuild irreversible.
  //   rollback: RENAME TABLE payout_ledger TO payout_ledger_bad,
  //                          payout_ledger_prev TO payout_ledger;
  await pool.query("DROP TABLE IF EXISTS payout_ledger_prev");
  await pool.query("RENAME TABLE payout_ledger TO payout_ledger_prev, payout_ledger_stage TO payout_ledger");
  // Log the MONEY, not just row counts: a run that zeroes or doubles everything
  // looks identical in a row count and obvious in the total.
  try {
    const [[now]]  = await pool.query("SELECT ROUND(SUM(amount),2) s FROM payout_ledger");
    const [[was]]  = await pool.query("SELECT ROUND(SUM(amount),2) s FROM payout_ledger_prev");
    const a = Number(now?.s) || 0, b = Number(was?.s) || 0, d = a - b;
    if (overDistributed) console.warn(`⚠️  ${overDistributed} transactions had L1-L3 rates exceeding (100 - company%) — those clients over-distribute; fix the rates.`);
    console.log(`✅ DONE recalc: ${processed} tx, ${ledgerCount} ledger rows, total Rs ${a} (was Rs ${b}, change Rs ${d.toFixed(2)})`);
    try { await pool.query("SELECT RELEASE_LOCK('wf_recalc')"); } catch (_) {}
    if (b > 0 && Math.abs(d) / b > 0.10) {
      console.warn(`⚠️  payout total moved ${((d / b) * 100).toFixed(1)}% — verify before paying. Previous ledger kept as payout_ledger_prev.`);
    }
  } catch (_) {
    console.log(`✅ DONE recalc: ${processed} tx, ${ledgerCount} ledger rows`);
  }
  process.exit(0);
})();
