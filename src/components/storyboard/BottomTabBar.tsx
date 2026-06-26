interface TabItem {
  key: string;
  label: string;
  count: number;
}

interface BottomTabBarProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (key: string) => void;
}

export function BottomTabBar({ tabs, activeTab, onTabChange }: BottomTabBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 w-full border-t border-white/10 bg-slate-900/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom,0)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-2">
        {tabs.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`flex-1 py-2.5 rounded-2xl text-xs sm:text-sm font-medium transition ${
                isActive
                  ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/25'
                  : 'text-slate-300 hover:bg-white/5'
              }`}
            >
              {tab.label} <span className={`ml-1 ${isActive ? 'text-white/90' : 'text-slate-300'}`}>({tab.count})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
