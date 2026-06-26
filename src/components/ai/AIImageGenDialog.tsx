import React, { useState, useRef, useEffect } from 'react';
import { X, Upload, ImageIcon, Loader2, CheckCircle, AlertCircle, Info } from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import { uploadVideo2Image } from '../../lib/ossUtils';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface AIImageGenDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shot: Shot;
  onGenerated?: (media: ShotMedia) => void;
}

interface Settings {
  image_model: string;
  image_quality: string;
  model_prices: Record<string, any>;
}

interface GeneratedResult {
  url: string;
  cost: number;
}

type ImageSize = '1024x576' | '768x768' | '1536x1024';

const IMAGE_SIZES: { value: ImageSize; label: string }[] = [
  { value: '1024x576', label: '1024×576 (16:9)' },
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

export default function AIImageGenDialog({
  isOpen,
  onClose,
  shot,
  onGenerated,
}: AIImageGenDialogProps) {
  const [prompt, setPrompt] = useState(shot.sceneContent || '');
  const [sceneImage, setSceneImage] = useState<File | null>(null);
  const [sceneImagePreview, setSceneImagePreview] = useState<string | null>(null);
  const [reusedSceneImageUrl, setReusedSceneImageUrl] = useState<string | null>(null);
  const [sceneImages, setSceneImages] = useState<any[]>([]);
  const [selectedSize, setSelectedSize] = useState<ImageSize>('1024x576');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [generatedImage, setGeneratedImage] = useState<GeneratedResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [cost, setCost] = useState<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // 加载设置
  useEffect(() => {
    if (isOpen) {
      fetch('/api/video2/settings')
        .then(res => res.json())
        .then(data => {
          if (data.success !== false) {
            setSettings(data);
            // 根据模型和质量估算费用
            const model = data.image_model || 'gpt-image-2';
            const quality = data.image_quality || 'medium';
            const prices = data.model_prices || {};
            const priceKey = `${model}-${quality}`;
            const estimatedCost = prices[priceKey] || 0.08;
            setCost(estimatedCost);
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
      setPrompt(shot.sceneContent || '');
      setSceneImage(null);
      setSceneImagePreview(null);
      setReusedSceneImageUrl(null);
      setSceneImages([]);
      setSelectedSize('1024x576');
      setStatus('idle');
      setGeneratedImage(null);
      setErrorMessage('');
    }
  }, [isOpen, shot.sceneContent]);

  // 加载同场场景图
  useEffect(() => {
    if (isOpen && shot.sceneId) {
      fetch(`/api/video2/scenes/${shot.sceneId}/references`)
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data && data.data.length > 0) {
            setSceneImages(data.data);
          }
        })
        .catch(console.error);
    }
  }, [isOpen, shot.sceneId]);

  const handleSceneImageSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;

    setSceneImage(file);
    setSceneImagePreview(URL.createObjectURL(file));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleSceneImageSelect(e.dataTransfer.files);
  };

  const handleRemoveSceneImage = () => {
    setSceneImage(null);
    if (sceneImagePreview) {
      URL.revokeObjectURL(sceneImagePreview);
      setSceneImagePreview(null);
    }
  };

  const startGeneration = async () => {
    setStatus('generating');
    setErrorMessage('');

    try {
      // 1. 上传场景参考图（如果有）或使用复用的场景图
      let sceneImageUrl: string | undefined;
      if (reusedSceneImageUrl) {
        sceneImageUrl = reusedSceneImageUrl;
      } else if (sceneImage) {
        const uploadResult = await uploadVideo2Image(sceneImage, {
          projectId: shot.projectId,
          reference: true,
          title: `scene_ref_${shot.id}_${Date.now()}`,
        });
        sceneImageUrl = uploadResult.url;
      }

      // 2. 调用生成接口
      const response = await fetch('/api/video2/ai/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotId: shot.id,
          prompt: prompt,
          sceneImageUrl,
          size: selectedSize,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || '生成失败');
      }

      const { taskId } = await response.json();

      // 3. 轮询任务状态
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

            // 4. 生成完成后，获取结果 URL
            const output = task.output || {};
            const imageUrl = output.media?.url || output.imageUrl;
            if (imageUrl) {
              setGeneratedImage({
                url: imageUrl,
                cost: cost,
              });
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

  const handleAddToShot = async () => {
    if (!generatedImage) return;

    try {
      // 保存到 shot_media 表
      const response = await fetch(`/api/video2/shots/${shot.id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: generatedImage.url,
          type: 'image',
          filename: `ai_gen_${Date.now()}.png`,
          source: 'ai_generated',
        }),
      });

      if (!response.ok) {
        throw new Error('保存失败');
      }

      const data = await response.json();
      const newMedia: ShotMedia = {
        id: data.id,
        shotId: shot.id,
        url: generatedImage.url,
        type: 'image',
        filename: `ai_gen_${Date.now()}.png`,
        size: 0,
        sortOrder: (shot.media?.length || 0),
        source: 'ai_generated',
        createdAt: new Date().toISOString(),
      };

      onGenerated?.(newMedia);
      onClose();
    } catch (err) {
      setErrorMessage('保存到分镜失败');
      setStatus('error');
    }
  };

  const handleRegenerate = () => {
    setStatus('idle');
    setGeneratedImage(null);
    setErrorMessage('');
  };

  const getModelDisplayName = () => {
    if (!settings) return 'GPT-Image-2';
    const model = settings.image_model || 'gpt-image-2';
    const quality = settings.image_quality || 'medium';
    const displayNames: Record<string, string> = {
      'gpt-image-2': 'GPT-Image-2',
      'gpt-image-1': 'GPT-Image-1',
      'dall-e-3': 'DALL-E 3',
      'flux': 'Flux',
    };
    return displayNames[model.toLowerCase()] || model;
  };

  const getCostLevel = () => {
    if (!settings) return 'mid';
    const quality = settings.image_quality || 'medium';
    const qualityMap: Record<string, string> = {
      low: 'low',
      medium: 'mid',
      high: 'mid_high',
      '2k': 'high',
    };
    return qualityMap[quality] || 'mid';
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">AI 生成参考图</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {status === 'idle' && (
            <>
              {/* 画面内容 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">画面内容</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
                  placeholder="描述你想要生成的画面内容..."
                />
              </div>

              {/* 场景参考图 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">场景参考图（可选）</label>
                {sceneImagePreview ? (
                  <div className="relative rounded-xl border border-white/10 overflow-hidden">
                    <img
                      src={sceneImagePreview}
                      alt="场景参考"
                      className="w-full h-32 object-cover"
                    />
                    <button
                      onClick={handleRemoveSceneImage}
                      className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white transition"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-xs">
                      本地上传
                    </div>
                  </div>
                ) : reusedSceneImageUrl ? (
                  <div className="relative rounded-xl border border-white/10 overflow-hidden">
                    <img
                      src={reusedSceneImageUrl}
                      alt="复用场景图"
                      className="w-full h-32 object-cover"
                    />
                    <button
                      onClick={() => setReusedSceneImageUrl(null)}
                      className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white transition"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-xs">
                      同场复用
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
                    <p className="text-xs text-slate-500 mt-1">上传场景图片帮助生成特定场景</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => handleSceneImageSelect(e.target.files)}
                    />
                  </div>
                )}
              </div>

              {/* 同场场景图（可复用） */}
              {sceneImages.length > 0 && !sceneImagePreview && !reusedSceneImageUrl && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    同场场景图（点击复用）
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {sceneImages.map((img) => (
                      <button
                        key={img.id}
                        onClick={() => setReusedSceneImageUrl(img.url)}
                        className="relative rounded-lg overflow-hidden border border-white/10 hover:border-violet-400/50 transition group aspect-video"
                        title={img.title || '点击复用'}
                      >
                        <img
                          src={img.url}
                          alt={img.title || '场景图'}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center">
                          <span className="text-white text-xs opacity-0 group-hover:opacity-100 transition font-medium">
                            点击复用
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    本场次已有 {sceneImages.length} 张场景图，可直接复用
                  </p>
                </div>
              )}

              {/* 图片尺寸 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">图片尺寸</label>
                <div className="relative">
                  <select
                    value={selectedSize}
                    onChange={e => setSelectedSize(e.target.value as ImageSize)}
                    className="w-full px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
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

              {/* 模型和费用 */}
              <div className="mb-6 flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">使用模型：{getModelDisplayName()}</span>
                  <button className="w-5 h-5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition">
                    <Info className="w-3 h-3 text-slate-400" />
                  </button>
                </div>
                <span className="text-amber-300/80">费用{getCostLevel() !== 'free' ? `（${COST_LABELS[getCostLevel()]}）` : ''}</span>
              </div>
            </>
          )}

          {status === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-12 h-12 text-violet-400 animate-spin mb-4" />
              <p className="text-lg font-medium text-slate-200 mb-2">正在生成参考图...</p>
              <p className="text-sm text-slate-400 mb-1">模型：{getModelDisplayName()} ({settings?.image_quality || 'medium'})</p>
              <p className="text-xs text-slate-500">预计时间：15-30秒</p>
              <p className="text-xs text-slate-600 mt-4">请勿关闭页面</p>
            </div>
          )}

          {status === 'done' && generatedImage && (
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-2 text-green-400 mb-4">
                <CheckCircle className="w-6 h-6" />
                <span className="text-lg font-medium">生成完成！</span>
              </div>

              <div className="w-full rounded-xl border border-white/10 overflow-hidden mb-4">
                <img
                  src={generatedImage.url}
                  alt="生成的参考图"
                  className="w-full h-auto max-h-80 object-contain bg-black/40"
                />
              </div>

              <p className="text-sm text-slate-400 mb-6">费用：¥{generatedImage.cost.toFixed(2)}/张</p>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
              <p className="text-lg font-medium text-red-300 mb-2">生成失败</p>
              <p className="text-sm text-slate-400">{errorMessage || '请稍后重试'}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
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
                disabled={!prompt.trim()}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                生成参考图
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
              <button
                onClick={handleAddToShot}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition"
              >
                添加到分镜
              </button>
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
