import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Upload, GripVertical, Sparkles, Image as ImageIcon, FileVideo } from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import { uploadVideo2Image, uploadVideo2Video, detectFileType, getOssProxyUrl, checkVideoBitrate } from '../../lib/ossUtils';
import type { UploadDecision } from '../../lib/ossUtils';
import { VideoCompressionDialog } from '../VideoCompressionDialog';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface MediaManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shot: Shot;
  onMediaChange?: (shot: Shot) => void;
  onAiGenerate?: (shot: Shot) => void;
}

const MAX_MEDIA_COUNT = 10;

interface UploadingItem {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

function ImageWrapper({ url, alt, ossKey }: { url: string; alt: string; ossKey?: string }) {
  const [hasError, setHasError] = useState(false);
  const proxyUrl = getOssProxyUrl(url, ossKey);
  
  if (hasError) {
    return <ImageIcon className="w-8 h-8 text-white/30" />;
  }
  return (
    <img
      src={proxyUrl}
      alt={alt}
      className="w-full h-full object-cover absolute inset-0"
      onError={(e) => {
        console.error('[MediaManager] 图片加载失败:', { url, proxyUrl, ossKey, alt });
        setHasError(true);
      }}
    />
  );
}

export default function MediaManagerDialog({
  isOpen,
  onClose,
  shot,
  onMediaChange,
  onAiGenerate
}: MediaManagerDialogProps) {
  const [mediaList, setMediaList] = useState<ShotMedia[]>(shot?.media || []);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingItem[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneRefInputRef = useRef<HTMLInputElement>(null);

  // 压缩选择对话框状态
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);
  const [pendingDecision, setPendingDecision] = useState<UploadDecision | null>(null);
  const [pendingIsSceneRef, setPendingIsSceneRef] = useState(false);
  const pendingUploadRef = useRef<{ file: File; isSceneRef: boolean } | null>(null);

  // 阿里云配置状态
  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  // 处理关闭（检查是否有正在上传的文件）
  const handleClose = () => {
    if (uploadingFiles.some(f => f.status === 'uploading')) {
      return;
    }
    onClose();
  };

  // Escape 键关闭对话框（有文件上传时禁止关闭）
  useEscapeKey(handleClose, isOpen);

  useEffect(() => {
    fetch('/api/video2/aliyun/status')
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
      await fetch(`/api/video2/shots/${shot.id}/media/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders })
      });
      if (onMediaChange) {
        onMediaChange({ ...shot, media: list });
      }
    } catch (e) {
      console.error('保存排序失败:', e);
    }
  };

  const deleteMedia = async (mediaId: number) => {
    try {
      await fetch(`/api/video2/shots/${shot.id}/media/${mediaId}`, {
        method: 'DELETE'
      });
      const newList = mediaList.filter(m => m.id !== mediaId);
      setMediaList(newList);
      if (onMediaChange) {
        onMediaChange({ ...shot, media: newList });
      }
    } catch (e) {
      console.error('删除媒体失败:', e);
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const newList = [...mediaList];
    const [moved] = newList.splice(dragIndex, 1);
    newList.splice(targetIndex, 0, moved);
    updateMediaOrder(newList);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleFileSelect = async (files: FileList | null, isSceneRef = false) => {
    if (!files || files.length === 0) return;

    const remaining = MAX_MEDIA_COUNT - mediaList.length;
    if (remaining <= 0) {
      alert(`最多只能添加 ${MAX_MEDIA_COUNT} 个参考画面`);
      return;
    }

    const fileArray = Array.from(files).slice(0, remaining);
    const validFiles = fileArray.filter(f => {
      const d = detectFileType(f);
      if (!d.supported) {
        console.warn(`不支持的文件: ${f.name}`);
      }
      return d.supported;
    });

    if (validFiles.length === 0) return;

    const initial: UploadingItem[] = validFiles.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
      name: f.name,
      progress: 5,
      status: 'uploading' as const
    }));
    setUploadingFiles(prev => [...prev, ...initial]);

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      const detected = detectFileType(file);
      const fileId = initial[i].id;

      if (!detected.supported || detected.type === 'unknown') {
        setUploadingFiles(prev => prev.map(uf =>
          uf.id === fileId ? { ...uf, status: 'error', message: '不支持的文件格式' } : uf
        ));
        continue;
      }

      const fileType = detected.type as 'image' | 'video';

      if (fileType === 'video') {
        setUploadingFiles(prev => prev.map(uf =>
          uf.id === fileId ? { ...uf, progress: 5, message: '检测视频信息...' } : uf
        ));
        const decision = await checkVideoBitrate(file);
        if (decision.decision === 'must_compress') {
          setUploadingFiles(prev => prev.map(uf =>
            uf.id === fileId ? { ...uf, status: 'error', progress: 0, message: '需选择压缩方式' } : uf
          ));
          pendingUploadRef.current = { file, isSceneRef };
          setPendingVideo(file);
          setPendingDecision(decision);
          setPendingIsSceneRef(isSceneRef);
          continue;
        }
      }

      await doUploadFile(file, fileType, fileId, isSceneRef, 'none');
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

      let result: { url: string; id?: number; filename?: string; ossKey?: string };
      if (fileType === 'image') {
        result = await uploadVideo2Image(file, {
          projectId: shot.projectId,
          reference: !isSceneRef,
          onProgress: p => {
            setUploadingFiles(prev => prev.map(uf =>
              uf.id === fileId ? { ...uf, progress: p.progress, message: p.message } : uf
            ));
          }
        });
      } else {
        result = await uploadVideo2Video(file, {
          projectId: shot.projectId,
          reference: !isSceneRef,
          compressionMethod,
          skipBitrateCheck: true,
          onProgress: p => {
            setUploadingFiles(prev => prev.map(uf =>
              uf.id === fileId ? { ...uf, progress: p.progress, message: p.message } : uf
            ));
          }
        });
      }

      console.log('[MediaManager] 上传成功:', { url: result.url, ossKey: result.ossKey, filename: result.filename });

      setUploadingFiles(prev => prev.map(uf =>
        uf.id === fileId ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf
      ));

      await saveMediaToShot(result.url, fileType, file.name, isSceneRef ? 'video_split' : 'upload', result.ossKey);
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
      return;
    }

    if (method === 'cancel') {
      setPendingVideo(null);
      setPendingDecision(null);
      return;
    }

    const file = pendingVideo;
    const isSceneRef = pendingIsSceneRef;
    const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

    setPendingVideo(null);
    setPendingDecision(null);

    setUploadingFiles(prev => [...prev, {
      id: fileId,
      name: file.name,
      progress: 10,
      status: 'uploading',
      message: '准备上传...'
    }]);

    await doUploadFile(file, 'video', fileId, isSceneRef, method);
  };

  const saveMediaToShot = async (url: string, type: 'image' | 'video', filename: string, source: ShotMedia['source'], ossKey?: string) => {
    try {
      console.log('[MediaManager] 保存媒体到分镜:', { url, type, filename, source, ossKey, shotId: shot.id });
      
      const res = await fetch(`/api/video2/shots/${shot.id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type, filename, source, ossKey })
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
          size: 0,
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

  const handleSceneRefSelect = (files: FileList | null) => {
    handleFileSelect(files, true);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-4" onClick={handleClose}>
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">参考画面管理</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Media Grid */}
          {mediaList.length > 0 && (
            <div className="mb-6">
              <div className="grid grid-cols-4 gap-3">
                {mediaList.map((media, index) => {
                  const isDragging = dragIndex === index;
                  const isDragOver = dragOverIndex === index;
                  return (
                    <div
                      key={media.id}
                      draggable
                      onDragStart={e => handleDragStart(e, index)}
                      onDragOver={e => handleDragOver(e, index)}
                      onDrop={e => handleDrop(e, index)}
                      onDragEnd={handleDragEnd}
                      className={`relative rounded-xl border overflow-hidden transition-all ${
                        isDragging
                          ? 'opacity-40 border-violet-400/60 ring-2 ring-violet-400/40'
                          : isDragOver
                          ? 'ring-2 ring-violet-400/60 border-violet-400/50 -translate-y-0.5'
                          : 'border-white/10 hover:border-violet-400/30'
                      }`}
                    >
                      {/* Thumbnail */}
                      <div className="aspect-video bg-black/40 relative flex items-center justify-center">
                        {media.type === 'image' ? (
                          <ImageWrapper url={media.url} alt={media.filename} ossKey={(media as any).ossKey} />
                        ) : (
                          <>
                            <video
                              src={getOssProxyUrl(media.url, (media as any).ossKey)}
                              className="w-full h-full object-cover"
                              muted
                              preload="metadata"
                            />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                              <FileVideo className="w-6 h-6 text-white/70" />
                            </div>
                          </>
                        )}

                        {/* Delete button */}
                        <button
                          onClick={() => deleteMedia(media.id)}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white/80 hover:text-white transition text-xs"
                          title="删除"
                        >
                          <X className="w-3 h-3" />
                        </button>

                        {/* Source badge */}
                        {media.source === 'ai_generated' && (
                          <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-purple-500/80 text-white text-[10px]">
                            AI
                          </div>
                        )}
                      </div>

                      {/* Index number and drag handle */}
                      <div className="px-2 py-1.5 flex items-center gap-1.5 bg-white/[0.02]">
                        <div
                          draggable
                          className="text-white/40 hover:text-white cursor-grab active:cursor-grabbing"
                          title="拖拽排序"
                        >
                          <GripVertical className="w-3.5 h-3.5" />
                        </div>
                        <span className="text-xs text-white/60">{index + 1}</span>
                      </div>
                    </div>
                  );
                })}

                {/* Add button placeholder when under limit */}
                {mediaList.length < MAX_MEDIA_COUNT && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-video rounded-xl border-2 border-dashed border-white/15 hover:border-violet-400/40 flex flex-col items-center justify-center gap-1.5 transition bg-white/[0.02] hover:bg-violet-500/5"
                  >
                    <Plus className="w-5 h-5 text-white/40" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Counter */}
          <div className="text-sm text-slate-400 mb-4">
            {mediaList.length}/{MAX_MEDIA_COUNT} 已添加
          </div>

          {/* Upload zone */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDropZone}
            onClick={() => fileInputRef.current?.click()}
            className={`mb-4 border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition ${
              isDragOver
                ? 'border-violet-400 bg-violet-500/10'
                : 'border-white/15 hover:border-violet-400/40 bg-white/[0.02] hover:bg-white/[0.04]'
            }`}
          >
            <Upload className={`w-8 h-8 mx-auto mb-2 ${isDragOver ? 'text-violet-400' : 'text-white/40'}`} />
            <p className="text-sm font-medium mb-1">上传参考画面</p>
            <p className="text-xs text-slate-500">点击或拖拽文件到此处（图片或视频）</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*"
              className="hidden"
              onChange={e => handleFileSelect(e.target.files)}
            />
          </div>

          {/* Scene reference upload */}
          <div
            onClick={() => sceneRefInputRef.current?.click()}
            className="mb-4 border border-white/10 rounded-2xl p-4 text-center cursor-pointer transition bg-white/[0.02] hover:bg-white/[0.04]"
          >
            <div className="flex items-center justify-center gap-2 mb-1">
              <ImageIcon className="w-5 h-5 text-white/50" />
              <p className="text-sm font-medium">上传场景参考图</p>
            </div>
            <p className="text-xs text-slate-500">用于 AI 生图时的场景参考（不影响镜头参考画面数量）</p>
            <input
              ref={sceneRefInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={e => handleSceneRefSelect(e.target.files)}
            />
          </div>

          {/* AI Generate button */}
          {onAiGenerate && (
            <button
              onClick={() => onAiGenerate(shot)}
              className="w-full py-3 rounded-2xl border border-dashed border-yellow-400/30 bg-yellow-500/10 hover:bg-yellow-500/20 transition flex items-center justify-center gap-2 text-yellow-200"
            >
              <Sparkles className="w-5 h-5" />
              <span className="font-medium">AI 生成参考画面</span>
            </button>
          )}

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
            onClick={handleClose}
            className="px-5 py-2 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            关闭
          </button>
        </div>
      </div>

      <VideoCompressionDialog
        isOpen={pendingVideo !== null}
        onClose={() => { setPendingVideo(null); setPendingDecision(null); }}
        file={pendingVideo}
        decision={pendingDecision}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionSelect}
      />
    </div>
  );
}
