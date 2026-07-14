import React from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmButtonColor?: 'red' | 'blue' | 'gray';
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  confirmButtonColor = 'red',
  onConfirm,
  onCancel,
  children
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  const buttonColors = {
    red: 'bg-red-500/80 hover:bg-red-500',
    blue: 'bg-blue-500/80 hover:bg-blue-500',
    gray: 'bg-white/10 hover:bg-white/20'
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[70] p-8 sm:p-4">
      <div className="bg-slate-900/95 border border-white/10 rounded-2xl max-w-md w-full max-h-[85vh] p-6 shadow-xl overflow-y-auto">
        <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
        <p className="text-slate-300 mb-4">{message}</p>

        {children && (
          <div className="mb-4">
            {children}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-white/15 rounded-lg text-slate-300 hover:bg-white/10 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-white transition-colors ${buttonColors[confirmButtonColor]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
