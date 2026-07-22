import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Upload, Sparkles, Image as ImageIcon, FileVideo, ChevronUp, ChevronDown, Trash2, GripVertical } from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import { uploadImage, uploadVideo, detectFileType, checkVideoBitrate, getVideoPoster, batchGetSignedUrls, getSignedUrlFromCache } from '../../lib/ossUtils';
import type { UploadDecision } from '../../lib/ossUtils';
import { VideoCompressionDialog } from './VideoCompressionDialog';
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

interface UploadingItem {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

// 统一缩略图组件：视频用封面图（img），图片直接用 img，避免 video 元素的请求中止问题
function MediaThumb({ media, signedUrls }: { media: ShotMedia; signedUrls: Record<string, string> }) {
  const [hasError, setHasError] = useState(false);
  const isVideo = media.type === 'video';

  const thumbUrl = isVideo && media.url
    ? getVideoPoster(media.url, media.startTime)
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
  const [mediaList, setMediaList] = useState<ShotMedia[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [uploadingFiles, setUploadingFiles] = useState<UploadingItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processedUrlsRef = useRef<Set<string>>(new Set());
  const { showToast } = useToastContext();

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // 用户主动关闭按钮
  const handleUserClose = () => {
    if (uploadingFiles.some(f => f.status === 'uploading')) {
      return;
    }
    onClose();
  };

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

  // 压缩选择对话框状态
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);
  const [pendingDecision, setPendingDecision] = useState<UploadDecision | null>(null);
  const [pendingIsSceneRef, setPendingIsSceneRef] = useState(false);
  const pendingBatchRef = useRef<{
    videos: { file: File; fileId: string }[];
    isSceneRef: boolean;
  } | null>(null);

  // 阿里云配置状态
  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  // 处理关闭（检查是否有正在上传的文件）
  const handleClose = () => {
    if (uploadingFiles.some(f => f.status === 'uploading')) {
      return;
    }
    // 意外关闭（X/ESC/点遮罩）保留缓存
    onClose();
  };

  // Escape 键关闭对话框（有文件上传时禁止关闭）
  useEscapeKey(handleClose, isOpen);

  useEffect(() => {
    fetch('/api/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

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

  const handleFileSelect = async (files: FileList | null, isSceneRef = false) => {
    if (!files || files.length === 0) return;

    const remaining = MAX_MEDIA_COUNT - mediaList.length;
    const validFilesAll = Array.from(files).filter(f => detectFileType(f).supported);

    if (validFilesAll.length === 0) {
      showToast('没有支持的文件格式', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    if (validFilesAll.length > remaining) {
      showToast(`选择了 ${validFilesAll.length} 个文件，最多还能添加 ${remaining} 个，请减少后重新选择`, 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const validFiles = validFilesAll;

    // 第一阶段：检测所有视频的码率，收集需要压缩的视频
    const initial: UploadingItem[] = validFiles.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
      name: f.name,
      progress: 5,
      status: 'uploading' as const
    }));
    setUploadingFiles(prev => [...prev, ...initial]);

    const toUpload: { file: File; type: 'image' | 'video'; fileId: string; compression: 'none' | 'server' | 'browser' | 'aliyun' }[] = [];
    const videosToCompress: { file: File; fileId: string; decision: Awaited<ReturnType<typeof checkVideoBitrate>> }[] = [];

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      const detected = detectFileType(file);
      const fileId = initial[i].id;
      const fileType = detected.type as 'image' | 'video';

      if (fileType === 'video') {
        setUploadingFiles(prev => prev.map(uf =>
          uf.id === fileId ? { ...uf, progress: 5, message: '检测视频信息...' } : uf
        ));
        const decision = await checkVideoBitrate(file);
        if (decision.decision === 'must_compress') {
          videosToCompress.push({ file, fileId, decision });
          setUploadingFiles(prev => prev.map(uf =>
            uf.id === fileId ? { ...uf, status: 'pending', progress: 0, message: '等待压缩方式选择' } : uf
          ));
        } else {
          toUpload.push({ file, type: 'video', fileId, compression: 'none' });
        }
      } else {
        toUpload.push({ file, type: 'image', fileId, compression: 'none' });
      }
    }

    // 先上传不需要压缩的文件
    for (const item of toUpload) {
      await doUploadFile(item.file, item.type, item.fileId, isSceneRef, item.compression);
    }

    // 如果有需要压缩的视频，弹出对话框（一次选择，所有视频共用）
    if (videosToCompress.length > 0) {
      pendingBatchRef.current = { videos: videosToCompress, isSceneRef };
      setPendingVideo(videosToCompress[0].file);
      setPendingDecision(videosToCompress[0].decision);
      setPendingIsSceneRef(isSceneRef);
    }
  };

  const doUploadFile = async (
    file: File,
    fileType: 'image' | 'video',
    fileId: string,
    isSceneRef: boolean,
    compressionMethod: 'server' | 'browser' | 'aliyun' | 'none'
  ) => {
    try {
      setUploadingFiles(prev => prev.map(uf =>
        uf.id === fileId ? { ...uf, status: 'uploading', progress: 10, message: '准备上传...' } : uf
      ));

      let result: { url: string; id?: number; filename?: string; ossKey?: string; compressedSizeKB?: number; originalSizeKB?: number };
      if (fileType === 'image') {
        result = await uploadImage(file, {
          projectId: shot.projectId,
          usage: 'shot-reference',
          onProgress: p => {
            setUploadingFiles(prev => prev.map(uf =>
              uf.id === fileId ? { ...uf, progress: p.progress, message: p.message } : uf
            ));
          }
        });
      } else {
        result = await uploadVideo(file, {
          projectId: shot.projectId,
          usage: 'shot-reference',
          compressionMethod,
          skipBitrateCheck: true,
          onProgress: p => {
            setUploadingFiles(prev => prev.map(uf =>
              uf.id === fileId ? { ...uf, progress: p.progress, message: p.message } : uf
            ));
          }
        });
      }

      console.log('[MediaManager] 上传成功:', { url: result.url, ossKey: result.ossKey, filename: result.filename, compressedSizeKB: result.compressedSizeKB });

      setUploadingFiles(prev => prev.map(uf =>
        uf.id === fileId ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf
      ));

      const fileSize = result.compressedSizeKB
        ? Math.round(result.compressedSizeKB * 1024)
        : file.size;

      await saveMediaToShot(result.url, fileType, file.name, isSceneRef ? 'video_split' : 'upload', result.ossKey, fileSize);
    } catch (err) {
      console.error('上传失败:', file.name, err);
      setUploadingFiles(prev => prev.map(uf =>
        uf.id === fileId ? { ...uf, status: 'error', message: (err as Error).message } : uf
      ));
    }
  };

  const handleCompressionSelect = async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    if (!pendingVideo || !pendingDecision) {
      setPendingVideo(null);
      setPendingDecision(null);
      setPendingIsSceneRef(false);
      pendingBatchRef.current = null;
      return;
    }

    const batch = pendingBatchRef.current;
    const isSceneRef = pendingIsSceneRef;

    setPendingVideo(null);
    setPendingDecision(null);
    setPendingIsSceneRef(false);
    pendingBatchRef.current = null;

    const videos = batch?.videos || [];

    if (method === 'cancel') {
      // 取消时移除所有等待压缩的进度条
      const pendingIds = new Set(videos.map(v => v.fileId));
      if (pendingIds.size > 0) {
        setUploadingFiles(prev => prev.filter(uf => !pendingIds.has(uf.id)));
      }
      return;
    }

    // 批量上传所有需要压缩的视频
    for (const { file, fileId } of videos) {
      await doUploadFile(file, 'video', fileId, isSceneRef, method);
    }
  };

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
      }
    } catch (e) {
      console.error('保存媒体失败:', e);
    }
  };

