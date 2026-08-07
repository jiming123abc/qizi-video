import React, { useState, useRef, useEffect } from 'react';
import { X, Upload, Loader2, CheckCircle, Info, Plus, ChevronDown, Trash2, Archive, Film, Image as ImageIcon } from 'lucide-react';
import type { Shot, Settings, ModelConfig, AiGeneratedImage, RefImage, DigitalAsset, Scene } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useSignedUrl } from '../../hooks/useSignedUrl';
import ConfirmDialog from '../ConfirmDialog';
import { useToastContext } from '../ToastProvider';
import { useRefImages } from '../../hooks/useRefImages';
import { useUnifiedUpload } from '../../hooks/useUnifiedUpload';
import { AiErrorGuide } from './AiErrorGuide';

interface AIImageGenerateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  onUseImage?: (imageUrl: string, fileSize?: number) => void;
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
  scenes?: Scene[];               // 项目所有场次（用于场次分组显示）
  allShots?: Shot[];              // 项目所有分镜（用于跨场次选择参考图）
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
  scenes,
  allShots,
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
  const [genProgress, setGenProgress] = useState(0);
  const { showToast } = useToastContext();
  const { startUpload } = useUnifiedUpload();

  // Q1：多图暂存 - 第一张自动上传 OSS，后续（最多5张）需用户确认后上传
  const MAX_STAGED_IMAGES = 5;
  const [stagedImages, setStagedImages] = useState<Array<{ id: string; url: string; uploaded: boolean; fileSize?: number }>>([]);
  const [selectedStagedId, setSelectedStagedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // 正在上传预览图到 OSS
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // P3-24：@引用浮层
  const [showAtDropdown, setShowAtDropdown] = useState(false);
  const [atDropdownPos, setAtDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [atPanelTab, setAtPanelTab] = useState<'assets' | 'shots'>('assets');

  // 参考图来源选择面板
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [showShotPicker, setShowShotPicker] = useState(false);
  const [digitalAssets, setDigitalAssets] = useState<DigitalAsset[]>([]);
  const [loadedAllShots, setLoadedAllShots] = useState<Shot[]>([]);

  // 根据模型配置计算参考图上限和 @引用可用性
  const maxRefImages = selectedModel?.maxRefImages || 10;
  const atEnabled = true;  // 所有模型都支持参考图和@引用

  // P3-24：使用 useRefImages hook 统一管理参考图与历史图
  const {
    refImages,
    setRefImages,
    historyImages,
    maxRefImages: hookMaxRefImages,
    MAX_HISTORY,
    isFull,
    uploading: refUploading,
    uploadProgress: refUploadProgress,
    uploadMessage: refUploadMessage,
    addAssetRef,
    addUploadRef,
    addUrlRef,
    removeRef,
    clearRefs,
    isRefSelected,
    loadHistory,
    deleteHistory,
    getAllRefUrls,
    parseAtReferences,
  } = useRefImages({
    ownerType: effectiveOwnerType,
    ownerId: effectiveOwnerId,
    projectId: effectiveProjectId,
    enabled: !!effectiveOwnerId,
    maxRefImages,
  });

  // P3-24：轮询任务状态
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

  // 阻止页面滚动
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
    } else {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  }, [isOpen]);

  // 重置状态（每次打开时重新生成提示词）
  useEffect(() => {
    if (isOpen) {
      // 分镜模式：从 shot 当前字段重新生成提示词；资产模式：使用 initialPrompt
      setPrompt(isShotMode && shot ? generateSmartPrompt(shot) : initialPrompt);
      setStatus('idle');
      setGeneratedImageUrl(null);
      setErrorMessage('');
      // Q1：清空多图暂存
      setStagedImages([]);
      setSelectedStagedId(null);
      setConfirming(false);
      // P3-24：清空参考图，防止上次选择残留
      clearRefs();
      // P3-22：重新加载历史图（dialog 重新打开时手动触发，仅当 ownerId 存在）
      if (effectiveOwnerId) {
        loadHistory();
      }
      // 清空加载的全部分镜，等待 useEffect 重新加载
      setLoadedAllShots([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialPrompt, shot]);

  // P3-24：@引用浮层 - 当模型不支持 @引用时自动关闭
  useEffect(() => {
    if (showAtDropdown && !atEnabled) {
      setShowAtDropdown(false);
    }
  }, [refImages, showAtDropdown, atEnabled]);

  // 模型切换时裁剪超额参考图
  useEffect(() => {
    setRefImages(prev => prev.length > maxRefImages ? prev.slice(0, maxRefImages) : prev);
  }, [maxRefImages, setRefImages]);

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

  // 加载项目所有分镜（用于跨场次选择参考图）
  useEffect(() => {
    if (isOpen && isShotMode && effectiveProjectId) {
      // 分别请求 pending 和 done 状态的分镜
      Promise.all([
        fetch(`/api/list?projectId=${effectiveProjectId}&status=pending`).then(r => r.json()),
        fetch(`/api/list?projectId=${effectiveProjectId}&status=done`).then(r => r.json()),
      ])
        .then(([pendingData, doneData]) => {
          const pendingShots = pendingData.success ? (pendingData.data || []) : [];
          const doneShots = doneData.success ? (doneData.data || []) : [];
          const all = [...pendingShots, ...doneShots];
          all.sort((a: Shot, b: Shot) => (a.sortOrder || 0) - (b.sortOrder || 0));
          setLoadedAllShots(all);
        })
        .catch(console.error);
    }
  }, [isOpen, isShotMode, effectiveProjectId]);

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
    const lastChar = value[value.length - 1];
    if (lastChar === '@' && atEnabled) {
      const textarea = e.target;
      const rect = textarea.getBoundingClientRect();
      setAtDropdownPos({ top: rect.bottom + 4, left: rect.left + 20 });
      setShowAtDropdown(true);
      // 自动选择有内容的 Tab
      const hasAssets = refImages.some(r => r.source !== 'shot' && r.assetName);
      const hasShots = refImages.some(r => r.source === 'shot' && r.assetName);
      if (hasAssets && !hasShots) {
        setAtPanelTab('assets');
      } else if (hasShots && !hasAssets) {
        setAtPanelTab('shots');
      } else if (hasAssets && hasShots) {
        const assetCount = refImages.filter(r => r.source !== 'shot' && r.assetName).length;
        const shotCount = refImages.filter(r => r.source === 'shot' && r.assetName).length;
        setAtPanelTab(assetCount >= shotCount ? 'assets' : 'shots');
      } else {
        setAtPanelTab('assets');
      }
    } else if (showAtDropdown && lastChar !== '@') {
      setShowAtDropdown(false);
    }
  };

  // P3-24：选择 @ 引用项
  const handleSelectAtRef = (refImg: RefImage) => {
    const label = refImg.assetName || refImg.shotTitle;
    if (!label) return;
    setPrompt(prev => prev.replace(/@$/, `@${label} `));
    setShowAtDropdown(false);
    setAtDropdownPos(null);
  };

  // P3-24：拖拽上传 - drop 时调用 addUploadRef（支持多文件）
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter((f: File) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const remaining = maxRefImages - refImages.length;
    for (const file of imageFiles.slice(0, remaining)) {
      try {
        await addUploadRef(file);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '上传参考图失败', 'error');
        break;
      }
    }
  };

  // P3-24：触发统一上传模块上传参考图（多图模型支持选多张）
  const handleUploadClick = async () => {
    if (!effectiveProjectId) return;
    try {
      const results = await startUpload({
        projectId: effectiveProjectId,
        usage: 'shot-reference',
        accept: 'image/*',
        multiple: maxRefImages > 1,
      });
      const remaining = maxRefImages - refImages.length;
      results.slice(0, remaining).forEach(r => addUrlRef(r.url));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '上传参考图失败', 'error');
    }
  };

  const startGeneration = async () => {
    if (!selectedModel || !prompt.trim()) return;
    if (stagedImages.length >= MAX_STAGED_IMAGES) return;

    // Q1：第一张自动上传 OSS（previewOnly=false），后续为预览（previewOnly=true）
    const previewOnly = stagedImages.length > 0;

    setStatus('generating');
    setErrorMessage('');
    setGenProgress(0);

    try {
      // P3-24：使用统一的参考图 URL 列表
      const refUrls = getAllRefUrls();

      // 解析提示词中的 @引用，提取对应资产信息（供后端注入描述增强prompt）
      const atRefs = parseAtReferences(prompt);
      const atReferencedAssets = atRefs
        .filter(r => r.source === 'asset' && r.assetId && r.assetName)
        .map(r => ({
          assetId: r.assetId,
          assetName: r.assetName,
          assetType: r.assetType,
        }));

      // 根据模式选择 API 端点
      const apiEndpoint = isShotMode ? '/api/ai/generate-image' : '/api/ai/generic-image-gen';
      const requestBody: Record<string, unknown> = {
        prompt: prompt.trim(),
        refImages: refUrls,
        atReferencedAssets,
        size: selectedSize,
        provider: selectedProvider,
        model: selectedModel.model,
        quality: selectedModel.quality || 'standard',
        ownerType: effectiveOwnerType,
        ownerId: effectiveOwnerId || undefined,
        previewOnly,
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

          // 更新进度（后端在关键步骤更新 progress）
          if (task.progress) {
            setGenProgress(prev => task.progress > prev ? task.progress : prev);
          }

          if (task.status === 'done') {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;
            setGenProgress(100);

            const imageUrl = task.output?.imageUrl;
            const uploaded = task.output?.uploaded !== false;
            const fileSize = task.output?.fileSize;
            if (imageUrl) {
              // Q1：添加到暂存区
              const stagedId = `staged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              setStagedImages(prev => [...prev, { id: stagedId, url: imageUrl, uploaded, fileSize }]);
              setSelectedStagedId(stagedId);
              setGeneratedImageUrl(imageUrl);
              setStatus('done');
              // P3-22：生成成功后刷新历史图列表（仅当 ownerId 存在且已上传）
              if (effectiveOwnerId && uploaded) {
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

  // Q1：使用选中的图片 - 预览图需先上传 OSS
  const handleUseImage = async () => {
    const selected = stagedImages.find(s => s.id === selectedStagedId) || stagedImages[stagedImages.length - 1];
    if (!selected || !onUseImage) return;

    try {
      let finalUrl = selected.url;
      let finalFileSize: number | undefined;
      if (!selected.uploaded) {
        // 预览图需先上传到 OSS
        setConfirming(true);
        const res = await fetch('/api/ai/upload-preview-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: selected.url,
            projectId: effectiveProjectId,
            ownerType: effectiveOwnerType,
            ownerId: effectiveOwnerId || undefined,
            prompt: prompt.trim(),
            model: selectedModel?.model,
            provider: selectedProvider,
            size: selectedSize,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.message || '上传预览图失败');
        }
        const data = await res.json();
        finalUrl = data.url;
        finalFileSize = data.fileSize;
        // 更新暂存区状态
        setStagedImages(prev => prev.map(s => s.id === selected.id ? { ...s, url: finalUrl, uploaded: true } : s));
        if (effectiveOwnerId) {
          loadHistory();
        }
      } else {
        // 已经上传过的：从历史记录中取 fileSize
        finalFileSize = selected.fileSize || undefined;
      }
      onUseImage(finalUrl, finalFileSize);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '使用图片失败', 'error');
    } finally {
      setConfirming(false);
    }
  };

  const handleRegenerate = () => {
    // Q1：如果有暂存图且未达上限，回到 idle 允许继续生成
    if (stagedImages.length >= MAX_STAGED_IMAGES) {
      showToast('已达暂存上限（5张），请选择一张使用', 'info');
      return;
    }
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
      'kling-image-v3-omni': 'Kling 3.0 Omni',
      'nano-banana-2': 'Nano Banana 2',
      'qwen-image-3.0': '千问 3.0',
      'flux': 'Flux',
    };
    return displayNames[model.model.toLowerCase()] || model.model;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[65] p-4 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-full max-w-xl w-[calc(100%-2rem)] max-h-[100dvh] sm:max-h-[90vh] rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl overflow-hidden"
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
                  placeholder={`描述你想要生成的画面内容...${atEnabled ? '（输入 @ 可引用资产）' : ''}`}
                />
              </div>

              {/* 参考图功能说明（根据模型能力动态显示） */}
              <div className="mb-3 p-2.5 rounded-lg bg-violet-500/5 border border-violet-400/15">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-slate-400 leading-relaxed space-y-0.5">
                    {!selectedModel ? (
                      <p>选择模型后查看参考图能力说明。</p>
                    ) : (
                      <>
                        <p>
                          <span className="text-violet-200 font-medium">图生图模式：</span>
                          最多 <span className="text-violet-300 font-semibold">{maxRefImages} 张</span> 参考图，可上传、从数字资产或分镜中选取。
                        </p>
                        <p>
                          <span className="text-slate-300">@引用：</span>
                          在提示词中输入 <span className="text-violet-300 font-mono">@</span> 可引用数字资产作为参考素材。
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* 参考图区域（始终可交互） */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-300">
                    参考图 ({refImages.length}/{hookMaxRefImages})
                  </label>
                </div>
                {/* 三个并列入口（仅空状态时显示） */}
                {refImages.length === 0 && (
                  <div className="flex gap-2 mb-2">
                    {effectiveProjectId && (
                      <button
                        onClick={handleUploadClick}
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
                    {isShotMode && (loadedAllShots.length || allShots?.length || sceneShots?.length) ? (
                      <button
                        onClick={() => { setShowShotPicker(!showShotPicker); setShowAssetPicker(false); }}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border transition text-sm ${showShotPicker ? 'border-violet-400 bg-violet-500/10 text-violet-300' : 'border-white/15 hover:border-violet-400 hover:bg-violet-500/10 text-slate-300'}`}
                      >
                        <Film className="w-4 h-4" />
                        从分镜选择
                      </button>
                    ) : null}
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
                    <>
                    <div className="flex gap-2 overflow-x-auto p-2">
                      {refImages.map(r => (
                        <React.Fragment key={r.id}>
                          <RefThumb refImg={r} onRemove={() => removeRef(r.id)} />
                        </React.Fragment>
                      ))}
                      {!isFull && effectiveProjectId && !refUploading && (
                        <button
                          onClick={handleUploadClick}
                          className="shrink-0 w-16 h-16 rounded-lg border-2 border-dashed border-white/20 hover:border-violet-400 flex items-center justify-center transition"
                          title="上传参考图"
                        >
                          <Plus className="w-5 h-5 text-white/40" />
                        </button>
                      )}
                      {refUploading && (
                        <div className="shrink-0 w-16 h-16 rounded-lg border-2 border-violet-400 bg-violet-500/10 flex flex-col items-center justify-center px-1">
                          <Loader2 className="w-4 h-4 text-violet-300 animate-spin" />
                          <span className="text-[10px] text-violet-200 mt-0.5">{refUploadProgress}%</span>
                        </div>
                      )}
                    </div>
                    {refUploading && (
                      <div className="px-3 pb-2">
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-violet-500 transition-all duration-200"
                            style={{ width: `${refUploadProgress}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1 truncate">{refUploadMessage}</p>
                      </div>
                    )}
                    </>
                  )}
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
                            return (
                              <React.Fragment key={asset.id}>
                                <AssetThumb asset={asset} imgUrl={imgUrl} onAdd={() => addAssetRef(imgUrl, { assetId: asset.id, assetName: asset.name, assetType: asset.type })} isSelected={isRefSelected(imgUrl)} />
                              </React.Fragment>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-slate-500 text-center py-4">暂无带图片的数字资产</p>
                    )}
                  </div>
                )}

                {/* 分镜选择面板 - 支持场次分组 */}
                {showShotPicker && isShotMode && (
                  <ShotPickerPanel
                    shots={loadedAllShots.length > 0 ? loadedAllShots : (allShots || sceneShots || [])}
                    scenes={scenes}
                    currentShotId={shot?.id}
                    currentSceneId={shot?.sceneId}
                    onAddImage={(url, title) => addUrlRef(url, title, 'shot')}
                    isSelected={isRefSelected}
                  />
                )}
              </div>

              {/* AI 模型选择（平台 + 模型卡片） */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">AI 模型选择</label>
                {/* 平台选择 */}
                <div className="mb-3">
                  <select
                    value={selectedProvider}
                    onChange={e => setSelectedProvider(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-white/10 bg-slate-800 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 cursor-pointer"
                  >
                    {(settings?.ai_platforms || []).map(p => (
                      <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                    ))}
                  </select>
                </div>
                {/* 模型卡片选择 */}
                <div className="grid grid-cols-2 gap-2">
                  {filteredModels.map(model => (
                    <button
                      key={model.model}
                      type="button"
                      onClick={() => setSelectedModel(model)}
                      className={`p-3 rounded-xl border transition text-left ${
                        selectedModel?.model === model.model
                          ? 'border-violet-400 bg-violet-500/10'
                          : 'border-white/15 hover:border-white/25 bg-white/5'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-white truncate">
                          {getModelDisplayName(model)}
                        </span>
                        {model.cost === 'low' && <span className="text-[10px] text-green-400 whitespace-nowrap ml-1">低价</span>}
                        {model.cost === 'mid' && <span className="text-[10px] text-yellow-400 whitespace-nowrap ml-1">中等</span>}
                        {model.cost === 'mid_high' && <span className="text-[10px] text-orange-400 whitespace-nowrap ml-1">较高</span>}
                        {model.cost === 'high' && <span className="text-[10px] text-red-400 whitespace-nowrap ml-1">高价</span>}
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">图生图</span>
                        {model.maxRefImages && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                            {model.maxRefImages}张
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                {/* 费用提示 */}
                {selectedModel && (
                  <p className="text-xs text-slate-500 mt-2">
                    费用：{COST_LABELS[selectedModel.cost] || '未知'}
                    {selectedModel.maxRefImages && (
                      <span className="ml-2 text-slate-400">· 最多 {selectedModel.maxRefImages} 张参考图</span>
                    )}
                  </p>
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

              {/* Q1：已暂存的生成图（idle 状态下显示，允许用户选择已生成的图） */}
              {stagedImages.length > 0 && (
                <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-400">
                      已生成 {stagedImages.length}/{MAX_STAGED_IMAGES} 张
                    </p>
                    <button
                      onClick={() => {
                        const last = stagedImages[stagedImages.length - 1];
                        if (last) {
                          setSelectedStagedId(last.id);
                          setGeneratedImageUrl(last.url);
                          setStatus('done');
                        }
                      }}
                      className="text-xs text-violet-400 hover:text-violet-300 transition"
                    >
                      查看并选择 →
                    </button>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {stagedImages.map((img, idx) => (
                      <React.Fragment key={img.id}>
                        <StagedThumb
                          img={img}
                          idx={idx}
                          isSelected={false}
                          onSelect={() => {
                            setSelectedStagedId(img.id);
                            setGeneratedImageUrl(img.url);
                            setStatus('done');
                          }}
                        />
                      </React.Fragment>
                    ))}
                  </div>
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
              <p className="text-xs text-slate-500 mb-3">预计时间：15-30秒</p>
              {/* 进度条 */}
              <div className="w-full max-w-xs h-2 rounded-full bg-white/10 overflow-hidden mb-1">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                  style={{ width: `${genProgress}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">{genProgress > 0 ? `${genProgress}%` : '排队中...'}</p>
              <p className="text-xs text-slate-600 mt-4">请勿关闭页面</p>
            </div>
          )}

          {status === 'done' && generatedImageUrl && (
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-2 text-green-400 mb-4">
                <CheckCircle className="w-6 h-6" />
                <span className="text-lg font-medium">生成完成！</span>
                <span className="text-xs text-slate-400 ml-2">
                  已生成 {stagedImages.length}/{MAX_STAGED_IMAGES} 张
                </span>
              </div>

              {/* Q1：主预览区 - 显示当前选中的暂存图 */}
              {(() => {
                const selected = stagedImages.find(s => s.id === selectedStagedId) || stagedImages[stagedImages.length - 1];
                if (!selected) return null;
                return <MainPreviewImage img={selected} />;
              })()}

              {/* Q1：暂存图缩略图条 */}
              {stagedImages.length > 1 && (
                <div className="w-full mb-2">
                  <p className="text-xs text-slate-400 mb-2">点击缩略图选择</p>
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {stagedImages.map((img, idx) => (
                      <React.Fragment key={img.id}>
                        <StagedThumb
                          img={img}
                          idx={idx}
                          isSelected={selectedStagedId === img.id}
                          onSelect={() => {
                            setSelectedStagedId(img.id);
                            setGeneratedImageUrl(img.url);
                          }}
                        />
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
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
                  <React.Fragment key={img.id}>
                    <HistoryThumb
                      img={img}
                      isSelected={generatedImageUrl === img.url}
                      onSelect={() => {
                        setGeneratedImageUrl(img.url);
                        setStatus('done');
                      }}
                      onDelete={(e) => {
                        e.stopPropagation();
                        setConfirmDialog({
                          title: '确认删除',
                          message: '确定要删除这张历史图吗？',
                          onConfirm: () => {
                            setConfirmDialog(null);
                            deleteHistory(img.id);
                          }
                        });
                      }}
                    />
                  </React.Fragment>
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
                disabled={!prompt.trim() || !selectedModel || stagedImages.length >= MAX_STAGED_IMAGES}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {stagedImages.length > 0 ? `生成第 ${stagedImages.length + 1} 张` : '生成图片'}
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
              {/* Q1：继续生成（未达上限时） */}
              {stagedImages.length < MAX_STAGED_IMAGES && (
                <button
                  onClick={handleRegenerate}
                  className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
                >
                  继续生成 ({stagedImages.length}/{MAX_STAGED_IMAGES})
                </button>
              )}
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
              >
                取消
              </button>
              {onUseImage && (
                <button
                  onClick={handleUseImage}
                  disabled={confirming}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {confirming ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      上传中...
                    </>
                  ) : (
                    '使用此图片'
                  )}
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

      {/* P3-24：@引用浮层 - 支持资产和分镜 Tab 切换 */}
      {showAtDropdown && atDropdownPos && (
        <div
          className="fixed z-[70] bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden min-w-[240px]"
          style={{ top: atDropdownPos.top, left: atDropdownPos.left }}
        >
          {/* Tab 切换 */}
          <div className="flex border-b border-white/10">
            <button
              onClick={() => setAtPanelTab('assets')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition ${
                atPanelTab === 'assets' ? 'text-violet-300 bg-violet-500/10' : 'text-slate-400 hover:text-white'
              }`}
            >
              参考素材 ({refImages.filter(r => r.source !== 'shot' && r.assetName).length})
            </button>
            {isShotMode && (
              <button
                onClick={() => setAtPanelTab('shots')}
                className={`flex-1 px-3 py-2 text-xs font-medium transition ${
                  atPanelTab === 'shots' ? 'text-violet-300 bg-violet-500/10' : 'text-slate-400 hover:text-white'
                }`}
              >
                分镜 ({refImages.filter(r => r.source === 'shot' && r.assetName).length})
              </button>
            )}
          </div>
          {/* Tab 内容 */}
          <div className="max-h-48 overflow-y-auto py-1">
            {atPanelTab === 'assets' && refImages.filter(r => r.source !== 'shot' && r.assetName).length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-500">暂无引用，请先上传或添加参考图</p>
            )}
            {atPanelTab === 'assets' && refImages.filter(r => r.source !== 'shot' && r.assetName).map(r => (
              <button
                key={r.id}
                onClick={() => handleSelectAtRef(r)}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 text-white flex items-center gap-2"
              >
                <span className="w-6 h-6 rounded bg-white/10 flex items-center justify-center text-xs">@</span>
                <span className="truncate">{r.assetName}</span>
                {r.source === 'upload' && <span className="ml-auto text-[10px] text-slate-500">上传</span>}
                {r.source === 'asset' && <span className="ml-auto text-[10px] text-slate-500">资产</span>}
              </button>
            ))}
            {atPanelTab === 'shots' && refImages.filter(r => r.source === 'shot' && r.assetName).length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-500">暂不分镜引用，请先添加分镜到参考图</p>
            )}
            {atPanelTab === 'shots' && refImages.filter(r => r.source === 'shot' && r.assetName).map(r => (
              <button
                key={r.id}
                onClick={() => handleSelectAtRef(r)}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 text-white flex items-center gap-2"
              >
                <span className="w-6 h-6 rounded bg-violet-500/20 flex items-center justify-center text-xs text-violet-300">@</span>
                <span className="truncate">{r.assetName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmText="删除"
        confirmButtonColor="red"
        onConfirm={() => { confirmDialog?.onConfirm(); }}
        onCancel={() => setConfirmDialog(null)}
      />
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
  const { url: signedUrl, ready } = useSignedUrl(img.url);
  return (
    <div
      onClick={onSelect}
      className={`relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-white/30'
      }`}
      title={img.prompt || '历史生成图'}
    >
      {ready ? (
        <img
          src={signedUrl}
          alt="历史图"
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/40">
          <ImageIcon className="w-6 h-6 text-white/30 animate-pulse" />
        </div>
      )}
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
  const { url: signedUrl, ready } = useSignedUrl(refImg.url);
  return (
    <div
      className="relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-white/10"
      title={refImg.assetName || '参考图'}
    >
      {ready ? (
        <img
          src={signedUrl}
          alt={refImg.assetName || '参考图'}
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/40">
          <ImageIcon className="w-6 h-6 text-white/30 animate-pulse" />
        </div>
      )}
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
  const { url: signedUrl, ready } = useSignedUrl(imgUrl);
  return (
    <div
      onClick={onAdd}
      className={`relative shrink-0 aspect-square rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-violet-400/50'
      }`}
      title={asset.name}
    >
      {ready ? (
        <img
          src={signedUrl}
          alt={asset.name}
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/40">
          <ImageIcon className="w-6 h-6 text-white/30 animate-pulse" />
        </div>
      )}
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
  isSelected,
}: {
  imgUrl: string;
  shotTitle: string;
  onAdd: () => void;
  isSelected?: boolean;
}) {
  const { url: signedUrl, ready } = useSignedUrl(imgUrl);
  return (
    <div
      onClick={onAdd}
      className={`relative shrink-0 aspect-square rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-violet-400/50'
      }`}
      title={shotTitle}
    >
      {ready ? (
        <img
          src={signedUrl}
          alt={shotTitle}
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/40">
          <ImageIcon className="w-6 h-6 text-white/30 animate-pulse" />
        </div>
      )}
      {isSelected && (
        <div className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-violet-500 flex items-center justify-center">
          <CheckCircle className="w-3 h-3 text-white" />
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate">
        {shotTitle}
      </div>
    </div>
  );
}

// 分镜选择面板组件 - 按场次 + 分镜两级分组显示
function ShotPickerPanel({
  shots,
  scenes,
  currentShotId,
  currentSceneId,
  onAddImage,
  isSelected,
}: {
  shots: Shot[];
  scenes?: Scene[];
  currentShotId?: number;
  currentSceneId?: number;
  onAddImage: (url: string, title: string) => void;
  isSelected: (url: string) => boolean;
}) {
  const [expandedScenes, setExpandedScenes] = useState<Set<number>>(() => {
    // 默认展开当前场次
    if (currentSceneId != null) {
      return new Set([currentSceneId]);
    }
    // 默认展开第一个场次
    const firstScene = scenes?.[0];
    return new Set(firstScene ? [firstScene.id] : []);
  });
  const [expandedShots, setExpandedShots] = useState<Set<number>>(() => {
    // 默认展开当前分镜
    if (currentShotId != null) {
      return new Set([currentShotId]);
    }
    return new Set();
  });

  // 排除当前分镜
  const filteredShots = shots.filter(s => s.id !== currentShotId);

  // 整理图片数据
  const shotImages = filteredShots
    .map(s => {
      const images: { url: string; shotId: number; shotTitle: string }[] = [];
      if (s.media && Array.isArray(s.media)) {
        s.media.forEach((m: { url?: string; type?: string }) => {
          if (m.type === 'image' && m.url) {
            images.push({ url: m.url, shotId: s.id, shotTitle: s.title || `分镜 ${s.id}` });
          }
        });
      }
      if (s.type === 'image' && s.url && !s.media) {
        images.push({ url: s.url, shotId: s.id, shotTitle: s.title || `分镜 ${s.id}` });
      }
      return { shot: s, images };
    })
    .filter(s => s.images.length > 0);

  // 按场次分组
  const groupedByScene = () => {
    if (!scenes || scenes.length === 0) {
      // 无场次信息，直接平铺
      return [{ scene: null as Scene | null, shots: shotImages }];
    }

    const groups: { scene: Scene | null; shots: { shot: Shot; images: { url: string; shotId: number; shotTitle: string }[] }[] }[] = [];
    const processedSceneIds = new Set<number>();

    // 按场次分组
    for (const scene of scenes) {
      const sceneShots = shotImages.filter(s => s.shot.sceneId === scene.id);
      if (sceneShots.length > 0) {
        groups.push({ scene, shots: sceneShots });
        processedSceneIds.add(scene.id);
      }
    }

    // 未分类分镜（sceneId 为 null 或不在 scenes 中的）
    const uncategorized = shotImages.filter(s => {
      if (s.shot.sceneId == null) return true;
      return !processedSceneIds.has(s.shot.sceneId);
    });
    if (uncategorized.length > 0) {
      groups.push({ scene: null, shots: uncategorized });
    }

    return groups;
  };

  const sceneGroups = groupedByScene();

  const toggleScene = (sceneId: number) => {
    setExpandedScenes(prev => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  };

  const toggleShot = (shotId: number) => {
    setExpandedShots(prev => {
      const next = new Set(prev);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const expandAllScenes = () => {
    const allSceneIds = new Set<number>();
    sceneGroups.forEach(g => {
      if (g.scene) allSceneIds.add(g.scene.id);
    });
    setExpandedScenes(allSceneIds);
  };

  const collapseAllScenes = () => {
    setExpandedScenes(new Set());
  };

  if (filteredShots.length === 0) {
    return (
      <div className="mt-2 p-4 rounded-lg bg-slate-800/80 border border-white/10">
        <p className="text-xs text-slate-500 text-center">暂无其他分镜</p>
      </div>
    );
  }

  if (shotImages.length === 0) {
    return (
      <div className="mt-2 p-4 rounded-lg bg-slate-800/80 border border-white/10">
        <p className="text-xs text-slate-500 text-center">分镜暂无图片素材</p>
      </div>
    );
  }

  return (
    <div className="mt-2 p-2 rounded-lg bg-slate-800/80 border border-white/10 max-h-80 overflow-y-auto">
      {/* 操作栏 */}
      <div className="flex items-center justify-between mb-2 px-1">
        <p className="text-xs text-slate-400">点击图片添加为参考图（支持跨场次选择）</p>
        <div className="flex gap-1">
          <button
            onClick={expandAllScenes}
            className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition"
          >
            全部展开
          </button>
          <button
            onClick={collapseAllScenes}
            className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition"
          >
            全部收起
          </button>
        </div>
      </div>

      {/* 场次分组列表 */}
      <div className="space-y-2">
        {sceneGroups.map(({ scene, shots: sceneShotImages }) => {
          const sceneId = scene?.id ?? -1;
          const isSceneExpanded = expandedScenes.has(sceneId);
          const totalImages = sceneShotImages.reduce((acc, s) => acc + s.images.length, 0);
          const totalSelected = sceneShotImages.reduce(
            (acc, s) => acc + s.images.filter(img => isSelected(img.url)).length, 0
          );

          return (
            <div key={`scene-${sceneId}`} className="rounded-lg border border-white/10 overflow-hidden">
              {/* 场次标题栏 */}
              <button
                onClick={() => toggleScene(sceneId)}
                className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/70 hover:bg-slate-700/70 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${isSceneExpanded ? 'rotate-0' : '-rotate-90'}`}
                  />
                  <span className="text-sm font-semibold text-white truncate">
                    {scene?.name || '未分类'}
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">
                    ({sceneShotImages.length}个分镜 / {totalImages}张图)
                  </span>
                </div>
                {totalSelected > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 shrink-0">
                    已选 {totalSelected}
                  </span>
                )}
              </button>

              {/* 场次内容 */}
              {isSceneExpanded && (
                <div className="p-2 bg-slate-900/40 space-y-1">
                  {sceneShotImages.map(({ shot, images }) => {
                    const shotId = shot.id;
                    const isShotExpanded = expandedShots.has(shotId);
                    const selectedCount = images.filter(img => isSelected(img.url)).length;

                    return (
                      <div key={shotId} className="rounded-md border border-white/5 overflow-hidden">
                        {/* 分镜标题栏 */}
                        <button
                          onClick={() => toggleShot(shotId)}
                          className="w-full flex items-center justify-between px-2 py-1 bg-slate-800/40 hover:bg-slate-700/40 transition"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <ChevronDown
                              className={`w-3 h-3 text-slate-500 transition-transform shrink-0 ${isShotExpanded ? 'rotate-0' : '-rotate-90'}`}
                            />
                            <span className="text-xs text-slate-300 truncate">
                              {shot.title || `分镜 ${shot.id}`}
                            </span>
                            <span className="text-[10px] text-slate-600 shrink-0">
                              ({images.length}张)
                            </span>
                          </div>
                          {selectedCount > 0 && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-300 shrink-0">
                              {selectedCount}
                            </span>
                          )}
                        </button>

                        {/* 图片网格 */}
                        {isShotExpanded && (
                          <div className="p-1.5">
                            <div className="grid grid-cols-4 sm:grid-cols-6 gap-1">
                              {images.map((img, idx) => (
                                <React.Fragment key={`${img.shotId}-${idx}`}>
                                  <ShotImageThumb
                                    imgUrl={img.url}
                                    shotTitle={img.shotTitle}
                                    onAdd={() => onAddImage(img.url, img.shotTitle)}
                                    isSelected={isSelected(img.url)}
                                  />
                                </React.Fragment>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Q1：暂存图缩略图组件（独立组件以使用 useSignedUrl hook）
function StagedThumb({
  img,
  idx,
  isSelected,
  onSelect,
}: {
  img: { id: string; url: string; uploaded: boolean };
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { url: signedUrl, ready } = useSignedUrl(img.uploaded ? img.url : '');
  return (
    <div
      onClick={onSelect}
      className={`relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border cursor-pointer transition ${
        isSelected
          ? 'border-violet-400 ring-2 ring-violet-400/50'
          : 'border-white/10 hover:border-white/30'
      }`}
    >
      {img.uploaded ? (
        ready ? (
          <img
            src={signedUrl}
            alt={`生成图 ${idx + 1}`}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-black/40">
            <ImageIcon className="w-6 h-6 text-white/30 animate-pulse" />
          </div>
        )
      ) : (
        <img
          src={img.url}
          alt={`生成图 ${idx + 1}`}
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      )}
      <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white text-center py-0.5">
        {idx + 1}{!img.uploaded && ' · 预览'}
      </span>
    </div>
  );
}

// 主预览图组件（独立组件以使用 useSignedUrl hook）
function MainPreviewImage({ img }: { img: { id: string; url: string; uploaded: boolean } }) {
  const { url: signedUrl, ready } = useSignedUrl(img.uploaded ? img.url : '');
  return (
    <div className="w-full rounded-xl border border-white/10 overflow-hidden mb-3 relative">
      {img.uploaded ? (
        ready ? (
          <img
            src={signedUrl}
            alt="生成的图片"
            className="w-full h-auto max-h-80 object-contain bg-black/40"
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
          />
        ) : (
          <div className="w-full h-60 flex items-center justify-center bg-black/40">
            <ImageIcon className="w-10 h-10 text-white/30 animate-pulse" />
          </div>
        )
      ) : (
        <img
          src={img.url}
          alt="生成的图片"
          className="w-full h-auto max-h-80 object-contain bg-black/40"
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      )}
      {!img.uploaded && (
        <span className="absolute top-2 right-2 px-2 py-1 rounded-md bg-amber-500/80 text-white text-xs font-medium">
          预览（未上传）
        </span>
      )}
    </div>
  );
}
