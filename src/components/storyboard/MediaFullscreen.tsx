import React, { useRef, useEffect, useState, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Image as ImageIcon, FileVideo } from 'lucide-react';
import { batchGetSignedUrls, getSignedUrlFromCache, getVideoPoster } from '../../lib/ossUtils';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { ShotMedia } from '../../lib/types';

interface MediaFullscreenProps {
  isOpen: boolean;
  onClose: () => void;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  filename?: string;
  mediaList?: ShotMedia[];
  currentIndex?: number;
  onIndexChange?: (index: number) => void;
  videoRefCallback?: (ref: HTMLVideoElement | null) => void;
}

export function MediaFullscreen({
  isOpen,
  onClose,
  mediaType,
  mediaUrl,
  filename,
  mediaList,
  currentIndex = 0,
  onIndexChange,
  videoRefCallback,
}: MediaFullscreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaReady, setMediaReady] = useState(false);

  const currentMedia = mediaList && mediaList[currentIndex];
  const actualMediaType = currentMedia?.type || mediaType;
  const actualMediaUrl = currentMedia?.url || mediaUrl;
  const actualFilename = currentMedia?.filename || filename;
  const posterUrl = actualMediaType === 'video' && actualMediaUrl
    ? getVideoPoster(actualMediaUrl, currentMedia?.startTime)
    : '';

  const signedMediaUrl = getSignedUrlFromCache(actualMediaUrl) || actualMediaUrl;
  const signedPosterUrl = posterUrl ? (getSignedUrlFromCache(posterUrl) || '') : '';

  useEscapeKey(onClose, isOpen);

  useEffect(() => {
    if (!isOpen || !actualMediaUrl) {
      setMediaReady(false);
      return;
    }

    const hasCached = !!getSignedUrlFromCache(actualMediaUrl);
    const posterCached = !posterUrl || !!getSignedUrlFromCache(posterUrl);

    if (hasCached && posterCached) {
      setMediaReady(true);
      return;
    }

    setMediaReady(false);
    const urlsToSign: string[] = [];
    if (!hasCached) urlsToSign.push(actualMediaUrl);
    if (posterUrl && !posterCached) urlsToSign.push(posterUrl);

    if (urlsToSign.length > 0) {
      batchGetSignedUrls(urlsToSign).then(() => {
        setMediaReady(true);
      }).catch(() => {
        setMediaReady(true);
      });
    } else {
      setMediaReady(true);
    }
  }, [isOpen, actualMediaUrl, posterUrl]);

  useEffect(() => {
    if (!isOpen) {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch (_) {}
      }
      return;
    }
    if (actualMediaType === 'video' && videoRef.current && mediaReady) {
      videoRef.current.play().catch(() => {});
    }
  }, [isOpen, actualMediaType, actualMediaUrl, mediaReady]);

  useEffect(() => {
    if (videoRefCallback) {
      videoRefCallback(videoRef.current);
    }
    return () => {
      if (videoRefCallback) {
        videoRefCallback(null);
      }
    };
  }, [videoRefCallback, isOpen, actualMediaUrl, mediaReady]);

  useEffect(() => {
    return () => {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch (_) {}
      }
    };
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

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!mediaList || !onIndexChange) return;
    const newIndex = currentIndex > 0 ? currentIndex - 1 : mediaList.length - 1;
    onIndexChange(newIndex);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!mediaList || !onIndexChange) return;
    const newIndex = currentIndex < mediaList.length - 1 ? currentIndex + 1 : 0;
    onIndexChange(newIndex);
  };

  const hasList = mediaList && mediaList.length > 1;

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4 transition-opacity ${
        isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={onClose}
    >
      {isOpen && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full border border-white/25 bg-white/5 hover:bg-white/15 flex items-center justify-center text-white z-10"
          >
            <X className="w-5 h-5" />
          </button>

          {hasList && (
            <>
              <button
                onClick={handlePrev}
                className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full border border-white/25 bg-white/5 hover:bg-white/15 flex items-center justify-center text-white z-10"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={handleNext}
                className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full border border-white/25 bg-white/5 hover:bg-white/15 flex items-center justify-center text-white z-10"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}

          <div className="max-w-6xl w-full max-h-full" onClick={e => e.stopPropagation()}>
            {!mediaReady || !actualMediaUrl ? (
              <div className="flex items-center justify-center" style={{ height: '50vh' }}>
                {actualMediaType === 'video' ? (
                  <FileVideo className="w-12 h-12 text-white/30 animate-pulse" />
                ) : (
                  <ImageIcon className="w-12 h-12 text-white/30 animate-pulse" />
                )}
              </div>
            ) : actualMediaType === 'image' ? (
              <img
                src={signedMediaUrl}
                alt={actualFilename || actualMediaUrl}
                className="mx-auto max-w-full max-h-[80vh] object-contain rounded-2xl"
              />
            ) : (
              <video
                ref={videoRef}
                src={signedMediaUrl}
                poster={signedPosterUrl || signedMediaUrl}
                controls
                autoPlay
                loop
                playsInline
                muted={false}
                className="mx-auto max-w-full max-h-[80vh] rounded-2xl bg-black"
                onLoadedMetadata={handleVideoLoadedMetadata}
                onTimeUpdate={handleVideoTimeUpdate}
              />
            )}
            <p className="text-center text-sm text-slate-300 mt-4">
              {actualFilename || actualMediaUrl}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default MediaFullscreen;
