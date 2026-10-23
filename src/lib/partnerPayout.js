/**
 * Partner (Motilal Oswal and any other broking statement) payouts, by the MUTUAL FUND rule.
 *
 * A partner statement says what the firm earns ("our share"). That share is split across each
 * client's RM/BM chain with exactly the engine the mutual fund uses (src/lib/payoutEngine.js):
 * the company keeps its percentage, L5/L6 take their 5% out of it, the RMs take their own %,
 * and the residual receiver (L4, else whoever is first above) takes what is left. The same
 * chain-as-of-the-month, lead-source bonus and rounding apply.
 *
 * It lives in its OWN table (partner_payout_ledger) and never reads or writes the mutual fund
 * tables (transactions, payout_ledger), so nothing in mutual funds can change because of it.
 *
 * Locked months are frozen the same way the fund ledger is: once a (partner, month) has stored
 * rows and the month is locked, a recompute leaves those rows alone. A locked month that has no
 * rows yet is computed once, then frozen.
 */
import { residualSplit } from './payoutEngine.js';
import { chainAsOf } from './hierarchyHistory.js';

export const PARTNER_LEDGER_DDL =
  'CREATE TABLE IF NOT EXISTS partner_payout_ledger (' +
  'partner VARCHAR(40) NOT NULL, period VARCHAR(7) NOT NULL, clientId VARCHAR(120) NOT NULL, ' +
  'userId VARCHAR(100) NOT NULL, kind VARCHAR(12) NOT NULL, amount DECIMAL(15,4) NOT NULL, level INT, ' +
  'PRIMARY KEY (partner, period, clientId, userId, kind), INDEX idx_ppl_user (userId, period), INDEX idx_ppl_period (partner, period))';

/** Pure: split one client's partner share for one month. Same function as the fund. */
export function partnerShares({ ours, h, lsl, period, teamMap, cfg }) {
  return residualSplit({ gross: ours, h, lsl, period, teamMap, cfg }).shares.filter(s => s.amount !== 0);
}

/**
 * Rebuild partner_payout_ledger from partner_brokerage, the current chains and the current rates.
 * Returns { refreshed: [[partner, period]...], frozen: [[partner, period]...], rows }.
 */
export async function recomputePartnerLedger(pool, { partner } = {}) {
  await pool.query(PARTNER_LEDGER_DDL);
  const [[cfgRow]] = await pool.query("SELECT data FROM config WHERE id IN ('global_config','global') ORDER BY id = 'global_config' DESC LIMIT 1");
  let cfg = {}; try { cfg = JSON.parse(cfgRow?.data || '{}'); } catch { /* keep {} */ }
  const ecfg = {
    globalLevels: cfg.levels || {}, leadSourcePct: Number(cfg.leadSourcePct) || 0,
    companyExpensePct: Number(cfg.companyExpensePct) || 0, residualLevel: Number(cfg.residualLevel) || 4,
  };
  const locked = new Set(Array.isArray(cfg.lockedPeriods) ? cfg.lockedPeriods : []);

  const [clientRows] = await pool.query('SELECT id, data FROM clients');
  const clients = new Map();
  for (const c of clientRows) {
    let d = {}; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
    clients.set(c.id, { hierarchy: d.hierarchy || {}, hierarchyHistory: d.hierarchyHistory, leadSourceLevel: d.leadSourceLevel ? Number(d.leadSourceLevel) : undefined });
  }
  const [teamRows] = await pool.query('SELECT id, level, data FROM team');
  const teamMap = new Map();
  for (const t of teamRows) {
    let d = {}; try { d = JSON.parse(t.data || '{}'); } catch { /* keep {} */ }
    teamMap.set(t.id, { level: Number(t.level), customLevels: d.customLevels, rateHistory: d.rateHistory });
  }

  const pArg = partner ? [String(partner).toUpperCase()] : [];
  const [groups] = await pool.query(
    `SELECT partner, period, mappedClientId cid, ROUND(SUM(ourShare),4) ours FROM partner_brokerage
      WHERE mappedClientId IS NOT NULL AND mappedClientId <> '' AND period IS NOT NULL AND period <> ''${partner ? ' AND partner = ?' : ''}
      GROUP BY partner, period, mappedClientId`, pArg);
  const [existing] = await pool.query(
    `SELECT partner, period, COUNT(*) n FROM partner_payout_ledger${partner ? ' WHERE partner = ?' : ''} GROUP BY partner, period`, pArg);
  const stored = new Map(existing.map(r => [r.partner + '|' + r.period, Number(r.n)]));

  const keys = new Map();
  for (const g of groups) keys.set(g.partner + '|' + g.period, [g.partner, g.period]);
  for (const e of existing) keys.set(e.partner + '|' + e.period, [e.partner, e.period]);

  const refreshed = [], frozen = [], insert = [];
  for (const [k, [p, per]] of keys) {
    if (locked.has(per) && (stored.get(k) || 0) > 0) { frozen.push([p, per]); continue; }
    refreshed.push([p, per]);
  }
  const refreshSet = new Set(refreshed.map(([p, per]) => p + '|' + per));
  for (const g of groups) {
    if (!refreshSet.has(g.partner + '|' + g.period)) continue;
    const c = clients.get(g.cid); if (!c) continue;
    const ch = chainAsOf(c, g.period); if (!ch.hierarchy || !Object.values(ch.hierarchy).some(Boolean)) continue;
    for (const s of partnerShares({ ours: Number(g.ours) || 0, h: ch.hierarchy, lsl: ch.leadSourceLevel, period: g.period, teamMap, cfg: ecfg })) {
      insert.push([g.partner, g.period, g.cid, s.uid, s.kind, s.amount, s.level]);
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [p, per] of refreshed) await conn.query('DELETE FROM partner_payout_ledger WHERE partner = ? AND period = ?', [p, per]);
    for (let i = 0; i < insert.length; i += 1000) {
      await conn.query('INSERT INTO partner_payout_ledger (partner, period, clientId, userId, kind, amount, level) VALUES ? ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)', [insert.slice(i, i + 1000)]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  return { refreshed, frozen, rows: insert.length };
}

/**
 * GST, TDS and the cheque for a product viewed on its own. An RM's invoice covers the whole month
 * and is not split by product, so on a single-product view these are ESTIMATES on that product's
 * earnings, at the configured rates: GST only when the person has a GSTIN, TDS always.
 */
export function estimateTax(base, { hasGst, gstRate, tdsRate }) {
  const gst = hasGst ? Math.round(base * gstRate) / 100 : 0;
  const tds = Math.round(base * tdsRate) / 100;
  return { gst: Math.round(gst * 100) / 100, tds: Math.round(tds * 100) / 100, payable: Math.round(base + gst - tds) };
}

/** File layouts taught for a partner whose statement the system did not recognise. */
export const PARTNER_FORMAT_DDL =
  'CREATE TABLE IF NOT EXISTS partner_formats (partner VARCHAR(40) NOT NULL PRIMARY KEY, label VARCHAR(80), data TEXT)';
