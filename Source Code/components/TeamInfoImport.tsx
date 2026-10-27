import React, { useMemo, useState } from 'react';
import { X, FileSpreadsheet, AlertTriangle, CheckCircle2, Loader2, UserX } from 'lucide-react';
import { authFetch } from '../contexts/DataContext';
import { useToast } from './Toast';
import { TeamMember } from '../types';
import { FIELDS, detectColumns, readRows, matchRows, diffFor, maskAccount } from '../../src/lib/teamImport.js';

type Columns = Record<string, number>;
const cell = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
const MASK = (key: string, v: string) => (key === 'accountNumber' ? maskAccount(v) : v);

/**
 * Update RMs' and BMs' basic details from an Excel sheet, REVIEW FIRST.
 *   1. choose the file            2. check which column is which
 *   3. see who was found, who was not, and exactly what would change for each person
 *   4. tick the people, confirm, apply.
 * Sharing %, level, role and hierarchy are not on offer: the server only accepts the fields listed in src/lib/teamImport.js.
 */
export const TeamInfoImport: React.FC<{ team: TeamMember[]; onClose: () => void; onApplied: () => void }> = ({ team, onClose, onApplied }) => {
  const { showToast, showConfirm } = useToast();
  const [step, setStep] = useState<'file' | 'columns' | 'review' | 'done'>('file');
  const [fileName, setFileName] = useState('');
  const [grid, setGrid] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [columns, setColumns] = useState<Columns>({});
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [notFoundOpen, setNotFoundOpen] = useState(false);
  const [outcome, setOutcome] = useState<{ applied: number; rejected: Array<{ name?: string; id: string; why: string }> } | null>(null);

  const headers = (grid[headerRow] || []).map((h, i) => cell(h) || `Column ${i + 1}`);
  const maxCols = Math.max(...grid.slice(0, 20).map(r => (r || []).length), 1);

  const readFile = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData(); form.append('file', file);
      const res = await authFetch('/api/parse-sheet', { method: 'POST', body: form });
      const j = await res.json();
      if (!j?.ok || !Array.isArray(j.jsonData) || j.jsonData.length < 2) { showToast('Could not read that file. Use an Excel (.xlsx, .xls) or CSV file with a header row.', 'error'); return; }
      const g: string[][] = j.jsonData;
      const det = detectColumns(g);
      setGrid(g); setFileName(file.name); setHeaderRow(det.headerRow); setColumns(det.columns); setStep('columns');
    } catch { showToast('Could not read that file.', 'error'); } finally { setBusy(false); }
  };

  const redetect = (row: number) => { const det = detectColumns(grid, row); setHeaderRow(row); setColumns(det.columns); };

  const rows = useMemo(() => (step === 'review' || step === 'done') ? readRows(grid, headerRow, columns) : [], [step, grid, headerRow, columns]);
  const results = useMemo(() => matchRows(rows, team as any[]), [rows, team]);
  const plan = useMemo(() => results.map(r => ({ ...r, diff: r.status === 'matched' ? diffFor(r.person, r.row.values) : [] })), [results]);
  const toChange = plan.filter(p => p.status === 'matched' && p.diff.length > 0);
  const upToDate = plan.filter(p => p.status === 'matched' && p.diff.length === 0);
  const notFound = plan.filter(p => p.status === 'not_found');
  const ambiguous = plan.filter(p => p.status === 'ambiguous');
  const duplicates = plan.filter(p => p.status === 'duplicate');

  const goReview = () => {
    if (columns.name === undefined && columns.pan === undefined) { showToast('Choose the column that holds the RM / BM name (or PAN) first.', 'warning'); return; }
    if (!FIELDS.some(f => columns[f.key] !== undefined && f.key !== 'pan')) { showToast('Choose at least one column to import (ARN, EUIN, email, GST, address or bank).', 'warning'); return; }
    setStep('review');
  };
  // tick everyone with changes once, when the review is first computed
  React.useEffect(() => {
    if (step !== 'review') return;
    setChecked(new Set(toChange.map(p => p.person.id)));
    if (notFound.length + ambiguous.length > 0) setNotFoundOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const apply = async () => {
    const chosen = toChange.filter(p => checked.has(p.person.id));
    if (!chosen.length) { showToast('Tick at least one person.', 'warning'); return; }
    const fieldCount = chosen.reduce((a, p) => a + p.diff.length, 0);
    const ok = await showConfirm({
      title: `Update ${chosen.length} RM / BM${chosen.length !== 1 ? 's' : ''}?`,
      message: `${fieldCount} detail${fieldCount !== 1 ? 's' : ''} will be changed on ${chosen.length} account${chosen.length !== 1 ? 's' : ''}. Only basic details change (ARN, EUIN, email, PAN, GSTIN, address, bank). Sharing %, level, role and hierarchy are not touched, and nothing is erased where the sheet is blank. Each change is written to the Audit Log.`,
      confirmText: `Update ${chosen.length}`,
      variant: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const updates = chosen.map(p => ({ id: p.person.id, changes: Object.fromEntries(p.diff.map((d: any) => [d.key, d.to])) }));
      const res = await authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'team_basic_import', payload: { updates } }) });
      const j = await res.json();
      if (!res.ok) { showToast(j?.error || 'The update failed. Nothing was changed.', 'error'); return; }
      setOutcome({ applied: j.applied || 0, rejected: j.rejected || [] });
      setStep('done');
    } catch { showToast('The update failed. Nothing was changed.', 'error'); } finally { setBusy(false); }
  };

  // The page reloads the team when this closes, not before: reloading underneath the dialog would take the result screen away.
  const close = () => { if (step === 'done') onApplied(); onClose(); };

  const sel = 'w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 text-xs';
  const lab = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1';
  const stepNames = ['File', 'Columns', 'Review'];
  const stepIdx = step === 'file' ? 0 : step === 'columns' ? 1 : 2;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Import RM and BM details from Excel">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 w-full max-w-4xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-100 dark:border-slate-700">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100">Import RM / BM details from Excel</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Updates ARN, EUIN, email, PAN, GSTIN, office address and bank details. Sharing %, level and role are never changed here.</p>
            </div>
          </div>
          <button onClick={close} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>
        {step !== 'done' && (
          <div className="flex gap-2 px-5 pt-3">
            {stepNames.map((n, i) => (
              <span key={n} className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full ${i === stepIdx ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : i < stepIdx ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400 dark:bg-slate-700'}`}>{i + 1} · {n}</span>
            ))}
          </div>
        )}

        <div className="p-5 overflow-y-auto">
          {step === 'file' && (
            <div className="text-center py-10">
              <p className="text-sm text-slate-600 dark:text-slate-300 mb-1">Choose an Excel or CSV file with one row per RM / BM.</p>
              <p className="text-xs text-slate-400 mb-5 max-w-lg mx-auto">Each row is matched to an account by <b>PAN</b> first, then by <b>name</b>. Useful columns: Name, PAN, ARN, ARN valid till, EUIN, EUIN valid till, Email, GSTIN, Office address, City, State, Pincode, Account holder, Account number, IFSC, Bank, Branch. Blank cells are ignored.</p>
              <label className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black uppercase tracking-widest cursor-pointer">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Choose file
                <input type="file" className="hidden" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
              </label>
            </div>
          )}

          {step === 'columns' && (
            <div>
              <p className="text-xs text-slate-500 mb-3">{fileName} — check which column is which. Anything set to “not in this file” is left alone.</p>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="col-span-2">
                  <label className={lab}>Header row</label>
                  <select className={sel} value={headerRow} onChange={e => redetect(Number(e.target.value))}>
                    {grid.slice(0, 15).map((r, i) => <option key={i} value={i}>Row {i + 1}: {(r || []).map(cell).filter(Boolean).slice(0, 5).join(' · ').slice(0, 80) || '(empty)'}</option>)}
                  </select>
                </div>
                {[{ key: 'name', label: 'RM / BM name' }, ...FIELDS.map((f: any) => ({ key: f.key, label: f.label }))].map(f => (
                  <div key={f.key}>
                    <label className={lab}>{f.label}{f.key === 'name' ? ' *' : ''}</label>
                    <select className={sel} value={columns[f.key] ?? -1} onChange={e => { const v = Number(e.target.value); setColumns(c => { const n = { ...c }; if (v < 0) delete n[f.key]; else n[f.key] = v; return n; }); }}>
                      <option value={-1}>— not in this file —</option>
                      {Array.from({ length: maxCols }, (_, i) => <option key={i} value={i}>{headers[i] || `Column ${i + 1}`}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setStep('file')} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Back</button>
                <button onClick={goReview} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">Review changes</button>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div>
              <div className="flex flex-wrap gap-2 mb-3 text-[11px] font-bold">
                <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700">{toChange.length} will change</span>
                <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">{upToDate.length} already up to date</span>
                <button onClick={() => setNotFoundOpen(true)} className={`px-2.5 py-1 rounded-full ${notFound.length + ambiguous.length ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-slate-100 text-slate-400'}`}>{notFound.length} not found{ambiguous.length ? ` · ${ambiguous.length} unclear` : ''}</button>
                {duplicates.length > 0 && <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">{duplicates.length} repeated row{duplicates.length !== 1 ? 's' : ''} skipped</span>}
              </div>
              {toChange.length === 0 ? (
                <p className="text-sm text-slate-500 py-8 text-center">Nothing to change: every person found already has these details.</p>
              ) : (
                <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-[9px] uppercase tracking-widest">
                      <tr>
                        <th className="px-3 py-2 w-8"><input type="checkbox" checked={toChange.every(p => checked.has(p.person.id))} onChange={e => setChecked(e.target.checked ? new Set(toChange.map(p => p.person.id)) : new Set())} aria-label="Select all" /></th>
                        <th className="text-left px-3 py-2">Person</th><th className="text-left px-3 py-2">What changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toChange.map(p => (
                        <tr key={p.person.id} className="border-t border-slate-100 dark:border-slate-700/50 align-top">
                          <td className="px-3 py-2"><input type="checkbox" checked={checked.has(p.person.id)} onChange={e => setChecked(prev => { const n = new Set(prev); if (e.target.checked) n.add(p.person.id); else n.delete(p.person.id); return n; })} /></td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <div className="font-bold text-slate-900 dark:text-slate-100">{p.person.name}</div>
                            <div className="text-[10px] text-slate-400">L{p.person.level} · matched by {p.by} · row {p.row.rowNo}</div>
                          </td>
                          <td className="px-3 py-2">
                            <ul className="space-y-0.5">
                              {p.diff.map((d: any) => (
                                <li key={d.key} className="text-slate-700 dark:text-slate-300"><span className="text-slate-400">{d.label}:</span> <span className="line-through text-slate-400">{MASK(d.key, d.from) || '(blank)'}</span> → <b>{MASK(d.key, d.to)}</b></li>
                              ))}
                            </ul>
                            {p.row.problems.length > 0 && (
                              <p className="mt-1 text-[10px] text-amber-700">Ignored in row {p.row.rowNo}: {p.row.problems.map((x: any) => `${x.label} (${x.text})`).join('; ')}</p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 mt-4">
                <button onClick={() => setStep('columns')} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-bold">Back</button>
                <button disabled={busy || !toChange.some(p => checked.has(p.person.id))} onClick={apply}
                  className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-2">
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} Apply to {toChange.filter(p => checked.has(p.person.id)).length} people
                </button>
              </div>
            </div>
          )}

          {step === 'done' && outcome && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
              <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{outcome.applied} RM / BM account{outcome.applied !== 1 ? 's' : ''} updated</p>
              <p className="text-xs text-slate-500 mt-1">Each change is in the Audit Log. Payouts and sharing rates were not touched.</p>
              {outcome.rejected.length > 0 && (
                <div className="mt-4 text-left max-w-xl mx-auto rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-red-700 mb-1">Not updated</p>
                  <ul className="text-xs text-red-700 space-y-0.5">{outcome.rejected.map((r, i) => <li key={i}><b>{r.name || r.id}</b> — {r.why}</li>)}</ul>
                </div>
              )}
              <button onClick={close} className="mt-6 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">Close</button>
            </div>
          )}
        </div>
      </div>

      {notFoundOpen && (
        <div className="fixed inset-0 z-[60] bg-slate-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="RM or BM not found">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-5 flex items-start gap-3 border-b border-slate-100 dark:border-slate-700">
              <UserX className="w-5 h-5 text-red-500 mt-0.5" />
              <div>
                <h3 className="font-bold text-slate-900 dark:text-slate-100">{notFound.length} RM / BM not found</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">These names in your file match no RM or BM account, so nothing will be changed for them. Check the spelling, or add the PAN to the sheet.</p>
              </div>
            </div>
            <div className="p-5 overflow-y-auto space-y-3">
              {notFound.length > 0 && (
                <ul className="space-y-1">
                  {notFound.map(p => <li key={p.row.rowNo} className="text-sm text-slate-800 dark:text-slate-200"><b>{p.row.name || '(no name)'}</b>{p.row.pan ? <span className="text-xs text-slate-400"> · {p.row.pan}</span> : null} <span className="text-[10px] text-slate-400">row {p.row.rowNo}</span></li>)}
                </ul>
              )}
              {ambiguous.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> More than one account matches — skipped</p>
                  <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
                    {ambiguous.map(p => <li key={p.row.rowNo}><b>{p.row.name}</b> (row {p.row.rowNo}) could be {p.candidates.map((c: any) => `${c.name} (L${c.level})`).join(' or ')}. Add the PAN to the sheet to choose.</li>)}
                  </ul>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 dark:border-slate-700 flex justify-end">
              <button onClick={() => setNotFoundOpen(false)} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">Review the rest</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
