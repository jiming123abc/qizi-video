import { useState, useRef, useCallback, useEffect } from 'react';
import type { TouchEvent, KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Play, Maximize2 } from 'lucide-react';
import type { ShotMedia } from '../../lib/types';

interface MediaCarouselProps {
  media: ShotMedia[];
  onPlayVideo?: (media: ShotMedia) => void;
  onFullscreen?: (media: ShotMedia) => void;
  autoPlay?: boolean;
  aspectRatio?: string;
}

// 获取视频封面图
function getVideoPosterUrl(videoUrl: string): string {
  if (videoUrl && (videoUrl.includes('aliyuncs.com') || videoUrl.includes('qiziwenhua.top'))) {
    return videoUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

export function MediaCarousel({
  media,
  onPlayVideo,
  onFullscreen,
  autoPlay = false,
  aspectRatio = 'aspect-video',
}: MediaCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentMedia = media[currentIndex];
  const hasMultiple = media.length > 1;

  // 重置播放状态 when 切换到非视频
  useEffect(() => {
    if (currentMedia && currentMedia.type !== 'video') {
      setIsPlaying(false);
    }
  }, [currentMedia]);

  const goTo = useCallback((index: number) => {
    if (index < 0) index = media.length - 1;
    if (index >= media.length) index = 0;

    // 先暂停当前播放的视频
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsPlaying(false);
    setCurrentIndex(index);
  }, [media.length]);

  const goNext = useCallback(() => {
    goTo(currentIndex + 1);
  }, [currentIndex, goTo]);

  const goPrev = useCallback(() => {
    goTo(currentIndex - 1);
  }, [currentIndex, goTo]);

  const handlePlayVideo = () => {
    if (currentMedia?.type === 'video') {
      setIsPlaying(true);
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        videoRef.current.play().catch(() => {});
      }
      onPlayVideo?.(currentMedia);
    }
  };

  const handleFullscreen = () => {
    if (currentMedia) {
      onFullscreen?.(currentMedia);
    }
  };

  // 触摸滑动处理
  const handleTouchStart = (e: TouchEvent) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const diff = touchStart - touchEnd;
    const minSwipeDistance = 50;
    if (diff > minSwipeDistance) {
      goNext();
    } else if (diff < -minSwipeDistance) {
      goPrev();
    }
    setTouchStart(null);
    setTouchEnd(null);
  };

  if (!media || media.length === 0) {
    return null;
  }

  const isVideo = currentMedia?.type === 'video';

  return (
    <div
      ref={containerRef}
      className={`relative ${aspectRatio} bg-black/40 overflow-hidden rounded-xl`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* 媒体内容 */}
      {isVideo ? (
        <>
          <video
            ref={videoRef}
            src={currentMedia.url}
            poster={getVideoPosterUrl(currentMedia.url)}
            muted
            playsInline
            loop
            className="w-full h-full object-cover cursor-pointer"
            onEnded={() => setIsPlaying(false)}
            onClick={(e) => {
              e.stopPropagation();
              if (isPlaying && videoRef.current) {
                videoRef.current.pause();
                setIsPlaying(false);
              }
            }}
          />
          {/* 非播放状态显示封面和播放按钮 */}
          {!isPlaying && (
            <div className="absolute inset-0">
              <img
                src={getVideoPosterUrl(currentMedia.url) || currentMedia.url}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
              <div className="absolute inset-0 bg-black/20" />
              <button
                onClick={handlePlayVideo}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10"
              >
                <div className="w-14 h-14 rounded-full border-2 border-white/70 bg-black/40 backdrop-blur flex items-center justify-center hover:from-violet-500 hover:to-fuchsia-500 hover:bg-gradient-to-br transition">
                  <Play className="w-6 h-6 text-white fill-white ml-0.5" />
                </div>
              </button>
            </div>
          )}
        </>
      ) : (
        <img
          src={currentMedia.url}
          alt={currentMedia.filename}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
          }}
        />
      )}

      {/* 左箭头 */}
      {hasMultiple && !isPlaying && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/50 hover:border-violet-400/60 flex items-center justify-center transition opacity-0 hover:opacity-100 group-hover:opacity-100"
            style={{ opacity: 0.7 }}
          >
            <ChevronLeft className="w-4 h-4 text-white" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/50 hover:border-violet-400/60 flex items-center justify-center transition opacity-0 hover:opacity-100"
            style={{ opacity: 0.7 }}
          >
            <ChevronRight className="w-4 h-4 text-white" />
          </button>
        </>
      )}

      {/* 指示器 */}
      {hasMultiple && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
          {media.map((_, idx) => (
            <button
              key={idx}
              onClick={(e) => { e.stopPropagation(); goTo(idx); }}
              className={`w-1.5 h-1.5 rounded-full transition ${
                idx === currentIndex
                  ? 'bg-white w-3'
                  : 'bg-white/40 hover:bg-white/60'
              }`}
            />
          ))}
        </div>
      )}

      {/* 全屏按钮 */}
      <button
        onClick={(e) => { e.stopPropagation(); handleFullscreen(); }}
        className="absolute top-2 right-2 z-20 w-7 h-7 rounded-full border border-white/25 bg-black/40 backdrop-blur hover:bg-violet-500/50 hover:border-violet-400/60 flex items-center justify-center transition"
        style={{ opacity: 0.7 }}
      >
        <Maximize2 className="w-3.5 h-3.5 text-white/90" />
      </button>
    </div>
  );
}
