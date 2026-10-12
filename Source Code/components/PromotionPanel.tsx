import React from 'react';
import { ArrowUpRight, AlertTriangle } from 'lucide-react';

/**
 * Shown inside the team-member form the moment the level is changed. It says what the
 * promotion will do before anything is saved: how many of the person's clients move up
 * by themselves, which clients are in the way, and what rate the person will be paid.
 * Purely presentational; the form fetches the preview.
 */

export interface PromotionPreview {
  from: number; to: number; person?: string;
  clientsAtOldLevel?: number;
  moved: number; replaced: number; blocked: number;
  blockedClients: Array<{ id: string; name: string; heldBy: string }>;
  sample: string[];
}

interface Props {
  name: string;
  fromLevel: number;
  toLevel: number;
  /** "from September 2026" or "for all months". */
  effectiveLabel: string;
  /** The firm-wide rate for the new level, for the "standard rate" line. */
  cardRate: number;
  useCardRate: boolean;
  onUseCardRate: (v: boolean) => void;
  occupied: 'keep' | 'replace';
  onOccupied: (v: 'keep' | 'replace') => void;
  preview: PromotionPreview | null;
  loading?: boolean;
}

export const PromotionPanel: React.FC<Props> = ({
  name, fromLevel, toLevel, effectiveLabel, cardRate, useCardRate, onUseCardRate, occupied, onOccupied, preview, loading,
}) => {
  const up = toLevel > fromLevel;
  const total = preview ? preview.moved + preview.replaced : 0;
  return (
    <div className="mt-2 rounded-2xl border-2 border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-slate-800 p-4 space-y-3" role="region" aria-label="Level change">
      <div className="flex items-start gap-2">
        <ArrowUpRight className={`w-4 h-4 mt-0.5 flex-shrink-0 ${up ? 'text-emerald-600' : 'text-amber-600 rotate-90'}`} />
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
            {name}: Level {fromLevel} to Level {toLevel}, {effectiveLabel}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            Earlier months keep the level and chain they were paid at. Their upline does not change.
          </p>
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={useCardRate} onChange={e => onUseCardRate(e.target.checked)} />
        <span>
          Pay the <b>standard rate for Level {toLevel}</b> ({cardRate}%) automatically.
          {!useCardRate && <span className="text-slate-500"> Untick means the Sharing % box above is this person&rsquo;s personal rate at Level {toLevel}.</span>}
        </span>
      </label>

      <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-3 text-xs space-y-2">
        {loading && !preview && <p className="text-slate-400">Checking this person&rsquo;s clients…</p>}
        {preview && (
          <>
            <p className="text-slate-800 dark:text-slate-200">
              <b>{total}</b> client{total === 1 ? '' : 's'} will move to Level {toLevel} by themselves
              {preview.clientsAtOldLevel != null && <span className="text-slate-400"> (of {preview.clientsAtOldLevel} at Level {fromLevel})</span>}.
              {preview.sample.length > 0 && <span className="text-slate-400"> e.g. {preview.sample.slice(0, 3).join(', ')}{preview.sample.length > 3 ? '…' : ''}</span>}
            </p>
            {(preview.blocked > 0 || preview.replaced > 0) && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-2.5 space-y-2">
                <p className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300 font-bold">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  {(preview.blocked || preview.replaced)} client{(preview.blocked || preview.replaced) === 1 ? ' has' : 's have'} someone else at Level {toLevel} already.
                </p>
                <div className="space-y-1.5 text-slate-700 dark:text-slate-300">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="radio" name="occupied-rule" className="mt-0.5" checked={occupied === 'keep'} onChange={() => onOccupied('keep')} />
                    <span>Leave those clients as they are. Nothing is lost; you can decide for them later.</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="radio" name="occupied-rule" className="mt-0.5" checked={occupied === 'replace'} onChange={() => onOccupied('replace')} />
                    <span>Put {name} at Level {toLevel} on those clients too. The person there now leaves that client&rsquo;s chain from this month (their past months stay as paid).</span>
                  </label>
                </div>
                {preview.blockedClients.length > 0 && (
                  <ul className="text-[11px] text-slate-500 dark:text-slate-400 list-disc ml-5 max-h-24 overflow-y-auto">
                    {preview.blockedClients.slice(0, 8).map(b => <li key={b.id}>{b.name} <span className="text-slate-400">(Level {toLevel}: {b.heldBy})</span></li>)}
                    {preview.blockedClients.length > 8 && <li>and {preview.blockedClients.length - 8} more</li>}
                  </ul>
                )}
              </div>
            )}
            {total === 0 && preview.blocked === 0 && (
              <p className="text-slate-500">This person has no clients at Level {fromLevel}, so only their level and rate change.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
