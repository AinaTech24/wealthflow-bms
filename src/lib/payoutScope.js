/**
 * Who may see which rows of the payout overview.
 *
 * `payout_overview` builds the whole firm's earned / paid / owed table (every
 * person, every month, every product). ADMIN and FINANCE read all of it. Everyone
 * else (RMs, BMs) gets the same table cut down to their OWN row, so they can see
 * their month-by-month earnings without ever being sent a colleague's figures.
 *
 * The cut is made here, on the finished body, so the cached copy stays complete
 * and one expensive build serves every viewer.
 */
export function scopePayoutOverview(body, user, isWriter) {
  if (isWriter) return body;
  const me = user && user.id;
  return {
    ...body,
    people: me ? (body.people || []).filter(p => p.userId === me) : [],
  };
}
