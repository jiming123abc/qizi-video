import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="py-16 text-center border border-dashed border-white/10 rounded-3xl bg-white/[0.02]">
      <div className="mx-auto mb-3 w-10 h-10 flex items-center justify-center">
        {icon}
      </div>
      <p className="text-slate-300 mb-1">{title}</p>
      {description && (
        <p className="text-xs text-slate-500 mb-4">{description}</p>
      )}
      {action}
    </div>
  );
}
