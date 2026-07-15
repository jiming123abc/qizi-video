import React, { useState, useEffect, useRef } from 'react';
import { X, Loader2, Play, Check, ChevronDown, AlertCircle, Settings as SettingsIcon, Image as ImageIcon } from 'lucide-react';
import type { Shot, ShotMedia, Settings, ModelConfig } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useSignedUrl } from '../../hooks/useSignedUrl';
import { AiErrorGuide } from './AiErrorGuide';

interface AnalyzeShotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shot: Shot;
  currentMedia: ShotMedia;
  onApply: (shotId: number, updates: Partial<Shot>) => void;
  onOpenSettings?: () => void;
}

interface AnalysisResult {
  sceneContent?: string;
  location?: string;
  actors?: string;
  costume?: string;
  props?: string;
  shotType?: string;
  focalLength?: string;
  shotAngle?: string;
  lighting?: string;
  cameraMovement?: string;
  // 内部字段：供 AI 生图对话框使用，不在分析结果 UI 中展示
  aiImagePrompt?: string;
}

export default function AnalyzeShotDialog({ isOpen, onClose, shot, currentMedia, onApply, onOpenSettings }: AnalyzeShotDialogProps) {
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // P3-1：120s 超时 ref，用于清理
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const { url: signedUrl, ready } = useSignedUrl(currentMedia?.url);

  useEscapeKey(onClose, isOpen);

  // P3-1：组件卸载或对话框关闭时清理所有 timer，防止内存泄漏
  useEffect(() => {
    if (!isOpen) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setIsAnalyzing(false);
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setAnalysisResult(null);
      setError(null);
      setIsAnalyzing(false);
      setTaskId(null);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      fetch('/api/settings')
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data) {
            setSettings(data.data);
            const visionModels = (data.data.llm_fallback_chain || []).filter((m: ModelConfig) => m.supportsVision);
            if (visionModels.length > 0) {
              setSelectedProvider(visionModels[0].provider);
              setSelectedModel(visionModels[0].model);
            } else if ((data.data.llm_fallback_chain || []).length > 0) {
              setSelectedProvider(data.data.llm_fallback_chain[0].provider);
              setSelectedModel(data.data.llm_fallback_chain[0].model);
            }
          }
        })
        .catch(console.error);
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  }, [isOpen]);

  const visionModels = settings?.llm_fallback_chain?.filter((m: ModelConfig) => m.supportsVision) || [];
  const hasVisionModels = visionModels.length > 0;
  const availableModels = hasVisionModels ? visionModels : (settings?.llm_fallback_chain || []);

  const filteredModels = availableModels.filter((m: ModelConfig) => m.provider === selectedProvider);

  useEffect(() => {
    if (filteredModels.length > 0 && (!selectedModel || !filteredModels.find(m => m.model === selectedModel))) {
      setSelectedModel(filteredModels[0].model);
    }
  }, [selectedProvider, filteredModels, selectedModel]);

  const startAnalysis = async () => {
    if (!selectedProvider || !selectedModel || isAnalyzing) return;

    setIsAnalyzing(true);
    setError(null);
    setAnalysisResult(null);

    try {
      const response = await fetch('/api/ai/analyze-shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotId: shot.id,
          mediaUrl: currentMedia?.url,
          mediaType: currentMedia?.type,
          provider: selectedProvider,
          model: selectedModel,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || '分析失败');
      }

      const { taskId: newTaskId } = await response.json();
      setTaskId(newTaskId);

      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/ai/task/${newTaskId}`);
          if (!statusResponse.ok) {
            throw new Error(`HTTP ${statusResponse.status}`);
          }
          const result = await statusResponse.json();
          const task = result.data || result;

          if (task.status === 'done') {
            clearInterval(pollIntervalRef.current!);
            pollIntervalRef.current = null;
            setIsAnalyzing(false);

            const output = task.output || {};
            setAnalysisResult(output);
          } else if (task.status === 'error' || task.status === 'failed') {
            clearInterval(pollIntervalRef.current!);
            pollIntervalRef.current = null;
            setIsAnalyzing(false);
            setError(task.error || '分析失败');
          }
        } catch (e) {
          console.error('轮询分析状态失败:', e);
        }
      }, 2000);

      // P3-1：120s 超时，保存到 timeoutRef 以便关闭对话框时清理
      timeoutRef.current = setTimeout(() => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setIsAnalyzing(false);
          setError('分析超时');
        }
        timeoutRef.current = null;
      }, 120000);
    } catch (err) {
      console.error('AI分析失败:', err);
      setIsAnalyzing(false);
      setError((err as Error).message);
    }
  };

  // P3-7：取消分析，清理 timer 并停止前端轮询
  // 注意：后端 ai_tasks 记录会保留为 processing 状态，但不影响功能（任务最终会被视为过期）
  const cancelAnalysis = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsAnalyzing(false);
    setTaskId(null);
  };

  const handleApply = () => {
    if (!analysisResult) return;

    // 注意：单帧分析无法可靠判断 estimatedDuration/notes/narration，不回填这些字段
    const updates: Partial<Shot> = {
      sceneContent: analysisResult.sceneContent || '',
      location: analysisResult.location || '',
      actors: analysisResult.actors || '',
      costume: analysisResult.costume || '',
      props: analysisResult.props || '',
      shotType: analysisResult.shotType || '',
      focalLength: analysisResult.focalLength || '',
      shotAngle: analysisResult.shotAngle || '',
      lighting: analysisResult.lighting || '',
      cameraMovement: analysisResult.cameraMovement || '',
      // 内部回填：供 AI 生图对话框使用
      aiImagePrompt: analysisResult.aiImagePrompt || '',
    };

    onApply(shot.id, updates);
    onClose();
  };

  const handleOpenSettings = () => {
    onClose();
    onOpenSettings?.();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-8 sm:p-4">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[90vh] flex flex-col bg-slate-900 rounded-2xl sm:rounded-3xl border border-white/10 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10 shrink-0">
          <h2 className="text-base sm:text-lg font-semibold text-white">AI 分析画面</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5 space-y-4 sm:space-y-5">
          {/* 素材预览 */}
          <div>
            <label className="block text-xs sm:text-sm font-medium text-slate-300 mb-2">素材预览</label>
            <div className="relative aspect-video rounded-xl overflow-hidden bg-white/5 border border-white/10">
              {ready ? (
                currentMedia.type === 'video' ? (
                  <>
                    <video
                      ref={videoRef}
                      src={signedUrl}
                      className="w-full h-full object-cover"
                      poster={shot.coverUrl || signedUrl}
                      playsInline
                      muted
                    />
                    <button
                      onClick={() => videoRef.current?.play()}
                      className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition"
                    >
                      <Play className="w-10 sm:w-12 h-10 sm:h-12 text-white/90" />
                    </button>
                    {currentMedia.duration && (
                      <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/60 text-xs text-white">
                        {Math.floor(currentMedia.duration / 60)}:{(currentMedia.duration % 60).toString().padStart(2, '0')}
                      </div>
                    )}
                  </>
                ) : (
                  <img src={signedUrl} alt="素材预览" className="w-full h-full object-cover" />
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-black/40">
                  <ImageIcon className="w-8 h-8 text-white/30 animate-pulse" />
                </div>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-1 truncate">{currentMedia.filename}</div>
          </div>

          {/* 模型选择 */}
          <div>
            <label className="block text-xs sm:text-sm font-medium text-slate-300 mb-2">分析模型</label>
            {!hasVisionModels && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-3">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs text-amber-300 mb-2">
                    当前没有标记"支持视觉"的模型，请在设置中添加支持视觉的大语言模型。
                  </p>
                  <button
                    onClick={handleOpenSettings}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs transition"
                  >
                    <SettingsIcon className="w-3 h-3" />
                    去设置
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
              <div className="relative sm:w-36">
                <select
                  value={selectedProvider}
                  onChange={e => setSelectedProvider(e.target.value)}
                  className="w-full px-3 py-2.5 sm:py-2 pr-8 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50 min-h-[44px]"
                  disabled={isAnalyzing}
                >
                  <option value="" className="bg-slate-800 text-slate-100">选择平台</option>
                  {settings?.ai_platforms?.map(p => (
                    <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative flex-1">
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2.5 sm:py-2 pr-8 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50 min-h-[44px]"
                  disabled={isAnalyzing}
                >
                  <option value="" className="bg-slate-800 text-slate-100">选择模型</option>
                  {filteredModels.map(m => (
                    <option key={m.model} value={m.model} className="bg-slate-800 text-slate-100">
                      {m.model} {m.supportsVision ? '(视觉)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* 分析按钮 */}
          <div className="flex gap-2">
            <button
              onClick={startAnalysis}
              disabled={isAnalyzing || !selectedProvider || !selectedModel}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 hover:from-emerald-500/30 hover:to-teal-500/30 border border-emerald-400/30 text-emerald-200 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition min-h-[44px]"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  分析中...
                </>
              ) : (
                <>
                  <Loader2 className="w-4 h-4" />
                  开始分析
                </>
              )}
            </button>
            {isAnalyzing && (
              <button
                onClick={cancelAnalysis}
                className="px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 text-sm font-medium transition min-h-[44px]"
              >
                取消分析
              </button>
            )}
          </div>

          {/* 错误提示 + 操作引导 */}
          {error && (
            <AiErrorGuide error={error} onOpenSettings={handleOpenSettings} />
          )}

          {/* 分析结果 */}
          {analysisResult && (
            <div className="p-3 sm:p-4 rounded-xl bg-white/5 border border-white/10">
              <h3 className="text-sm font-medium text-violet-300 mb-3 flex items-center">
                <Check className="w-4 h-4 mr-2" />
                分析结果
              </h3>
              <div className="space-y-2">
                <div>
                  <span className="text-xs text-slate-400">画面内容：</span>
                  <span className="text-sm text-white">{analysisResult.sceneContent || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">地点：</span>
                  <span className="text-sm text-white">{analysisResult.location || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">演员：</span>
                  <span className="text-sm text-white">{analysisResult.actors || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">服饰：</span>
                  <span className="text-sm text-white">{analysisResult.costume || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">道具：</span>
                  <span className="text-sm text-white">{analysisResult.props || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">景别：</span>
                  <span className="text-sm text-white">{analysisResult.shotType || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">焦段：</span>
                  <span className="text-sm text-white">{analysisResult.focalLength || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">角度：</span>
                  <span className="text-sm text-white">{analysisResult.shotAngle || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">灯光：</span>
                  <span className="text-sm text-white">{analysisResult.lighting || '-'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400">镜头运动：</span>
                  <span className="text-sm text-white">{analysisResult.cameraMovement || '-'}</span>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mt-4">
                <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 text-sm font-medium transition min-h-[44px]">
                  取消
                </button>
                <button onClick={handleApply} className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition min-h-[44px]">
                  应用到分镜
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
