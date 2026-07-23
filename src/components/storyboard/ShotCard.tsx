import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Check,
  ChevronUp,
  ChevronDown,
  Trash2,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Play,
  Upload,
  Sparkles,
  Image as ImageIcon,
  Scissors,
  GripVertical,
  X,
  Info,
  RotateCcw
} from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import AnalyzeShotDialog from '../ai/AnalyzeShotDialog';
import { getVideoPoster } from '../../lib/ossUtils';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useUnifiedUpload } from '../../hooks/useUnifiedUpload';

interface FieldSuggestions {
  location: string[];
  actors: string[];
  costume: string[];
  props: string[];
  shotType: string[];
  focalLength: string[];
  shotAngle: string[];
  lighting: string[];
  cameraMovement: string[];
}

interface ShotCardProps {
  shot: Shot;
  projectId?: number;
  fieldSuggestions?: FieldSuggestions;
  isSelected?: boolean;
  highlighted?: boolean;
  onSelect?: (shot: Shot) => void;
  onUpdate?: (id: number, fields: Partial<Shot>) => void;
  onDelete?: (id: number) => void;
  onHardDelete?: (id: number) => void;
  onRestore?: (id: number) => void;
  onSort?: (id: number, direction: 'up' | 'down') => void;
  onExpand?: (id: number) => void;
  isExpanded?: boolean;
  onManageMedia?: (shot: Shot) => void;
  onUploadMedia?: (shot: Shot) => void;
  onAiGenerate?: (shot: Shot) => void;
  onSplitVideo?: (shot: Shot) => void;
  onFullscreen?: (media: ShotMedia) => void;
  isFirst?: boolean;
  isLast?: boolean;
  index?: number;
  isMobile?: boolean;
  currentTab?: 'pending' | 'done' | 'trash';
  // P4-1：搜索状态下禁用拖拽，手柄显示禁用样式
  dragDisabled?: boolean;
  onStatusClick?: (shot: Shot) => void;
  onShotNoClick?: (shot: Shot) => void;
  onDragHandleMouseDown?: () => void;
  onVideoPlay?: (shotId: number, mediaId: number) => void;
  onVideoPause?: (shotId: number, mediaId: number) => void;
  playingVideoKey?: string;
  onVideoRefReady?: (key: string, ref: HTMLVideoElement | null) => void;
  onDeleteMedia?: (shotId: number, mediaId: number) => void;
  onOpenSettings?: () => void;
  // P3-4：上传失败等提示改用 toast 而非 alert
  onShowToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  // 父级批量签名后的媒体 URL（参考项目列表页模式）
  signedMediaUrls?: Record<string, string>;
}

const SHOT_TYPES = ['大远景', '远景', '全景', '中景', '中近景', '近景', '特写', '大特写'];
const SHOT_ANGLES = ['平拍', '俯拍', '仰拍', '正拍', '侧拍', '反打', '鸟瞰', '主观视角', '客观视角'];
const CAMERA_MOVEMENTS = ['固定', '推', '拉', '摇', '移', '跟', '升降', '旋转', '环绕', '变焦', '手持', '甩'];

// 行内下拉选择字段组件
interface InlineSelectFieldProps {
  label: string;
  value: string;
  options: string[];
  onSave: (value: string) => void;
  placeholder?: string;
}

function InlineSelectField({ label, value, options, onSave, placeholder = '请选择' }: InlineSelectFieldProps) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-slate-400 shrink-0">{label}：</span>
      <select
        value={value}
        onChange={(e) => onSave(e.target.value)}
        className="flex-1 min-w-0 px-1 py-0.5 text-xs leading-tight bg-white/10 border border-white/10 rounded outline-none focus:border-violet-400 min-h-5 text-white/90 cursor-pointer"
      >
        <option value="" className="bg-slate-900 text-white/50">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option} className="bg-slate-900 text-white/90">
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

// 行内编辑字段组件
interface InlineEditFieldProps {
  label: string;
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  hideLabel?: boolean;
  suggestions?: string[];
  enableAutocomplete?: boolean;
  inputType?: 'text' | 'number';
  datalistId?: string;
  placeholder?: string;
}

