/**
 * The payout rules, in one place.
 *
 * Until now this arithmetic was copy-pasted into four places (the recompute that
 * writes the ledger, the report engine, the standalone recalcRun.js script, and the
 * browser). Every change had to be made four times and they drifted. Now the
 * recompute, the report engine and recalcRun.js all call residualSplit(), so a
 * client's brokerage can never be split one way in the ledger and another way in a
 * report.
 *
 * THE RULES (RESIDUAL model)
 *
 *   1. The company keeps companyExpensePct off the top.
 *   2. Each level BELOW the residual level (default L4) with a person on the client
 *      takes that person's own %: their personal rate at their own level, else
 *      their personal rate for the slot, else the client owner's rate for the slot,
 *      else the firm-wide rate for the level. Each person is paid once.
 *   3. The lead-source bonus goes to the person at the lead-source level.
 *   4. UPPER LEVELS (L5, L6): paid OUT OF THE COMPANY'S SHARE, never out of the
 *      receiver's. Each slot has a rate (a person's own, else the firm-wide rate for
 *      the level; the owner's legacy rate card is deliberately NOT consulted). A slot
 *      with nobody in it stays with the company; it does NOT roll up to anyone above.
 *      Example, L5 = L6 = 5%, company 15%: a client with an L5 and an L6 leaves the
 *      company 5%; an L5 alone, or an L6 alone, leaves it 10%.
 *   5. The RESIDUAL RECEIVER (the first person at the residual level or above, so
 *      L4, else L5, ...) takes whatever is left: 100 - company(after rule 4) - lower
 *      - upper. So a client owned directly by an L5 pays that L5 90%, and one owned
 *      directly by an L6 also 90% (its empty L5 stays with the company).
 *
 * With no upper-level rate set (today's configuration: L5, L6, L7 = 0) rule 4 pays
 * nothing and the result is identical to the model before it existed. That is
 * verified against a verbatim copy of the old code in payoutEngine.test.mjs.
 */

/**
 * A team member's level and rates AS OF a brokerage period.
 *
 * `rateHistory` is a timeline [{ effectiveFrom:'YYYY-MM', level, customLevels }].
 * The entry in force for the period is used; a period older than every entry uses
 * the EARLIEST one, never the current values, which is the bug this exists to
 * prevent: re-grading someone must never restate months already paid. A member with
 * no history resolves to their current values.
 */
