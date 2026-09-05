import React, { useMemo } from 'react';
import { ShieldAlert, ShieldCheck, Clock } from 'lucide-react';
import { TeamMember } from '../types';
import { useData } from '../contexts/DataContext';

interface ComplianceAlertsProps {
  currentUser: TeamMember;
  warningDays?: number;  // alert when expiry is within this many days (default 30)
}

type AlertSeverity = 'expired' | 'expiring' | 'missing';

interface ComplianceAlert {
  memberId: string;
  memberName: string;
  memberCode: string;
  kind: 'ARN' | 'EUIN';
  severity: AlertSeverity;
  number?: string;
  validTill?: string;
  daysRemaining?: number;
}

const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));

const severityTone: Record<AlertSeverity, { label: string; tone: string; chipTone: string }> = {
  expired: {
    label: 'Expired',
    tone: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300',
    chipTone: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  },
  expiring: {
    label: 'Expiring soon',
    tone: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300',
    chipTone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  },
  missing: {
    label: 'Not on file',
    tone: 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300',
    chipTone: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  },
};

export const ComplianceAlerts: React.FC<ComplianceAlertsProps> = ({ currentUser, warningDays = 30 }) => {
  const { team } = useData();

  const alerts = useMemo<ComplianceAlert[]>(() => {
    const isAdmin = currentUser.role === 'ADMIN';
    const members = isAdmin ? team : team.filter(m => m.id === currentUser.id);
    const now = new Date();
    const out: ComplianceAlert[] = [];

    for (const m of members) {
      // ARN
      if (!m.arnNumber) {
        out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'ARN', severity: 'missing' });
      } else if (m.arnValidTill) {
        const exp = new Date(m.arnValidTill);
        if (!isNaN(exp.getTime())) {
          const d = daysBetween(exp, now);
          if (d < 0) out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'ARN', severity: 'expired', number: m.arnNumber, validTill: m.arnValidTill, daysRemaining: d });
          else if (d <= warningDays) out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'ARN', severity: 'expiring', number: m.arnNumber, validTill: m.arnValidTill, daysRemaining: d });
        }
      }
      // EUIN
      if (!m.euinNumber) {
        out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'EUIN', severity: 'missing' });
      } else if (m.euinValidTill) {
        const exp = new Date(m.euinValidTill);
        if (!isNaN(exp.getTime())) {
          const d = daysBetween(exp, now);
          if (d < 0) out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'EUIN', severity: 'expired', number: m.euinNumber, validTill: m.euinValidTill, daysRemaining: d });
          else if (d <= warningDays) out.push({ memberId: m.id, memberName: m.name, memberCode: m.code, kind: 'EUIN', severity: 'expiring', number: m.euinNumber, validTill: m.euinValidTill, daysRemaining: d });
        }
      }
    }

    // Sort: expired first, then expiring, then missing; within group by soonest
    const order: Record<AlertSeverity, number> = { expired: 0, expiring: 1, missing: 2 };
    out.sort((a, b) => {
      if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
      return (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999);
    });
    return out;
  }, [team, currentUser, warningDays]);

  // Hide missing-only noise for non-admins so RMs aren't nagged for fields they can't see.
  const visibleAlerts = currentUser.role === 'ADMIN'
    ? alerts
    : alerts.filter(a => a.severity !== 'missing');

  if (visibleAlerts.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-5 flex items-center gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-600" />
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100">All ARN/EUIN registrations are current</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">No expirations in the next {warningDays} days.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-600" />
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Compliance attention</h3>
        <span className="ml-auto text-[10px] font-black uppercase tracking-widest bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full">
          {visibleAlerts.length}
        </span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-700 max-h-80 overflow-y-auto">
        {visibleAlerts.slice(0, 20).map((a, i) => {
          const tone = severityTone[a.severity];
          return (
            <li key={`${a.memberId}-${a.kind}-${i}`} className={`p-3 ${tone.tone} border-l-4`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">{a.memberName} <span className="text-[10px] font-mono opacity-60">({a.memberCode})</span></p>
                  <p className="text-[11px] opacity-80 mt-0.5">
                    {a.kind} {a.number ? `• ${a.number}` : ''}
                    {a.validTill && (
                      <> • valid till <span className="font-bold">{new Date(a.validTill).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span></>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${tone.chipTone}`}>
                    {a.kind}
                  </span>
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${tone.chipTone}`}>
                    <Clock className="w-3 h-3" />
                    {a.severity === 'expired' && `${Math.abs(a.daysRemaining ?? 0)}d ago`}
                    {a.severity === 'expiring' && `${a.daysRemaining}d`}
                    {a.severity === 'missing' && 'Missing'}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {visibleAlerts.length > 20 && (
        <div className="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700 text-center">
          + {visibleAlerts.length - 20} more — review in Settings
        </div>
      )}
    </div>
  );
};
