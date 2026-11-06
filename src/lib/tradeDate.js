/**
 * Reading the date column of a partner statement (Motilal's "Trade Date" and the like).
 *
 * WHY: a partner file carries no "this is the September file" field; the month is whatever
 * the dates say. The sheet reader hands every cell over as TEXT, formatted the way the cell
 * was formatted, so the same day can arrive as "01 Sep 2026", "01-Sep-26", "9/1/26",
 * "01/09/2026 10:30" or an Excel serial such as "46266". A date that could not be read used
 * to drop the line, or send the person to a "which month?" box for a file that has dates.
 *
 * Every function here is pure and returns null rather than guess on something that is not a
 * date, so a bad cell is reported instead of landing in the wrong month.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const fullYear = (y) => (y < 100 ? 2000 + y : y);

function iso(y, m, d) {
  if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;   // 31 Feb is not a date
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Drops a trailing clock time: "2026-09-01 00:00:00", "01/09/2026 10:30 AM", "2026-09-01T10:30:00Z". */
function withoutTime(raw) {
  return String(raw == null ? '' : raw).trim()
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(AM|PM)?\s*Z?$/i, '')
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '')     // "Tuesday, 01 Sep 2026"
    .replace(/^(\d{1,2})(st|nd|rd|th)\b/i, '$1')                      // "1st Sep 2026"
    .replace(/^([A-Za-z]{3,9}\.?\s+\d{1,2})(st|nd|rd|th)\b/i, '$1')   // "Sep 1st, 2026"
    .trim();
}

const NUMERIC = /^(\d{1,2})([/\-.])(\d{1,2})\2(\d{2}|\d{4})$/;   // 01/09/2026, 9/1/26, 01-09-26

/**
 * Which way round a column of all-numeric dates is written: 'dmy' (01/09/2026) or 'mdy' (9/1/26).
 * The values themselves decide when any of them can (a first or second part above 12). When nothing
 * decides, a 2-digit year with slashes is what the sheet reader prints for a real spreadsheet date
 * cell, month first; anything else is the Indian day-first way people type a date.
 */
export function detectDateOrder(values) {
  let dmy = 0, mdy = 0, seen = 0, slashShort = 0;
  for (const v of values || []) {
    const m = withoutTime(v).match(NUMERIC);
    if (!m) continue;
    seen++;
    const a = Number(m[1]), b = Number(m[3]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
    if (m[4].length === 2 && m[2] === '/') slashShort++;
  }
  if (dmy && !mdy) return 'dmy';
  if (mdy && !dmy) return 'mdy';
  return seen > 0 && slashShort === seen ? 'mdy' : 'dmy';
}

/**
 * 'YYYY-MM-DD' from any of the ways a statement writes a day, or null.
 * `order` only matters for all-numeric dates (see detectDateOrder); a value that cannot be that
 * order but can be the other (13/1/26) is read the other way rather than rejected.
 */
export function parseTradeDate(raw, order = 'dmy') {
  const s = withoutTime(raw);
  if (!s) return null;
  let m;

  // Excel serial day number ("46266"), when a date cell comes through unformatted.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n >= 36526 && n <= 73050) {                       // 2000-01-01 .. 2099-12-31
      const t = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    return null;
  }
  // 2026-09-01, 2026/09/01, 2026.09.01
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // 01 Sep 2026, 01-Sep-26, 1/Sep/2026, 01.Sep.2026
  if ((m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? iso(fullYear(Number(m[3])), mo, Number(m[1])) : null;
  }
  // Sep 1, 2026 / September 1 2026
  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? iso(fullYear(Number(m[3])), mo, Number(m[2])) : null;
  }
  // 01/09/2026, 9/1/26, 01-09-26
  if ((m = s.match(NUMERIC))) {
    const a = Number(m[1]), b = Number(m[3]), y = fullYear(Number(m[4]));
    let day = order === 'mdy' ? b : a, month = order === 'mdy' ? a : b;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return iso(y, month, day);
  }
  return null;
}

/** 'YYYY-MM' of a date written any of those ways, or null. */
export function monthOfDate(raw, order = 'dmy') {
  const d = parseTradeDate(raw, order);
  return d ? d.slice(0, 7) : null;
}

/**
 * The column of a statement that holds dates, found from its contents when the header does not
 * say so. A column counts when at least `minShare` of its filled cells read as a date; of those,
 * a header that mentions date / month / period wins, then the highest share, then the leftmost.
 * Returns { index, order, share } or null.
 */
export function findDateColumn(grid, headerRow = 0, minShare = 0.8) {
  const head = (grid && grid[headerRow]) || [];
  const body = (grid || []).slice(headerRow + 1).filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() !== ''));
  if (!body.length) return null;
  let best = null;
  for (let c = 0; c < head.length; c++) {
    const cells = body.map(r => r[c]).filter(v => String(v ?? '').trim() !== '');
    if (cells.length < Math.max(1, Math.ceil(body.length * 0.5))) continue;          // a mostly empty column is not the date column
    const order = detectDateOrder(cells);
    const good = cells.filter(v => parseTradeDate(v, order)).length;
    // A bare 5-digit number is only a date if the header says so; amounts and codes look like serials too.
    const hinted = /date|month|period/i.test(String(head[c] ?? ''));
    const allSerial = cells.every(v => /^\d{5}(\.\d+)?$/.test(String(v).trim()));
    if (allSerial && !hinted) continue;
    const share = good / cells.length;
    if (share < minShare) continue;
    const cand = { index: c, order, share, hinted };
    if (!best || (cand.hinted && !best.hinted) || (cand.hinted === best.hinted && cand.share > best.share + 1e-9)) best = cand;
  }
  return best ? { index: best.index, order: best.order, share: best.share } : null;
}
