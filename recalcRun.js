// Standalone recompute runner — mirrors server.js recomputeAllBreakdowns()
// (atomic staging-table + RENAME swap). Rebuilds tx.breakdown + payout_ledger
// from CURRENT config + per-RM customLevels. Run after a rate change.
//   cd /home/u477139614/domains/nflx.in/nodejs && node recalcRun.js
import './bootstrap-env.js';
import pool from './src/lib/db.js';

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
  const hier = new Map(), lead = new Map();
  for (const c of clients) { let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; } if (d.hierarchy) hier.set(c.id, d.hierarchy); if (d.leadSourceLevel) lead.set(c.id, Number(d.leadSourceLevel)); }
  const [teamRows] = await pool.query("SELECT id,level,data FROM team");
  const teamMap = new Map();
  for (const t of teamRows) { let cl, rh; try { const d = JSON.parse(t.data || '{}'); cl = d.customLevels; rh = d.rateHistory; } catch {} teamMap.set(t.id, { level: Number(t.level), customLevels: cl, rateHistory: rh }); }

  // Effective-dated rates — MUST stay identical to server.js memberAsOf().
  // A member's level/rate is a timeline; a promotion applies from its effective
  // month forward and must never restate earlier (often already invoiced) months.
  const memberAsOf = (info, period) => {
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
  };

  // RESIDUAL model — mirror of server.js recomputeAllBreakdowns.calcResidual.
  let overDistributed = 0;   // clients whose L1-L3 rates alone exceed (100 - company%)
    const calcResidual = (gross, h, lsl, period) => {
    const lp = {1:0,2:0,3:0,4:0,5:0,6:0,7:0}, up = {};
    let oCL; for (let l=1;l<=7;l++){ const u=h[`level${l}Id`]; if(u){ oCL=memberAsOf(teamMap.get(u), period)?.customLevels; break; } }
    const rl = residualLevel; const paid = new Set(); let lowerSum = 0, dist = 0;
    for (let l=1;l<rl;l++){ const u=h[`level${l}Id`]; if(!u||paid.has(u)) continue; paid.add(u);
      const info=memberAsOf(teamMap.get(u), period); const cl=info?.customLevels, uL=info?.level;
      const pct=Math.max(0, cl&&cl[uL]!==undefined?cl[uL]:(cl&&cl[l]!==undefined?cl[l]:(oCL?.[l]!==undefined?oCL[l]:(globalLevels[l]||0))));
      const p=Math.round(gross*pct/100*10000)/10000; lp[l]=p; if(p!==0)up[u]=(up[u]||0)+p; lowerSum+=pct; dist+=p; }   // p!==0: clawbacks must deduct
    // Lead-source add-on goes to the LOWER-level owner and must reduce the
    // residual too — identical to server.js calcResidual.
    if (leadPct > 0 && lsl && lsl < rl) {
      const su = h[`level${lsl}Id`];
      if (su) { const p=Math.round(gross*leadPct/100*10000)/10000; lp[lsl]=(lp[lsl]||0)+p; if(p!==0)up[su]=(up[su]||0)+p; lowerSum+=leadPct; dist+=p; }
    }
    let ru=null, ruL=rl; for(let l=rl;l<=7;l++){ if(h[`level${l}Id`]){ ru=h[`level${l}Id`]; ruL=l; break; } }
    if (lowerSum > 100 - companyExpensePct + 0.0001) overDistributed++;   // config error: levels alone exceed what is available
      if (ru && !paid.has(ru)) { const surplus=Math.max(0, 100-companyExpensePct-lowerSum);
      const p=Math.round(gross*surplus/100*10000)/10000; lp[ruL]=(lp[ruL]||0)+p; if(p!==0)up[ru]=(up[ru]||0)+p; dist+=p; }   // p!==0: clawbacks must deduct
    const exp = Math.round((gross-dist)*100)/100;
    return { gross, expenseAmount: exp, netPool: Math.round((gross-exp)*100)/100, levelPayouts: lp, userPayouts: up };
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
      const gross = Number(r.grossAmount) || 0; const h = hier.get(d.mappedClientId);
      const bd = !h ? { gross, expenseAmount: gross, netPool: 0, levelPayouts:{1:0,2:0,3:0,4:0,5:0,6:0,7:0}, userPayouts:{} }
                    // RESIDUAL is the ONLY model (Slices/Cumulative removed 2026-08-18).
                    : calcResidual(gross, h, lead.get(d.mappedClientId), r.brokeragePeriod);
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
