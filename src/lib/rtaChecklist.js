/**
 * Which RTA files have been imported for a month, and which are still missing.
 *
 * The monthly flow is six files from two registrars (CAMS, Kfintech), plus CAMS's SIF statement:
 *   1. Transactions  - CAMS WBR2, Kfin MFSD201     (PAN + full names)
 *   2. Folio Master  - CAMS WBR9, Kfin MFSD211     (investor master)
 *   3. Brokerage     - CAMS, CAMS SIF, Kfin        (the money)
 * A month paid with one of them missing is wrong without anything saying so (September: the SIF file was never
 * imported and nobody noticed for weeks), so the Imports page asks this before anyone locks or pays a month.
 *
 * Transaction and brokerage files leave rows behind, so they are read from the transactions themselves. A folio master
 * only enriches clients and leaves nothing, so each master import is written to rta_import_log; a month that predates
 * that log is reported as 'unverified', never as missing.
 */

export const RTA_LOG_DDL = 'CREATE TABLE IF NOT EXISTS rta_import_log (id INT AUTO_INCREMENT PRIMARY KEY, period VARCHAR(20) NOT NULL, source VARCHAR(40) NOT NULL, fileName VARCHAR(255), rowsCount INT, createdBy VARCHAR(120), createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_ril_period (period, source))';

export const RTA_FILES = [
  { key: 'WBR2',    label: 'CAMS WBR2',    kind: 'Transactions', source: 'CAMS_WBR2',     step: 1 },
  { key: 'MFSD201', label: 'Kfin MFSD201', kind: 'Transactions', source: 'KARVY_MFSD201', step: 1 },
  { key: 'WBR9',    label: 'CAMS WBR9',    kind: 'Folio master', source: 'CAMS_WBR9',     step: 2, master: true },
  { key: 'MFSD211', label: 'Kfin MFSD211', kind: 'Folio master', source: 'KARVY_MFSD211', step: 2, master: true },
  { key: 'CAMS',    label: 'CAMS',         kind: 'Brokerage',    source: 'CAMS',          step: 3 },
  { key: 'SIF',     label: 'CAMS SIF',     kind: 'Brokerage',    source: 'CAMS',          step: 3, optional: true },
  { key: 'KFIN',    label: 'Kfin',         kind: 'Brokerage',    source: 'KARVY',         step: 3 },
];

/** Which checklist file a stored transaction belongs to. */
export function fileKeyOf({ source, sif }) {
  switch (String(source || '').toUpperCase()) {
    case 'CAMS_WBR2': return 'WBR2';
    case 'KARVY_MFSD201': return 'MFSD201';
    case 'CAMS': return sif ? 'SIF' : 'CAMS';
    case 'KARVY': case 'KFINTECH': return 'KFIN';
    default: return null;
  }
}

export const prevPeriod = (p) => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

/**
 * @param {{period:string, key:string, rows:number, gross:number, fileName?:string}[]} found  one entry per month + file seen in the transactions
 * @param {{period:string, key:string, fileName?:string, rows?:number}[]} logged             folio master imports from rta_import_log
 * @param {string[]} periods                                                                  the months to report, oldest first
 */
export function buildChecklist({ found, logged, periods }) {
  const foundBy = new Map(found.map(f => [`${f.period}|${f.key}`, f]));
  const loggedBy = new Map(); for (const l of logged) if (!loggedBy.has(`${l.period}|${l.key}`)) loggedBy.set(`${l.period}|${l.key}`, l);
  const firstLog = {}; for (const l of logged) if (!firstLog[l.key] || l.period < firstLog[l.key]) firstLog[l.key] = l.period;
  const firstSeen = {}; for (const f of found) if (!firstSeen[f.key] || f.period < firstSeen[f.key]) firstSeen[f.key] = f.period;
  const months = periods.map(period => {
    const files = RTA_FILES.map(f => {
      const hit = f.master ? loggedBy.get(`${period}|${f.key}`) : foundBy.get(`${period}|${f.key}`);
      const base = { key: f.key, label: f.label, kind: f.kind, source: f.source, step: f.step, optional: !!f.optional };
      if (hit) return { ...base, status: 'done', rows: hit.rows ?? 0, gross: hit.gross ?? 0, fileName: hit.fileName || '' };
      if (f.master) {
        // Nothing to check before the first logged master import: say so instead of calling it missing.
        const first = firstLog[f.key];
        return { ...base, status: first && period > first ? 'missing' : 'unverified', rows: 0, gross: 0, fileName: '' };
      }
      if (f.key === 'SIF') {
        // CAMS only sends a SIF statement when it has SIF brokerage, so it is expected only when one of the last three months had it.
        let p = period, seen = false;
        for (let i = 0; i < 3 && !seen; i++) { p = prevPeriod(p); seen = foundBy.has(`${p}|SIF`); }
        return { ...base, status: seen ? 'missing' : 'not_expected', rows: 0, gross: 0, fileName: '' };
      }
      // A file counts as missing only once it has been imported for an earlier month, so months from before a file was
      // part of the routine (WBR2 / MFSD201 start in June 2026) are not reported as gaps.
      const first = firstSeen[f.key];
      return { ...base, status: first && period > first ? 'missing' : 'not_expected', rows: 0, gross: 0, fileName: '' };
    });
    const done = files.filter(f => f.status === 'done').length;
    return { period, started: done > 0, files, missing: files.filter(f => f.status === 'missing').map(f => f.key) };
  });
  return months;
}
