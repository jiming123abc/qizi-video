import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Upload, ImageIcon, Loader2, CheckCircle, AlertCircle, Info, Plus, Sparkles, ChevronDown } from 'lucide-react';
import type { Shot, ShotMedia, DigitalAsset, ModelConfig, Settings } from '../../lib/types';
import { uploadVideo2Image } from '../../lib/ossUtils';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import AIImageGenerateDialog from './AIImageGenerateDialog';

interface AIImageGenDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shot: Shot;
  onGenerated?: (media: ShotMedia) => void;
  onOpenSettings?: () => void;
}

interface GeneratedResult {
  url: string;
  cost: number;
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

// 同地点选择缓存（location -> 选择状态，key 为规范化后的地点名）
const locationSelectionCache: Record<string, {
  selectedActors: number[];
  selectedProps: number[];
  selectedScene: number | null;
}> = {};

function getLocationKey(location: string | undefined): string {
  return (location || '').trim().toLowerCase();
}

export default function AIImageGenDialog({
  isOpen,
  onClose,
  shot,
  onGenerated,
  onOpenSettings,
}: AIImageGenDialogProps) {
  // 根据分镜信息智能生成提示词
  const generateSmartPrompt = (s: typeof shot): string => {
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

  // 提示词（默认填充 aiImagePrompt，若为空则用 sceneContent，再为空则智能生成）
  const [prompt, setPrompt] = useState(generateSmartPrompt(shot));

  // 数字资产
  const [actorAssets, setActorAssets] = useState<DigitalAsset[]>([]);
  const [propAssets, setPropAssets] = useState<DigitalAsset[]>([]);
  const [sceneAssets, setSceneAssets] = useState<DigitalAsset[]>([]);

  // 选中状态
  const [selectedActors, setSelectedActors] = useState<number[]>([]);
  const [selectedProps, setSelectedProps] = useState<number[]>([]);
  const [selectedScene, setSelectedScene] = useState<number | null>(null);

  // 展开的资产（显示多张图片）
  const [expandedAssetId, setExpandedAssetId] = useState<{ type: 'actor' | 'prop' | 'scene'; id: number } | null>(null);

  // 选中的图片ID（key: "type-assetId-imageId"）
  const [selectedImageKeys, setSelectedImageKeys] = useState<Set<string>>(new Set());

  // 平台和模型
  const [selectedProvider, setSelectedProvider] = useState<string>('geekai');
  const [selectedModel, setSelectedModel] = useState<ModelConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelConfig[]>([]);
  const [selectedSize, setSelectedSize] = useState<ImageSize>('1024x576');

  // 生成状态
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [generatedImage, setGeneratedImage] = useState<GeneratedResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // AI 生成对话框
  const [showAIGenDialog, setShowAIGenDialog] = useState(false);
  const [aiGenDialogType, setAiGenDialogType] = useState<'actor' | 'prop' | 'scene'>('actor');
  const [aiGenDialogPrompt, setAiGenDialogPrompt] = useState('');

  // 生成结果处理选项
  const [showSaveOptions, setShowSaveOptions] = useState(false);
  const [saveMode, setSaveMode] = useState<'shot_only' | 'add_to_assets' | 'replace_asset'>('shot_only');
  const [assetToReplace, setAssetToReplace] = useState<number | null>(null);

  const fileInputRefs = {
    actor: useRef<HTMLInputElement>(null),
    prop: useRef<HTMLInputElement>(null),
    scene: useRef<HTMLInputElement>(null),
  };

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // 获取资产的所有图片（含旧的 imageUrl 兼容）
  const getAssetImages = (asset: DigitalAsset) => {
    if (asset.images && asset.images.length > 0) {
      return asset.images;
    }
    if (asset.imageUrl) {
      return [{ id: 0, assetId: asset.id, imageUrl: asset.imageUrl, sortOrder: 0, createdAt: '' }];
    }
    return [];
  };

  // 构建选中图片的 key
  const getImageKey = (type: 'actor' | 'prop' | 'scene', assetId: number, imageId: number) =>
    `${type}-${assetId}-${imageId}`;

  // 获取资产中选中的图片
  const getSelectedImagesForAsset = (type: 'actor' | 'prop' | 'scene', asset: DigitalAsset) => {
    const images = getAssetImages(asset);
    return images.filter(img =>
      selectedImageKeys.has(getImageKey(type, asset.id, img.id))
    );
  };

  // 获取资产是否被选中（至少有一张图片被选中）
  const isAssetSelected = (type: 'actor' | 'prop' | 'scene', assetId: number) => {
    const keyPrefix = `${type}-${assetId}-`;
    for (const key of selectedImageKeys) {
      if (key.startsWith(keyPrefix)) return true;
    }
    return false;
  };

  // 切换资产选择（选中第一张图或取消所有选中）
  const toggleAssetSelection = (type: 'actor' | 'prop' | 'scene', asset: DigitalAsset) => {
    const images = getAssetImages(asset);
    if (images.length === 0) return;

    const keyPrefix = `${type}-${asset.id}-`;
    const hasSelected = Array.from(selectedImageKeys).some((k: string) => k.startsWith(keyPrefix));

    const newSet = new Set<string>(selectedImageKeys);
    if (hasSelected) {
      // 取消所有选中
      for (const key of Array.from(newSet)) {
        if (key.startsWith(keyPrefix)) newSet.delete(key);
      }
    } else {
      // 选中第一张图
      newSet.add(getImageKey(type, asset.id, images[0].id));
    }
    setSelectedImageKeys(newSet);

    // 同步更新旧的 selectedActors/selectedProps/selectedScene 状态（保持兼容）
    if (type === 'actor') {
      if (hasSelected) {
        setSelectedActors(prev => prev.filter(id => id !== asset.id));
      } else {
        setSelectedActors(prev => [...prev, asset.id]);
      }
    } else if (type === 'prop') {
      if (hasSelected) {
        setSelectedProps(prev => prev.filter(id => id !== asset.id));
      } else {
        setSelectedProps(prev => [...prev, asset.id]);
      }
    } else {
      setSelectedScene(hasSelected ? null : asset.id);
    }
  };

  // 切换单张图片的选中状态
  const toggleImageSelection = (type: 'actor' | 'prop' | 'scene', asset: DigitalAsset, imageId: number) => {
    const key = getImageKey(type, asset.id, imageId);
    const newSet = new Set<string>(selectedImageKeys);
    const wasSelected = newSet.has(key);

    if (wasSelected) {
      newSet.delete(key);
    } else {
      // 不支持图生图的模型限制只能选1张？这里暂时不限制，后端处理
      newSet.add(key);
    }
    setSelectedImageKeys(newSet);

    // 同步更新旧的选中状态
    const images = getAssetImages(asset);
    const keyPrefix = `${type}-${asset.id}-`;
    const hasAnySelected = Array.from(newSet).some((k: string) => k.startsWith(keyPrefix));

    if (type === 'actor') {
      if (hasAnySelected && !selectedActors.includes(asset.id)) {
        setSelectedActors(prev => [...prev, asset.id]);
      } else if (!hasAnySelected) {
        setSelectedActors(prev => prev.filter(id => id !== asset.id));
      }
    } else if (type === 'prop') {
      if (hasAnySelected && !selectedProps.includes(asset.id)) {
        setSelectedProps(prev => [...prev, asset.id]);
      } else if (!hasAnySelected) {
        setSelectedProps(prev => prev.filter(id => id !== asset.id));
      }
    } else {
      setSelectedScene(hasAnySelected ? asset.id : null);
    }
  };

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
            if (models.length > 0) {
              setSelectedModel(models[0]);
              setSelectedProvider(models[0].provider);
            }
            if (data.data.default_image_size) {
              const sizeMap: Record<string, ImageSize> = {
                '1024×576 (16:9)': '1024x576',
                '576×1024 (9:16)': '576x1024',
                '768×768 (1:1)': '768x768',
                '1536×1024 (3:2)': '1536x1024',
              };
              const mappedSize = sizeMap[data.data.default_image_size];
              if (mappedSize) {
                setSelectedSize(mappedSize);
              }
            }
          }
        })
        .catch(console.error);
    }
  }, [isOpen]);

  // 加载数字资产
  useEffect(() => {
    if (isOpen && shot.projectId) {
      // 加载演员
      fetch(`/api/video2/projects/${shot.projectId}/assets?type=actor`)
        .then(res => res.json())
        .then(data => {
          if (data.success !== false) {
            setActorAssets(data);
          }
        })
        .catch(console.error);

      // 加载道具
      fetch(`/api/video2/projects/${shot.projectId}/assets?type=prop`)
        .then(res => res.json())
        .then(data => {
          if (data.success !== false) {
            setPropAssets(data);
          }
        })
        .catch(console.error);

      // 加载场景
      fetch(`/api/video2/projects/${shot.projectId}/assets?type=scene`)
        .then(res => res.json())
        .then(data => {
          if (data.success !== false) {
            setSceneAssets(data);
          }
        })
        .catch(console.error);
    }
  }, [isOpen, shot.projectId]);

  // 恢复同地点缓存的选择状态 + 自动匹配场景资产
  useEffect(() => {
    if (!isOpen) return;

    const locationKey = getLocationKey(shot.location);

    // 先尝试从地点缓存恢复
    if (locationKey) {
      const cached = locationSelectionCache[locationKey];
      if (cached) {
        setSelectedActors(cached.selectedActors);
        setSelectedProps(cached.selectedProps);
        setSelectedScene(cached.selectedScene);
        return;
      }
    }

    // 如果没有缓存，自动根据地点匹配场景资产
    if (locationKey && sceneAssets.length > 0) {
      const matchedScene = sceneAssets.find(a =>
        a.name && a.name.trim().toLowerCase() === locationKey
      );
      if (matchedScene) {
        setSelectedScene(matchedScene.id);
      }
    }
  }, [isOpen, shot.location, sceneAssets]);

  // 保存选择状态到地点缓存
  useEffect(() => {
    const locationKey = getLocationKey(shot.location);
    if (locationKey) {
      locationSelectionCache[locationKey] = {
        selectedActors,
        selectedProps,
        selectedScene,
      };
    }
  }, [shot.location, selectedActors, selectedProps, selectedScene]);

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
      setPrompt(generateSmartPrompt(shot));
      setSelectedSize('1024x576');
      setStatus('idle');
      setGeneratedImage(null);
      setErrorMessage('');
      setShowSaveOptions(false);
      setSaveMode('shot_only');
      setAssetToReplace(null);
    }
  }, [isOpen, shot.aiImagePrompt, shot.sceneContent]);

  // 根据平台过滤模型
  const filteredModels = availableModels.filter(m => m.provider === selectedProvider);

  // 当切换平台时，自动选择该平台的第一个模型
  useEffect(() => {
    if (filteredModels.length > 0 && (!selectedModel || selectedModel.provider !== selectedProvider)) {
      setSelectedModel(filteredModels[0]);
    }
  }, [selectedProvider, filteredModels, selectedModel]);

  // 演员选择（多选）
  const handleActorToggle = (id: number) => {
    setSelectedActors(prev =>
      prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
    );
  };

  // 道具选择（多选）
  const handlePropToggle = (id: number) => {
    setSelectedProps(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  // 场景选择（单选）
  const handleSceneSelect = (id: number) => {
    setSelectedScene(prev => (prev === id ? null : id));
  };

  // 上传数字资产
  const handleUploadAsset = async (type: 'actor' | 'prop' | 'scene', files: FileList | null) => {
    if (!files || files.length === 0 || !shot.projectId) return;

    const file = files[0];
    if (!file.type.startsWith('image/')) return;

    try {
      // 上传图片
      const uploadResult = await uploadVideo2Image(file, {
        projectId: shot.projectId,
        reference: true,
        title: `${type}_${Date.now()}`,
      });

      // 创建数字资产
      const response = await fetch(`/api/video2/projects/${shot.projectId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          name: file.name.replace(/\.[^/.]+$/, ''),
          imagePrompt: '',
          imageUrl: uploadResult.url,
        }),
      });

      if (!response.ok) throw new Error('创建数字资产失败');

      const newAsset = await response.json();

      // 更新本地列表
      if (type === 'actor') {
        setActorAssets(prev => [...prev, newAsset]);
      } else if (type === 'prop') {
        setPropAssets(prev => [...prev, newAsset]);
      } else {
        setSceneAssets(prev => [...prev, newAsset]);
      }
    } catch (err) {
      console.error('上传失败:', err);
    }
  };

  // 打开 AI 生成对话框
  const handleOpenAIGenDialog = (type: 'actor' | 'prop' | 'scene') => {
    setAiGenDialogType(type);
    // 根据类型设置初始提示词
    if (type === 'actor') {
      setAiGenDialogPrompt(shot.actors || '');
    } else if (type === 'prop') {
      setAiGenDialogPrompt(shot.props || '');
    } else {
      setAiGenDialogPrompt(shot.location || '');
    }
    setShowAIGenDialog(true);
  };

  // AI 生成完成后的回调
  const handleAIImageGenerated = async (imageUrl: string) => {
    if (!shot.projectId) return;

    try {
      // 创建数字资产
      const response = await fetch(`/api/video2/projects/${shot.projectId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: aiGenDialogType,
          name: `AI生成${aiGenDialogType === 'actor' ? '演员' : aiGenDialogType === 'prop' ? '道具' : '地点'}_${Date.now()}`,
          imagePrompt: aiGenDialogPrompt,
          imageUrl,
        }),
      });

      if (!response.ok) throw new Error('创建数字资产失败');

      const newAsset = await response.json();

      // 更新本地列表
      if (aiGenDialogType === 'actor') {
        setActorAssets(prev => [...prev, newAsset]);
        setSelectedActors(prev => [...prev, newAsset.id]);
        setSelectedImageKeys(prev => {
          const newSet = new Set(prev);
          const images = newAsset.images?.length > 0 ? newAsset.images : [{ id: 0, imageUrl: newAsset.imageUrl }];
          newSet.add(getImageKey('actor', newAsset.id, images[0].id));
          return newSet;
        });
      } else if (aiGenDialogType === 'prop') {
        setPropAssets(prev => [...prev, newAsset]);
        setSelectedProps(prev => [...prev, newAsset.id]);
        setSelectedImageKeys(prev => {
          const newSet = new Set(prev);
          const images = newAsset.images?.length > 0 ? newAsset.images : [{ id: 0, imageUrl: newAsset.imageUrl }];
          newSet.add(getImageKey('prop', newAsset.id, images[0].id));
          return newSet;
        });
      } else {
        setSceneAssets(prev => [...prev, newAsset]);
        setSelectedScene(newAsset.id);
        setSelectedImageKeys(prev => {
          const newSet = new Set(prev);
          const images = newAsset.images?.length > 0 ? newAsset.images : [{ id: 0, imageUrl: newAsset.imageUrl }];
          newSet.add(getImageKey('scene', newAsset.id, images[0].id));
          return newSet;
        });
      }
    } catch (err) {
      console.error('创建数字资产失败:', err);
    }
  };

  // 开始生成
  const startGeneration = async () => {
    if (!selectedModel || !prompt.trim()) return;

    setStatus('generating');
    setErrorMessage('');

    try {
      // 获取选中图片的 URL（按图片粒度选择）
      const getSelectedUrls = (type: 'actor' | 'prop' | 'scene', assets: DigitalAsset[]) => {
        const urls: string[] = [];
        for (const asset of assets) {
          const images = getAssetImages(asset);
          for (const img of images) {
            if (selectedImageKeys.has(getImageKey(type, asset.id, img.id))) {
              urls.push(img.imageUrl);
            }
          }
        }
        return urls;
      };

      const actorUrls = getSelectedUrls('actor', actorAssets);
      const propUrls = getSelectedUrls('prop', propAssets);
      const sceneUrls = getSelectedUrls('scene', sceneAssets);
      const sceneUrl = sceneUrls[0]; // 场景只取第一张

      // 调用生成接口
      const response = await fetch('/api/video2/ai/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotId: shot.id,
          prompt: prompt.trim(),
          actorImageUrls: actorUrls,
          propImageUrls: propUrls,
          sceneImageUrl: sceneUrl,
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

            const output = task.output || {};
            const imageUrl = output.media?.url || output.imageUrl;
            if (imageUrl) {
              setGeneratedImage({
                url: imageUrl,
                cost: selectedModel.cost === 'free' ? 0 : 0.08,
              });
              setStatus('done');
              setShowSaveOptions(true);
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

  // 添加到分镜
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

  // 保存到数字资产
  const handleSaveToAsset = async (mode: 'add' | 'replace') => {
    if (!generatedImage || !shot.projectId) return;

    try {
      if (mode === 'add') {
        // 追加新资产
        const type = selectedActors.length > 0 ? 'actor' : selectedProps.length > 0 ? 'prop' : 'scene';
        await fetch(`/api/video2/projects/${shot.projectId}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            name: `AI生成${type === 'actor' ? '演员' : type === 'prop' ? '道具' : '地点'}_${Date.now()}`,
            imagePrompt: prompt,
            imageUrl: generatedImage.url,
          }),
        });
      } else if (mode === 'replace' && assetToReplace) {
        // 替换现有资产
        const asset = [...actorAssets, ...propAssets, ...sceneAssets].find(a => a.id === assetToReplace);
        if (asset) {
          await fetch(`/api/video2/projects/${shot.projectId}/assets/${assetToReplace}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: asset.name,
              imagePrompt: asset.imagePrompt,
              imageUrl: generatedImage.url,
            }),
          });
        }
      }

      // 同时添加到分镜
      await handleAddToShot();
    } catch (err) {
      setErrorMessage('保存失败');
      setStatus('error');
    }
  };

  const handleRegenerate = () => {
    setStatus('idle');
    setGeneratedImage(null);
    setErrorMessage('');
    setShowSaveOptions(false);
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
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-2 sm:p-4" onClick={onClose}>
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] rounded-2xl sm:rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10 shrink-0">
            <h2 className="text-base sm:text-lg font-semibold">AI 生成参考画面</h2>
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
                {/* 提示信息 */}
                <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-blue-300">
                      <p className="font-medium mb-1">风格一致性提示</p>
                      <p className="text-xs text-blue-400/80">
                        若同地点已有参考图，生成的图片会参考其风格；演员/地点/道具的选择优先级最高
                      </p>
                    </div>
                  </div>
                </div>

                {/* 提示词输入 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    提示词
                  </label>
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
                    placeholder="描述你想要生成的画面内容..."
                  />
                </div>

                {/* 演员选择区 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    演员（可多选，支持选多张参考图）
                  </label>
                  <div className="border border-white/10 rounded-xl p-3 bg-white/[0.02]">
                    {actorAssets.length > 0 && (
                      <div className="space-y-2 mb-3">
                        {actorAssets.map(asset => {
                          const images = getAssetImages(asset);
                          const isSelected = isAssetSelected('actor', asset.id);
                          const isExpanded = expandedAssetId?.type === 'actor' && expandedAssetId.id === asset.id;
                          const selectedCount = images.filter(img => selectedImageKeys.has(getImageKey('actor', asset.id, img.id))).length;
                          return (
                            <div key={asset.id} className="rounded-lg overflow-hidden border border-white/5">
                              <div className="flex items-center gap-2 p-2 hover:bg-white/5 transition">
                                <button
                                  onClick={() => toggleAssetSelection('actor', asset)}
                                  className={`relative rounded-md overflow-hidden border-2 transition flex-shrink-0 ${
                                    isSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                  }`}
                                >
                                  <img
                                    src={images[0]?.imageUrl || asset.imageUrl}
                                    alt={asset.name}
                                    className="w-12 h-12 object-cover"
                                  />
                                  {isSelected && (
                                    <div className="absolute inset-0 bg-violet-500/30 flex items-center justify-center">
                                      <CheckCircle className="w-4 h-4 text-white" />
                                    </div>
                                  )}
                                </button>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-white truncate">{asset.name}</p>
                                  <p className="text-[10px] text-slate-400">{images.length} 张图 · 已选 {selectedCount} 张</p>
                                </div>
                                {images.length > 1 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedAssetId(isExpanded ? null : { type: 'actor', id: asset.id });
                                    }}
                                    className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white transition"
                                  >
                                    <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                  </button>
                                )}
                              </div>
                              {isExpanded && images.length > 1 && (
                                <div className="px-2 pb-2 flex flex-wrap gap-2 border-t border-white/5 pt-2">
                                  {images.map((img, idx) => {
                                    const imgSelected = selectedImageKeys.has(getImageKey('actor', asset.id, img.id));
                                    return (
                                      <button
                                        key={img.id}
                                        onClick={() => toggleImageSelection('actor', asset, img.id)}
                                        className={`relative rounded-md overflow-hidden border-2 transition ${
                                          imgSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                        }`}
                                      >
                                        <img
                                          src={img.imageUrl}
                                          alt={`${asset.name} ${idx + 1}`}
                                          className="w-10 h-10 object-cover"
                                        />
                                        {imgSelected && (
                                          <div className="absolute inset-0 bg-violet-500/40 flex items-center justify-center">
                                            <CheckCircle className="w-3.5 h-3.5 text-white" />
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        ref={fileInputRefs.actor}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => handleUploadAsset('actor', e.target.files)}
                      />
                      <button
                        onClick={() => fileInputRefs.actor.current?.click()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm transition"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        上传
                      </button>
                      <button
                        onClick={() => handleOpenAIGenDialog('actor')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 text-sm transition"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        AI 生成
                      </button>
                    </div>
                  </div>
                </div>

                {/* 道具选择区 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    道具（可多选，支持选多张参考图）
                  </label>
                  <div className="border border-white/10 rounded-xl p-3 bg-white/[0.02]">
                    {propAssets.length > 0 && (
                      <div className="space-y-2 mb-3">
                        {propAssets.map(asset => {
                          const images = getAssetImages(asset);
                          const isSelected = isAssetSelected('prop', asset.id);
                          const isExpanded = expandedAssetId?.type === 'prop' && expandedAssetId.id === asset.id;
                          const selectedCount = images.filter(img => selectedImageKeys.has(getImageKey('prop', asset.id, img.id))).length;
                          return (
                            <div key={asset.id} className="rounded-lg overflow-hidden border border-white/5">
                              <div className="flex items-center gap-2 p-2 hover:bg-white/5 transition">
                                <button
                                  onClick={() => toggleAssetSelection('prop', asset)}
                                  className={`relative rounded-md overflow-hidden border-2 transition flex-shrink-0 ${
                                    isSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                  }`}
                                >
                                  <img
                                    src={images[0]?.imageUrl || asset.imageUrl}
                                    alt={asset.name}
                                    className="w-12 h-12 object-cover"
                                  />
                                  {isSelected && (
                                    <div className="absolute inset-0 bg-violet-500/30 flex items-center justify-center">
                                      <CheckCircle className="w-4 h-4 text-white" />
                                    </div>
                                  )}
                                </button>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-white truncate">{asset.name}</p>
                                  <p className="text-[10px] text-slate-400">{images.length} 张图 · 已选 {selectedCount} 张</p>
                                </div>
                                {images.length > 1 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedAssetId(isExpanded ? null : { type: 'prop', id: asset.id });
                                    }}
                                    className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white transition"
                                  >
                                    <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                  </button>
                                )}
                              </div>
                              {isExpanded && images.length > 1 && (
                                <div className="px-2 pb-2 flex flex-wrap gap-2 border-t border-white/5 pt-2">
                                  {images.map((img, idx) => {
                                    const imgSelected = selectedImageKeys.has(getImageKey('prop', asset.id, img.id));
                                    return (
                                      <button
                                        key={img.id}
                                        onClick={() => toggleImageSelection('prop', asset, img.id)}
                                        className={`relative rounded-md overflow-hidden border-2 transition ${
                                          imgSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                        }`}
                                      >
                                        <img
                                          src={img.imageUrl}
                                          alt={`${asset.name} ${idx + 1}`}
                                          className="w-10 h-10 object-cover"
                                        />
                                        {imgSelected && (
                                          <div className="absolute inset-0 bg-violet-500/40 flex items-center justify-center">
                                            <CheckCircle className="w-3.5 h-3.5 text-white" />
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        ref={fileInputRefs.prop}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => handleUploadAsset('prop', e.target.files)}
                      />
                      <button
                        onClick={() => fileInputRefs.prop.current?.click()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm transition"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        上传
                      </button>
                      <button
                        onClick={() => handleOpenAIGenDialog('prop')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 text-sm transition"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        AI 生成
                      </button>
                    </div>
                  </div>
                </div>

                {/* 地点选择区 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    地点（单选，支持选多张参考图）
                  </label>
                  <div className="border border-white/10 rounded-xl p-3 bg-white/[0.02]">
                    {sceneAssets.length > 0 && (
                      <div className="space-y-2 mb-3">
                        {sceneAssets.map(asset => {
                          const images = getAssetImages(asset);
                          const isSelected = isAssetSelected('scene', asset.id);
                          const isExpanded = expandedAssetId?.type === 'scene' && expandedAssetId.id === asset.id;
                          const selectedCount = images.filter(img => selectedImageKeys.has(getImageKey('scene', asset.id, img.id))).length;
                          return (
                            <div key={asset.id} className="rounded-lg overflow-hidden border border-white/5">
                              <div className="flex items-center gap-2 p-2 hover:bg-white/5 transition">
                                <button
                                  onClick={() => toggleAssetSelection('scene', asset)}
                                  className={`relative rounded-md overflow-hidden border-2 transition flex-shrink-0 ${
                                    isSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                  }`}
                                >
                                  <img
                                    src={images[0]?.imageUrl || asset.imageUrl}
                                    alt={asset.name}
                                    className="w-12 h-12 object-cover"
                                  />
                                  {isSelected && (
                                    <div className="absolute inset-0 bg-violet-500/30 flex items-center justify-center">
                                      <CheckCircle className="w-4 h-4 text-white" />
                                    </div>
                                  )}
                                </button>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-white truncate">{asset.name}</p>
                                  <p className="text-[10px] text-slate-400">{images.length} 张图 · 已选 {selectedCount} 张</p>
                                </div>
                                {images.length > 1 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedAssetId(isExpanded ? null : { type: 'scene', id: asset.id });
                                    }}
                                    className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white transition"
                                  >
                                    <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                  </button>
                                )}
                              </div>
                              {isExpanded && images.length > 1 && (
                                <div className="px-2 pb-2 flex flex-wrap gap-2 border-t border-white/5 pt-2">
                                  {images.map((img, idx) => {
                                    const imgSelected = selectedImageKeys.has(getImageKey('scene', asset.id, img.id));
                                    return (
                                      <button
                                        key={img.id}
                                        onClick={() => toggleImageSelection('scene', asset, img.id)}
                                        className={`relative rounded-md overflow-hidden border-2 transition ${
                                          imgSelected ? 'border-violet-500' : 'border-transparent hover:border-white/30'
                                        }`}
                                      >
                                        <img
                                          src={img.imageUrl}
                                          alt={`${asset.name} ${idx + 1}`}
                                          className="w-10 h-10 object-cover"
                                        />
                                        {imgSelected && (
                                          <div className="absolute inset-0 bg-violet-500/40 flex items-center justify-center">
                                            <CheckCircle className="w-3.5 h-3.5 text-white" />
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        ref={fileInputRefs.scene}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => handleUploadAsset('scene', e.target.files)}
                      />
                      <button
                        onClick={() => fileInputRefs.scene.current?.click()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm transition"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        上传
                      </button>
                      <button
                        onClick={() => handleOpenAIGenDialog('scene')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 text-sm transition"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        AI 生成
                      </button>
                    </div>
                  </div>
                </div>

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

                {/* 费用提示 */}
                {selectedModel && (
                  <div className="mb-6 text-sm text-slate-400">
                    <span className="text-amber-300/80">
                      费用：{COST_LABELS[selectedModel.cost] || '未知'}
                    </span>
                  </div>
                )}
              </>
            )}

            {status === 'generating' && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-12 h-12 text-violet-400 animate-spin mb-4" />
                <p className="text-lg font-medium text-slate-200 mb-2">正在生成参考画面...</p>
                <p className="text-sm text-slate-400 mb-1">
                  模型：{getModelDisplayName(selectedModel)} ({selectedModel?.quality || 'standard'})
                </p>
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
                    alt="生成的参考画面"
                    className="w-full h-auto max-h-80 object-contain bg-black/40"
                  />
                </div>

                {showSaveOptions && (
                  <div className="w-full p-4 rounded-xl border border-white/10 bg-white/5 mb-4">
                    <p className="text-sm font-medium text-slate-300 mb-3">保存选项：</p>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="saveMode"
                          value="shot_only"
                          checked={saveMode === 'shot_only'}
                          onChange={() => setSaveMode('shot_only')}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-slate-300">仅添加到当前分镜</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="saveMode"
                          value="add_to_assets"
                          checked={saveMode === 'add_to_assets'}
                          onChange={() => setSaveMode('add_to_assets')}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-slate-300">追加到数字资产并添加到分镜</span>
                      </label>
                      {(selectedActors.length > 0 || selectedProps.length > 0 || selectedScene) && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="saveMode"
                            value="replace_asset"
                            checked={saveMode === 'replace_asset'}
                            onChange={() => setSaveMode('replace_asset')}
                            className="w-4 h-4"
                          />
                          <span className="text-sm text-slate-300">替换选中的资产图片</span>
                        </label>
                      )}
                    </div>
                  </div>
                )}

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
                  生成参考画面
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
                  onClick={() => {
                    if (saveMode === 'shot_only') {
                      handleAddToShot();
                    } else if (saveMode === 'add_to_assets') {
                      handleSaveToAsset('add');
                    } else if (saveMode === 'replace_asset') {
                      handleSaveToAsset('replace');
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition"
                >
                  保存
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

      {/* AI 生成对话框 */}
      <AIImageGenerateDialog
        isOpen={showAIGenDialog}
        onClose={() => setShowAIGenDialog(false)}
        initialPrompt={aiGenDialogPrompt}
        onUseImage={handleAIImageGenerated}
        title={`AI 生成${aiGenDialogType === 'actor' ? '演员' : aiGenDialogType === 'prop' ? '道具' : '地点'}图片`}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}