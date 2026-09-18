import { useState, useEffect, useMemo } from 'react';
import { authFetch } from '../contexts/DataContext';

// ONE definition of a client's AUM, because keeping a second copy is what broke it.
// The clients page and the Reports client-summary tab each derived this themselves
// and drifted: the same investor read ₹10,986 under Enterprise Management, ₹12,266
// under Linked Portfolios, and a third figure again in Reports.

export interface AumEntry { total: number; asOf: string }

export interface ClientAum {
  aum: Map<string, AumEntry>;
  /**
   * Clients that appear in at least one imported row, with or without an AUM.
   * `null` until the server answers — the browser holds too few transactions to
   * decide this locally, and guessing would label a real client as missing.
   */
  clientsWithTx: Set<string> | null;
}

/**
 * Derive AUM per client from whatever transactions the browser is holding.
 *
 * Anchored on the LATEST MONTH EACH FOLIO REPORTED, then the schemes in that month
 * are added up. Keying per folio+scheme instead let dead scheme spellings pile up —
 * folio 38383558/63 is one holding that three imports named three different ways
 * ("HDFC Diversified Equity All Cap Active FOF - Regular Plan - Growth Plan",
 * "…FOF Regular Growth", and the bare scheme code "HARGR"), so the latest value of
 * each was summed and ₹10,245 read as ₹12,285.
 *
 * Within that month the DISTINCT row values are summed.
 *
 * Since around March 2026 a brokerage file writes one row per LOT — per SIP
 * instalment — each with its own value. Folio 44004359/43 runs a ₹1,000 monthly SIP
 * from 10-04-2026 and carries 1 row in April, 2 in May, 3 in June: the row count IS
 * the instalment count, and June's rows total ₹3,011.86 against the AMC's own
 * ₹3,000 cost basis.
 *
 * Before that the format repeated the folio+scheme TOTAL on every row — folio
 * 11654668/34 has 132 rows in Jan-26, each a separate transaction with its own
 * gross, every one stamped ₹394,795. Summing those would multiply the holding by
 * 132. Summing DISTINCT values reads both formats correctly, and is what makes the
 * implied annual trail land at 0.55–0.96% on every file in the system.
 *
 * Rows flagged `aumUnreliable` are skipped. July's CAMS half came from an
 * AdvisorKhoj portfolio export, which repeats ONE total on every row instead of
 * writing per-lot values, and that total is the value at the export date rather
 * than at July — summed, it reads ₹20,448 where the folio held about ₹4,000. Those
 * rows stay in the system as the brokerage record; they just cannot state an AUM,
 * so the folio falls back to its last clean month.
 *
 * Keyed on folio alone, never amc+folio: amcName is spelled inconsistently across
 * imports, and pairing them splits one folio in two (₹41.37 Cr → ₹75.97 Cr).
 */
export function deriveClientAum(transactions: any[]): Map<string, AumEntry> {
  const perClient = new Map<string, Map<string, { period: string; schemes: Map<string, Set<number>> }>>();
  for (const tx of transactions) {
    const cid = tx?.mappedClientId;
    const value = Number(tx?.currentValue);
    if (!cid || !(value > 0) || tx?.aumUnreliable === true) continue;
    // transactionDate is the original investment date, never the brokerage month,
    // so it cannot stand in for a missing period.
    const period = String(tx.brokeragePeriod || '');
    if (!period) continue;
    const folio = String(tx.folio ?? '');
    const scheme = String(tx.schemeName ?? '');
    let folios = perClient.get(cid);
    if (!folios) { folios = new Map(); perClient.set(cid, folios); }
    let f = folios.get(folio);
    if (!f || period > f.period) { f = { period, schemes: new Map() }; folios.set(folio, f); }
    if (period < f.period) continue;
    let vals = f.schemes.get(scheme);
    if (!vals) { vals = new Set(); f.schemes.set(scheme, vals); }
    vals.add(value);
  }
  const out = new Map<string, AumEntry>();
  for (const [cid, folios] of perClient) {
    let total = 0, asOf = '';
    for (const f of folios.values()) {
      for (const vals of f.schemes.values()) for (const v of vals) total += v;
      if (f.period > asOf) asOf = f.period;
    }
    if (total > 0) out.set(cid, { total, asOf });
  }
  return out;
}

/**
 * AUM per client, preferring the server's figure.
 *
 * The browser only ever holds 200k of ~450k transactions, so the local derivation
 * is right only for whoever's slice happens to be complete — an admin sees a
 * truncated book and an RM sees all of their own. `client_aum` runs the identical
 * rule in SQL across every row, so every screen and every role agree. The local
 * figure is what we show while that request is in flight.
 */
export function useClientAum(transactions: any[]): ClientAum {
  const local = useMemo(() => deriveClientAum(transactions), [transactions]);
  const [server, setServer] = useState<Map<string, AumEntry> | null>(null);
  const [withTx, setWithTx] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/data?action=client_aum&_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled || !j?.aum) return;
        setServer(new Map(Object.entries(j.aum as Record<string, AumEntry>)));
        if (Array.isArray(j.clientsWithTx)) setWithTx(new Set(j.clientsWithTx as string[]));
      } catch {
        /* leave both null and fall back to the local derivation */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Memoised so the object's identity is stable — callers memoise sorted client
  // lists on it, and a fresh object every render would re-sort the whole book.
  return useMemo(
    () => ({ aum: server ?? local, clientsWithTx: withTx }),
    [server, local, withTx],
  );
}
