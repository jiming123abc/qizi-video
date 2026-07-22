import type { ReactNode } from 'react';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxWidth?: string;
  showClose?: boolean;
  maxHeight?: string;
}

export function Dialog({ open, onClose, title, children, maxWidth = 'max-w-sm', showClose = true, maxHeight = 'max-h-[85vh]' }: DialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
          className={`absolute inset-x-0 top-0 bottom-0 sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 w-full sm:w-[calc(100%-2rem)] max-h-[100dvh] sm:${maxWidth} sm:${maxHeight} sm:rounded-3xl rounded-none border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl overflow-hidden flex flex-col`}
          onClick={(e) => e.stopPropagation()}
        >
        {title && (
          <div className="flex items-center justify-between mb-4 shrink-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {showClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
