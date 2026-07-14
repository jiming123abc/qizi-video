import React, { useState, useRef, useEffect } from 'react';
import { X, Upload, Loader2, CheckCircle, AlertCircle, Info, Plus, ChevronDown, Trash2, Archive, Film } from 'lucide-react';
import type { Shot, Settings, ModelConfig, AiGeneratedImage, RefImage, DigitalAsset } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useSignedUrl } from '../../hooks/useSignedUrl';
import { useRefImages } from '../../hooks/useRefImages';
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
  // P3-24 新增：
  ownerId?: number;  // 用于历史图持久化（如数字资产 ID）
  projectId?: number;  // 用于上传参考图到正确的 OSS 目录
  // 统一对话框新增：
  shot?: Shot;                    // 分镜上下文（传入时为分镜生图模式）
  ownerType?: 'shot' | 'asset';   // 默认 'asset'，shot 上下文时传 'shot'
  sceneShots?: Shot[];            // 当前场次的分镜列表（仅分镜模式，用于参考图选择）
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
  ownerId,
  projectId,
  shot,
  ownerType: ownerTypeProp = 'asset',
  sceneShots,
}: AIImageGenerateDialogProps) {
  // 统一模式判断
  const isShotMode = !!shot;
  const effectiveOwnerType = isShotMode ? 'shot' : ownerTypeProp;
  const effectiveOwnerId = isShotMode ? shot!.id : (ownerId || 0);
  const effectiveProjectId = isShotMode ? shot!.projectId : projectId;

  // 智能提示词生成：根据 shot 字段生成提示词
  const generateSmartPrompt = (s: Shot): string => {
    if (s.aiImagePrompt) return s.aiImagePrompt;
    if (s.sceneContent) return s.sceneContent;

    const parts: string[] = [];
    if (s.location) parts.push(`地点：${s.location}`);
    if (s.actors) parts.push(`演员：${s.actors}`);
    if (s.costume) parts.push(`服饰：${s.costume}`);
    if (s.props) parts.push(`道具：${s.props}`);
    if (s.shotType) parts.push(`景别：${s.shotType}`);
    if (s.focalLength) parts.push(`焦段：${s.focalLength}`);
    if (s.shotAngle) parts.push(`角度：${s.shotAngle}`);
    if (s.lighting) parts.push(`灯光：${s.lighting}`);
    if (s.cameraMovement) parts.push(`镜头运动：${s.cameraMovement}`);

    if (parts.length === 0) return '';
    return parts.join('，') + '。请根据以上信息生成一张专业的电影画面参考图。';
  };

  const [prompt, setPrompt] = useState(isShotMode ? generateSmartPrompt(shot!) : initialPrompt);
  const [selectedProvider, setSelectedProvider] = useState<string>('geekai');
  const [selectedModel, setSelectedModel] = useState<ModelConfig | null>(null);
  const [selectedSize, setSelectedSize] = useState<ImageSize>('1024x576');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelConfig[]>([]);
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);

  // P3-24：@引用浮层
  const [showAtDropdown, setShowAtDropdown] = useState(false);
  const [atDropdownPos, setAtDropdownPos] = useState<{ top: number; left: number } | null>(null);

  // 参考图来源选择面板
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [showShotPicker, setShowShotPicker] = useState(false);
  const [digitalAssets, setDigitalAssets] = useState<DigitalAsset[]>([]);

  // P3-24：使用 useRefImages hook 统一管理参考图与历史图
  const {
    refImages,
    historyImages,
    MAX_REF_IMAGES,
    MAX_HISTORY,
    isFull,
    addAssetRef,
    addUploadRef,
    addUrlRef,
    removeRef,
    clearRefs,
    isRefSelected,
    loadHistory,
    deleteHistory,
    getAllRefUrls,
  } = useRefImages({
    ownerType: effectiveOwnerType,
    ownerId: effectiveOwnerId,
    projectId: effectiveProjectId,
    enabled: !!effectiveOwnerId,
  });

  // P3-24：参考图上传 input（缩略图条的 + 按钮）
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // 加载设置
  useEffect(() => {
    if (isOpen) {
      fetch('/api/settings')
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

  // P3-1：清理轮询（unmount 或对话框关闭时）
  useEffect(() => {
    if (!isOpen) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isOpen]);

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 重置状态（每次打开时重新生成提示词）
  useEffect(() => {
    if (isOpen) {
      // 分镜模式：从 shot 当前字段重新生成提示词；资产模式：使用 initialPrompt
      setPrompt(isShotMode && shot ? generateSmartPrompt(shot) : initialPrompt);
      setStatus('idle');
      setGeneratedImageUrl(null);
      setErrorMessage('');
      // P3-24：清空参考图，防止上次选择残留
      clearRefs();
      // P3-22：重新加载历史图（dialog 重新打开时手动触发，仅当 ownerId 存在）
      if (effectiveOwnerId) {
        loadHistory();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialPrompt, shot]);

  // P3-24：@引用浮层 - 当无可引用的资产时自动关闭
  useEffect(() => {
    if (showAtDropdown && !refImages.some(r => r.source === 'asset' && r.assetName)) {
      setShowAtDropdown(false);
    }
  }, [refImages, showAtDropdown]);

  // 加载项目数字资产（用于参考图选择和 @引用）
  useEffect(() => {
    if (isOpen && effectiveProjectId) {
      fetch(`/api/projects/${effectiveProjectId}/assets`)
        .then(res => res.json())
        .then(data => {
          if (data.success && Array.isArray(data.data)) {
            // 仅保留有图片的资产
            const assetsWithImages = data.data.filter(
              (a: DigitalAsset) => a.imageUrl || (a.images && a.images.length > 0)
            );
            setDigitalAssets(assetsWithImages);
          }
        })
        .catch(console.error);
    }
  }, [isOpen, effectiveProjectId]);

  // 根据平台过滤模型
  const filteredModels = availableModels.filter(m => m.provider === selectedProvider);

  // 当切换平台时，自动选择该平台的第一个模型
  useEffect(() => {
    if (filteredModels.length > 0 && (!selectedModel || selectedModel.provider !== selectedProvider)) {
      setSelectedModel(filteredModels[0]);
    }
  }, [selectedProvider, filteredModels, selectedModel]);

  // P3-24：prompt 输入变化，检测 @ 触发引用浮层
  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setPrompt(value);
    // 检测 @ 触发（最后一个字符为 @，且存在可引用的资产参考图）
    const lastChar = value[value.length - 1];
    if (lastChar === '@' && refImages.some(r => r.source === 'asset' && r.assetName)) {
      const textarea = e.target;
      const rect = textarea.getBoundingClientRect();
      setAtDropdownPos({ top: rect.bottom + 4, left: rect.left + 20 });
      setShowAtDropdown(true);
    } else {
      setShowAtDropdown(false);
    }
  };

  // P3-24：选择 @ 引用项
  const handleSelectAtRef = (refImg: RefImage) => {
    if (!refImg.assetName) return;
    setPrompt(prev => prev.replace(/@$/, `@${refImg.assetName} `));
    setShowAtDropdown(false);
    setAtDropdownPos(null);
  };

  // P3-24：拖拽上传 - drop 时调用 addUploadRef
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;
    try {
      await addUploadRef(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : '上传参考图失败');
    }
  };

  // P3-24：文件选择上传
  const handleUploadInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      try {
        await addUploadRef(f);
      } catch (err) {
        alert(err instanceof Error ? err.message : '上传参考图失败');
      }
    }
    e.target.value = '';
  };

  const startGeneration = async () => {
    if (!selectedModel || !prompt.trim()) return;

    setStatus('generating');
    setErrorMessage('');

    try {
      // P3-24：使用统一的参考图 URL 列表
      const refUrls = getAllRefUrls();

      // 根据模式选择 API 端点
      const apiEndpoint = isShotMode ? '/api/ai/generate-image' : '/api/ai/generic-image-gen';
      const requestBody: Record<string, unknown> = {
        prompt: prompt.trim(),
        refImages: refUrls,
        size: selectedSize,
        provider: selectedProvider,
        model: selectedModel.model,
        quality: selectedModel.quality || 'standard',
        ownerType: effectiveOwnerType,
        ownerId: effectiveOwnerId || undefined,
      };
      // 非分镜模式传 projectId（用于 AI 通用生图存到正确的 digital-assets 目录）
      if (!isShotMode && effectiveProjectId) {
        requestBody.projectId = effectiveProjectId;
      }
      // 分镜模式需传 shotId
      if (isShotMode && shot) {
        requestBody.shotId = shot.id;
      }

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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
          const statusResponse = await fetch(`/api/ai/task/${taskId}`);
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
              // P3-22：生成成功后刷新历史图列表（仅当 ownerId 存在）
              if (effectiveOwnerId) {
                loadHistory();
              }
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-8 sm:p-4" onClick={onClose}>
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md sm:max-w-xl rounded-2xl sm:rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl max-h-[90vh] overflow-hidden"
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
                  onChange={handlePromptChange}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
                  placeholder="描述你想要生成的画面内容...（输入 @ 可引用资产）"
                />
              </div>

              {/* P3-24：已选参考图缩略图条（始终显示，含拖拽上传） */}
              <div className={`mb-4 ${selectedModel && !selectedModel.supportsImageRef ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-300">
                    参考图 ({refImages.length}/{MAX_REF_IMAGES})
                  </label>
                </div>
                {selectedModel && !selectedModel.supportsImageRef && (
                  <p className="text-xs text-orange-300 mb-2">当前模型不支持参考图</p>
                )}
                {/* 三个并列入口（仅空状态时显示） */}
                {refImages.length === 0 && (
                  <div className="flex gap-2 mb-2">
                    {effectiveProjectId && (
                      <button
                        onClick={() => uploadInputRef.current?.click()}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-white/15 hover:border-violet-400 hover:bg-violet-500/10 transition text-sm text-slate-300"
                      >
                        <Upload className="w-4 h-4" />
                        上传图片
                      </button>
                    )}
                    {effectiveProjectId && (
                      <button
                        onClick={() => { setShowAssetPicker(!showAssetPicker); setShowShotPicker(false); }}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border transition text-sm ${showAssetPicker ? 'border-violet-400 bg-violet-500/10 text-violet-300' : 'border-white/15 hover:border-violet-400 hover:bg-violet-500/10 text-slate-300'}`}
                      >
                        <Archive className="w-4 h-4" />
                        数字资产
                      </button>
                    )}
                    {isShotMode && sceneShots && (
                      <button
                        onClick={() => { setShowShotPicker(!showShotPicker); setShowAssetPicker(false); }}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border transition text-sm ${showShotPicker ? 'border-violet-400 bg-violet-500/10 text-violet-300' : 'border-white/15 hover:border-violet-400 hover:bg-violet-500/10 text-slate-300'}`}
                      >
                        <Film className="w-4 h-4" />
                        从分镜选择
                      </button>
                    )}
                  </div>
                )}
                <div
                  onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  className={`rounded-xl border-2 border-dashed transition ${
                    isDragOver
                      ? 'border-violet-400 bg-violet-500/10'
                      : 'border-white/15 bg-white/[0.02]'
                  }`}
                >
                  {refImages.length === 0 ? (
                    <div className="p-3 text-center">
                      <p className="text-xs text-slate-500">
                        {isDragOver ? '松开以上传参考图' : '支持拖拽图片到此处'}
                      </p>
                    </div>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto p-2">
                      {refImages.map(r => (
                        <RefThumb key={r.id} refImg={r} onRemove={() => removeRef(r.id)} />
                      ))}
                      {!isFull && effectiveProjectId && (
                        <button
                          onClick={() => uploadInputRef.current?.click()}
                          className="shrink-0 w-16 h-16 rounded-lg border-2 border-dashed border-white/20 hover:border-violet-400 flex items-center justify-center transition"
                          title="上传参考图"
                        >
                          <Plus className="w-5 h-5 text-white/40" />
                        </button>
                      )}
                    </div>
                  )}
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleUploadInputChange}
                  />
                </div>

                {/* 从数字资产选择面板 */}
                {showAssetPicker && (
                  <div className="mt-2 p-2 rounded-lg bg-slate-800/80 border border-white/10 max-h-48 overflow-y-auto">
                    {digitalAssets.length > 0 ? (
                      <>
                        <p className="text-xs text-slate-400 mb-2 px-1">点击资产添加为参考图</p>
                        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                          {digitalAssets.map(asset => {
                            const imgUrl = asset.imageUrl || (asset.images && asset.images[0]?.imageUrl);
                            if (!imgUrl) return null;
                            return <AssetThumb key={asset.id} asset={asset} imgUrl={imgUrl} onAdd={() => addAssetRef(imgUrl, { assetId: asset.id, assetName: asset.name, assetType: asset.type })} isSelected={isRefSelected(imgUrl)} />;
                          })}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-slate-500 text-center py-4">暂无带图片的数字资产</p>
                    )}
                  </div>
                )}

                {/* 从当前场次分镜选择面板 */}
                {showShotPicker && isShotMode && sceneShots && (
                  <div className="mt-2 p-2 rounded-lg bg-slate-800/80 border border-white/10 max-h-48 overflow-y-auto">
                    <p className="text-xs text-slate-400 mb-2 px-1">点击分镜图片添加为参考图</p>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {sceneShots
                        .filter(s => s.id !== shot?.id)  // 排除当前 shot
                        .flatMap(s => {
                          const images: { url: string; shotId: number; shotTitle: string }[] = [];
                          if (s.media && Array.isArray(s.media)) {
                            s.media.forEach((m: { url?: string; type?: string }) => {
                              if (m.type === 'image' && m.url) {
                                images.push({ url: m.url, shotId: s.id, shotTitle: s.title });
                              }
                            });
                          }
                          // 兼容旧字段
                          if (s.type === 'image' && s.url && !s.media) {
                            images.push({ url: s.url, shotId: s.id, shotTitle: s.title });
                          }
                          return images;
                        })
                        .map((img, idx) => (
                          <ShotImageThumb key={`${img.shotId}-${idx}`} imgUrl={img.url} shotTitle={img.shotTitle} onAdd={() => addUrlRef(img.url, img.shotTitle)} />
                        ))
                      }
                    </div>
                    {sceneShots.filter(s => s.id !== shot?.id).length === 0 && (
                      <p className="text-xs text-slate-500 text-center py-2">当前场次无其他分镜</p>
                    )}
                  </div>
                )}
              </div>

              {/* AI 模型选择（平台 + 模型并排） */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">AI 模型选择</label>
                <div className="flex gap-3">
                  {/* 平台选择 */}
                  <div className="relative sm:w-36">
                    <select
                      value={selectedProvider}
                      onChange={e => setSelectedProvider(e.target.value)}
                      className="w-full px-3 py-3 pr-8 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                    >
                      {(settings?.ai_platforms || []).map(p => (
                        <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                  {/* 模型选择 */}
                  <div className="relative flex-1">
                    <select
                      value={selectedModel?.model || ''}
                      onChange={e => {
                        const model = filteredModels.find(m => m.model === e.target.value);
                        setSelectedModel(model || null);
                      }}
                      className="w-full px-3 py-3 pr-8 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                    >
                      {filteredModels.map(model => (
                        <option key={model.model} value={model.model} className="bg-slate-800 text-slate-100">
                          {getModelDisplayName(model)} {model.supportsImageRef ? '(支持图生图)' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
                {/* 费用提示 */}
                {selectedModel && (
                  <p className="text-xs text-slate-500 mt-1">
                    费用：{COST_LABELS[selectedModel.cost] || '未知'}
                  </p>
                )}
                {/* P3-24：模型能力警告 */}
                {selectedModel && !selectedModel.supportsImageRef && refImages.length > 0 && (
                  <div className="mt-2 p-2 rounded-lg bg-orange-500/10 border border-orange-500/30 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-orange-300">
                      当前模型不支持图生图，将仅以文字描述参考图风格生成
                    </p>
                  </div>
                )}
                {selectedModel?.supportsImageRef && refImages.length > 1 && (
                  <div className="mt-2 p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-start gap-2">
                    <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-blue-300">
                      当前模型仅支持单张参考图，将使用第一张（已选 {refImages.length} 张）
                    </p>
                  </div>
                )}
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
                      <option key={size.value} value={size.value} className="bg-slate-800 text-slate-100">
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

          {/* P3-22：历史图缩略图条（仅当 ownerId 存在时显示，持久化跨会话保留） */}
          {effectiveOwnerId && historyImages.length > 0 && (
            <div className="mt-6 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400">
                  历史生成 ({historyImages.length}/{MAX_HISTORY})
                </p>
                <p className="text-xs text-slate-500">点击缩略图重新选择</p>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {historyImages.map((img) => (
                  <HistoryThumb
                    key={img.id}
                    img={img}
                    isSelected={generatedImageUrl === img.url}
                    onSelect={() => {
                      setGeneratedImageUrl(img.url);
                      setStatus('done');
                    }}
                    onDelete={(e) => {
                      e.stopPropagation();
                      if (!confirm('确定要删除这张历史图吗？')) return;
                      deleteHistory(img.id);
                    }}
                  />
                ))}
              </div>
              {historyImages.length >= MAX_HISTORY && (
                <p className="text-xs text-amber-400 mt-1">
                  已达上限，请先删除旧图才能继续生成
                </p>
              )}
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

      {/* P3-24：@引用浮层 */}
      {showAtDropdown && atDropdownPos && (
        <div
          className="fixed z-[70] bg-slate-800 border border-white/10 rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto min-w-[200px]"
          style={{ top: atDropdownPos.top, left: atDropdownPos.left }}
        >
          {refImages.filter(r => r.source === 'asset' && r.assetName).map(r => (
            <button
              key={r.id}
              onClick={() => handleSelectAtRef(r)}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 text-white"
            >
              @{r.assetName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// P3-22：历史图缩略图组件（独立组件以使用 useSignedUrl hook）
function HistoryThumb({
  img,
  isSelected,
  onSelect,
  onDelete,
}: {
  img: AiGeneratedImage;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const signedUrl = useSignedUrl(img.url);
  return (
    <div
      onClick={onSelect}
      className={`relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-white/30'
      }`}
      title={img.prompt || '历史生成图'}
    >
      <img
        src={signedUrl || img.url}
        alt="历史图"
        className="w-full h-full object-cover"
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
      />
      <button
        onClick={onDelete}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 hover:bg-red-500/80 flex items-center justify-center transition"
        title="删除此历史图"
      >
        <Trash2 className="w-2.5 h-2.5 text-white" />
      </button>
    </div>
  );
}

// P3-24：已选参考图缩略图组件（独立组件以使用 useSignedUrl hook）
function RefThumb({
  refImg,
  onRemove,
}: {
  refImg: RefImage;
  onRemove: () => void;
}) {
  const signedUrl = useSignedUrl(refImg.url);
  return (
    <div
      className="relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-white/10"
      title={refImg.assetName || '参考图'}
    >
      <img
        src={signedUrl || refImg.url}
        alt={refImg.assetName || '参考图'}
        className="w-full h-full object-cover"
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
      />
      <button
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 hover:bg-red-500/80 flex items-center justify-center transition"
        title="移除参考图"
      >
        <X className="w-2.5 h-2.5 text-white" />
      </button>
      {refImg.assetName && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate">
          {refImg.assetName}
        </div>
      )}
    </div>
  );
}

// 数字资产缩略图组件（用于参考图选择面板）
function AssetThumb({
  asset,
  imgUrl,
  onAdd,
  isSelected,
}: {
  asset: DigitalAsset;
  imgUrl: string;
  onAdd: () => void;
  isSelected: boolean;
}) {
  const signedUrl = useSignedUrl(imgUrl);
  return (
    <div
      onClick={onAdd}
      className={`relative shrink-0 aspect-square rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-violet-400/50'
      }`}
      title={asset.name}
    >
      <img
        src={signedUrl || imgUrl}
        alt={asset.name}
        className="w-full h-full object-cover"
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
      />
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate">
        {asset.name}
      </div>
    </div>
  );
}

// 分镜图片缩略图组件（用于参考图选择面板）
function ShotImageThumb({
  imgUrl,
  shotTitle,
  onAdd,
}: {
  imgUrl: string;
  shotTitle: string;
  onAdd: () => void;
}) {
  const signedUrl = useSignedUrl(imgUrl);
  return (
    <div
      onClick={onAdd}
      className="relative shrink-0 aspect-square rounded-lg overflow-hidden border border-white/10 hover:border-violet-400/50 cursor-pointer transition"
      title={shotTitle}
    >
      <img
        src={signedUrl || imgUrl}
        alt={shotTitle}
        className="w-full h-full object-cover"
        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
      />
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate">
        {shotTitle}
      </div>
    </div>
  );
}