function InlineEditField({ label, value, onSave, multiline = false, hideLabel = false, suggestions = [], enableAutocomplete = true, inputType = 'text', datalistId, placeholder }: InlineEditFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shouldShowAutocomplete = enableAutocomplete && label !== '旁白' && label !== '备注' && suggestions.length > 0;

  useEffect(() => {
    if (!isEditing && !isExpanded) {
      setEditValue(value);
    }
  }, [value, isEditing, isExpanded]);

  const handleSave = useCallback(() => {
    onSave(editValue.trim());
    setIsEditing(false);
    setIsExpanded(false);
  }, [editValue, onSave]);

  const handleCancel = useCallback(() => {
    setEditValue(value);
    setIsEditing(false);
    setIsExpanded(false);
  }, [value]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (multiline) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    } else {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    }
  }, [handleSave, handleCancel, multiline]);

  // 展开编辑弹窗
  useEscapeKey(() => {
    if (isExpanded) handleCancel();
  }, isExpanded);

  if (isExpanded && multiline) {
    return (
      <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4" onClick={handleCancel}>
        <div className="absolute inset-x-0 top-0 bottom-0 sm:w-[calc(100%-2rem)] sm:max-w-2xl bg-slate-900/95 backdrop-blur-xl sm:rounded-2xl rounded-none border border-white/10 flex flex-col shadow-2xl max-h-[100dvh] sm:max-h-[85vh]" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
            <h3 className="text-sm font-medium text-white">{label}</h3>
            <button
              onClick={handleCancel}
              className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 p-4 overflow-hidden">
            <textarea
              ref={expandedTextareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder={`请输入${label}...`}
              className="w-full h-full min-h-[300px] px-4 py-3 text-sm bg-white/5 border border-white/10 rounded-xl outline-none focus:border-violet-400/50 resize-none text-white/90 leading-relaxed"
            />
          </div>
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/10 shrink-0">
            <span className="text-xs text-slate-500">Ctrl/Cmd + Enter 保存 · Esc 取消</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-white/10 transition"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-1.5 rounded-lg text-xs bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white font-medium hover:shadow-lg hover:shadow-violet-500/30 transition"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className={`${hideLabel ? '' : 'gap-1.5'} flex items-center min-h-5`}>
        {!hideLabel && <span className="text-xs text-slate-400 shrink-0">{label}：</span>}
        {multiline ? (
          <div className="flex-1 min-w-0 relative flex items-center">
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              autoFocus
              rows={1}
              className="flex-1 w-full min-w-0 px-1 text-xs leading-tight bg-white/10 border border-violet-400/50 rounded outline-none focus:border-violet-400 resize-none min-h-5"
            />
          </div>
        ) : (
          <div className="flex-1 min-w-0 relative">
            <input
              ref={inputRef}
              type={inputType}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              list={shouldShowAutocomplete && datalistId ? datalistId : undefined}
              autoFocus
              className="flex-1 min-w-0 px-1 text-xs leading-tight bg-white/10 border border-violet-400/50 rounded outline-none focus:border-violet-400 min-h-5 w-full"
            />
            {shouldShowAutocomplete && datalistId && (
              <datalist id={datalistId}>
                {suggestions.map((s, i) => (
                  <option key={i} value={s} />
                ))}
              </datalist>
            )}
          </div>
        )}
      </div>
    );
  }

  const hasLongContent = multiline && value && value.length > 30;

  return (
    <div
      className={`${hideLabel ? '' : 'gap-1.5'} cursor-pointer hover:bg-white/5 rounded px-1 py-0.5 -mx-1 transition flex items-center min-w-0`}
      onClick={() => setIsEditing(true)}
    >
      {!hideLabel && <span className="text-xs text-slate-400 shrink-0">{label}：</span>}
      <span className={`text-xs text-white/90 flex-1 min-w-0 truncate`}>
        {value || <span className="text-slate-500 italic">{placeholder || '点击编辑'}</span>}
      </span>
      {hasLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(value);
            setIsExpanded(true);
          }}
          className="shrink-0 w-5 h-5 rounded hover:bg-white/10 flex items-center justify-center text-slate-500 hover:text-violet-300 transition"
          title="展开编辑"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export function ShotCard({
  shot,
  projectId,
  fieldSuggestions,
  isSelected = false,
  highlighted = false,
  onSelect,
  onUpdate,
  onDelete,
  onHardDelete,
  onRestore,
  onSort,
  onExpand,
  isExpanded = false,
  onManageMedia,
  onUploadMedia,
  onAiGenerate,
  onSplitVideo,
  onFullscreen,
  isFirst = false,
  isLast = false,
  index = 0,
  isMobile = false,
  currentTab = 'pending',
  dragDisabled = false,
  onStatusClick,
  onShotNoClick,
  onDragHandleMouseDown,
  onVideoPlay,
  onVideoPause,
  playingVideoKey,
  onVideoRefReady,
  onDeleteMedia,
  onOpenSettings,
  onShowToast,
  signedMediaUrls,
}: ShotCardProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [bufferProgress, setBufferProgress] = useState(0);
  const [imgError, setImgError] = useState(false);
  const [posterRetryCount, setPosterRetryCount] = useState(0);
  const [showMergedFrom, setShowMergedFrom] = useState(false);
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showAnalyzeDialog, setShowAnalyzeDialog] = useState(false);

  const { startUpload } = useUnifiedUpload();
  
  const media = shot.media || [];
  const currentMedia = media[currentIndex];
  const isVideo = currentMedia?.type === 'video';
  const videoKey = `${shot.id}-${currentMedia?.id}`;
  const isThisVideoPlaying = playingVideoKey === videoKey;

  // 从父级传入的批量签名结果中获取签名 URL（参考项目列表页模式）
  const mediaUrl = currentMedia?.url || '';
  const posterUrl = isVideo ? getVideoPoster(mediaUrl, currentMedia?.startTime) : '';
  const signedMediaUrl = signedMediaUrls?.[mediaUrl] || mediaUrl;
  // poster URL 现在使用后端代理 /api/oss-snapshot，不需要 OSS 签名
  const signedPosterUrl = posterUrl;
  const mediaReady = !!mediaUrl && signedMediaUrl !== mediaUrl;
  const posterReady = !!posterUrl;

  // 媒体切换时重置错误和播放状态
  useEffect(() => {
    // 切换 media 前先清理 video 元素
    if (videoRef.current) {
      try {
        videoRef.current.pause();
      } catch (e) {}
    }
    setImgError(false);
    setPosterRetryCount(0);
    setShouldLoadVideo(false);
  }, [currentIndex, currentMedia?.id]);

  useEffect(() => {
    if (onVideoRefReady && videoRef.current) {
      onVideoRefReady(videoKey, videoRef.current);
    }
    return () => {
      if (onVideoRefReady) {
        onVideoRefReady(videoKey, null);
      }
    };
  }, [videoKey, onVideoRefReady, shouldLoadVideo]);

  useEffect(() => {
    return () => {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          // 不再调用 load()，避免触发空 src 的 abort
        } catch (e) {
          // 忽略清理时的错误
        }
      }
    };
  }, []);

  const handleFieldUpdate = useCallback((field: keyof Shot, value: string) => {
    onUpdate?.(shot.id, { [field]: value });
  }, [shot.id, onUpdate]);

  // AI分析分镜画面内容
  const handleAnalyzeShot = useCallback(() => {
    if (currentMedia) {
      setShowAnalyzeDialog(true);
    }
  }, [currentMedia]);

  // 通过统一上传模块上传文件并关联到分镜
  const handleUploadClick = useCallback(async () => {
    if (!projectId) return;

    const results = await startUpload({
      projectId,
      sceneId: shot.sceneId,
      usage: 'shot-reference',
      accept: 'image/*,video/*',
      multiple: true,
      maxFiles: 10,
      currentCount: media.length,
      createShot: false,
    });

    if (results.length === 0) return;

    for (const result of results) {
      const fileSize = result.compressedSizeKB
        ? Math.round(result.compressedSizeKB * 1024)
        : result.size;

      // 调用后端API关联媒体到分镜
      const res = await fetch(`/api/shots/${shot.id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: result.url,
          type: result.type,
          filename: result.filename,
          source: 'upload',
          ossKey: result.ossKey,
          size: fileSize,
        })
      });

      const data = await res.json();
      if (data.success || data.id) {
        const newMedia: ShotMedia = {
          id: data.data?.id || data.id || Date.now(),
          shotId: shot.id,
          url: result.url,
          type: result.type,
          filename: result.filename,
          size: fileSize,
          sortOrder: media.length + results.indexOf(result),
          source: 'upload',
          ossKey: result.ossKey,
          createdAt: new Date().toISOString()
        };

        onUpdate?.(shot.id, { media: [...media, newMedia] });
      } else {
        // 关联失败，清理已上传的 OSS 文件避免残留
        if (result.url) {
          fetch('/api/oss/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [result.url] })
          }).catch(() => {});
        }
        throw new Error(data.message || '保存失败');
      }
    }
  }, [shot.id, shot.sceneId, projectId, media, onUpdate, onShowToast, startUpload]);

  const handlePlayVideo = useCallback(() => {
    if (!shouldLoadVideo) {
      setShouldLoadVideo(true);
    }
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.play().catch(() => {});
      }
    }, 0);
  }, [shouldLoadVideo]);

  const handlePauseVideo = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
  }, []);

  const handleTogglePlay = useCallback(() => {
    if (isThisVideoPlaying) {
      handlePauseVideo();
    } else {
      handlePlayVideo();
    }
  }, [isThisVideoPlaying, handlePlayVideo, handlePauseVideo]);

  const handleVideoPlay = useCallback(() => {
    setIsVideoPlaying(true);
    onVideoPlay?.(shot.id, currentMedia?.id);
  }, [shot.id, currentMedia?.id, onVideoPlay]);

  const handleVideoPause = useCallback(() => {
    setIsVideoPlaying(false);
    onVideoPause?.(shot.id, currentMedia?.id);
  }, [shot.id, currentMedia?.id, onVideoPause]);

  const handleVideoWaiting = useCallback(() => {
    setIsVideoLoading(true);
  }, []);

  const handleVideoCanPlay = useCallback(() => {
    setIsVideoLoading(false);
  }, []);

  const handleVideoProgress = useCallback(() => {
    if (videoRef.current && videoRef.current.buffered.length > 0) {
      const bufferedEnd = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
      const duration = videoRef.current.duration;
      if (duration > 0) {
        setBufferProgress((bufferedEnd / duration) * 100);
      }
    }
  }, []);

  const handleVideoLoadedMetadata = useCallback(() => {
    if (videoRef.current && currentMedia?.startTime !== undefined && currentMedia.startTime > 0) {
      videoRef.current.currentTime = currentMedia.startTime;
    }
  }, [currentMedia?.startTime]);

  const handleVideoTimeUpdate = useCallback(() => {
    if (!videoRef.current || currentMedia?.startTime === undefined) return;
    const startTime = currentMedia.startTime || 0;
    const segmentDuration = currentMedia.duration || 0;
    if (segmentDuration > 0) {
      const endTime = startTime + segmentDuration;
      if (videoRef.current.currentTime >= endTime - 0.1) {
        videoRef.current.currentTime = startTime;
        if (!videoRef.current.paused) {
          videoRef.current.play().catch(() => {});
        }
      }
    }
  }, [currentMedia?.startTime, currentMedia?.duration]);

  const handleFullscreen = useCallback((mediaItem: ShotMedia) => {
    handlePauseVideo();
    onFullscreen?.(mediaItem);
  }, [onFullscreen, handlePauseVideo]);

  const handlePrevMedia = useCallback(() => {
    handlePauseVideo();
    setImgError(false);
    setShouldLoadVideo(false);
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : media.length - 1));
  }, [media.length, handlePauseVideo]);

  const handleNextMedia = useCallback(() => {
    handlePauseVideo();
    setImgError(false);
    setShouldLoadVideo(false);
    setCurrentIndex((prev) => (prev < media.length - 1 ? prev + 1 : 0));
  }, [media.length, handlePauseVideo]);

  const hasMedia = media.length > 0;



  useEffect(() => {
    if (playingVideoKey && playingVideoKey !== videoKey && isVideoPlaying) {
      handlePauseVideo();
    }
  }, [playingVideoKey, videoKey, isVideoPlaying, handlePauseVideo]);

  useEffect(() => {
    handlePauseVideo();
    setIsVideoPlaying(false);
    setBufferProgress(0);
    setShouldLoadVideo(false);
  }, [currentIndex, handlePauseVideo]);

  return (
    <>
      <div
        id={`shot-card-${shot.id}`}
      className={`relative rounded-2xl border overflow-hidden transition-all ${
        highlighted
          ? 'ring-2 ring-violet-400 ring-offset-2 ring-offset-slate-900 border-violet-400/60'
          : isSelected
            ? 'border-violet-400/60 ring-2 ring-violet-400/30 bg-white/[0.05]'
            : 'border-white/10 bg-white/[0.03] hover:border-violet-400/30'
      }`}
    >
      {/* 顶部媒体区域 */}
      <div className="relative">
        {hasMedia ? (
          <>
            {/* 有媒体时使用轮播 */}
            <div
              className="relative aspect-video bg-black/40"
            >
              {/* 左上角：选择按钮 */}
              <button
                onClick={(e) => { e.stopPropagation(); onSelect?.(shot); }}
                className={`absolute top-3 left-3 z-30 w-8 h-8 rounded-full border flex items-center justify-center transition ${
                  isSelected
                    ? 'border-transparent bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white'
                    : 'border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/30 hover:border-violet-400/60 text-white/70'
                }`}
                title="选择"
              >
                {isSelected ? <Check className="w-4 h-4" /> : <span className="w-3 h-3 rounded-full border border-white/40" />}
              </button>
              {/* 媒体内容（条件渲染，参考项目卡片模式） */}
              {!currentMedia || !mediaReady ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <ImageIcon className="w-8 h-8 text-white/30 animate-pulse" />
                </div>
              ) : isVideo ? (
                shouldLoadVideo ? (
                  <video
                    ref={videoRef}
                    src={signedMediaUrl}
                    preload="none"
                    muted={false}
                    playsInline
                    loop
                    controls={false}
                    className="w-full h-full object-cover"
                    onPlay={handleVideoPlay}
                    onPause={handleVideoPause}
                    onWaiting={handleVideoWaiting}
                    onCanPlay={handleVideoCanPlay}
                    onProgress={handleVideoProgress}
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onClick={(e) => {
                      if (!isMobile && isThisVideoPlaying) {
                        e.preventDefault();
                        handleTogglePlay();
                      }
                    }}
                  />
                ) : (
                  <img
                    key={`poster-${shot.id}-${currentMedia?.id}-${posterRetryCount}`}
                    src={posterReady ? signedPosterUrl : signedMediaUrl}
                    alt={currentMedia?.filename || ''}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={() => {
                      console.error('[ShotCard] 封面加载失败:', { url: currentMedia?.url, shotId: shot.id });
                      setImgError(true);
                      if (posterRetryCount < 3) {
                        setTimeout(() => {
                          setImgError(false);
                          setPosterRetryCount(c => c + 1);
                        }, 1000 * (posterRetryCount + 1));
                      }
                    }}
                  />
                )
              ) : (
                <img
                  src={signedMediaUrl}
                  alt={currentMedia?.filename || ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={() => {
                    console.error('[ShotCard] 图片加载失败:', { url: currentMedia?.url, filename: currentMedia?.filename, shotId: shot.id });
                    setImgError(true);
                    if (posterRetryCount < 3) {
                      setTimeout(() => {
                        setImgError(false);
                        setPosterRetryCount(c => c + 1);
                      }, 1000 * (posterRetryCount + 1));
                    }
                  }}
                />
              )}

              {/* 媒体错误 overlay */}
              {imgError && mediaReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30">
                    <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                    <circle cx="9" cy="9" r="2"/>
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                  </svg>
                </div>
              )}

              {/* 播放按钮（仅视频类型且未播放时显示） */}
              {isVideo && mediaReady && !isThisVideoPlaying && (
                <button
                  onClick={(e) => { e.stopPropagation(); handlePlayVideo(); }}
                  className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 hover:bg-black/40 transition"
                >
                  <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center hover:bg-white/30 transition">
                    <Play className="w-8 h-8 text-white fill-white ml-1" />
                  </div>
                </button>
              )}

              {/* 加载进度条（仅视频类型且播放中显示） */}
              {isVideo && (isVideoLoading || bufferProgress < 100) && isThisVideoPlaying && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40 z-20">
                  <div
                    className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                    style={{ width: `${bufferProgress}%` }}
                  />
                </div>
              )}

              {/* 加载指示器（仅视频类型且加载中显示） */}
              {isVideo && isVideoLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20">
                  <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                </div>
              )}

              {/* 左箭头 */}
              {media.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handlePrevMedia(); }}
                  className={`absolute left-0 top-1/2 -translate-y-1/2 z-40 rounded-full border border-white/30 bg-black/50 backdrop-blur hover:bg-violet-500/50 flex items-center justify-center transition ${
                    isMobile ? 'w-10 h-10' : 'w-8 h-8'
                  }`}
                  style={{ opacity: 0.85 }}
                >
                  <ChevronLeft className={`text-white ${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                </button>
              )}

              {/* 右箭头 */}
              {media.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleNextMedia(); }}
                  className={`absolute right-0 top-1/2 -translate-y-1/2 z-40 rounded-full border border-white/30 bg-black/50 backdrop-blur hover:bg-violet-500/50 flex items-center justify-center transition ${
                    isMobile ? 'w-10 h-10' : 'w-8 h-8'
                  }`}
                  style={{ opacity: 0.85 }}
                >
                  <ChevronRight className={`text-white ${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                </button>
              )}

              {/* 指示器 */}
              {media.length > 1 && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
                  {media.map((_, idx) => (
                    <div
                      key={idx}
                      className={`w-1.5 h-1.5 rounded-full transition ${
                        idx === currentIndex ? 'bg-white w-3' : 'bg-white/40'
                      }`}
                    />
                  ))}
                </div>
              )}

            </div>
          </>
        ) : (
          /* 无媒体时显示占位 - 桌面端保持与有媒体时一致的高度，手机端使用较矮高度 */
          <div className={`${isMobile ? 'h-[110px]' : 'aspect-video'} bg-black/40 flex flex-col items-center justify-center gap-2 relative`}>
            {/* 左上角：选择按钮 */}
            <button
              onClick={(e) => { e.stopPropagation(); onSelect?.(shot); }}
              className={`absolute top-3 left-3 z-30 w-8 h-8 rounded-full border flex items-center justify-center transition ${
                isSelected
                  ? 'border-transparent bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white'
                  : 'border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/30 hover:border-violet-400/60 text-white/70'
              }`}
              title="选择"
            >
              {isSelected ? <Check className="w-4 h-4" /> : <span className="w-3 h-3 rounded-full border border-white/40" />}
            </button>
            <>
              <div className="flex items-center gap-3">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUploadClick();
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-dashed border-violet-400/40 bg-violet-500/10 hover:bg-violet-500/20 text-xs font-medium text-violet-200 transition"
                >
                  <Upload className="w-4 h-4" />
                  上传
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAiGenerate?.(shot);
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-dashed border-pink-400/40 bg-pink-500/10 hover:bg-pink-500/20 text-xs font-medium text-pink-200 transition"
                >
                  <Sparkles className="w-4 h-4" />
                  AI生成
                </button>
              </div>
              <p className="text-xs text-slate-500">上传或AI生成参考画面</p>
            </>
          </div>
        )}



        {/* 右上角：全屏按钮 */}
        <div className={`absolute z-20 flex items-center gap-1.5 ${isMobile ? 'top-2 right-2' : 'top-3 right-3'}`}>
          {hasMedia && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); handleFullscreen(currentMedia); }}
                className="touch-target-36 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
                title="全屏查看"
              >
                <Maximize2 className="w-4 h-4 text-white/90" />
              </button>
            </>
          )}
        </div>

        {/* 左下角：状态标签 / 恢复按钮 */}
        <div className={`absolute z-20 ${isMobile ? 'bottom-2 left-2' : 'bottom-3 left-3'}`}>
          {currentTab === 'trash' ? (
            <button
              onClick={(e) => { e.stopPropagation(); onRestore?.(shot.id); }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-white/25 bg-white/10 text-white/80 hover:bg-white/20 transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              恢复
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onStatusClick?.(shot); }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition cursor-pointer ${
                shot.status === 'done'
                  ? 'bg-green-500/20 border-green-400/60 text-green-200 hover:bg-green-500/30'
                  : 'bg-white/10 border-white/25 text-white/80 hover:bg-white/20'
              }`}
            >
              {shot.status === 'done' ? (
                <>
                  <span className="w-4 h-4 rounded-full border-[1.5px] border-green-400 flex items-center justify-center shrink-0" style={{ backgroundColor: '#22c55e' }}>
                    <Check className="w-3 h-3 text-white" />
                  </span>
                  已拍摄
                </>
              ) : (
                <>
                  <span className="w-4 h-4 rounded-full border-[1.5px] border-white/40 shrink-0" />
                  未拍摄
                </>
              )}
            </button>
          )}
        </div>

        {/* 右下角：镜头编号（仅已拍摄 tab 显示） / AI分析（仅未拍摄 tab + 桌面端显示） */}
        {currentTab === 'done' && (
          <div className={`absolute z-20 ${isMobile ? 'bottom-2 right-2' : 'bottom-3 right-3'}`}>
            <button
              onClick={(e) => { e.stopPropagation(); onShotNoClick?.(shot); }}
              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-black/40 backdrop-blur border-white/25 text-white/80 cursor-pointer hover:bg-black/60 hover:border-white/40 transition"
            >
              {shot.shotNo ? `编号${shot.shotNo}` : '无编号'}
            </button>
          </div>
        )}
        {currentTab === 'pending' && !isMobile && currentMedia && (
          <div className="absolute bottom-3 right-3 z-20">
            <button
              onClick={(e) => { e.stopPropagation(); handleAnalyzeShot(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-200 backdrop-blur transition"
              title="AI分析画面内容，自动填充各项信息"
            >
              <Sparkles className="w-3.5 h-3.5" />
              AI分析
            </button>
          </div>
        )}
      </div>

      {/* 中部内容区 */}
      <div className="px-3 py-2">
        {/* 画面内容（可编辑，无标题） */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <InlineEditField
              label="画面内容"
              value={shot.sceneContent}
              onSave={(value) => handleFieldUpdate('sceneContent', value)}
              multiline
              hideLabel
              suggestions={[]}
              enableAutocomplete={false}
            />
          </div>
        </div>
      </div>

      {/* 展开详情区域 */}
      {isExpanded && (
        <div className="px-3 pb-3 border-t border-white/5 pt-2 space-y-1.5">
          {/* 合并来源信息 */}
          {shot.mergedFrom && shot.mergedFrom.length > 0 && (
            <div className="px-2 py-1.5 rounded-lg bg-violet-500/10 border border-violet-400/20">
              <div className="flex items-center justify-between">
                <span className="text-xs text-violet-300">由 {shot.mergedFrom.length} 个分镜合并而来</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowMergedFrom(!showMergedFrom)}
                    className="text-xs text-violet-400 hover:text-violet-300 transition"
                  >
                    {showMergedFrom ? '收起' : '详情'}
                  </button>
                </div>
              </div>
              {showMergedFrom && (
                <div className="mt-2 pt-2 border-t border-violet-400/10">
                  <div className="flex flex-wrap gap-1.5">
                    {shot.mergedFrom.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-violet-500/20 text-violet-200"
                      >
                        #{id}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 第一行：地点（占满一行） */}
          <InlineEditField
            label="地点"
            value={shot.location}
            onSave={(value) => handleFieldUpdate('location', value)}
            suggestions={fieldSuggestions?.location || []}
            datalistId={`shot-${shot.id}-location`}
          />

          {/* 第二行：演员 */}
          <InlineEditField
            label="演员"
            value={shot.actors}
            onSave={(value) => handleFieldUpdate('actors', value)}
            suggestions={fieldSuggestions?.actors || []}
            datalistId={`shot-${shot.id}-actors`}
          />

          {/* 第三行：服饰 */}
          <InlineEditField
            label="服饰"
            value={shot.costume || ''}
            onSave={(value) => handleFieldUpdate('costume', value)}
            suggestions={fieldSuggestions?.costume || []}
            datalistId={`shot-${shot.id}-costume`}
          />

          {/* 第四行：道具 */}
          <InlineEditField
            label="道具"
            value={shot.props}
            onSave={(value) => handleFieldUpdate('props', value)}
            suggestions={fieldSuggestions?.props || []}
            datalistId={`shot-${shot.id}-props`}
          />

          {/* 第五行：景别 + 焦段 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineSelectField
              label="景别"
              value={shot.shotType || ''}
              options={SHOT_TYPES}
              onSave={(value) => handleFieldUpdate('shotType', value)}
            />
            <InlineEditField
              label="焦段"
              value={shot.focalLength}
              onSave={(value) => handleFieldUpdate('focalLength', value)}
              suggestions={fieldSuggestions?.focalLength || []}
              datalistId={`shot-${shot.id}-focalLength`}
              placeholder="如35mm"
            />
          </div>

          {/* 第六行：角度 + 灯光 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineSelectField
              label="角度"
              value={shot.shotAngle || ''}
              options={SHOT_ANGLES}
              onSave={(value) => handleFieldUpdate('shotAngle', value)}
            />
            <InlineEditField
              label="灯光"
              value={shot.lighting}
              onSave={(value) => handleFieldUpdate('lighting', value)}
              suggestions={fieldSuggestions?.lighting || []}
              datalistId={`shot-${shot.id}-lighting`}
            />
          </div>

          {/* 第七行：镜头运动 + 预估时长 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineSelectField
              label="镜头运动"
              value={shot.cameraMovement || ''}
              options={CAMERA_MOVEMENTS}
              onSave={(value) => handleFieldUpdate('cameraMovement', value)}
            />
            <InlineEditField
              label="预估时长"
              value={shot.estimatedDuration?.toString() || ''}
              inputType="number"
              enableAutocomplete={false}
              suggestions={[]}
              placeholder="秒"
              onSave={(value) => handleFieldUpdate('estimatedDuration', value)}
            />
          </div>

          {/* 第八行：旁白（占满一行） */}
          <InlineEditField
            label="旁白"
            value={shot.narration}
            onSave={(value) => handleFieldUpdate('narration', value)}
            multiline
            suggestions={[]}
            enableAutocomplete={false}
          />

          {/* 第九行：备注（占满一行） */}
          <InlineEditField
            label="备注"
            value={shot.notes}
            onSave={(value) => handleFieldUpdate('notes', value)}
            multiline
            suggestions={[]}
            enableAutocomplete={false}
          />

          {/* 视频分割按钮 */}
          {currentTab === 'pending' && media.some(m => m.type === 'video') && (
            <button
              onClick={() => onSplitVideo?.(shot)}
              className="w-full mt-2 py-2 rounded-xl border border-dashed border-amber-400/30 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-medium text-amber-200 transition flex items-center justify-center gap-2"
            >
              <Scissors className="w-4 h-4" />
              视频分割为分镜
            </button>
          )}

          {/* 管理参考画面按钮 */}
          <button
            onClick={() => onManageMedia?.(shot)}
            className="mt-2 w-full py-2 rounded-xl border border-dashed border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/20 text-xs font-medium text-violet-200 transition flex items-center justify-center gap-2"
          >
            <ImageIcon className="w-4 h-4" />
            管理参考画面 ({media.length}/10)
          </button>
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="px-3 pb-3 flex items-center justify-between flex-wrap gap-y-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isMobile ? (
            <>
              <button
                onClick={() => onSort?.(shot.id, 'up')}
                disabled={isFirst}
                className={`w-9 h-9 rounded-full border flex items-center justify-center transition ${
                  isFirst
                    ? 'border-white/10 text-slate-600 cursor-not-allowed'
                    : 'border-white/20 bg-white/5 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50 hover:text-white'
                }`}
                title="上移"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                onClick={() => onSort?.(shot.id, 'down')}
                disabled={isLast}
                className={`w-9 h-9 rounded-full border flex items-center justify-center transition ${
                  isLast
                    ? 'border-white/10 text-slate-600 cursor-not-allowed'
                    : 'border-white/20 bg-white/5 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50 hover:text-white'
                }`}
                title="下移"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </>
          ) : (
            <button
              data-drag-handle
              onMouseDown={() => { if (!dragDisabled) onDragHandleMouseDown?.(); }}
              disabled={dragDisabled}
              className={`w-6 h-6 flex items-center justify-center rounded transition ${
                dragDisabled
                  ? 'cursor-not-allowed text-white/20'
                  : 'cursor-grab active:cursor-grabbing text-white/40 hover:text-white hover:bg-white/10'
              }`}
              title={dragDisabled ? '搜索状态下不可拖拽排序' : '拖拽排序'}
            >
              <GripVertical className="w-4 h-4" />
            </button>
          )}
          <span className="text-xs text-slate-500 ml-1">分镜 {index + 1}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onExpand?.(shot.id)}
            className={`inline-flex items-center gap-1 rounded-full text-xs border border-violet-400/30 hover:bg-violet-500/20 text-violet-200 transition ${
              isMobile ? 'px-2.5 py-2' : 'px-2.5 py-1.5'
            }`}
            title={isExpanded ? '收起详情' : '展开详情'}
          >
            {isExpanded ? <ChevronUp className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} /> : <ChevronDown className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />}
            {!isMobile && <span>{isExpanded ? '收起' : '详情'}</span>}
          </button>
          {currentTab === 'trash' && onHardDelete ? (
            <button
              onClick={() => onHardDelete(shot.id)}
              className={`inline-flex items-center gap-1 rounded-full text-xs border border-red-400/30 hover:bg-red-500/20 text-red-200 transition ${
                isMobile ? 'px-2.5 py-2' : 'px-2.5 py-1.5'
              }`}
              title="彻底删除"
            >
              <Trash2 className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            </button>
          ) : (
            <button
              onClick={() => onDelete?.(shot.id)}
              className={`inline-flex items-center gap-1 rounded-full text-xs border border-red-400/30 hover:bg-red-500/20 text-red-200 transition ${
                isMobile ? 'px-2.5 py-2' : 'px-2.5 py-1.5'
              }`}
              title="删除"
            >
              <Trash2 className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            </button>
          )}
        </div>
      </div>
    </div>

    <AnalyzeShotDialog
      isOpen={showAnalyzeDialog}
      onClose={() => setShowAnalyzeDialog(false)}
      shot={shot}
      currentMedia={currentMedia!}
      onApply={(shotId, updates) => onUpdate?.(shotId, updates)}
      onOpenSettings={onOpenSettings}
    />
    </>
  );
}
