import React, { useRef, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useSignedUrl } from '../../hooks/useSignedUrl';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { ShotMedia } from '../../lib/types';

function getPosterUrl(videoUrl: string): string {
  if (videoUrl && (videoUrl.includes('aliyuncs.com') || videoUrl.includes('qiziwenhua.top'))) {
    return videoUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

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
  const signedUrl = useSignedUrl(mediaUrl);
  const signedPoster = useSignedUrl(mediaType === 'video' && mediaUrl ? getPosterUrl(mediaUrl) : undefined);

  useEscapeKey(onClose, isOpen);

  useEffect(() => {
    if (isOpen && mediaType === 'video' && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [isOpen, mediaType, mediaUrl]);

  useEffect(() => {
    if (videoRefCallback) {
      videoRefCallback(videoRef.current);
    }
  }, [videoRefCallback, isOpen, mediaUrl]);

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

  if (!isOpen) return null;

  const hasList = mediaList && mediaList.length > 1;

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
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
        {mediaType === 'image' ? (
          <img
            src={signedUrl}
            alt={filename || mediaUrl}
            className="mx-auto max-w-full max-h-[80vh] object-contain rounded-2xl"
          />
        ) : (
          <video
            ref={videoRef}
            src={signedUrl}
            poster={signedPoster}
            controls
            autoPlay
            playsInline
            muted={false}
            className="mx-auto max-w-full max-h-[80vh] rounded-2xl bg-black"
          />
        )}
        <p className="text-center text-sm text-slate-300 mt-4">
          {filename || mediaUrl}
        </p>
      </div>
    </div>
  );
}

export default MediaFullscreen;
