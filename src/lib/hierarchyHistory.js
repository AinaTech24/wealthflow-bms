/**
 * A client's chain of people, AS OF a brokerage month, and the planner that moves a
 * promoted person's clients up a level from a chosen month.
 *
 * WHY: a client's chain (level1Id..level7Id) used to be a single snapshot. Promoting
 * someone moved their clients' slots for EVERY month, so a month already paid at the
 * old level would, on the next recalculation, be rebuilt with the new chain. Locking
 * the month protected it; nothing else did.
 *
 * HOW: the client keeps its CURRENT chain exactly as before (every screen keeps
 * reading it). When a promotion applies from month M, the arrangement that was in
 * force until then is saved as a snapshot "valid before M":
 *
 *     hierarchyHistory: [ { before: '2026-09', hierarchy: {...older chain...}, leadSourceLevel: 2 } ]
 *
 * The lead-source level is part of the snapshot: if it follows the promotion, earlier
 * months must still pay the lead bonus at the old slot.
 *
 * For a period P the chain is the snapshot with the smallest `before` greater than P,
 * and the current chain when there is none. Only OLDER chains are stored, so a manual
 * edit of the current chain (the Clients page) still takes effect from the last
 * promotion month onward, just as it always did. A client with no history behaves
 * exactly as before.
 */

/**
 * The month a promotion applies from, as sent by the member form: 'YYYY-MM', or
 * '0000-01' meaning "all months". Anything else (blank, malformed) falls back to
 * `fallback`, normally the current month.
 */
export function effectiveMonthOr(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim();
  return /^\d{4}-\d{2}$/.test(s) ? s : fallback;
}

/** 'YYYY-MM' one month earlier. */
export function monthBefore(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return period;
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The chain AND lead-source level in force for `period`.
 * `client` = { hierarchy, hierarchyHistory, leadSourceLevel }.
 */
export function chainAsOf(client, period) {
  if (!client) return { hierarchy: undefined, leadSourceLevel: undefined };
  const hist = client.hierarchyHistory;
  if (!period || !Array.isArray(hist) || hist.length === 0) {
    return { hierarchy: client.hierarchy, leadSourceLevel: client.leadSourceLevel };
  }
  const p = String(period);
  let best = null;
  for (const e of hist) {
    if (!e || !e.before || !e.hierarchy) continue;
    const b = String(e.before);
    if (p < b && (!best || b < String(best.before))) best = e;
  }
  return best
    ? { hierarchy: best.hierarchy, leadSourceLevel: best.leadSourceLevel }
    : { hierarchy: client.hierarchy, leadSourceLevel: client.leadSourceLevel };
}

/** The chain in force for `period`. */
export function hierarchyAsOf(client, period) {
  return chainAsOf(client, period).hierarchy;
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7];
const sameChain = (a, b) => SLOTS.every(l => String((a || {})[`level${l}Id`] || '') === String((b || {})[`level${l}Id`] || ''));

/** Drop snapshots that say nothing new (identical to the chain that follows them). */
function normalise(history, current, leadNow) {
  const sorted = history.filter(e => e && e.before && e.hierarchy)
    .sort((a, b) => String(a.before).localeCompare(String(b.before)));
  const kept = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const after = kept.length ? kept[0].hierarchy : current;     // the chain applying once this snapshot ends
    const afterLead = kept.length ? kept[0].leadSourceLevel : leadNow;
    if (!sameChain(sorted[i].hierarchy, after) || Number(sorted[i].leadSourceLevel || 0) !== Number(afterLead || 0)) kept.unshift(sorted[i]);
  }
  return kept;
}

