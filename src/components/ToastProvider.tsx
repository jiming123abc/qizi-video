import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '../hooks/useToast';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastContextValue {
  showToast: (msg: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toast, toastVisible, showToast } = useToast();
  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[90] px-6 py-3 rounded-2xl bg-slate-800/95 border border-white/10 text-sm shadow-xl transition-all duration-300 ${
            toastVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 inline mr-2 text-green-400" />}
          {toast.type === 'error' && <XCircle className="w-4 h-4 inline mr-2 text-red-400" />}
          {toast.type === 'info' && <Info className="w-4 h-4 inline mr-2 text-blue-400" />}
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToastContext() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToastContext must be used within ToastProvider');
  return ctx;
}
