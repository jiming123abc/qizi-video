import { Search, X } from 'lucide-react';

interface ShotSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function ShotSearchBar({ value, onChange, placeholder = '搜索画面内容、演员、地点、旁白...' }: ShotSearchBarProps) {
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