/**
 * Move one person from level `from` to level `to` on every client that has them at
 * `from`, from `effectiveFrom` onward.
 *
 *   effectiveFrom  'YYYY-MM', or '0000-01' for "all months" (a correction: the chain
 *                  is simply changed, with no history kept).
 *   occupied       what to do when `to` already holds someone else on a client:
 *                    'keep'    leave that client alone and report it (the default)
 *                    'replace' put the promoted person there; the previous holder
 *                              leaves that client's chain
 *   toId           optional: promote into this slot a person other than `personId`
 *                  is NOT supported; the mover is always `personId`.
 *
 * Pure: returns the plan; nothing is written. `clients` = [{ id, name, hierarchy,
 * hierarchyHistory, leadSourceLevel }].
 *
 * @returns {{ moves: Array<{id,name,status,hierarchy,hierarchyHistory,leadSourceLevel,replacedId?}>,
 *             blocked: Array<{id,name,heldBy}>, counts: {moved,replaced,blocked} }}
 */
export function planLevelMove({ clients, personId, from, to, effectiveFrom, occupied = 'keep' }) {
  const moves = [], blocked = [];
  const M = /^\d{4}-\d{2}$/.test(String(effectiveFrom || '')) ? String(effectiveFrom) : '0000-01';
  const fromKey = `level${from}Id`, toKey = `level${to}Id`;

  const shift = (h) => {          // the same person, one slot up/down; null when it cannot be done
    if (!h || String(h[fromKey] || '') !== personId) return null;
    const holder = String(h[toKey] || '');
    if (holder && holder !== personId && occupied !== 'replace') return { blockedBy: holder };
    const next = { ...h, [fromKey]: '', [toKey]: personId };
    return { next, replacedId: holder && holder !== personId ? holder : undefined };
  };

  for (const c of clients) {
    const cur = c.hierarchy || {};
    const r = shift(cur);
    if (!r) continue;                                   // this client does not have them at `from`
    if (r.blockedBy) { blocked.push({ id: c.id, name: c.name, heldBy: r.blockedBy }); continue; }

    let history = Array.isArray(c.hierarchyHistory) ? c.hierarchyHistory.map(e => ({ before: e.before, hierarchy: { ...e.hierarchy }, leadSourceLevel: e.leadSourceLevel })) : [];
    const shiftLead = (v) => (Number(v) === from ? to : v);
    if (M !== '0000-01') {
      // What applied the month before the promotion: that is what earlier months keep.
      const base = chainAsOf({ hierarchy: cur, hierarchyHistory: history, leadSourceLevel: c.leadSourceLevel }, monthBefore(M));
      // Snapshots covering months from M onward must reflect the promotion too. If one
      // of them cannot take it (the slot is held by someone else there), applying the
      // move to only part of the timeline would leave a client paying two different
      // chains for the same months, so the client is reported instead.
      let clash = null;
      history = history.map(e => {
        if (String(e.before) <= M) return e;
        const moved = shift(e.hierarchy);
        if (moved && moved.blockedBy) { clash = moved.blockedBy; return e; }
        return moved && moved.next ? { before: e.before, hierarchy: moved.next, leadSourceLevel: shiftLead(e.leadSourceLevel) } : e;
      });
      if (clash) { blocked.push({ id: c.id, name: c.name, heldBy: clash }); continue; }
      if (!history.some(e => String(e.before) === M)) history.push({ before: M, hierarchy: { ...base.hierarchy }, leadSourceLevel: base.leadSourceLevel });
      history = normalise(history, r.next, shiftLead(c.leadSourceLevel));
    }

    const lead = shiftLead(c.leadSourceLevel);
    moves.push({
      id: c.id, name: c.name,
      status: r.replacedId ? 'replaced' : 'moved',
      hierarchy: r.next, hierarchyHistory: history, leadSourceLevel: lead,
      ...(r.replacedId ? { replacedId: r.replacedId } : {}),
    });
  }
  return {
    moves, blocked,
    counts: {
      moved: moves.filter(m => m.status === 'moved').length,
      replaced: moves.filter(m => m.status === 'replaced').length,
      blocked: blocked.length,
    },
  };
}
