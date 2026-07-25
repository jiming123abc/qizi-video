import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, Sparkles, Image as ImageIcon, FileVideo, ChevronUp, ChevronDown, Trash2, GripVertical } from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import { getVideoPoster, batchGetSignedUrls, getSignedUrlFromCache } from '../../lib/ossUtils';
import { useUnifiedUpload } from '../../hooks/useUnifiedUpload';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useToastContext } from '../ToastProvider';

interface MediaManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shot: Shot;
  onMediaChange?: (shot: Shot) => void;
  onAiGenerate?: (shot: Shot) => void;
  refreshTrigger?: number;
  childDialogOpen?: boolean;
}

const MAX_MEDIA_COUNT = 10;

// 统一缩略图组件：视频用封面图（img），图片直接用 img，避免 video 元素的请求中止问题
function MediaThumb({ media, signedUrls }: { media: ShotMedia; signedUrls: Record<string, string> }) {
  const [hasError, setHasError] = useState(false);
  const isVideo = media.type === 'video';

  // 封面图时间添加 0.05 秒偏移，避免截到上一镜头的尾帧（与 ShotCard/VideoSplitDialog 保持一致）
  const shotStartTime = media.startTime || 0;
  const shotEndTime = shotStartTime + (media.duration || 0);
  const thumbTime = Math.min(shotStartTime + 0.05, Math.max(shotEndTime - 0.01, shotStartTime));
  const thumbUrl = isVideo && media.url
    ? getVideoPoster(media.url, thumbTime)
    : (media.url ? signedUrls[media.url] : undefined);

  return (
    <div className="absolute inset-0">
      {thumbUrl && !hasError ? (
        <img
          src={thumbUrl}
          alt={media.filename}
          className="w-full h-full object-cover"
          onError={() => setHasError(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {isVideo ? (
            <FileVideo className={`w-6 h-6 text-white/30 ${thumbUrl && !hasError ? '' : 'animate-pulse'}`} />
          ) : (
            <ImageIcon className={`w-8 h-8 text-white/30 ${thumbUrl && !hasError ? '' : 'animate-pulse'}`} />
          )}
        </div>
      )}
      {isVideo && thumbUrl && !hasError && (
        <div className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
          <FileVideo className="w-3 h-3 text-white/80" />
        </div>
      )}
    </div>
  );
}

export default function MediaManagerDialog({
  isOpen,
  onClose,
  shot,
  onMediaChange,
  onAiGenerate,
  refreshTrigger = 0,
  childDialogOpen = false
}: MediaManagerDialogProps) {
  const { startUpload } = useUnifiedUpload();
  const [mediaList, setMediaList] = useState<ShotMedia[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const processedUrlsRef = useRef<Set<string>>(new Set());
  const uploadingRef = useRef(false);
  const { showToast } = useToastContext();

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Dialog 关闭时清理已处理 URL 集合
  useEffect(() => {
    if (!isOpen) {
      processedUrlsRef.current.clear();
    }
  }, [isOpen]);

  // 从 API 拉取最新媒体列表（打开时、切换 shot 时、refreshTrigger 变化时）
  const fetchMediaList = async () => {
    if (!shot?.id) return;
    setMediaLoading(true);
    try {
      const res = await fetch(`/api/shots/${shot.id}/media`);
      const data = await res.json();
      if (data && data.success && Array.isArray(data.data)) {
        const sorted = [...data.data].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setMediaList(sorted);
        if (onMediaChange) {
          onMediaChange({ ...shot, media: sorted });
        }
      }
    } catch (e) {
      console.error('[MediaManager] 拉取媒体列表失败:', e);
    } finally {
      setMediaLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !shot?.id) return;
    fetchMediaList();
  }, [isOpen, shot?.id, refreshTrigger]);

  // 批量签名媒体 URL（含视频封面），只处理未处理过的 URL，避免重复触发重渲染
  useEffect(() => {
    if (!isOpen || mediaList.length === 0) return;

    const allUrls: string[] = [];
    mediaList.forEach(m => {
      if (m.url && !allUrls.includes(m.url)) allUrls.push(m.url);
    });

    const newUrls = allUrls.filter(u => !processedUrlsRef.current.has(u));
    if (newUrls.length === 0) return;

    newUrls.forEach(u => processedUrlsRef.current.add(u));

    // 判断是否已签名：getSignedUrlFromCache 未缓存时返回原始 URL
    const initial: Record<string, string> = {};
    const needSign: string[] = [];

    newUrls.forEach(u => {
      const cached = getSignedUrlFromCache(u);
      if (cached && cached !== u) {
        // 缓存命中，有签名 URL
        initial[u] = cached;
      } else {
        // 未缓存，标记为需要签名
        needSign.push(u);
      }
    });

    if (Object.keys(initial).length > 0) {
      setSignedUrls(prev => {
        const changed = Object.keys(initial).some(k => prev[k] !== initial[k]);
        return changed ? { ...prev, ...initial } : prev;
      });
    }

    if (needSign.length > 0) {
      batchGetSignedUrls(needSign).then(() => {
        const updated: Record<string, string> = {};
        needSign.forEach(u => {
          const signed = getSignedUrlFromCache(u);
          if (signed && signed !== u) {
            updated[u] = signed;
          }
        });
        if (Object.keys(updated).length > 0) {
          setSignedUrls(prev => {
            const changed = Object.keys(updated).some(k => prev[k] !== updated[k]);
            return changed ? { ...prev, ...updated } : prev;
          });
        }
      }).catch(() => {});
    }
  }, [isOpen, mediaList]);

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

  const updateMediaOrder = (newList: ShotMedia[]) => {
    const updated = newList.map((m, idx) => ({ ...m, sortOrder: idx }));
    setMediaList(updated);
    saveMediaOrder(updated);
  };

  const saveMediaOrder = async (list: ShotMedia[]) => {
    const orders = list.map((m, idx) => ({ id: m.id, sortOrder: idx }));
    try {
      await fetch(`/api/shots/${shot.id}/media/sort`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: orders })
      });
      if (onMediaChange) {
        onMediaChange({ ...shot, media: list });
      }
    } catch (e) {
      console.error('保存排序失败:', e);
    }
  };

  // 移动端：上下移动按钮
  const moveMedia = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= mediaList.length) return;
    const newList = [...mediaList];
    [newList[index], newList[newIndex]] = [newList[newIndex], newList[index]];
    updateMediaOrder(newList);
  };

  // 电脑端：拖拽排序
  const handleMediaDragStart = (index: number, e: React.DragEvent) => {
    if (isMobile) return;
    setDraggingIndex(index);
    try {
      e.dataTransfer.effectAllowed = 'move';
    } catch (_) {}
  };

  const handleMediaDragOver = (index: number, e: React.DragEvent) => {
    if (isMobile || draggingIndex === null || draggingIndex === index) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(index);
  };

  const handleMediaDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleMediaDrop = (targetIndex: number) => {
    if (isMobile || draggingIndex === null || draggingIndex === targetIndex) {
      setDraggingIndex(null);
      setDragOverIndex(null);
      return;
    }
    const newList = [...mediaList];
    const [moved] = newList.splice(draggingIndex, 1);
    newList.splice(targetIndex, 0, moved);
    updateMediaOrder(newList);
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const deleteMedia = async (mediaId: number) => {
    try {
      const res = await fetch(`/api/shots/${shot.id}/media/${mediaId}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        showToast(data.message || '删除失败', 'error');
        return;
      }
      const newList = mediaList.filter(m => m.id !== mediaId);
      setMediaList(newList);
      if (onMediaChange) {
        onMediaChange({ ...shot, media: newList });
      }
      showToast('参考画面已删除', 'success');
    } catch (e) {
      console.error('删除媒体失败:', e);
      showToast('删除失败', 'error');
    }
  };

  // 关联媒体到分镜（调用后端 API 创建 shot-media 关联记录）
  const saveMediaToShot = async (url: string, type: 'image' | 'video', filename: string, source: ShotMedia['source'], ossKey?: string, fileSize?: number) => {
    try {
      console.log('[MediaManager] 保存媒体到分镜:', { url, type, filename, source, ossKey, fileSize, shotId: shot.id });

      const res = await fetch(`/api/shots/${shot.id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type, filename, source, ossKey, size: fileSize || 0 })
      });
      const data = await res.json();
      console.log('[MediaManager] 保存媒体响应:', data);

      if (data.success || data.id) {
        const newMedia: ShotMedia & { ossKey?: string } = {
          id: data.data?.id || data.id || Date.now(),
          shotId: shot.id,
          url,
          type,
          filename,
          size: fileSize || 0,
          sortOrder: mediaList.length,
          source,
          ossKey: ossKey || data.data?.ossKey,
          createdAt: new Date().toISOString()
        };
        const newList = [...mediaList, newMedia];
        setMediaList(newList);
        if (onMediaChange) {
          onMediaChange({ ...shot, media: newList });
        }
      } else {
        console.error('保存媒体失败:', data.message || '未知错误');
        // 关联失败，清理已上传的 OSS 文件避免残留
        if (url) {
          fetch('/api/oss/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [url] })
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('保存媒体失败:', e);
    }
  };

  // 统一上传：调用 useUnifiedUpload，上传完成后将结果关联到分镜
  const handleUpload = async () => {
    if (!shot.projectId) {
      showToast('缺少项目信息，无法上传', 'error');
      return;
    }
    // 防止重复点击导致重复上传
    if (uploadingRef.current) return;
    uploadingRef.current = true;

    try {
      const results = await startUpload({
        projectId: shot.projectId,
        sceneId: shot.sceneId,
        usage: 'shot-reference',
        accept: 'image/*,video/*',
        multiple: true,
        maxFiles: MAX_MEDIA_COUNT,
        currentCount: mediaList.length,
        createShot: false,
      });

      if (results.length > 0) {
        // 去重：按 URL 去重，防止同一文件产生重复结果
        const seenUrls = new Set<string>();
        const uniqueResults = results.filter(r => {
          if (seenUrls.has(r.url)) return false;
          seenUrls.add(r.url);
          return true;
        });

        // 将上传结果逐个关联到分镜
        for (const r of uniqueResults) {
          await saveMediaToShot(r.url, r.type, r.filename, 'upload', r.ossKey, r.size);
        }
        // 刷新列表确保 sortOrder 一致
        fetchMediaList();
        showToast(`已添加 ${uniqueResults.length} 个参考画面`, 'success');
      }
    } finally {
      uploadingRef.current = false;
    }
  };

  // P3-23：handleSceneRefSelect 已移除（场景参考图上传功能废弃）

  if (!isOpen) return null;

  return (
    <div className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-4 transition-opacity duration-200 flex items-center justify-center ${
      childDialogOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'
    }`} onClick={onClose}>
      <div
        className="w-full max-w-2xl w-[calc(100%-2rem)] max-h-[100dvh] sm:max-h-[85vh] rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">参考画面管理</h2>
          <button
            onClick={onClose}
            className="touch-target-36 w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Loading skeleton */}
          {mediaLoading && mediaList.length === 0 && (
            <div className="mb-6">
              <div className="grid grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="aspect-video rounded-xl bg-white/5 animate-pulse" />
                ))}
              </div>
            </div>
          )}

          {/* Media Grid */}
          {mediaList.length > 0 && (
            <div className="mb-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {mediaList.map((media, index) => {
                  const isDragging = draggingIndex === index;
                  const isDragOver = dragOverIndex === index;
                  return (
                    <div
                      key={media.id}
                      draggable={!isMobile}
                      onDragStart={(e) => handleMediaDragStart(index, e)}
                      onDragOver={(e) => handleMediaDragOver(index, e)}
                      onDragLeave={handleMediaDragLeave}
                      onDrop={() => handleMediaDrop(index)}
                      className={`relative rounded-xl border transition-all overflow-hidden ${
                        isDragging ? 'opacity-50 scale-95' : ''
                      } ${
                        isDragOver ? 'ring-2 ring-violet-400/70 scale-105' : 'border-white/10 hover:border-violet-400/30'
                      }`}
                    >
                      {/* Thumbnail */}
                      <div className="aspect-video bg-black/40 relative flex items-center justify-center">
                        <MediaThumb media={media} signedUrls={signedUrls} />

                        {/* Delete button - 始终可见（移动端也需要），尺寸增大以便于点击 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteMedia(media.id); }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-red-500/80 hover:bg-red-500 active:bg-red-600 flex items-center justify-center text-white shadow-md transition z-10"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>

                        {/* Source badge */}
                        {media.source === 'ai_generated' && (
                          <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-purple-500/80 text-white text-[10px]">
                            AI
                          </div>
                        )}

                        {/* Index number on thumbnail */}
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium">
                          {index + 1}
                        </div>

                        {/* 电脑端：拖拽手柄（左下角，避免与右上角删除按钮重叠） */}
                        {!isMobile && (
                          <div className="absolute bottom-1.5 left-1.5 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center cursor-grab active:cursor-grabbing transition z-10">
                            <GripVertical className="w-3.5 h-3.5 text-white/70" />
                          </div>
                        )}
                      </div>

                      {/* 移动端：上下移动按钮（替代拖拽排序） */}
                      {isMobile && (
                        <div className="flex items-center justify-between gap-1 px-1.5 py-1.5 bg-white/[0.02]">
                          <button
                            onClick={(e) => { e.stopPropagation(); moveMedia(index, -1); }}
                            disabled={index === 0}
                            className={`flex-1 inline-flex items-center justify-center gap-1 py-1 rounded text-[10px] transition ${
                              index === 0
                                ? 'text-slate-600 cursor-not-allowed'
                                : 'text-white/70 hover:bg-white/10 active:bg-white/15'
                            }`}
                            title="上移"
                          >
                            <ChevronUp className="w-3 h-3" />
                            <span>上移</span>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); moveMedia(index, 1); }}
                            disabled={index === mediaList.length - 1}
                            className={`flex-1 inline-flex items-center justify-center gap-1 py-1 rounded text-[10px] transition ${
                              index === mediaList.length - 1
                                ? 'text-slate-600 cursor-not-allowed'
                                : 'text-white/70 hover:bg-white/10 active:bg-white/15'
                            }`}
                            title="下移"
                          >
                            <ChevronDown className="w-3 h-3" />
                            <span>下移</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

              </div>
            </div>
          )}

          {/* Counter */}
          <div className="text-sm text-slate-400 mb-4">
            {mediaList.length}/{MAX_MEDIA_COUNT} 已添加
          </div>

          {/* 添加参考画面 */}
          <div className="mb-4">
            <p className="text-sm font-medium text-slate-300 mb-3">添加参考画面</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 上传方式 */}
              <div
                onClick={handleUpload}
                className="border-2 border-dashed rounded-2xl p-5 text-center cursor-pointer transition border-white/15 hover:border-violet-400/40 bg-white/[0.02] hover:bg-white/[0.04]"
              >
                <Upload className="w-7 h-7 mx-auto mb-1.5 text-white/40" />
                <p className="text-sm font-medium mb-0.5">上传</p>
                <p className="text-xs text-slate-500">点击选择文件</p>
              </div>

              {/* AI 生成方式 */}
              {onAiGenerate && (
                <button
                  onClick={() => onAiGenerate(shot)}
                  disabled={mediaList.length >= MAX_MEDIA_COUNT}
                  className={`border-2 border-dashed rounded-2xl p-5 text-center transition ${
                    mediaList.length >= MAX_MEDIA_COUNT
                      ? 'border-white/10 bg-white/[0.02] text-slate-600 cursor-not-allowed'
                      : 'border-pink-400/30 bg-pink-500/10 hover:bg-pink-500/20 text-pink-200 hover:border-pink-400/50'
                  }`}
                >
                  <Sparkles className={`w-7 h-7 mx-auto mb-1.5 ${mediaList.length >= MAX_MEDIA_COUNT ? 'text-slate-600' : ''}`} />
                  <p className="text-sm font-medium mb-0.5">AI 生成</p>
                  <p className="text-xs text-slate-500">
                    {mediaList.length >= MAX_MEDIA_COUNT ? '已达上限' : '智能生成参考画面'}
                  </p>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
