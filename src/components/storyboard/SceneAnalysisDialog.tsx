import React, { useState, useEffect, useMemo } from 'react';
import { X, Loader2, Sparkles, CheckCircle2, AlertTriangle, Trash2, FolderPlus, ArrowRight } from 'lucide-react';
import type { Shot, Settings, ModelConfig } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface SceneAnalysisDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shots: Shot[];
  projectId: number;
  onApply: (actions: SceneAction[]) => Promise<void>;
}

export interface SceneAction {
  type: 'create_scene' | 'move_to_scene' | 'delete_shot';
  shotId?: number;
  sceneName?: string;
  sceneId?: number;
}

interface AnalysisResultItem {
  shotId: number;
  scene: string;
  type: 'shot' | 'non_shot';
}

type DialogPhase = 'intro' | 'analyzing' | 'result';

export default function SceneAnalysisDialog({ isOpen, onClose, shots, projectId, onApply }: SceneAnalysisDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>('intro');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [results, setResults] = useState<AnalysisResultItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [deleteNonShots, setDeleteNonShots] = useState(false);

  useEscapeKey(onClose, isOpen && phase !== 'analyzing');

  // 重置状态
  useEffect(() => {
    if (isOpen) {
      setPhase('intro');
      setResults([]);
      setError(null);
      setIsApplying(false);
      setDeleteNonShots(false);
    }
  }, [isOpen]);

  // 获取设置，筛选视觉模型
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data) {
          setSettings(data.data);
          const visionModels = (data.data.llm_fallback_chain || []).filter((m: ModelConfig) => m.supportsVision);
          if (visionModels.length > 0) {
            setSelectedProvider(visionModels[0].provider);
            setSelectedModel(visionModels[0].model);
          }
        }
      })
      .catch(() => {});
  }, [isOpen]);

  const visionModels = useMemo(() => {
    if (!settings) return [];
    return (settings.llm_fallback_chain || []).filter((m: ModelConfig) => m.supportsVision);
  }, [settings]);

  // 按场景分组结果
  const groupedResults = useMemo(() => {
    const groups: Record<string, AnalysisResultItem[]> = {};
    for (const r of results) {
      if (r.type === 'non_shot') continue;
      const key = r.scene || '未分类';
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    return groups;
  }, [results]);

  const nonShotResults = useMemo(() => results.filter((r: AnalysisResultItem) => r.type === 'non_shot'), [results]);

  const startAnalysis = async () => {
    if (!selectedProvider || !selectedModel) {
      setError('请选择视觉模型');
      return;
    }
    setPhase('analyzing');
    setError(null);

    try {
      const shotIds = shots.map(s => s.id);
      const res = await fetch('/api/ai/analyze-shot-scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotIds, provider: selectedProvider, model: selectedModel })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || '分析失败');
      }
      setResults(data.results || []);
      setPhase('result');
    } catch (e: any) {
      setError(e.message || '分析失败');
      setPhase('intro');
    }
  };

  const applyResults = async () => {
    setIsApplying(true);
    try {
      const actions: SceneAction[] = [];

      // 为每个场景组创建场次并移动分镜
      for (const [sceneName, items] of Object.entries(groupedResults) as [string, AnalysisResultItem[]][]) {
        for (const item of items) {
          actions.push({ type: 'move_to_scene', shotId: item.shotId, sceneName });
        }
      }

      // 删除非实拍分镜
      if (deleteNonShots) {
        for (const item of nonShotResults) {
          actions.push({ type: 'delete_shot', shotId: item.shotId });
        }
      }

      await onApply(actions);
      onClose();
    } catch (e: any) {
      setError(e.message || '应用失败');
    } finally {
      setIsApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <Sparkles className="w-4.5 h-4.5 text-white" />
            </div>
            <h2 className="text-base font-semibold text-white">AI 场次分析</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition" disabled={phase === 'analyzing'}>
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ===== 介绍阶段 ===== */}
          {phase === 'intro' && (
            <div className="space-y-5">
              <div className="p-4 rounded-2xl bg-violet-500/10 border border-violet-400/20">
                <p className="text-sm text-violet-100 leading-relaxed">
                  AI 将分析当前「未分类」中 <span className="font-semibold text-violet-300">{shots.length}</span> 个分镜的第一个参考画面，
                  自动识别每个镜头的场景环境（如"室内-办公室"、"室外-街道"），并给出场次划分建议。
                </p>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-slate-200">分析流程：</h3>
                <div className="space-y-2.5">
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-violet-300">1</span>
                    </div>
                    <p className="text-sm text-slate-300">提取每个分镜的第一帧画面，发送给视觉 AI 模型</p>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-violet-300">2</span>
                    </div>
                    <p className="text-sm text-slate-300">AI 识别场景环境，区分实拍镜头与非实拍内容（标题卡/字幕/黑屏）</p>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-violet-300">3</span>
                    </div>
                    <p className="text-sm text-slate-300">展示分组建议，确认后自动创建场次、移动分镜、删除非实拍内容</p>
                  </div>
                </div>
              </div>

              {/* 模型选择 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-200">选择视觉模型</label>
                {visionModels.length === 0 ? (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/20">
                    <p className="text-xs text-amber-200">
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                      未找到支持视觉的模型，请在设置中配置 supportsVision 模型
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={selectedProvider}
                      onChange={e => {
                        setSelectedProvider(e.target.value);
                        const m = visionModels.find(v => v.provider === e.target.value);
                        if (m) setSelectedModel(m.model);
                      }}
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-violet-400/50"
                    >
                      {Array.from(new Set(visionModels.map(v => v.provider))).map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                    <select
                      value={selectedModel}
                      onChange={e => setSelectedModel(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-violet-400/50"
                    >
                      {visionModels.filter(v => v.provider === selectedProvider).map(m => (
                        <option key={m.model} value={m.model}>{m.model}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-400/20">
                  <p className="text-xs text-red-200">{error}</p>
                </div>
              )}
            </div>
          )}

          {/* ===== 分析中 ===== */}
          {phase === 'analyzing' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 text-violet-400 animate-spin" />
              <p className="text-sm text-slate-300">正在分析 {shots.length} 个分镜的画面...</p>
              <p className="text-xs text-slate-500">AI 正在识别场景环境，请稍候</p>
            </div>
          )}

          {/* ===== 结果阶段 ===== */}
          {phase === 'result' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle2 className="w-4 h-4" />
                <span>分析完成，共识别 {Object.keys(groupedResults).length} 个场景</span>
              </div>

              {/* 场景分组 */}
              <div className="space-y-3">
                {(Object.entries(groupedResults) as [string, AnalysisResultItem[]][]).map(([sceneName, items]) => (
                  <div key={sceneName} className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <FolderPlus className="w-4 h-4 text-violet-400" />
                      <span className="text-sm font-medium text-white">{sceneName}</span>
                      <span className="text-xs text-slate-400 ml-auto">{items.length} 个分镜</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map(item => {
                        const shot = shots.find(s => s.id === item.shotId);
                        return (
                          <span key={item.shotId} className="px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-400/20 text-xs text-violet-200">
                            #{shot?.shotNo || item.shotId}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* 非实拍内容 */}
              {nonShotResults.length > 0 && (
                <div className="p-3.5 rounded-2xl bg-red-500/5 border border-red-400/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Trash2 className="w-4 h-4 text-red-400" />
                    <span className="text-sm font-medium text-red-200">非实拍内容（{nonShotResults.length} 个）</span>
                  </div>
                  <p className="text-xs text-red-200/70 mb-2">标题卡、字幕、黑屏等非实拍镜头</p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteNonShots}
                      onChange={e => setDeleteNonShots(e.target.checked)}
                      className="w-4 h-4 rounded border-white/20 bg-white/5 text-red-500 focus:ring-red-400/50"
                    />
                    <span className="text-xs text-slate-300">确认后删除这些非实拍分镜</span>
                  </label>
                </div>
              )}

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-400/20">
                  <p className="text-xs text-red-200">{error}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-white/10">
          {phase === 'intro' && (
            <button
              onClick={startAnalysis}
              disabled={visionModels.length === 0}
              className={`w-full py-3 rounded-2xl text-sm font-medium transition flex items-center justify-center gap-2 ${
                visionModels.length > 0
                  ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:shadow-lg hover:shadow-violet-500/25'
                  : 'bg-white/5 text-white/30 cursor-not-allowed'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              开始分析（{shots.length} 个分镜）
            </button>
          )}
          {phase === 'analyzing' && (
            <button disabled className="w-full py-3 rounded-2xl text-sm font-medium bg-white/5 text-white/30 cursor-not-allowed flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              分析中...
            </button>
          )}
          {phase === 'result' && (
            <div className="flex gap-3">
              <button
                onClick={() => { setPhase('intro'); setResults([]); }}
                className="flex-1 py-3 rounded-2xl text-sm font-medium border border-white/20 bg-white/5 hover:bg-white/10 text-slate-200 transition"
              >
                重新分析
              </button>
              <button
                onClick={applyResults}
                disabled={isApplying || Object.keys(groupedResults).length === 0}
                className="flex-1 py-3 rounded-2xl text-sm font-medium bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:shadow-lg hover:shadow-emerald-500/25 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isApplying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                确认应用
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
