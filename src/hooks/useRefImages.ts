import { useState, useCallback, useEffect } from 'react';
import type { RefImage, AiGeneratedImage } from '../lib/types';
import { uploadImage } from '../lib/ossUtils';

export const MAX_HISTORY = 20;

/**
 * P3-24：AI 生图参考图统一管理 hook
 * - 管理 refImages（数字资产选择 + 用户上传）单一 state
 * - 管理 historyImages（ai_generated_images 表持久化的历史图）
 * - @引用解析（prompt 中的 @资产名 → 对应 refImage URL）
 * - 供 AIImageGenerateDialog 共用（统一对话框，支持 shot 和 asset 两种上下文）
 */
export function useRefImages(options: {
  ownerType: 'shot' | 'asset';
  ownerId: number;
  projectId?: number;
  enabled?: boolean;
  maxRefImages?: number;
}) {
  const { ownerType, ownerId, projectId, enabled = true, maxRefImages = 1 } = options;

  const [refImages, setRefImages] = useState<RefImage[]>([]);
  const [historyImages, setHistoryImages] = useState<AiGeneratedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState('');

  // 加载历史图（持久化到 ai_generated_images 表）
  const loadHistory = useCallback(async () => {
    if (!enabled || !ownerId) return;
    try {
      const res = await fetch(`/api/ai/generated-images?ownerType=${ownerType}&ownerId=${ownerId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setHistoryImages(data.data || []);
        }
      }
    } catch (e) {
      console.error('[useRefImages] 加载历史失败:', e);
    }
  }, [ownerType, ownerId, enabled]);

  useEffect(() => {
    if (enabled) {
      loadHistory();
    }
  }, [loadHistory, enabled]);

  // 添加资产参考图（如果 URL 已存在则跳过）
  const addAssetRef = useCallback((
    url: string,
    assetInfo: { assetId: number; assetName: string; assetType: 'actor' | 'prop' | 'scene' }
  ) => {
    setRefImages(prev => {
      if (prev.some(r => r.url === url)) return prev;  // 去重
      if (prev.length >= maxRefImages) return prev;   // 上限
      const newRef: RefImage = {
        id: `asset-${assetInfo.assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        source: 'asset',
        assetId: assetInfo.assetId,
        assetName: assetInfo.assetName,
        assetType: assetInfo.assetType,
      };
      return [...prev, newRef];
    });
  }, [maxRefImages]);

  // 切换资产参考图选择状态（UI 用）
  const toggleAssetRef = useCallback((
    url: string,
    assetInfo: { assetId: number; assetName: string; assetType: 'actor' | 'prop' | 'scene' }
  ) => {
    setRefImages(prev => {
      const existing = prev.find(r => r.url === url);
      if (existing) {
        return prev.filter(r => r.id !== existing.id);
      }
      if (prev.length >= maxRefImages) return prev;
      const newRef: RefImage = {
        id: `asset-${assetInfo.assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        source: 'asset',
        assetId: assetInfo.assetId,
        assetName: assetInfo.assetName,
        assetType: assetInfo.assetType,
      };
      return [...prev, newRef];
    });
  }, [maxRefImages]);

  // 上传本地图片作为参考图
  const addUploadRef = useCallback(async (file: File) => {
    if (!projectId) {
      throw new Error('缺少 projectId，无法上传参考图');
    }
    if (refImages.length >= maxRefImages) {
      throw new Error(`参考图已达上限（${maxRefImages} 张）`);
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadMessage('准备上传...');
    try {
      const uploadResult = await uploadImage(file, {
        projectId,
        usage: 'shot-reference',
        title: `ai-ref-${Date.now()}`,
        onProgress: p => {
          setUploadProgress(p.progress);
          setUploadMessage(p.message);
        }
      });
      const currentCount = refImages.length;
      const newRef: RefImage = {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url: uploadResult.url,
        source: 'upload',
        assetName: `参考图${currentCount + 1}`,
      };
      setRefImages(prev => [...prev, newRef]);
      setUploadProgress(100);
      setUploadMessage('完成');
      return newRef;
    } finally {
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
        setUploadMessage('');
      }, 500);
    }
  }, [projectId, refImages.length]);

  // 移除参考图
  const removeRef = useCallback((id: string) => {
    setRefImages(prev => prev.filter(r => r.id !== id));
  }, []);

  // 清空所有参考图
  const clearRefs = useCallback(() => {
    setRefImages([]);
  }, []);

  // 判断 URL 是否已选为参考图
  const isRefSelected = useCallback((url: string) => {
    return refImages.some(r => r.url === url);
  }, [refImages]);

  // 用户明确删除单张历史图（调用 DELETE API + 刷新 state）
  const deleteHistory = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/ai/generated-images/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setHistoryImages(prev => prev.filter(img => img.id !== id));
      }
    } catch (err) {
      console.error('[useRefImages] 删除历史图失败:', err);
    }
  }, []);

  // 选择历史图作为生成结果（外部回调使用）
  const selectHistory = useCallback((img: AiGeneratedImage) => {
    // 此处仅返回数据，由调用方处理结果状态
    return img;
  }, []);

  // 解析 prompt 中的 @资产名 → 返回对应的 refImages
  // 简单实现：扫描 prompt 中所有 @xxx，匹配 refImages 中 assetName
  const parseAtReferences = useCallback((promptText: string): RefImage[] => {
    if (!promptText) return [];
    const matches = promptText.match(/@([^\s@，。,.\u3001]+)/g) || [];
    const names = matches.map(m => m.slice(1).trim());
    return refImages.filter(r => r.assetName && names.includes(r.assetName));
  }, [refImages]);

  // 收集所有参考图 URL（用于后端调用）
  const getAllRefUrls = useCallback((): string[] => {
    return refImages.map(r => r.url);
  }, [refImages]);

  // 直接添加 URL 作为参考图（用于分镜图片等无 File 的场景）
  const addUrlRef = useCallback((url: string, label?: string, source?: 'upload' | 'shot') => {
    setRefImages(prev => {
      if (prev.some(r => r.url === url)) return prev;  // 去重
      if (prev.length >= maxRefImages) return prev;   // 上限
      const isShot = source === 'shot';
      const defaultName = label || (isShot ? `分镜参考${prev.length + 1}` : `参考图${prev.length + 1}`);
      const newRef: RefImage = {
        id: `url-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        source: source || 'upload',
        assetName: defaultName,
        shotTitle: isShot ? defaultName : undefined,
      };
      return [...prev, newRef];
    });
  }, [maxRefImages]);

  const isFull = refImages.length >= maxRefImages;

  return {
    refImages,
    setRefImages,
    historyImages,
    maxRefImages,
    MAX_HISTORY,
    isFull,
    uploading,
    uploadProgress,
    uploadMessage,
    addAssetRef,
    toggleAssetRef,
    addUploadRef,
    addUrlRef,
    removeRef,
    clearRefs,
    isRefSelected,
    loadHistory,
    deleteHistory,
    selectHistory,
    parseAtReferences,
    getAllRefUrls,
  };
}
