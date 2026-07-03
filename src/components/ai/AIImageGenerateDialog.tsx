import React, { useState, useRef, useEffect } from 'react';
import { X, Upload, Loader2, CheckCircle, AlertCircle, ChevronDown } from 'lucide-react';
import type { Settings, ModelConfig } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { AiErrorGuide } from './AiErrorGuide';

interface AIImageGenerateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  onUseImage?: (imageUrl: string) => void;
  title?: string;
  showUpdatePromptOption?: boolean;
  updatePromptChecked?: boolean;
  onUpdatePromptChange?: (checked: boolean) => void;
  onOpenSettings?: () => void;
}

type ImageSize = '1024x576' | '576x1024' | '768x768' | '1536x1024';

const IMAGE_SIZES: { value: ImageSize; label: string }[] = [
  { value: '1024x576', label: '1024×576 (16:9)' },
  { value: '576x1024', label: '576×1024 (9:16)' },
  { value: '768x768', label: '768×768 (1:1)' },
  { value: '1536x1024', label: '1536×1024 (3:2)' },
];

const COST_LABELS: Record<string, string> = {
  free: '免费',
  low: '低',
  mid: '中',
  mid_high: '中高',
  high: '高',
};

export default function AIImageGenerateDialog({
  isOpen,
  onClose,
  initialPrompt = '',
  onUseImage,
  title = 'AI 生成图片',
  showUpdatePromptOption = false,
  updatePromptChecked = false,
  onUpdatePromptChange,
  onOpenSettings,
}: AIImageGenerateDialogProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [refImage, setRefImage] = useState<File | null>(null);
  const [refImagePreview, setRefImagePreview] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('geekai');
  const [selectedModel, setSelectedModel] = useState<ModelConfig | null>(null);
  const [selectedSize, setSelectedSize] = useState<ImageSize>('1024x576');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelConfig[]>([]);
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // 加载设置
  useEffect(() => {
    if (isOpen) {
      fetch('/api/video2/settings')
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data) {
            setSettings(data.data);
            const models = data.data.image_fallback_chain || data.data.image_models || [];
            setAvailableModels(models);
            // 默认选择第一个模型
            if (models.length > 0) {
              setSelectedModel(models[0]);
              setSelectedProvider(models[0].provider);
            }
          }
        })
        .catch(console.error);
    }
  }, [isOpen]);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 重置状态
  useEffect(() => {
    if (isOpen) {
      setPrompt(initialPrompt);
      setRefImage(null);
      if (refImagePreview) {
        URL.revokeObjectURL(refImagePreview);
      }
      setRefImagePreview(null);
      setStatus('idle');
      setGeneratedImageUrl(null);
      setErrorMessage('');
    }
  }, [isOpen, initialPrompt]);

  // 根据平台过滤模型
  const filteredModels = availableModels.filter(m => m.provider === selectedProvider);

  // 当切换平台时，自动选择该平台的第一个模型
  useEffect(() => {
    if (filteredModels.length > 0 && (!selectedModel || selectedModel.provider !== selectedProvider)) {
      setSelectedModel(filteredModels[0]);
    }
  }, [selectedProvider, filteredModels, selectedModel]);

  const handleRefImageSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;

    setRefImage(file);
    setRefImagePreview(URL.createObjectURL(file));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleRefImageSelect(e.dataTransfer.files);
  };

  const handleRemoveRefImage = () => {
    setRefImage(null);
    if (refImagePreview) {
      URL.revokeObjectURL(refImagePreview);
      setRefImagePreview(null);
    }
  };

  const uploadRefImage = async (): Promise<string | undefined> => {
    if (!refImage) return undefined;

    try {
      const formData = new FormData();
      formData.append('file', refImage);
      formData.append('reference', 'true');
      formData.append('title', `ref_${Date.now()}`);

      const response = await fetch('/api/video2/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('上传参考图失败');
      }

      const data = await response.json();
      return data.url;
    } catch (err) {
      console.error('上传参考图失败:', err);
      throw err;
    }
  };

  const startGeneration = async () => {
    if (!selectedModel || !prompt.trim()) return;

    setStatus('generating');
    setErrorMessage('');

    try {
      // 上传参考图（如果有）
      let refImageUrl: string | undefined;
      if (refImage) {
        refImageUrl = await uploadRefImage();
      }

      // 调用通用生图接口
      const response = await fetch('/api/video2/ai/generic-image-gen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          refImageUrl,
          size: selectedSize,
          provider: selectedProvider,
          model: selectedModel.model,
          quality: selectedModel.quality || 'standard',
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || '生成失败');
      }

      const { taskId } = await response.json();

      // 轮询任务状态
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 5;
      pollingRef.current = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/video2/ai/task/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error(`HTTP ${statusResponse.status}`);
          }
          const result = await statusResponse.json();
          const task = result.data || result;
          consecutiveFailures = 0;

          if (task.status === 'done') {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;

            const imageUrl = task.output?.imageUrl;
            if (imageUrl) {
              setGeneratedImageUrl(imageUrl);
              setStatus('done');
            } else {
              throw new Error('生成结果无效');
            }
          } else if (task.status === 'error') {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;
            throw new Error(task.error || '生成失败');
          }
        } catch (err) {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;
            setErrorMessage(err instanceof Error ? err.message : '未知错误');
            setStatus('error');
          }
        }
      }, 2000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '未知错误');
      setStatus('error');
    }
  };

  const handleUseImage = () => {
    if (generatedImageUrl && onUseImage) {
      onUseImage(generatedImageUrl);
      onClose();
    }
  };

  const handleRegenerate = () => {
    setStatus('idle');
    setGeneratedImageUrl(null);
    setErrorMessage('');
  };

  const getModelDisplayName = (model: ModelConfig | null) => {
    if (!model) return '未选择';
    const displayNames: Record<string, string> = {
      'gpt-image-2': 'GPT-Image-2',
      'gpt-image-1': 'GPT-Image-1',
      'dall-e-3': 'DALL-E 3',
      'z-image-turbo': 'Z-Image Turbo',
      'nano-banana-2': 'Nano Banana 2',
      'cogview-4': 'CogView 4',
      'flux': 'Flux',
    };
    return displayNames[model.model.toLowerCase()] || model.model;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-2 sm:p-4" onClick={onClose}>
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md sm:max-w-xl rounded-2xl sm:rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10 shrink-0">
          <h2 className="text-base sm:text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="w-10 h-10 sm:w-8 sm:h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {status === 'idle' && (
            <>
              {/* 提示词输入 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">提示词</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
                  placeholder="描述你想要生成的画面内容..."
                />
              </div>

              {/* 参考图上传（仅支持图生图的模型显示） */}
              {selectedModel?.supportsImageRef && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">参考图（可选）</label>
                  {refImagePreview ? (
                    <div className="relative rounded-xl border border-white/10 overflow-hidden">
                      <img
                        src={refImagePreview}
                        alt="参考图"
                        className="w-full h-32 object-cover"
                      />
                      <button
                        onClick={handleRemoveRefImage}
                        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white transition"
                      >
                        <X className="w-4 h-4" />
                      </button>
                      <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-xs">
                        本地上传
                      </div>
                    </div>
                  ) : (
                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                      onDragLeave={() => setIsDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition ${
                        isDragOver
                          ? 'border-violet-400 bg-violet-500/10'
                          : 'border-white/15 hover:border-violet-400/40 bg-white/[0.02] hover:bg-white/[0.04]'
                      }`}
                    >
                      <Upload className={`w-6 h-6 mx-auto mb-2 ${isDragOver ? 'text-violet-400' : 'text-white/40'}`} />
                      <p className="text-sm text-slate-400">点击或拖拽图片到此处</p>
                      <p className="text-xs text-slate-500 mt-1">上传参考图帮助生成相似风格图片</p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => handleRefImageSelect(e.target.files)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* 平台选择 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">平台</label>
                <div className="relative">
                  <select
                    value={selectedProvider}
                    onChange={e => setSelectedProvider(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                  >
                    {(settings?.ai_platforms || []).map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  </div>
                </div>
              </div>

              {/* 模型选择 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">模型</label>
                <div className="relative">
                  <select
                    value={selectedModel?.model || ''}
                    onChange={e => {
                      const model = filteredModels.find(m => m.model === e.target.value);
                      setSelectedModel(model || null);
                    }}
                    className="w-full px-4 py-3 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                  >
                    {filteredModels.map(model => (
                      <option key={model.model} value={model.model}>
                        {getModelDisplayName(model)} {model.supportsImageRef ? '(支持图生图)' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* 图片尺寸 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">图片尺寸</label>
                <div className="relative">
                  <select
                    value={selectedSize}
                    onChange={e => setSelectedSize(e.target.value as ImageSize)}
                    className="w-full px-4 py-3 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                  >
                    {IMAGE_SIZES.map(size => (
                      <option key={size.value} value={size.value}>
                        {size.label}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* 更新提示词选项 */}
              {showUpdatePromptOption && (
                <div className="mb-4">
                  <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={updatePromptChecked}
                      onChange={e => onUpdatePromptChange?.(e.target.checked)}
                      className="accent-violet-500"
                    />
                    <span>生成后更新该资产的提示词</span>
                  </label>
                </div>
              )}

              {/* 费用提示 */}
              {selectedModel && (
                <div className="mb-6 text-sm text-slate-400">
                  <span className="text-amber-300/80">
                    费用：{COST_LABELS[selectedModel.cost] || '未知'}
                    {selectedModel.cost !== 'free' ? `（${COST_LABELS[selectedModel.cost]}）` : ''}
                  </span>
                </div>
              )}
            </>
          )}

          {status === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-12 h-12 text-violet-400 animate-spin mb-4" />
              <p className="text-lg font-medium text-slate-200 mb-2">正在生成图片...</p>
              <p className="text-sm text-slate-400 mb-1">
                模型：{getModelDisplayName(selectedModel)} ({selectedModel?.quality || 'standard'})
              </p>
              <p className="text-xs text-slate-500">预计时间：15-30秒</p>
              <p className="text-xs text-slate-600 mt-4">请勿关闭页面</p>
            </div>
          )}

          {status === 'done' && generatedImageUrl && (
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-2 text-green-400 mb-4">
                <CheckCircle className="w-6 h-6" />
                <span className="text-lg font-medium">生成完成！</span>
              </div>

              <div className="w-full rounded-xl border border-white/10 overflow-hidden mb-4">
                <img
                  src={generatedImageUrl}
                  alt="生成的图片"
                  className="w-full h-auto max-h-80 object-contain bg-black/40"
                />
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="py-4 sm:py-8">
              <AiErrorGuide error={errorMessage || '生成失败'} onOpenSettings={onOpenSettings} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-t border-white/10 flex flex-col sm:flex-row justify-end gap-2 sm:gap-3 shrink-0">
          {status === 'idle' && (
            <>
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                取消
              </button>
              <button
                onClick={startGeneration}
                disabled={!prompt.trim() || !selectedModel}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                生成图片
              </button>
            </>
          )}

          {status === 'generating' && (
            <button
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
            >
              取消
            </button>
          )}

          {status === 'done' && (
            <>
              <button
                onClick={handleRegenerate}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                重新生成
              </button>
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                取消
              </button>
              {onUseImage && (
                <button
                  onClick={handleUseImage}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition"
                >
                  使用此图片
                </button>
              )}
            </>
          )}

          {status === 'error' && (
            <>
              <button
                onClick={handleRegenerate}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                重试
              </button>
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                取消
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}