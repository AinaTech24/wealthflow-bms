/**
 * Does an investor name on a statement row agree with the name on a client record?
 *
 * One rule, used in two places that must never disagree: the importer, which
 * decides whose client a folio's money belongs to, and the Attribution Health
 * check, which reports money that looks like it reached the wrong person. A
 * second copy of this rule would eventually drift from the first, and the
 * difference would be paid out before anybody noticed.
 *
 * WHY IT EXISTS
 * Folio is the strongest mapping key the importer has, so it is consulted first.
 * But folio lists are polluted — single folios are claimed by 80+ client records
 * — and the lookup kept whichever record came last, which is arbitrary and
 * differs between imports. One record ("Amit Parshotam Menghani") had collected
 * ten folios belonging to six other investors; because folio wins, it quietly
 * took ₹1,137.10 of August off RAVISANKAR K K and Vinubhai Nathubhai Desai and
 * gave it to Mahek Haresh Chugh. Deleting the month and re-importing it
 * reproduced the same result exactly, because nothing about the folio lists had
 * changed.
 */

/**
 * Words that carry no identity. Half this book shares "KUMAR", and the honorifics
 * attach to everyone, so a match on one of these is not evidence of anything.
 */
const STOP = new Set(['KUMAR', 'HUF', 'REP', 'BY', 'MR', 'MRS', 'SHRI', 'SMT', 'DEVI', 'LATE']);

/**
 * The identifying words in a name.
 *
 * "X REP BY Y" is still X — a minor's folio is represented by a guardian, and the
 * guardian's name must not make the row look like somebody else's.
 */
export function nameTokens(s) {
  return new Set(
    String(s || '')
      .toUpperCase()
      .replace(/\bREP(RESENTED)?\s+BY\b.*$/, '')
      .replace(/[^A-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOP.has(t))
  );
}

/**
 * True only when both names carry identifying words and NONE of them overlap.
 *
 * Deliberately one-sided: it answers "is this definitely a different person?",
 * never "is this the same person?". A name we cannot judge — blank, initials
 * only, nothing but stop-words — returns false, so the caller keeps its existing
 * behaviour rather than discarding a row on no evidence.
 */
export function nameContradicts(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  for (const t of tb) if (ta.has(t)) return false;
  return true;
}

/**
 * Which of several client records is the BEST match for an investor's name?
 *
 * `nameContradicts` says only "definitely someone else", which is the right test
 * for ONE claimant. It is the wrong test for choosing BETWEEN several: it let any
 * record sharing a single word through, so a folio claimed by "Aaradhay Singh",
 * "Dal Bahadur Singh" and "Manish Singh" saw all three as agreeing with the
 * investor "Aaradhay Singh" — they all contain SINGH — and the importer, unable to
 * pick, left the row unattached. That sent Aaradhay's Rs 9.18 to the house account
 * and out of MSA Financial Services.
 *
 * So rank them. The record sharing the MOST identifying words wins; an exact name
 * outranks a shared surname. Several records can still TIE — "Amit Parshotam
 * Menghani" exists four times — and the caller decides what a tie means.
 *
 * @param {string[]} candidateNames  the names on the competing client records
 * @param {string}   investorName    the investor named on the statement row
 * @returns {number[]} indexes of the best-scoring candidates ([] when none share a word)
 */
export function bestNameMatches(candidateNames, investorName) {
  const wanted = nameTokens(investorName);
  // A name with nothing identifying in it cannot discriminate — keep everyone, the
  // caller's same-RM check then decides, exactly as before.
  if (!wanted.size) return candidateNames.map((_, i) => i);
  const scores = candidateNames.map(n => {
    const have = nameTokens(n);
    let s = 0;
    for (const t of wanted) if (have.has(t)) s++;
    return s;
  });
  const best = Math.max(0, ...scores);
  if (best < 1) return [];
  return scores.map((s, i) => (s === best ? i : -1)).filter(i => i >= 0);
}
