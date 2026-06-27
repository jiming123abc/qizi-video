import { useState, useCallback, useRef, useEffect } from 'react';
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
  Info
} from 'lucide-react';
import type { Shot, ShotMedia } from '../../lib/types';
import { MediaCarousel } from './MediaCarousel';
import { getVideoPoster } from '../../lib/ossUtils';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useSignedUrl } from '../../hooks/useSignedUrl';

interface ShotCardProps {
  shot: Shot;
  isSelected?: boolean;
  onSelect?: (shot: Shot) => void;
  onUpdate?: (id: number, fields: Partial<Shot>) => void;
  onDelete?: (id: number) => void;
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
  isMobile?: boolean;
  currentTab?: 'pending' | 'done' | 'trash';
  onStatusClick?: (shot: Shot) => void;
  onShotNoClick?: (shot: Shot) => void;
  onDragHandleMouseDown?: () => void;
  onVideoPlay?: (shotId: number, mediaId: number) => void;
  onVideoPause?: (shotId: number, mediaId: number) => void;
  playingVideoKey?: string;
  onVideoRefReady?: (key: string, ref: HTMLVideoElement | null) => void;
}

// 行内编辑字段组件
interface InlineEditFieldProps {
  label: string;
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  hideLabel?: boolean;
}

function InlineEditField({ label, value, onSave, multiline = false, hideLabel = false }: InlineEditFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, []);

  useEffect(() => {
    if (!isEditing && !isExpanded) {
      setEditValue(value);
    }
  }, [value, isEditing, isExpanded]);

  useEffect(() => {
    if (isEditing && multiline) {
      adjustTextareaHeight();
    }
  }, [isEditing, multiline, editValue, adjustTextareaHeight]);

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
      <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={handleCancel}>
        <div className="bg-slate-900/95 backdrop-blur-xl rounded-2xl border border-white/10 w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
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
      <div className={`${hideLabel ? '' : 'gap-1.5'} ${multiline ? 'flex flex-col' : 'flex items-center'}`}>
        {!hideLabel && <span className="text-xs text-slate-400 shrink-0">{label}：</span>}
        {multiline ? (
          <div className="flex-1 min-w-0 relative">
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                adjustTextareaHeight();
              }}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              autoFocus
              rows={1}
              className="flex-1 w-full min-w-0 px-2 py-1 pr-16 text-xs bg-white/10 border border-violet-400/50 rounded outline-none focus:border-violet-400 resize-none overflow-hidden"
            />
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsExpanded(true);
              }}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute right-1 top-1 w-6 h-6 rounded hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-violet-300 transition"
              title="展开编辑"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-white/10 border border-violet-400/50 rounded outline-none focus:border-violet-400"
          />
        )}
      </div>
    );
  }

  const hasLongContent = multiline && value && value.length > 30;

  return (
    <div
      className={`${hideLabel ? '' : 'gap-1.5'} cursor-pointer hover:bg-white/5 rounded px-1 py-0.5 -mx-1 transition ${multiline ? 'flex flex-col' : 'flex items-center'}`}
    >
      <div className="flex items-center justify-between" onClick={() => setIsEditing(true)}>
        {!hideLabel && <span className="text-xs text-slate-400 shrink-0">{label}：</span>}
        {hideLabel && hasLongContent && (
          <span className="text-xs text-slate-400 shrink-0">{label}</span>
        )}
      </div>
      <div className="flex items-start gap-1" onClick={() => setIsEditing(true)}>
        <span className={`text-xs text-white/90 flex-1 ${multiline ? 'whitespace-pre-wrap break-words line-clamp-3' : 'truncate'}`}>
          {value || <span className="text-slate-500 italic">点击编辑</span>}
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
    </div>
  );
}