export function memberAsOf(info, period) {
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

const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Split one brokerage amount across a client's chain.
 *
 * @param gross  the amount (negative for a clawback: every share then goes negative)
 * @param h      the client's chain { level1Id..level7Id } AS OF this period
 * @param lsl    lead-source level (1-7) or undefined
 * @param period 'YYYY-MM'
 * @param teamMap Map id -> { level, customLevels, rateHistory }
 * @param cfg    { globalLevels, leadSourcePct, companyExpensePct, residualLevel }
 *
 * @returns {{ shares: Array<{uid, level, amount, kind}>, lowerSum, upperSum,
 *             overDistributed: boolean }}
 *   kind is 'level' | 'lead' | 'upper' | 'residual'. `amount` is rounded to four
 *   decimals, exactly as the ledger has always stored it.
 */
export function residualSplit({ gross, h, lsl, period, teamMap, cfg }) {
  const globalLevels = cfg.globalLevels || {};
  const leadPct = Number(cfg.leadSourcePct) || 0;
  const companyPct = Number(cfg.companyExpensePct) || 0;
  const rl = Number(cfg.residualLevel) || 4;

  const shares = [];
  const paid = new Set();
  let lowerSum = 0, upperSum = 0;

  // The client's owner is the person at the lowest filled slot; their rate card
  // supplies the rate for any slot that has no rate of its own.
  let ownerCards;
  for (let l = 1; l <= 7; l++) {
    const u = h[`level${l}Id`];
    if (u) { ownerCards = memberAsOf(teamMap.get(u), period)?.customLevels; break; }
  }

  for (let l = 1; l < rl; l++) {
    const u = h[`level${l}Id`];
    if (!u || paid.has(u)) continue;
    paid.add(u);
    const info = memberAsOf(teamMap.get(u), period);
    const cl = info?.customLevels, uL = info?.level;
    const pct = Math.max(0,
      cl && cl[uL] !== undefined ? cl[uL]
      : cl && cl[l] !== undefined ? cl[l]
      : ownerCards?.[l] !== undefined ? ownerCards[l]
      : (globalLevels[l] || 0));
    shares.push({ uid: u, level: l, amount: round4(gross * pct / 100), kind: 'level' });
    lowerSum += pct;
  }

  // The lead-source add-on belongs to the lower levels, so it also reduces what is
  // left for the receiver; otherwise the firm would hand out more than 100%.
  if (leadPct > 0 && lsl && lsl < rl) {
    const su = h[`level${lsl}Id`];
    if (su) {
      shares.push({ uid: su, level: lsl, amount: round4(gross * leadPct / 100), kind: 'lead' });
      lowerSum += leadPct;
    }
  }

  let receiver = null, receiverLevel = rl;
  for (let l = rl; l <= 7; l++) {
    if (h[`level${l}Id`]) { receiver = h[`level${l}Id`]; receiverLevel = l; break; }
  }

  // Upper levels. L5 and L6 are paid OUT OF THE COMPANY'S SHARE, never out of the
  // receiver's. Each slot has a rate (a person's own, else the firm-wide one). A slot
  // with nobody in it rolls its rate up to the next person above; if nobody is above,
  // it stays with the company. A receiver at L5/L6 takes the slots up to and including
  // their own through the remainder (so L5 alone = 90%, L6 alone = 95%).
  // L7 is the company itself: whatever rate is typed on the L7 row is NOT paid to a
  // person. The company's own cut is companyExpensePct (less what L5/L6 take).
  const slotRate = (u, l) => {
    if (!u) return Math.max(0, globalLevels[l] || 0);
    const info = memberAsOf(teamMap.get(u), period);
    const cl = info?.customLevels, uL = info?.level;
    return Math.max(0,
      cl && cl[uL] !== undefined ? cl[uL]
      : cl && cl[l] !== undefined ? cl[l]
      : (globalLevels[l] || 0));
  };
  let fundedSum = 0;
  if (receiver) {
    for (let l = rl + 1; l <= 6; l++) {
      const u = h[`level${l}Id`];
      if (!u) continue;                                   // nobody here: this slot's share stays with the company
      if (u === receiver) { fundedSum += slotRate(u, l); continue; }
      if (paid.has(u)) continue;
      const pct = slotRate(u, l);
      if (pct <= 0) continue;
      const take = pct;
      paid.add(u);
      shares.push({ uid: u, level: l, amount: round4(gross * take / 100), kind: 'upper' });
      upperSum += take; fundedSum += take;
    }
  }
  const companyEff = Math.max(0, companyPct - fundedSum);

  const overDistributed = (lowerSum + upperSum) > 100 - companyEff + 0.0001;

  if (receiver && !paid.has(receiver)) {
    const surplus = Math.max(0, 100 - companyEff - lowerSum - upperSum);
    shares.push({ uid: receiver, level: receiverLevel, amount: round4(gross * surplus / 100), kind: 'residual' });
  }

  return { shares, lowerSum, upperSum, overDistributed };
}

/**
 * The breakdown object the ledger and the transaction rows store, from the shares.
 * Shape and rounding are exactly what the recompute has always written.
 */
export function breakdownFromShares(gross, split) {
  const levelPayouts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const userPayouts = {};
  let dist = 0;
  for (const s of split.shares) {
    if (s.kind === 'level') levelPayouts[s.level] = s.amount;
    else levelPayouts[s.level] = (levelPayouts[s.level] || 0) + s.amount;
    // A zero share is not recorded against the person, but a negative one (a
    // clawback) must deduct, so the test is "not zero", not "positive".
    if (s.amount !== 0) userPayouts[s.uid] = (userPayouts[s.uid] || 0) + s.amount;
    dist += s.amount;
  }
  const expenseAmount = Math.round((gross - dist) * 100) / 100;
  return {
    gross,
    expenseAmount,
    netPool: Math.round((gross - expenseAmount) * 100) / 100,
    levelPayouts,
    userPayouts,
  };
}
