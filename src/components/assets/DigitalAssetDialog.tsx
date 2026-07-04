import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  Loader2,
  Plus,
  Trash2,
  Edit2,
  Check,
  Image as ImageIcon,
  Sparkles,
  CheckCircle2
} from 'lucide-react';
import type { DigitalAsset } from '../../lib/types';
import AIImageGenerateDialog from '../ai/AIImageGenerateDialog';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface DigitalAssetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  aiSuggestedAssets?: {
    mainActors: Array<{ name: string; imagePrompt: string }>;
    keyProps: Array<{ name: string; imagePrompt: string }>;
    mainScenes: Array<{ name: string; imagePrompt: string }>;
  } | null;
  onAssetsImported?: () => void;
}

type AssetType = 'actor' | 'prop' | 'scene';

interface EditingState {
  id: number | null;
  field: 'name' | 'imagePrompt' | null;
  value: string;
}

const TABS: { type: AssetType; label: string; icon: string }[] = [
  { type: 'actor', label: '演员', icon: '👤' },
  { type: 'prop', label: '道具', icon: '🎭' },
  { type: 'scene', label: '地点', icon: '📍' },
];

export default function DigitalAssetDialog({
  isOpen,
  onClose,
  projectId,
  aiSuggestedAssets,
  onAssetsImported,
}: DigitalAssetDialogProps) {
  const [activeTab, setActiveTab] = useState<AssetType>('actor');
  const [assets, setAssets] = useState<DigitalAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<EditingState>({ id: null, field: null, value: '' });
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAsset, setNewAsset] = useState({ name: '' });
  const [expandedAssetId, setExpandedAssetId] = useState<number | null>(null);

  // AI 建议资产状态
  const [showAiSuggestions, setShowAiSuggestions] = useState(false);
  const [selectedAiAssets, setSelectedAiAssets] = useState<Set<string>>(new Set());

  // AI 生图对话框状态
  const [aiImageDialogOpen, setAiImageDialogOpen] = useState(false);
  const [aiImageTargetAsset, setAiImageTargetAsset] = useState<DigitalAsset | null>(null);
  const [aiImagePrompt, setAiImagePrompt] = useState('');
  const [updatePromptAfterGen, setUpdatePromptAfterGen] = useState(true);

  // 上传文件 input ref
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAssetId, setUploadingAssetId] = useState<number | null>(null);

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 加载资产列表
  useEffect(() => {
    if (isOpen) {
      fetchAssets();
    }
  }, [isOpen, projectId, activeTab]);

  // 检测是否有 AI 建议资产
  useEffect(() => {
    if (isOpen && aiSuggestedAssets) {
      const hasAssets =
        (aiSuggestedAssets.mainActors?.length || 0) > 0 ||
        (aiSuggestedAssets.keyProps?.length || 0) > 0 ||
        (aiSuggestedAssets.mainScenes?.length || 0) > 0;
      setShowAiSuggestions(hasAssets);
    }
  }, [isOpen, aiSuggestedAssets]);

  const fetchAssets = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets?type=${activeTab}`);
      const data = await res.json();
      if (data.success) {
        setAssets(data.data || []);
      }
    } catch (err) {
      console.error('加载资产失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 新增资产
  const handleAddAsset = async () => {
    if (!newAsset.name.trim()) return;

    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: activeTab,
          name: newAsset.name.trim(),
          imagePrompt: '',
          imageUrl: '',
        }),
      });

      if (res.ok) {
        setNewAsset({ name: '' });
        setShowAddForm(false);
        fetchAssets();
      }
    } catch (err) {
      console.error('新增资产失败:', err);
    }
  };

  // 删除资产
  const handleDeleteAsset = async (id: number) => {
    if (!confirm('确定要删除这个资产吗？')) return;

    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error('删除资产失败:', err);
    }
  };

  // 更新资产
  const handleUpdateAsset = async (id: number, updates: Partial<DigitalAsset>) => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error('更新资产失败:', err);
    }
  };

  // 开始编辑
  const startEditing = (asset: DigitalAsset, field: 'name' | 'imagePrompt') => {
    setEditing({
      id: asset.id,
      field,
      value: asset[field] || '',
    });
  };

  // 保存编辑
  const saveEditing = () => {
    if (editing.id !== null && editing.field) {
      handleUpdateAsset(editing.id, { [editing.field]: editing.value });
      setEditing({ id: null, field: null, value: '' });
    }
  };

  // 取消编辑
  const cancelEditing = () => {
    setEditing({ id: null, field: null, value: '' });
  };

  // 上传图片
  const handleUploadImage = async (assetId: number, file: File) => {
    setUploadingAssetId(assetId);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', `asset_${assetId}_${Date.now()}`);

      const res = await fetch('/api/video2/upload', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        // 添加到资产图片列表
        await addAssetImage(assetId, data.url);
      }
    } catch (err) {
      console.error('上传图片失败:', err);
    } finally {
      setUploadingAssetId(null);
    }
  };

  // 添加图片到资产
  const addAssetImage = async (assetId: number, imageUrl: string) => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets/${assetId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });
      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error('添加资产图片失败:', err);
    }
  };

  // 删除资产图片
  const handleDeleteImage = async (assetId: number, imageId: number) => {
    if (!confirm('确定要删除这张图片吗？')) return;
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/assets/${assetId}/images/${imageId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error('删除图片失败:', err);
    }
  };

  // AI 生图
  const openAiImageDialog = (asset: DigitalAsset) => {
    setAiImageTargetAsset(asset);
    setAiImagePrompt(asset.imagePrompt || '');
    setUpdatePromptAfterGen(true);
    setAiImageDialogOpen(true);
  };

  const handleUseAiImage = async (imageUrl: string) => {
    if (aiImageTargetAsset) {
      // 添加到图片列表
      await addAssetImage(aiImageTargetAsset.id, imageUrl);
      // 如果勾选了更新提示词
      if (updatePromptAfterGen && aiImagePrompt.trim()) {
        await handleUpdateAsset(aiImageTargetAsset.id, { imagePrompt: aiImagePrompt.trim() });
      }
      setAiImageTargetAsset(null);
    }
  };

  // AI 建议资产相关
  const getAiAssetsByType = (type: AssetType) => {
    if (!aiSuggestedAssets) return [];
    if (type === 'actor') return aiSuggestedAssets.mainActors || [];
    if (type === 'prop') return aiSuggestedAssets.keyProps || [];
    if (type === 'scene') return aiSuggestedAssets.mainScenes || [];
    return [];
  };

  const toggleAiAssetSelection = (key: string) => {
    const newSet = new Set(selectedAiAssets);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    setSelectedAiAssets(newSet);
  };

  const importSelectedAiAssets = async () => {
    const assetsToImport: Array<{ type: AssetType; name: string; imagePrompt: string }> = [];

    TABS.forEach(({ type }) => {
      const aiAssets = getAiAssetsByType(type);
      aiAssets.forEach((asset, index) => {
        const key = `${type}-${index}`;
        if (selectedAiAssets.has(key)) {
          assetsToImport.push({
            type,
            name: asset.name,
            imagePrompt: asset.imagePrompt,
          });
        }
      });
    });

    if (assetsToImport.length === 0) return;

    try {
      // 批量创建资产
      await Promise.all(
        assetsToImport.map(asset =>
          fetch(`/api/video2/projects/${projectId}/assets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: asset.type,
              name: asset.name,
              imagePrompt: asset.imagePrompt,
              imageUrl: '',
            }),
          })
        )
      );

      setShowAiSuggestions(false);
      setSelectedAiAssets(new Set());
      fetchAssets();
      if (onAssetsImported) {
        onAssetsImported();
      }
    } catch (err) {
      console.error('导入资产失败:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-4" onClick={onClose}>
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl max-h-[90vh] rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">数字资产管理</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* AI 建议资产提示 */}
        {showAiSuggestions && aiSuggestedAssets && (
          <div className="px-6 py-3 bg-violet-500/10 border-b border-violet-500/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-violet-300">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-medium">AI 已识别数字资产，是否导入？</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAiSuggestions(false)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-white/15 hover:bg-white/10 transition"
                >
                  稍后处理
                </button>
                <button
                  onClick={importSelectedAiAssets}
                  className="px-3 py-1.5 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition"
                >
                  导入选中资产
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-white/10">
          {TABS.map(({ type, label, icon }) => {
            const aiAssetCount = showAiSuggestions ? getAiAssetsByType(type).length : 0;
            return (
              <button
                key={type}
                onClick={() => setActiveTab(type)}
                className={`flex-1 px-4 py-3 text-sm font-medium transition border-b-2 ${
                  activeTab === type
                    ? 'border-violet-500 text-violet-400 bg-violet-500/5'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
              >
                <span className="mr-2">{icon}</span>
                {label}
                {aiAssetCount > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-violet-500/20 text-violet-300">
                    +{aiAssetCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* AI 建议资产列表 */}
          {showAiSuggestions && getAiAssetsByType(activeTab).length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-violet-300 mb-3 flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                AI 建议资产
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {getAiAssetsByType(activeTab).map((asset, index) => {
                  const key = `${activeTab}-${index}`;
                  const isSelected = selectedAiAssets.has(key);
                  return (
                    <div
                      key={key}
                      onClick={() => toggleAiAssetSelection(key)}
                      className={`relative p-3 rounded-xl border-2 cursor-pointer transition ${
                        isSelected
                          ? 'border-violet-500 bg-violet-500/10'
                          : 'border-white/10 bg-white/5 hover:border-white/20'
                      }`}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-500 flex items-center justify-center">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      )}
                      <h4 className="font-medium text-sm mb-1 truncate">{asset.name}</h4>
                      <p className="text-xs text-slate-400 line-clamp-2">{asset.imagePrompt}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 已有资产列表 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-slate-300">已有资产</h3>
              <button
                onClick={() => setShowAddForm(true)}
                className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white flex items-center gap-1 transition"
              >
                <Plus className="w-3 h-3" />
                新增资产
              </button>
            </div>

            {/* 新增资产表单 */}
            {showAddForm && (
              <div className="mb-4 p-4 rounded-xl border border-violet-500/30 bg-violet-500/5">
                <div className="mb-3">
                  <label className="block text-xs text-slate-400 mb-1">名称</label>
                  <input
                    type="text"
                    value={newAsset.name}
                    onChange={e => setNewAsset({ ...newAsset, name: e.target.value })}
                    placeholder="输入资产名称"
                    className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setNewAsset({ name: '' });
                    }}
                    className="px-3 py-1.5 text-sm rounded-lg border border-white/15 hover:bg-white/10 transition"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleAddAsset}
                    disabled={!newAsset.name.trim()}
                    className="px-3 py-1.5 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}

            {/* 资产网格 */}
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
              </div>
            ) : assets.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p className="text-sm">暂无资产</p>
                <p className="text-xs mt-1">点击上方"新增资产"按钮添加</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {assets.map(asset => {
                  const images = asset.images || [];
                  const coverUrl = images.length > 0 ? images[0].imageUrl : asset.imageUrl;
                  const isExpanded = expandedAssetId === asset.id;
                  const maxImages = 10;
                  const canAddImage = images.length < maxImages;

                  return (
                    <div
                      key={asset.id}
                      className="group rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:border-white/20 transition"
                    >
                      {/* 封面图区域 - 点击展开/收起 */}
                      <div
                        className="relative aspect-square bg-black/40 cursor-pointer"
                        onClick={() => setExpandedAssetId(isExpanded ? null : asset.id)}
                      >
                        {coverUrl ? (
                          <img
                            src={coverUrl}
                            alt={asset.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-500">
                            <ImageIcon className="w-12 h-12" />
                          </div>
                        )}

                        {/* 图片数量角标 */}
                        {images.length > 1 && (
                          <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/60 text-xs text-white">
                            {images.length} / {maxImages}
                          </div>
                        )}

                        {/* 悬浮操作按钮 */}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                          {/* 上传图片 */}
                          {canAddImage && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setUploadingAssetId(asset.id);
                                const input = document.createElement('input');
                                input.type = 'file';
                                input.accept = 'image/*';
                                input.onchange = (e) => {
                                  const files = (e.target as HTMLInputElement).files;
                                  if (files && files[0]) {
                                    handleUploadImage(asset.id, files[0]);
                                  }
                                };
                                input.click();
                              }}
                              className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition"
                              title="上传图片"
                            >
                              {uploadingAssetId === asset.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Upload className="w-4 h-4" />
                              )}
                            </button>
                          )}

                          {/* AI 生图 */}
                          {canAddImage && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openAiImageDialog(asset);
                              }}
                              className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition"
                              title="AI 生图"
                            >
                              <Sparkles className="w-4 h-4" />
                            </button>
                          )}

                          {/* 删除 */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteAsset(asset.id);
                            }}
                            className="w-8 h-8 rounded-full bg-red-500/50 hover:bg-red-500/70 flex items-center justify-center transition"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* 名称 */}
                      <div className="p-3">
                        {editing.id === asset.id && editing.field === 'name' ? (
                          <div className="flex gap-1">
                            <input
                              type="text"
                              value={editing.value}
                              onChange={e => setEditing({ ...editing, value: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEditing();
                                if (e.key === 'Escape') cancelEditing();
                              }}
                              className="flex-1 px-2 py-1 text-sm rounded border border-violet-500 bg-slate-800 focus:outline-none"
                              autoFocus
                            />
                            <button onClick={saveEditing} className="p-1 hover:bg-white/10 rounded">
                              <Check className="w-4 h-4 text-green-400" />
                            </button>
                          </div>
                        ) : (
                          <div
                            className="flex items-center gap-1 cursor-pointer group/name"
                            onClick={() => startEditing(asset, 'name')}
                          >
                            <h4 className="font-medium text-sm truncate flex-1">{asset.name}</h4>
                            <Edit2 className="w-3 h-3 opacity-0 group-hover/name:opacity-100 text-slate-400 transition" />
                          </div>
                        )}
                      </div>

                      {/* 展开的图片列表 */}
                      {isExpanded && images.length > 0 && (
                        <div className="px-3 pb-3 border-t border-white/5 pt-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-slate-400">图片列表 ({images.length}/{maxImages})</span>
                          </div>
                          <div className="grid grid-cols-5 gap-1.5">
                            {images.map(img => (
                              <div
                                key={img.id}
                                className="relative aspect-square rounded-lg overflow-hidden bg-black/30 group/img"
                              >
                                <img
                                  src={img.imageUrl}
                                  alt=""
                                  className="w-full h-full object-cover"
                                />
                                <button
                                  onClick={() => handleDeleteImage(asset.id, img.id)}
                                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-red-500/70 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition"
                                  title="删除图片"
                                >
                                  <X className="w-3 h-3 text-white" />
                                </button>
                              </div>
                            ))}
                          </div>
                          {!canAddImage && (
                            <p className="text-xs text-amber-400 mt-2">最多 {maxImages} 张图片</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            关闭
          </button>
        </div>
      </div>

      <AIImageGenerateDialog
        isOpen={aiImageDialogOpen}
        onClose={() => {
          setAiImageDialogOpen(false);
          setAiImageTargetAsset(null);
        }}
        initialPrompt={aiImagePrompt}
        onUseImage={handleUseAiImage}
        title={`AI 生成${aiImageTargetAsset ? `「${aiImageTargetAsset.name}」` : ''}图片`}
        showUpdatePromptOption={true}
        updatePromptChecked={updatePromptAfterGen}
        onUpdatePromptChange={setUpdatePromptAfterGen}
        ownerId={aiImageTargetAsset?.id}
        projectId={projectId}
      />

      {/* 隐藏的文件上传 input */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          if (uploadingAssetId && e.target.files && e.target.files[0]) {
            handleUploadImage(uploadingAssetId, e.target.files[0]);
          }
        }}
      />
    </div>
  );
}