export function ShotCard({
  shot,
  isSelected = false,
  onSelect,
  onUpdate,
  onDelete,
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
  isMobile = false,
  currentTab = 'pending',
  onStatusClick,
  onShotNoClick,
  onDragHandleMouseDown,
  onVideoPlay,
  onVideoPause,
  playingVideoKey,
  onVideoRefReady,
}: ShotCardProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [bufferProgress, setBufferProgress] = useState(0);
  const [imgError, setImgError] = useState(false);
  const [showMergedFrom, setShowMergedFrom] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const media = shot.media || [];
  const currentMedia = media[currentIndex];
  const isVideo = currentMedia?.type === 'video';
  const videoKey = `${shot.id}-${currentMedia?.id}`;
  const isThisVideoPlaying = playingVideoKey === videoKey;

  // 签名 URL
  const signedMediaUrl = useSignedUrl(currentMedia?.url);
  const signedPosterUrl = useSignedUrl(currentMedia?.url ? getVideoPoster(currentMedia.url) : undefined);

  useEffect(() => {
    if (!cardRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        });
      },
      { rootMargin: '200px' }
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

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

  const handleFieldUpdate = useCallback((field: keyof Shot, value: string) => {
    onUpdate?.(shot.id, { [field]: value });
  }, [shot.id, onUpdate]);

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
    <div
      ref={cardRef}
      className={`relative rounded-2xl border overflow-hidden transition-all ${
        isSelected
          ? 'border-violet-400/60 ring-2 ring-violet-400/30 bg-white/[0.05]'
          : shot.status === 'done'
            ? 'border-green-500/30 bg-green-900/10 hover:border-green-400/50 border-l-2 border-l-green-400/60'
            : 'border-white/10 bg-white/[0.03] hover:border-violet-400/30'
      }`}
    >
      {/* 顶部媒体区域 */}
      <div className="relative">
        {hasMedia ? (
          <>
            {/* 有媒体时使用轮播 */}
            <div className="relative aspect-video bg-black/40">
              {isVideo ? (
                <>
                  {/* 封面图（懒加载，未播放时显示） */}
                  {(!shouldLoadVideo || !isVisible) && (
                    <>
                      {imgError ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30">
                            <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                            <circle cx="9" cy="9" r="2"/>
                            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                          </svg>
                        </div>
                      ) : isVisible ? (
                        <img
                          src={signedPosterUrl || signedMediaUrl}
                          alt={currentMedia.filename}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={() => {
                            console.error('[ShotCard] 封面加载失败:', { url: currentMedia.url, shotId: shot.id });
                            setImgError(true);
                          }}
                        />
                      ) : (
                        <div className="absolute inset-0 bg-black/40" />
                      )}
                    </>
                  )}

                  {/* 视频元素（仅在可见且点击播放后创建） */}
                  {shouldLoadVideo && isVisible && (
                    <video
                      ref={videoRef}
                      src={signedMediaUrl}
                      muted={false}
                      playsInline
                      loop
                      controls={isMobile}
                      className="w-full h-full object-cover"
                      onPlay={handleVideoPlay}
                      onPause={handleVideoPause}
                      onWaiting={handleVideoWaiting}
                      onCanPlay={handleVideoCanPlay}
                      onProgress={handleVideoProgress}
                      onClick={(e) => {
                        if (!isMobile && isThisVideoPlaying) {
                          e.preventDefault();
                          handleTogglePlay();
                        }
                      }}
                    />
                  )}

                  {/* 播放按钮（未播放时显示） */}
                  {!isThisVideoPlaying && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handlePlayVideo(); }}
                      className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 hover:bg-black/40 transition"
                    >
                      <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center hover:bg-white/30 transition">
                        <Play className="w-8 h-8 text-white fill-white ml-1" />
                      </div>
                    </button>
                  )}

                  {/* 加载进度条 */}
                  {(isVideoLoading || bufferProgress < 100) && isThisVideoPlaying && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40 z-20">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                        style={{ width: `${bufferProgress}%` }}
                      />
                    </div>
                  )}

                  {/* 加载指示器 */}
                  {isVideoLoading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20">
                      <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    </div>
                  )}
                </>
              ) : (
                imgError ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                      <circle cx="9" cy="9" r="2"/>
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                    </svg>
                  </div>
                ) : (
                  <img
                    src={signedMediaUrl}
                    alt={currentMedia.filename}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={() => {
                      console.error('[ShotCard] 图片加载失败:', { url: currentMedia.url, filename: currentMedia.filename, shotId: shot.id });
                      setImgError(true);
                    }}
                  />
                )
              )}

              {/* 左箭头 */}
              {media.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handlePrevMedia(); }}
                  className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/50 flex items-center justify-center transition"
                  style={{ opacity: 0.7 }}
                >
                  <ChevronLeft className="w-4 h-4 text-white" />
                </button>
              )}

              {/* 右箭头 */}
              {media.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleNextMedia(); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/50 flex items-center justify-center transition"
                  style={{ opacity: 0.7 }}
                >
                  <ChevronRight className="w-4 h-4 text-white" />
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
          /* 无媒体时显示占位 - 桌面端与有媒体保持一致高度，移动端降低高度 */
          <div className={`${isMobile ? 'aspect-[16/6]' : 'aspect-video'} bg-black/40 flex flex-col items-center justify-center gap-3`}>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onUploadMedia?.(shot)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-dashed border-violet-400/40 bg-violet-500/10 hover:bg-violet-500/20 text-xs font-medium text-violet-200 transition"
              >
                <Upload className="w-4 h-4" />
                上传
              </button>
              <button
                onClick={() => onAiGenerate?.(shot)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-dashed border-pink-400/40 bg-pink-500/10 hover:bg-pink-500/20 text-xs font-medium text-pink-200 transition"
              >
                <Sparkles className="w-4 h-4" />
                AI生成
              </button>
            </div>
            <p className="text-xs text-slate-500">上传或AI生成参考画面</p>
          </div>
        )}

        {/* 左上角：选择按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); onSelect?.(shot); }}
          className={`absolute top-3 left-3 z-20 w-8 h-8 rounded-full border flex items-center justify-center transition ${
            isSelected
              ? 'border-transparent bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white'
              : 'border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/30 hover:border-violet-400/60 text-white/70'
          }`}
          title="选择"
        >
          {isSelected ? <Check className="w-4 h-4" /> : <span className="w-3 h-3 rounded-full border border-white/40" />}
        </button>

        {/* 右上角：全屏按钮（无媒体时显示上传区域） */}
        {hasMedia && (
          <button
            onClick={(e) => { e.stopPropagation(); handleFullscreen(currentMedia); }}
            className="absolute top-3 right-3 z-20 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
            title="全屏查看"
          >
            <Maximize2 className="w-4 h-4 text-white/90" />
          </button>
        )}

        {/* 左下角：状态标签 */}
        <div className="absolute bottom-3 left-3 z-20">
          <button
            onClick={(e) => { e.stopPropagation(); onStatusClick?.(shot); }}
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition cursor-pointer ${
              shot.status === 'done'
                ? 'bg-green-500/20 border-green-400/60 text-green-200 hover:bg-green-500/30'
                : 'bg-white/10 border-white/25 text-white/80 hover:bg-white/20'
            }`}
          >
            {shot.status === 'done' ? (
              <>
                <span className="w-4 h-4 rounded-full border-[1.5px] border-green-400 flex items-center justify-center mr-1.5" style={{ backgroundColor: '#22c55e' }}>
                  <Check className="w-3 h-3 text-white" />
                </span>
                已拍摄
              </>
            ) : (
              '未拍摄'
            )}
          </button>
        </div>

        {/* 右下角：镜头编号（仅已拍摄 tab 显示） */}
        {currentTab === 'done' && (
          <div className="absolute bottom-3 right-3 z-20">
            <button
              onClick={(e) => { e.stopPropagation(); onShotNoClick?.(shot); }}
              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-black/40 backdrop-blur border-white/25 text-white/80 cursor-pointer hover:bg-black/60 hover:border-white/40 transition"
            >
              {shot.shotNo ? `编号${shot.shotNo}` : '无编号'}
            </button>
          </div>
        )}
      </div>

      {/* 中部内容区 */}
      <div className="px-3 py-2">
        {/* 画面内容（可编辑，无标题） */}
        <div>
          <InlineEditField
            label="画面内容"
            value={shot.sceneContent}
            onSave={(value) => handleFieldUpdate('sceneContent', value)}
            multiline
            hideLabel
          />
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

          {/* 第一行：演员 + 道具 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineEditField
              label="演员"
              value={shot.actors}
              onSave={(value) => handleFieldUpdate('actors', value)}
            />
            <InlineEditField
              label="道具"
              value={shot.props}
              onSave={(value) => handleFieldUpdate('props', value)}
            />
          </div>

          {/* 第二行：地点 + 焦段 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineEditField
              label="地点"
              value={shot.location}
              onSave={(value) => handleFieldUpdate('location', value)}
            />
            <InlineEditField
              label="焦段"
              value={shot.focalLength}
              onSave={(value) => handleFieldUpdate('focalLength', value)}
            />
          </div>

          {/* 第三行：景别 + 角度 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineEditField
              label="景别"
              value={shot.shotType}
              onSave={(value) => handleFieldUpdate('shotType', value)}
            />
            <InlineEditField
              label="角度"
              value={shot.shotAngle}
              onSave={(value) => handleFieldUpdate('shotAngle', value)}
            />
          </div>

          {/* 第四行：镜头运动 + 灯光 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineEditField
              label="镜头运动"
              value={shot.cameraMovement}
              onSave={(value) => handleFieldUpdate('cameraMovement', value)}
            />
            <InlineEditField
              label="灯光"
              value={shot.lighting}
              onSave={(value) => handleFieldUpdate('lighting', value)}
            />
          </div>

          {/* 第五行：旁白 */}
          <InlineEditField
            label="旁白"
            value={shot.narration}
            onSave={(value) => handleFieldUpdate('narration', value)}
            multiline
          />

          {/* 第六行：预估时长 + 备注 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <InlineEditField
              label="预估时长"
              value={shot.estimatedDuration}
              onSave={(value) => handleFieldUpdate('estimatedDuration', value)}
            />
            <InlineEditField
              label="备注"
              value={shot.notes}
              onSave={(value) => handleFieldUpdate('notes', value)}
              multiline
            />
          </div>

          {/* 视频分割按钮 */}
          {(shot.type === 'video' || media.some(m => m.type === 'video')) && (
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
            className="w-full mt-2 py-2 rounded-xl border border-dashed border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/20 text-xs font-medium text-violet-200 transition flex items-center justify-center gap-2"
          >
            <ImageIcon className="w-4 h-4" />
            管理参考画面 ({media.length}/10)
          </button>
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="px-3 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
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
              onMouseDown={() => onDragHandleMouseDown?.()}
              className="w-6 h-6 flex items-center justify-center cursor-grab active:cursor-grabbing text-white/40 hover:text-white hover:bg-white/10 rounded transition"
              title="拖拽排序"
            >
              <GripVertical className="w-4 h-4" />
            </button>
          )}
          <span className="text-xs text-slate-500 ml-1">分镜 {shot.shotIndex}</span>
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
          <button
            onClick={() => onDelete?.(shot.id)}
            className={`inline-flex items-center gap-1 rounded-full text-xs border border-red-400/30 hover:bg-red-500/20 text-red-200 transition ${
              isMobile ? 'px-2.5 py-2' : 'px-2.5 py-1.5'
            }`}
            title="删除"
          >
            <Trash2 className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
          </button>
        </div>
      </div>
    </div>
  );
}
