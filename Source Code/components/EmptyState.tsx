import React from 'react';
import { LucideIcon, Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  cta?: { label: string; onClick: () => void };
  /** Use 'compact' inside cards, 'page' for full-page empties. */
  size?: 'compact' | 'page';
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon = Inbox,
  title,
  description,
  cta,
  size = 'compact',
}) => {
  const isPage = size === 'page';
  return (
    <div className={`flex flex-col items-center justify-center text-center ${isPage ? 'py-24 px-8' : 'py-12 px-6'}`}>
      <div className={`rounded-full bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center mb-4 ${isPage ? 'w-20 h-20' : 'w-14 h-14'}`}>
        <Icon className={`text-slate-400 dark:text-slate-500 ${isPage ? 'w-9 h-9' : 'w-6 h-6'}`} />
      </div>
      <h3 className={`font-bold text-slate-700 dark:text-slate-200 ${isPage ? 'text-lg mb-2' : 'text-sm mb-1'}`}>{title}</h3>
      {description && (
        <p className={`text-slate-500 dark:text-slate-400 max-w-md ${isPage ? 'text-sm' : 'text-xs'}`}>{description}</p>
      )}
      {cta && (
        <button
          onClick={cta.onClick}
          className="mt-5 bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-blue-700 transition shadow-sm"
        >
          {cta.label}
        </button>
      )}
    </div>
  );
};
