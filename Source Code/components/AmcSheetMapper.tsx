import React, { useMemo, useState } from 'react';
import { X, FileSpreadsheet } from 'lucide-react';
import { detectLayout, rowsFromGrid, parseRate } from '../../src/lib/amcSheet.js';

export interface SheetLayout { headerRow: number; schemeCol: number; rateCol: number; categoryCol: number; amcCol: number; unit: 'percent' | 'fraction' }
export interface MappedRows { rows: any[]; layout: SheetLayout; amcName: string; remember: boolean }

const cell = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * "What do the columns of this AMC file mean?" A rate card can arrive in any spreadsheet layout, so the page guesses
 * (header row, scheme column, rate column, unit), shows what that would import, and lets the person correct it.
 * Remembering the layout means the next file from the same AMC needs no clicking at all.
 */
export const AmcSheetMapper: React.FC<{
  fileName: string; grid: string[][]; initial: SheetLayout | null; amcName: string;
  onCancel: () => void; onDone: (r: MappedRows) => void;
}> = ({ fileName, grid, initial, amcName, onCancel, onDone }) => {
  const start: SheetLayout = initial || detectLayout(grid) || { headerRow: 0, schemeCol: 0, rateCol: 1, categoryCol: -1, amcCol: -1, unit: 'percent' };
  const [layout, setLayout] = useState<SheetLayout>(start);
  const [amc, setAmc] = useState(amcName);
  const [remember, setRemember] = useState(true);

  const headers = (grid[layout.headerRow] || []).map((h, i) => cell(h) || `Column ${i + 1}`);
  const maxCols = Math.max(...grid.slice(0, 30).map(r => (r || []).length), 1);
  const colName = (i: number) => headers[i] || `Column ${i + 1}`;
  const colIdx = Array.from({ length: maxCols }, (_, i) => i);
  const result = useMemo(() => rowsFromGrid(grid, layout, { amcName: amc, sourceFile: fileName }), [grid, layout, amc, fileName]);
  const set = (patch: Partial<SheetLayout>) => setLayout(l => ({ ...l, ...patch }));
  const sample = grid.slice(layout.headerRow + 1).map(r => parseRate(r[layout.rateCol])).filter((v): v is number => v !== null && v > 0);
  const lookOdd = sample.length > 0 && (layout.unit === 'percent' ? Math.max(...sample) > 3.5 : Math.max(...sample) * 100 > 3.5);

  const sel = 'w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-xs';
  const lab = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1';
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="What do the columns mean">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-100 dark:border-slate-700">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100">What do the columns of this file mean?</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{fileName} — this layout was not seen before. Check the guess, fix anything wrong, then use the rows.</p>
            </div>
          </div>
          <button onClick={onCancel} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 grid grid-cols-2 gap-3">
          <div>
            <label className={lab}>Header row</label>
            <select className={sel} value={layout.headerRow} onChange={e => setLayout(detectOn(grid, Number(e.target.value), layout))}>
              {grid.slice(0, 20).map((r, i) => <option key={i} value={i}>Row {i + 1}: {(r || []).map(cell).filter(Boolean).slice(0, 4).join(' · ').slice(0, 60) || '(empty)'}</option>)}
            </select>
          </div>
          <div>
            <label className={lab}>AMC name</label>
            <input className={sel} value={amc} onChange={e => setAmc(e.target.value)} placeholder="e.g. Groww Mutual Fund" />
          </div>
          <div>
            <label className={lab}>Scheme name column</label>
            <select className={sel} value={layout.schemeCol} onChange={e => set({ schemeCol: Number(e.target.value) })}>
              {colIdx.map(i => <option key={i} value={i}>{colName(i)}</option>)}
            </select>
          </div>
          <div>
            <label className={lab}>Rate column (the brokerage / trail %)</label>
            <select className={sel} value={layout.rateCol} onChange={e => set({ rateCol: Number(e.target.value) })}>
              {colIdx.map(i => <option key={i} value={i}>{colName(i)}</option>)}
            </select>
          </div>
          <div>
            <label className={lab}>Category column <span className="font-normal normal-case tracking-normal">(optional)</span></label>
            <select className={sel} value={layout.categoryCol} onChange={e => set({ categoryCol: Number(e.target.value) })}>
              <option value={-1}>None — work it out from the scheme name</option>
              {colIdx.map(i => <option key={i} value={i}>{colName(i)}</option>)}
            </select>
          </div>
          <div>
            <label className={lab}>Rates are written as</label>
            <select className={sel} value={layout.unit} onChange={e => set({ unit: e.target.value as 'percent' | 'fraction' })}>
              <option value="percent">Percent (1.05 or 1.05%)</option>
              <option value="fraction">Fraction (0.0105 means 1.05%)</option>
            </select>
          </div>
        </div>

        <div className="px-5 pb-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
            This would import {result.rows.length} scheme{result.rows.length !== 1 ? 's' : ''}{result.skipped ? ` (${result.skipped} line${result.skipped !== 1 ? 's' : ''} skipped)` : ''}
          </p>
          {lookOdd && <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-1">Some rates are above 3.5% — check the rate column and the unit.</p>}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-[9px] uppercase tracking-widest">
                <tr><th className="text-left px-3 py-1.5">Scheme</th><th className="text-left px-3 py-1.5">Category</th><th className="text-right px-3 py-1.5">Rate %</th></tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 6).map((r, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-700/50">
                    <td className="px-3 py-1.5 text-slate-800 dark:text-slate-200">{r.schemeName}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.category}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.trailRate}</td>
                  </tr>
                ))}
                {result.rows.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-slate-400">No schemes found with these columns.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 p-5">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Remember this layout — the next file with these column names is read automatically
          </label>
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
            <button disabled={result.rows.length === 0} onClick={() => onDone({ rows: result.rows, layout, amcName: amc, remember })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-40">Use these rows</button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Moving the header row re-guesses the columns from the new header, keeping the unit the person already chose. */
function detectOn(grid: string[][], headerRow: number, prev: SheetLayout): SheetLayout {
  const g = detectLayout(grid, headerRow) as SheetLayout | null;
  if (!g) return { ...prev, headerRow };
  return { ...g, headerRow, unit: prev.unit };
}
