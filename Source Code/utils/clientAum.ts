import { useState, useEffect, useMemo } from 'react';
import { authFetch } from '../contexts/DataContext';

// ONE definition of a client's AUM, because keeping a second copy is what broke it.
// The clients page and the Reports client-summary tab each derived this themselves
// and drifted: the same investor read ₹10,986 under Enterprise Management, ₹12,266
// under Linked Portfolios, and a third figure again in Reports.

export interface AumEntry { total: number; asOf: string }

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
 * Within that month the LARGEST slice wins, not the first one seen. CAMS writes
 * about twelve sub-period rows per folio+scheme, so first-seen makes the answer
 * depend on the order rows arrive in — which is how two screens disagreed.
 *
 * Keyed on folio alone, never amc+folio: amcName is spelled inconsistently across
 * imports, and pairing them splits one folio in two (₹41.37 Cr → ₹75.97 Cr).
 */
export function deriveClientAum(transactions: any[]): Map<string, AumEntry> {
  const perClient = new Map<string, Map<string, { period: string; schemes: Map<string, number> }>>();
  for (const tx of transactions) {
    const cid = tx?.mappedClientId;
    const value = Number(tx?.currentValue);
    if (!cid || !(value > 0)) continue;
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
    const prev = f.schemes.get(scheme);
    if (prev === undefined || value > prev) f.schemes.set(scheme, value);
  }
  const out = new Map<string, AumEntry>();
  for (const [cid, folios] of perClient) {
    let total = 0, asOf = '';
    for (const f of folios.values()) {
      for (const v of f.schemes.values()) total += v;
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
export function useClientAum(transactions: any[]): Map<string, AumEntry> {
  const local = useMemo(() => deriveClientAum(transactions), [transactions]);
  const [server, setServer] = useState<Map<string, AumEntry> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/data?action=client_aum&_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled || !j?.aum) return;
        setServer(new Map(Object.entries(j.aum as Record<string, AumEntry>)));
      } catch {
        /* leave `server` null and fall back to the local derivation */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Returned as a Map rather than a lookup function so its identity is stable —
  // callers memoise sorted client lists on it, and a fresh closure every render
  // would re-sort the whole book each time.
  return server ?? local;
}
