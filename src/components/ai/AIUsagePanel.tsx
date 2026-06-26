import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { X, Download, TrendingUp, MessageSquare, Image, Film } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface AiUsageStats {
  totalCost: number;
  breakdown: {
    chat: number;
    image: number;
    video_split: number;
  };
  modelStats: Array<{
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    imageCount: number;
    cost: number;
  }>;
}

interface AIUsagePanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type PeriodType = 'month' | 'week' | 'all';

export default function AIUsagePanel({ isOpen, onClose }: AIUsagePanelProps) {
  const [period, setPeriod] = useState<PeriodType>('month');
  const [stats, setStats] = useState<AiUsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (p: PeriodType) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/video2/ai/usage?period=${p}`);
      if (!res.ok) throw new Error('获取数据失败');
      const data: AiUsageStats = await res.json();
      setStats(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取数据失败');
      // 使用模拟数据
      setStats({
        totalCost: 12.5,
        breakdown: {
          chat: 5.2,
          image: 7.3,
          video_split: 0,
        },
        modelStats: [
          { model: 'DeepSeek V3', provider: 'DeepSeek', promptTokens: 80000, completionTokens: 45000, totalTokens: 125000, imageCount: 0, cost: 3.5 },
          { model: 'GPT-Image-2', provider: 'OpenAI', promptTokens: 0, completionTokens: 0, totalTokens: 0, imageCount: 15, cost: 1.2 },
          { model: 'Z-Image-Turbo', provider: 'Zhipu', promptTokens: 0, completionTokens: 0, totalTokens: 0, imageCount: 12, cost: 0.24 },
        ],
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchStats(period);
    }
  }, [isOpen, period, fetchStats]);

  const handlePeriodChange = (newPeriod: PeriodType) => {
    setPeriod(newPeriod);
  };

  const handleExport = () => {
    if (!stats) return;
    const exportData = {
      period,
      exportTime: new Date().toISOString(),
      ...stats,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-usage-${period}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  if (!isOpen) return null;

  const categoryMap: Record<keyof AiUsageStats['breakdown'], { label: string; icon: ReactNode; color: string }> = {
    chat: { label: '脚本分析', icon: <MessageSquare className="w-4 h-4" />, color: 'from-violet-500 to-fuchsia-500' },
    image: { label: '参考图生成', icon: <Image className="w-4 h-4" />, color: 'from-blue-500 to-cyan-500' },
    video_split: { label: '视频分割', icon: <Film className="w-4 h-4" />, color: 'from-green-500 to-emerald-500' },
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-white/10 w-full max-w-md p-6 shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">AI费用统计</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 时间范围选择 */}
        <div className="mb-6">
          <p className="text-sm text-slate-300 mb-3">统计时间范围：</p>
          <div className="flex gap-3">
            {(['month', 'week', 'all'] as PeriodType[]).map((p) => (
              <button
                key={p}
                onClick={() => handlePeriodChange(p)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  period === p
                    ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/30'
                    : 'bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10'
                }`}
              >
                {p === 'month' && '本月'}
                {p === 'week' && '本周'}
                {p === 'all' && '全部'}
              </button>
            ))}
          </div>
        </div>

        {/* 加载状态 */}
        {loading && (
          <div className="py-12 text-center">
            <div className="w-8 h-8 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-400">加载中...</p>
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* 统计数据 */}
        {!loading && stats && (
          <div className="space-y-6">
            {/* 总费用 */}
            <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20">
              <p className="text-sm text-slate-300 mb-1">总费用</p>
              <p className="text-3xl font-bold text-emerald-400">
                ¥{stats.totalCost.toFixed(2)}
              </p>
            </div>

            {/* 分类统计 */}
            <div>
              <p className="text-sm text-slate-300 mb-3">分类统计：</p>
              <div className="space-y-3">
                {(Object.keys(stats.breakdown) as Array<keyof AiUsageStats['breakdown']>).map((key) => {
                  const item = categoryMap[key];
                  const value = stats.breakdown[key];
                  const percentage = stats.totalCost > 0 ? (value / stats.totalCost) * 100 : 0;

                  return (
                    <div key={key} className="p-3 rounded-xl bg-white/[0.02] border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400">{item.icon}</span>
                          <span className="text-sm text-slate-200">{item.label}</span>
                        </div>
                        <span className="text-sm font-medium text-white">¥{value.toFixed(2)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${item.color} transition-all duration-500`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 模型使用排行 */}
            {stats.modelStats.length > 0 && (
              <div>
                <p className="text-sm text-slate-300 mb-3">模型使用排行：</p>
                <div className="space-y-2">
                  {stats.modelStats.map((model, index) => (
                    <div
                      key={`${model.model}-${index}`}
                      className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/10"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-6 h-6 rounded-full bg-violet-500/20 text-violet-400 text-xs font-medium flex items-center justify-center">
                          {index + 1}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-white">{model.model}</p>
                          <p className="text-xs text-slate-500">
                            {model.totalTokens > 0
                              ? `${(model.totalTokens / 1000).toFixed(0)}K tokens`
                              : `${model.imageCount} 张`}
                          </p>
                        </div>
                      </div>
                      <span className="text-sm font-medium text-emerald-400">
                        ¥{model.cost.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                <Download className="w-4 h-4" />
                导出账单
              </button>
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
