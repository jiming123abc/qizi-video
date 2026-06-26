import { useState, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface ShotSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  variant?: 'inline' | 'icon' | 'dialog';
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ShotSearchBar({
  value,
  onChange,
  placeholder = '搜索画面内容、演员、地点、旁白...',
  variant = 'inline',
  isOpen: controlledIsOpen,
  onOpenChange,
}: ShotSearchBarProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : uncontrolledOpen;
  const setIsOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    setUncontrolledOpen(v);
  };

  useEffect(() => {
    if (isOpen && inputRef.current && variant === 'icon') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, variant]);

  useEscapeKey(() => setIsOpen(false), isOpen && variant !== 'inline');

  if (variant === 'icon') {
    return (
      <div className="relative">
        {isOpen ? (
          <div className="relative w-48 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="w-full pl-9 pr-8 py-2 rounded-full bg-white/5 border border-white/15 focus:border-violet-400/50 outline-none text-sm transition placeholder:text-slate-500"
            />
            <button
              onClick={() => { onChange(''); setIsOpen(false); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsOpen(true)}
            className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
            title="搜索"
          >
            <Search className="w-4 h-4 text-white/90" />
          </button>
        )}
      </div>
    );
  }

  if (variant === 'dialog') {
    if (!isOpen) return null;
    return (
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 pt-20" onClick={() => setIsOpen(false)}>
        <div className="w-full max-w-lg" onClick={e => e.stopPropagation()}>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="w-full pl-12 pr-12 py-3.5 rounded-2xl bg-slate-900/95 border border-white/10 focus:border-violet-400/50 outline-none text-base transition backdrop-blur-xl placeholder:text-slate-500 text-white"
              autoFocus
            />
            <button
              onClick={() => { onChange(''); setIsOpen(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-center text-xs text-slate-500 mt-3">按 ESC 关闭</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="relative max-w-xl mx-auto sm:mx-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-10 pr-4 py-2.5 rounded-full bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition backdrop-blur-sm placeholder:text-slate-500"
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
