/**
 * Reading an AMC's brokerage rate card that arrives as a spreadsheet (xlsx, xls, csv) in whatever layout the AMC chose.
 *
 * PDFs have their own extractor. A spreadsheet has no fixed shape: the header may sit under a title block, the rate
 * may be "1.05%", 1.05 or 0.0105, and there may be several rate columns (first year, second year...). So the layout is
 * GUESSED here, shown to the person for correction, and remembered by its header names so the next file from the same
 * AMC needs no clicking.
 */

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const lower = (v) => clean(v).toLowerCase();

/** "1.05%" -> 1.05, "1,05" is not guessed, 1.05 -> 1.05, "" / "NA" / "-" -> null. A bare number keeps its value. */
export function parseRate(v) {
  const s = clean(v);
  if (!s || /^(na|n\/a|nil|-+|--)$/i.test(s)) return null;
  const n = parseFloat(s.replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const hasPercentSign = (v) => /%/.test(String(v ?? ''));

const SCHEME_H = /scheme|fund name|name of (the )?(scheme|fund)|product/;
const RATE_H = /trail|brokerage|commission|payout|rate|%/;
const CATEGORY_H = /category|asset class|type|class/;
const AMC_H = /^(amc|fund house|mutual fund|amc name)$/;

/** Which row is the header: the first of the top 20 with two or more filled cells, one of which names the scheme. */
export function findHeaderRow(grid) {
  const top = grid.slice(0, 20);
  for (let i = 0; i < top.length; i++) {
    const cells = (top[i] || []).map(lower).filter(Boolean);
    if (cells.length >= 2 && cells.some(c => SCHEME_H.test(c))) return i;
  }
  for (let i = 0; i < top.length; i++) if ((top[i] || []).filter(c => clean(c)).length >= 2) return i;
  return 0;
}

/** A best guess at the layout, as column NUMBERS (so the screen can show it) plus the header names (so it can be remembered). */
export function detectLayout(grid, forcedHeaderRow) {
  if (!grid || !grid.length) return null;
  const headerRow = Number.isInteger(forcedHeaderRow) ? forcedHeaderRow : findHeaderRow(grid);
  const headers = (grid[headerRow] || []).map(clean);
  const body = grid.slice(headerRow + 1).filter(r => (r || []).some(c => clean(c)));
  const colVals = (c) => body.map(r => r[c]);
  const idx = (re) => headers.findIndex(h => re.test(h.toLowerCase()));

  let schemeCol = idx(SCHEME_H);
  if (schemeCol < 0) {
    // the column whose cells are longest text
    let best = -1, bestLen = 0;
    headers.forEach((_, c) => {
      const texts = colVals(c).map(clean).filter(v => v && parseRate(v) === null);
      const avg = texts.length ? texts.reduce((a, t) => a + t.length, 0) / texts.length : 0;
      if (avg > bestLen) { bestLen = avg; best = c; }
    });
    schemeCol = best;
  }
  const rateLike = (c) => { const vals = colVals(c).map(parseRate).filter(v => v !== null); return vals.length >= Math.max(2, Math.floor(body.length * 0.3)); };
  let rateCol = headers.findIndex((h, c) => c !== schemeCol && RATE_H.test(h.toLowerCase()) && rateLike(c));
  if (rateCol < 0) rateCol = headers.findIndex((h, c) => c !== schemeCol && rateLike(c));
  const categoryCol = headers.findIndex((h, c) => c !== schemeCol && c !== rateCol && CATEGORY_H.test(h.toLowerCase()));
  const amcCol = headers.findIndex((h, c) => c !== schemeCol && c !== rateCol && AMC_H.test(h.toLowerCase()));
  const layout = { headerRow, schemeCol, rateCol, categoryCol, amcCol, unit: 'percent' };
  layout.unit = guessUnit(grid, layout);
  return layout;
}

/** 'fraction' when the rate column holds 0.0105-style values (nothing above 0.1, no % signs), otherwise 'percent'. */
export function guessUnit(grid, layout) {
  if (layout.rateCol < 0) return 'percent';
  const raw = grid.slice(layout.headerRow + 1).map(r => r[layout.rateCol]);
  if (raw.some(hasPercentSign)) return 'percent';
  const vals = raw.map(parseRate).filter(v => v !== null && v > 0);
  if (!vals.length) return 'percent';
  return Math.max(...vals) <= 0.1 ? 'fraction' : 'percent';
}

/** Category from the scheme's own words when the sheet has no category column. */
export function inferCategory(name) {
  const s = String(name || '').toLowerCase();
  if (/\betf\b|\bfof\b|fund of fund/.test(s)) return 'ETF';
  if (/index|nifty|sensex/.test(s)) return 'Index';
  if (/liquid|overnight|money market|ultra short|low duration/.test(s)) return 'Liquid';
  if (/gilt|bond|debt|duration|credit|income|short term|corporate|banking & psu|psu/.test(s)) return 'Debt';
  if (/hybrid|balanced|arbitrage|multi asset|allocation|savings/.test(s)) return 'Hybrid';
  return 'Equity';
}

/** Rows ready for the preview, in the same shape the PDF extractor produces. */
export function rowsFromGrid(grid, layout, { amcName = '', sourceFile = '' } = {}) {
  if (!grid || !layout || layout.schemeCol < 0 || layout.rateCol < 0) return { rows: [], skipped: 0 };
  const rows = []; let skipped = 0;
  for (const r of grid.slice(layout.headerRow + 1)) {
    if (!r || !r.some(c => clean(c))) continue;
    const scheme = clean(r[layout.schemeCol]);
    const rawRate = r[layout.rateCol];
    const n = parseRate(rawRate);
    // A section line ("Equity Schemes") or a footnote has a name but no rate: not a scheme.
    if (!scheme || n === null) { if (scheme && /scheme|fund|plan/i.test(scheme)) skipped++; continue; }
    const rate = layout.unit === 'fraction' ? n * 100 : n;
    if (!(rate > 0)) { skipped++; continue; }
    rows.push({
      amcName: clean(layout.amcCol >= 0 ? r[layout.amcCol] : '') || amcName,
      schemeName: scheme,
      category: clean(layout.categoryCol >= 0 ? r[layout.categoryCol] : '') || inferCategory(scheme),
      trailRate: Math.round(rate * 10000) / 10000,
      sourceFile,
      rawLine: r.map(clean).filter(Boolean).join(' | ').slice(0, 200),
    });
  }
  return { rows, skipped };
}

/** The layout as header NAMES, so it still applies when the AMC moves a column. */
export function layoutToNames(grid, layout) {
  const h = (grid[layout.headerRow] || []).map(clean);
  const nm = (c) => (c >= 0 ? h[c] || '' : '');
  return { schemeHeader: nm(layout.schemeCol), rateHeader: nm(layout.rateCol), categoryHeader: nm(layout.categoryCol), amcHeader: nm(layout.amcCol), unit: layout.unit };
}

/** A remembered layout (header names) applied to a new sheet. Null when the sheet does not have those headers. */
export function layoutFromNames(grid, saved) {
  if (!grid || !saved || !saved.schemeHeader || !saved.rateHeader) return null;
  const top = grid.slice(0, 20);
  for (let i = 0; i < top.length; i++) {
    const h = (top[i] || []).map(clean);
    const at = (name) => (name ? h.findIndex(x => x.toLowerCase() === name.toLowerCase()) : -1);
    const schemeCol = at(saved.schemeHeader), rateCol = at(saved.rateHeader);
    if (schemeCol >= 0 && rateCol >= 0) return { headerRow: i, schemeCol, rateCol, categoryCol: at(saved.categoryHeader), amcCol: at(saved.amcHeader), unit: saved.unit === 'fraction' ? 'fraction' : 'percent' };
  }
  return null;
}

/** What identifies "the same kind of sheet again": its header names. */
export function sheetSignature(grid, layout) {
  return (grid[layout.headerRow] || []).map(c => clean(c).toLowerCase()).filter(Boolean).join('|').slice(0, 180);
}
