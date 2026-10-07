/**
 * Plan the move of a whole branch under a new manager.
 *
 * WHY THIS EXISTS
 * Manish Singh used to be the BM (L4). He was promoted to L5, and a new firm,
 * MSA FINANCIAL SERVICES LLP, was made the L4 under him. The app moved his clients'
 * placement from the L4 slot to the L5 slot as it should — but nothing put the new
 * L4 into those clients, and the RMs who reported to Manish still report to him
 * rather than to the LLP. So 32 clients carry no BM at all, the LLP appears on none
 * of them, and everything the comparison reports for MSA at BM level is wrong.
 *
 * Doing it by hand means finding 32 clients and 2 team members one at a time.
 *
 * WHAT IT DOES
 *   - Every team member whose parent is `fromId` (except `toId` itself) is moved to
 *     report to `toId`.
 *   - Every client that has `fromId` in ANY slot and an EMPTY slot at `toId`'s level
 *     gets `toId` placed in that slot.
 *
 * WHAT IT NEVER DOES
 *   - Overwrite a slot that already holds someone. A client whose L4 is already
 *     filled is reported as skipped, not changed — that is somebody's decision.
 *   - Touch a transaction, a payout, an invoice or a payment.
 *
 * Pure function: no database, no clock. The caller applies what it returns.
 */

/**
 * @param {{clients: Array<{id:string,name?:string,hierarchy?:Object}>,
 *          team: Array<{id:string,name?:string,level:number,parentId?:string|null}>,
 *          fromId: string, toId: string}} input
 */
export function planBranchRestructure({ clients, team, fromId, toId }) {
  const from = team.find(t => t.id === fromId);
  const to = team.find(t => t.id === toId);
  if (!from) return { error: 'The manager to move people away from was not found.' };
  if (!to) return { error: 'The manager to move people under was not found.' };
  if (fromId === toId) return { error: 'Choose two different people.' };

  const level = Number(to.level);
  if (!(level >= 1 && level <= 7)) return { error: `${to.name} has no valid level to place clients at.` };
  const slot = `level${level}Id`;

  const clientChanges = [];
  const skipped = [];
  for (const c of clients) {
    const h = c.hierarchy || {};
    const underFrom = Object.keys(h).some(k => /^level[0-7]Id$/.test(k) && h[k] === fromId);
    if (!underFrom) continue;
    if (h[slot] === toId) continue;                    // already there — nothing to do
    if (h[slot]) {                                     // someone else holds the slot: leave it
      skipped.push({ id: c.id, name: c.name || c.id, holder: h[slot] });
      continue;
    }
    clientChanges.push({ id: c.id, name: c.name || c.id, slot, toId });
  }

  const teamChanges = team
    .filter(t => t.parentId === fromId && t.id !== toId)
    .map(t => ({ id: t.id, name: t.name || t.id, level: t.level, fromParent: fromId, toParent: toId }));

  return { slot, level, from: from.name, to: to.name, clientChanges, teamChanges, skipped };
}
