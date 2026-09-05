/// <reference lib="webworker" />

// Web Worker that runs xlsx parsing off the main thread.
// The main app posts { buffer: ArrayBuffer } and gets back { ok, jsonData, sheetName }.
// Without this, XLSX.read() blocks the UI thread for 10–60s on multi-MB files,
// which triggers Chrome's "Page Unresponsive" dialog.
//
// `xlsx` is dynamically imported INSIDE the worker so the main bundle never
// pays its weight (the worker chunk gets loaded only when an import starts).

interface ParseRequest {
  buffer: ArrayBuffer;
}

interface ParseProgress {
  type: 'progress';
  stage: 'loading' | 'reading' | 'extracting' | 'done';
  msg: string;
}

interface ParseSuccess {
  ok: true;
  jsonData: any[][];
  sheetName: string;
  rowCount: number;
  ms: number;
}

interface ParseFailure {
  ok: false;
  error: string;
}

const post = (m: ParseProgress | ParseSuccess | ParseFailure) =>
  (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const t0 = Date.now();
  try {
    post({ type: 'progress', stage: 'loading', msg: 'Loading xlsx parser…' });
    const XLSX = await import('xlsx');

    post({ type: 'progress', stage: 'reading', msg: 'Reading workbook…' });
    const data = new Uint8Array(e.data.buffer);
    // dense:true → flat typed-array internal representation, much less memory
    //              + faster GC for big files (45MB CAMS .xls).
    // cellDates / cellNF / cellStyles all OFF — we don't render styled cells,
    // and we re-parse dates from raw strings during processData.
    const workbook = XLSX.read(data, {
      type: 'array',
      dense: true,
      cellDates: false,
      cellNF: false,
      cellStyles: false,
      cellHTML: false,
      cellFormula: false,
    });

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('Workbook has no sheets.');
    const worksheet = workbook.Sheets[sheetName];

    post({ type: 'progress', stage: 'extracting', msg: `Extracting rows from "${sheetName}"…` });

    // ── Fix scientific-notation folios ───────────────────────────────────────
    // Excel stores 12+ digit numbers (long BSE/NSE/Karvy folios like
    // 910209065875) as numbers and DISPLAYS them as "9.10209E+11". With
    // raw:false, sheet_to_json returns that lossy display string — which mangles
    // the folio and, worse, MERGES distinct folios (their transaction IDs then
    // collide and overwrite each other, losing brokerage). The raw numeric value
    // (cell.v) is intact, so rewrite the formatted text (cell.w) to the full
    // integer for any numeric cell rendered in scientific notation.
    const deScientify = (cell: any) => {
      if (cell && cell.t === 'n' && typeof cell.w === 'string' && /\de[+-]?\d/i.test(cell.w) && Number.isFinite(cell.v)) {
        cell.w = Number.isInteger(cell.v) ? String(cell.v) : cell.v.toFixed(6).replace(/\.?0+$/, '');
      }
    };
    for (const key in worksheet) {
      if (key[0] === '!') continue;
      const entry = (worksheet as any)[key];
      // dense:true stores each row as an array of cells under integer keys;
      // sparse mode stores individual cells under "A1"-style keys.
      if (Array.isArray(entry)) { for (const cell of entry) deScientify(cell); }
      else deScientify(entry);
    }

    // raw:false coerces values to strings, matching what our import code expects.
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: '',
    }) as any[][];

    post({ type: 'progress', stage: 'done', msg: `Parsed ${jsonData.length.toLocaleString()} rows` });
    post({
      ok: true,
      jsonData,
      sheetName,
      rowCount: jsonData.length,
      ms: Date.now() - t0,
    });
  } catch (err: any) {
    const reason = err?.message || String(err);
    post({ ok: false, error: `XLSX parse failed after ${Date.now() - t0}ms: ${reason}` });
  }
};

export {};
