import React from 'react';
import { AlertTriangle, CheckCircle2, X, HelpCircle } from 'lucide-react';

export interface RtaFile {
  key: string;
  label: string;
  kind: string;
  source: string;
  step: number;
  optional: boolean;
  status: 'done' | 'missing' | 'unverified' | 'not_expected';
  rows: number;
  gross: number;
  fileName: string;
}
export interface RtaMonth { period: string; started: boolean; files: RtaFile[]; missing: string[]; }

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const rtaMonthName = (p: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(p || '');
  return m ? `${NAMES[Number(m[2]) - 1] || m[2]} ${m[1]}` : p || '—';
};

/** The months worth interrupting for: started (something is in) but a file is missing. Newest two only, so old history never nags. */
export const monthsWithGaps = (months: RtaMonth[]): RtaMonth[] =>
  months.filter(m => m.started).slice(-2).filter(m => m.missing.length > 0);

/** Same set, as a string, so "remind me later" holds until a different file goes missing. */
export const gapSignature = (gaps: RtaMonth[]): string => gaps.map(m => `${m.period}:${m.missing.join(',')}`).join('|');

/** Small status row under the month picker: one chip per file for the month being imported. */
export const RtaMonthChips: React.FC<{ month?: RtaMonth; onPick: (f: RtaFile) => void }> = ({ month, onPick }) => {
  if (!month) return null;
  const shown = month.files.filter(f => f.status !== 'not_expected');
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-1.5">Files for {rtaMonthName(month.period)}</p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(f => {
          const cls = f.status === 'done'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
            : f.status === 'missing'
              ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300'
              : 'border-slate-200 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400';
          const title = f.status === 'done' ? `${f.rows.toLocaleString()} rows${f.fileName ? ` · ${f.fileName}` : ''}`
            : f.status === 'missing' ? 'Not imported for this month — click to import it'
              : 'Folio master files are not tracked before this feature, so this month cannot be checked';
          return (
            <button key={f.key} type="button" disabled={f.status !== 'missing'} onClick={() => onPick(f)} title={title}
              className={`px-2 py-1 rounded-md border text-[11px] font-bold ${cls} ${f.status === 'missing' ? 'cursor-pointer' : 'cursor-default'}`}>
              {f.status === 'done' ? '✓' : f.status === 'missing' ? '✗' : '?'} {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** The pop-up: which files are still missing, month by month, each with an Import button. */
export const RtaMissingModal: React.FC<{
  gaps: RtaMonth[];
  onPick: (period: string, f: RtaFile) => void;
  onClose: () => void;
}> = ({ gaps, onPick, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Missing RTA files">
    <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xl">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Some RTA files are not imported yet</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">A month paid with a file missing pays the wrong amounts. Import these before locking or paying the month.</p>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {gaps.map(m => (
          <div key={m.period}>
            <p className="text-xs font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 mb-1.5">{rtaMonthName(m.period)}</p>
            <ul className="space-y-1.5">
              {m.files.filter(f => f.status === 'missing').map(f => (
                <li key={f.key} className="flex items-center justify-between gap-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2">
                  <div>
                    <p className="text-sm font-bold text-red-800 dark:text-red-300">{f.label} <span className="font-medium text-red-700/80 dark:text-red-300/80">· {f.kind}</span></p>
                    {f.key === 'SIF' && <p className="text-[11px] text-red-700/90 dark:text-red-300/90">CAMS sent a SIF statement in an earlier month. If CAMS has none for this month, you can skip it.</p>}
                  </div>
                  <button onClick={() => onPick(m.period, f)} className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold">Import</button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-500" /> In: {m.files.filter(f => f.status === 'done').map(f => f.label).join(', ') || 'nothing'}
            </p>
            {m.files.some(f => f.status === 'unverified') && (
              <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1"><HelpCircle className="w-3 h-3" /> Cannot be checked yet: {m.files.filter(f => f.status === 'unverified').map(f => f.label).join(', ')}</p>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 px-5 pb-5">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-700">Remind me later</button>
      </div>
    </div>
  </div>
);
