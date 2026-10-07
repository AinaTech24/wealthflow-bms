/**
 * Which client record should hold a folio, given the RM who owns it?
 *
 * An investor can be filed as several records ("Amit Parshotam Menghani" exists four
 * times). When the firm decides a folio belongs to one RM, one record under that RM
 * has to keep it and the rest let go. This picks the record that keeps it.
 *
 * Preference, in order:
 *   1. records that carry the RM at level 3 — the usual "RM" slot;
 *   2. otherwise records that carry the RM in ANY slot (an RM graded L1 or L2 sits
 *      elsewhere, and must still be assignable);
 * and among those, the record that already holds the MOST folios — the fullest, most
 * established one — with the id as a stable tie-break, so running it twice picks the
 * same record both times.
 *
 * Returns null when no record under that RM claims the folio at all. It never invents
 * a record and never adds a folio to one.
 *
 * @param {Array<{id:string, folios?:string[], hierarchy?:Object}>} records
 *        the records that currently claim this folio
 * @param {string} rmId
 */
export function pickOwnerRecord(records, rmId) {
  if (!rmId) return null;
  const atL3 = records.filter(r => (r.hierarchy || {}).level3Id === rmId);
  const anySlot = records.filter(r => Object.values(r.hierarchy || {}).includes(rmId));
  const pool = atL3.length ? atL3 : anySlot;
  if (!pool.length) return null;
  return [...pool].sort((a, b) =>
    (b.folios || []).length - (a.folios || []).length || String(a.id).localeCompare(String(b.id)))[0];
}
