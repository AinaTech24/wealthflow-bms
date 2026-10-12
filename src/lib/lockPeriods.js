/**
 * Locked months: a settled month is frozen. Recalculating (after an import, a rate
 * change, a promotion or a re-mapping) re-emits its stored payouts untouched, so a
 * figure that has been paid and invoiced can never move.
 *
 * Two small rules live here so they can be tested on their own.
 */

/**
 * Which months a "lock everything up to <through>" would newly lock: the months that
 * actually hold data, up to and including `through`, that are not locked yet.
 */
export function monthsToLock(through, periodsWithData, alreadyLocked = []) {
  if (!/^\d{4}-\d{2}$/.test(String(through || ''))) return [];
  const have = new Set(alreadyLocked);
  return [...new Set(periodsWithData)]
    .filter(p => /^\d{4}-\d{2}$/.test(p) && p <= through && !have.has(p))
    .sort();
}

/**
 * The locked list after an ordinary config save. A save may ADD locks but can never
 * remove one: the settings page sends its whole config, and a tab opened before a
 * month was locked would otherwise write the older, shorter list back and silently
 * unlock it. Removing a lock is its own deliberate action.
 */
export function mergeLocks(stored, incoming) {
  const a = Array.isArray(stored) ? stored : [];
  const b = Array.isArray(incoming) ? incoming : [];
  return [...new Set([...a, ...b].filter(p => /^\d{4}-\d{2}$/.test(String(p))))].sort();
}