  const handleDropZone = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  // P3-23：handleSceneRefSelect 已移除（场景参考图上传功能废弃）

  if (!isOpen) return null;

  return (
    <div className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-0 sm:p-4 transition-opacity duration-200 ${
      childDialogOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'
    }`} onClick={handleClose}>
      <div
        className="absolute inset-x-0 top-0 bottom-0 sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 w-full sm:max-w-2xl sm:w-[calc(100%-2rem)] max-h-[100dvh] sm:max-h-[85vh] sm:rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">参考画面管理</h2>
          <button
            onClick={handleClose}
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

                        {/* 电脑端：拖拽手柄 */}
                        {!isMobile && (
                          <div className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center cursor-grab active:cursor-grabbing transition z-10">
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
                onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDropZone}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-5 text-center cursor-pointer transition ${
                  isDragOver
                    ? 'border-violet-400 bg-violet-500/10'
                    : 'border-white/15 hover:border-violet-400/40 bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
              >
                <Upload className={`w-7 h-7 mx-auto mb-1.5 ${isDragOver ? 'text-violet-400' : 'text-white/40'}`} />
                <p className="text-sm font-medium mb-0.5">上传</p>
                <p className="text-xs text-slate-500">点击或拖拽文件</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={e => handleFileSelect(e.target.files)}
                />
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

          {/* Upload progress */}
          {uploadingFiles.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="text-xs text-slate-400">上传进度</p>
              {uploadingFiles.map(f => (
                <div key={f.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-200 truncate">{f.name}</div>
                    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2">
                      <div
                        className={`h-full rounded-full transition-all ${
                          f.status === 'error' ? 'bg-red-400' : f.status === 'done' ? 'bg-green-400' : 'bg-gradient-to-r from-violet-500 to-fuchsia-500'
                        }`}
                        style={{ width: `${f.progress}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-right">
                    {f.status === 'error' ? (
                      <span className="text-red-300">{f.message || '失败'}</span>
                    ) : (
                      <span className="text-slate-300">{f.message || `${f.progress}%`}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end">
          <button
            onClick={handleUserClose}
            className="px-5 py-2 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            关闭
          </button>
        </div>
      </div>

      <VideoCompressionDialog
        isOpen={pendingVideo !== null}
        onClose={() => { setPendingVideo(null); setPendingDecision(null); setPendingIsSceneRef(false); pendingBatchRef.current = null; }}
        file={pendingVideo}
        decision={pendingDecision}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionSelect}
      />
    </div>
  );
}
