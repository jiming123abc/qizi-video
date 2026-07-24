import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Play, Pause, Plus, Trash2, Loader2, Upload, Video, ZoomIn, ZoomOut, Maximize2, Scissors, Sparkles, ChevronDown, ArrowLeft } from 'lucide-react';
import { getVideoPoster } from '../../lib/ossUtils';
import type { SplitShot } from '../../lib/types';
import type { AiTaskUpdate } from '../../lib/taskStream';
import { useSignedUrl } from '../../hooks/useSignedUrl';
import { useUnifiedUpload } from '../../hooks/useUnifiedUpload';
import { AiErrorGuide } from '../ai/AiErrorGuide';

interface UploadedVideo {
  id: string;
  url: string;
  name: string;
  thumbnail?: string;
  isFromShot?: boolean;
}

interface VideoSplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl?: string;
  initialVideos?: UploadedVideo[];
  projectId: number;
  sceneId?: number | null;
  onSplit?: (shots: SplitShot[], videoUrl: string) => void;
  onVideoUpload?: (file: File) => Promise<string>;
  maxUploads?: number;
  source?: 'global' | 'shot';
  shotId?: number | null;
  onOpenSettings?: () => void;
}

type SplitMode = 'manual' | 'ai_frame' | 'aliyun';
type DialogState = 'initial' | 'processing' | 'preview' | 'completed';

interface SplitPoint {
  id: string;
  time: number;
}

interface TaskResult {
  taskId: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number;
  output?: {
    shots: Array<{
      startTime: number;
      endTime: number;
      thumbnail?: string;
    }>;
    estimatedCost?: number;
  };
  error?: string;
}

interface AIModeOption {
  id: 'ai_frame' | 'aliyun';
  name: string;
  description: string;
  cost: string;
  accuracy: string;
  speed: string;
  available: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function getVideoThumbnail(url: string): string {
  if (url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
    // 使用后端代理，避免前端直接请求 OSS 截图触发 ORB
    return `/api/oss-snapshot?url=${encodeURIComponent(url)}&t=1000&w=160`;
  }
  return '';
}

export default function VideoSplitDialog({
  isOpen,
  onClose,
  videoUrl: initialVideoUrl,
  initialVideos,
  projectId,
  sceneId,
  onSplit,
  onVideoUpload,
  maxUploads = 10,
  source = 'global',
  shotId = null,
  onOpenSettings
}: VideoSplitDialogProps) {
  const isShotMode = source === 'shot';
  const { startUpload } = useUnifiedUpload();
  const [mode, setMode] = useState<SplitMode>('manual');
  const [state, setState] = useState<DialogState>('initial');
  const [progress, setProgress] = useState(0);
  const [currentPhase, setCurrentPhase] = useState('');
  const [detectedShots, setDetectedShots] = useState(0);
  const [splitPoints, setSplitPoints] = useState<SplitPoint[]>([]);
  const [estimatedCost, setEstimatedCost] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [shotThumbnails, setShotThumbnails] = useState<Record<string, string>>({});
  const [generatingThumbs, setGeneratingThumbs] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // 根据后端 stage 映射前端提示文字
  const getPhaseText = (output?: { stage?: string; shots?: unknown[] }): string => {
    const stage = output?.stage || '';
    if (output?.shots) return '正在整理识别结果...';
    switch (stage) {
      case 'downloading_video': return '正在下载视频到本地...';
      case 'detecting_scenes': return '正在检测镜头切换点...';
      case 'submitting_to_aliyun': return '正在上传视频到阿里云分析服务...';
      case 'processing_aliyun': return '阿里云正在识别镜头切换点...';
      case 'aliyun_processing': return '阿里云处理中，请稍候...';
      case 'aliyun_process_success': return '分析完成，正在整理结果...';
      default: return '正在检测镜头切换点...';
    }
  };

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const thumbVideoRef = useRef<HTMLVideoElement>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = thumbCanvasRef;
  const timelineRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [draggingPoint, setDraggingPoint] = useState<string | null>(null);
  const dragStartPointRef = useRef<number>(0);
  const [selectedSplitPoint, setSelectedSplitPoint] = useState<string | null>(null);
  const [aliyunConfigured, setAliyunConfigured] = useState(false);
  const [aiMode, setAiMode] = useState<'ai_frame' | 'aliyun'>('ai_frame');
  // AI 模型选择

  const [zoom, setZoom] = useState(1);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const PIXELS_PER_SECOND = 50;
  const MIN_SHOT_DURATION = 0.5;
  const initialZoomSetRef = useRef(false);
  // 分割结果预览
  const [previewShots, setPreviewShots] = useState<SplitShot[]>([]);
  const [playingPreviewIndex, setPlayingPreviewIndex] = useState<number | null>(null);
  // AI 辅助分析入口展开状态
  const [showAIMode, setShowAIMode] = useState(false);
  // 确认创建分镜对话框
  const [confirmDialog, setConfirmDialog] = useState(false);

  const timelineWidth = useMemo(() => {
    return videoDuration * PIXELS_PER_SECOND * zoom + 1;
  }, [videoDuration, zoom]);

  const ticks = useMemo(() => {
    if (!videoDuration || videoDuration === 0) return [];

    const pixelsPerSecond = PIXELS_PER_SECOND * zoom;
    const minTickSpacing = 50;

    let majorInterval = 1;
    const intervals = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const interval of intervals) {
      if (interval * pixelsPerSecond >= minTickSpacing) {
        majorInterval = interval;
        break;
      }
    }

    const minorCount = majorInterval >= 1 ? 5 : (majorInterval >= 0.5 ? 5 : 2);
    const minorInterval = majorInterval / minorCount;

    const result: { time: number; isMajor: boolean; label: string }[] = [];

    const totalMinorSteps = Math.ceil(videoDuration / minorInterval);

    const formatTickLabel = (sec: number): string => {
      const mins = Math.floor(sec / 60);
      const secs = Math.floor(sec % 60);
      if (majorInterval < 1) {
        const frac = Math.round((sec - Math.floor(sec)) * 10);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${frac}`;
      }
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    for (let i = 0; i <= totalMinorSteps; i++) {
      const t = i * minorInterval;
      const clamped = Math.min(t, videoDuration);
      const isMajor = i % minorCount === 0;

      let label = '';
      if (isMajor) {
        label = formatTickLabel(clamped);
      }

      result.push({
        time: clamped,
        isMajor,
        label
      });

      if (clamped >= videoDuration) break;
    }

    return result;
  }, [videoDuration, zoom]);

  const getMinZoom = useCallback(() => {
    if (!timelineScrollRef.current || !videoDuration || videoDuration === 0) return 0.01;
    const rect = timelineScrollRef.current.getBoundingClientRect();
    const containerWidth = rect.width;
    if (containerWidth <= 0) return 0.01;
    const targetWidth = videoDuration * PIXELS_PER_SECOND;
    if (targetWidth <= 0) return 0.01;
    return containerWidth / targetWidth;
  }, [videoDuration]);

  const getMaxZoom = useCallback(() => {
    const minMajorInterval = 0.5;
    const intervals = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const idx = intervals.indexOf(minMajorInterval);
    const nextSmaller = idx > 0 ? intervals[idx - 1] : minMajorInterval;
    const minTickSpacing = 50;
    return (minTickSpacing / (nextSmaller * PIXELS_PER_SECOND)) * 0.99;
  }, []);

  const fitZoomToContainer = useCallback(() => {
    if (!timelineScrollRef.current || !videoDuration || videoDuration === 0) return false;
    const rect = timelineScrollRef.current.getBoundingClientRect();
    const containerWidth = rect.width;
    if (containerWidth <= 0) return false;
    const targetWidth = videoDuration * PIXELS_PER_SECOND;
    if (targetWidth <= 0) return false;
    const newZoom = containerWidth / targetWidth;
    setZoom(Math.min(getMaxZoom(), newZoom));
    return true;
  }, [videoDuration, getMaxZoom]);

  const tryFitZoomWithRetries = useCallback((retries: number = 15) => {
    if (initialZoomSetRef.current) return;
    const done = fitZoomToContainer();
    if (done) {
      initialZoomSetRef.current = true;
    } else if (retries > 0) {
      setTimeout(() => tryFitZoomWithRetries(retries - 1), 80);
    }
  }, [fitZoomToContainer]);

  const handleZoomIn = () => {
    initialZoomSetRef.current = true;
    setZoom(prev => Math.min(prev * 1.5, getMaxZoom()));
  };

  const handleZoomOut = () => {
    initialZoomSetRef.current = true;
    setZoom(prev => Math.max(prev / 1.5, getMinZoom()));
  };

  const handleZoomReset = () => {
    fitZoomToContainer();
    if (timelineScrollRef.current) {
      timelineScrollRef.current.scrollLeft = 0;
    }
  };

  const handleTimelineWheel = useCallback((e: WheelEvent) => {
    if (!timelineScrollRef.current || !videoDuration) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? 0.85 : 1.15;
    const newZoom = Math.max(getMinZoom(), Math.min(getMaxZoom(), zoom * delta));
    if (newZoom === zoom) return;

    initialZoomSetRef.current = true;

    const rect = timelineScrollRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const scrollLeft = timelineScrollRef.current.scrollLeft;
    const mouseTime = (scrollLeft + mouseX) / (PIXELS_PER_SECOND * zoom);

    setZoom(newZoom);

    requestAnimationFrame(() => {
      if (timelineScrollRef.current) {
        const newScrollLeft = mouseTime * PIXELS_PER_SECOND * newZoom - mouseX;
        timelineScrollRef.current.scrollLeft = Math.max(0, newScrollLeft);
      }
    });
  }, [zoom, videoDuration, getMinZoom, getMaxZoom]);

  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el || state === 'processing') return;
    const handler = (e: WheelEvent) => handleTimelineWheel(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
    };
  }, [handleTimelineWheel, state]);

  const [uploadedVideos, setUploadedVideos] = useState<UploadedVideo[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  useEffect(() => {
    initialZoomSetRef.current = false;
    setVideoDuration(0);
    setCurrentTime(0);
  }, [selectedVideoId]);

  useEffect(() => {
    if (isOpen && videoDuration > 0 && !initialZoomSetRef.current) {
      requestAnimationFrame(() => tryFitZoomWithRetries(15));
    }
  }, [isOpen, videoDuration, tryFitZoomWithRetries]);

  const currentVideo = uploadedVideos.find(v => v.id === selectedVideoId);
  const currentVideoRawUrl = currentVideo?.url || '';
  const { url: signedVideoUrl } = useSignedUrl(currentVideoRawUrl);
  const currentVideoUrl = signedVideoUrl;

  useEffect(() => {
    fetch('/api/aliyun/status')
      .then(res => res.json())
      .then(data => {
        if (data.configured) {
          setAliyunConfigured(true);
        }
      })
      .catch(() => {});
  }, []);



  useEffect(() => {
    if (!isOpen) return;

    // 重新打开时重置主动关闭标记
    userClosedRef.current = false;

    if (!isShotMode) {
      // global 模式：从 sessionStorage 恢复全部状态（含 uploadedVideos）
      const cacheKey = `videoSplitCache_global_${projectId}_${sceneId ?? 'null'}`;
      let restored = false;
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          const data = JSON.parse(cached);
          if (data.uploadedVideos && Array.isArray(data.uploadedVideos) && data.uploadedVideos.length > 0) {
            // 缩略图（dataURL）过大且为上传时本地生成，关闭后失效；仅保留 url/name
            setUploadedVideos(data.uploadedVideos.map((v: any) => ({
              id: v.id,
              url: v.url,
              name: v.name,
              isFromShot: v.isFromShot
            })));
            setSelectedVideoId(data.selectedVideoId || (data.uploadedVideos[0]?.id ?? null));
            if (data.splitPoints && Array.isArray(data.splitPoints)) setSplitPoints(data.splitPoints);
            if (data.mode) setMode(data.mode);
            if (data.zoom !== undefined) {
              setZoom(data.zoom);
              initialZoomSetRef.current = true;
            }
            // 恢复 preview 状态相关
            if (data.previewShots && Array.isArray(data.previewShots)) setPreviewShots(data.previewShots);
            if (typeof data.showAIMode === 'boolean') setShowAIMode(data.showAIMode);
            // 如果有 previewShots，恢复到 preview 状态；否则恢复到 initial
            setState(data.previewShots && data.previewShots.length > 0 ? 'preview' : 'initial');
            restored = true;
          }
        }
      } catch (_) { /* 忽略反序列化错误 */ }

      if (!restored) {
        if (initialVideos && initialVideos.length > 0) {
          setUploadedVideos(initialVideos);
          setSelectedVideoId(initialVideos[0].id);
        } else if (initialVideoUrl) {
          const video: UploadedVideo = {
            id: generateId(),
            url: initialVideoUrl,
            name: '视频'
          };
          setUploadedVideos([video]);
          setSelectedVideoId(video.id);
        } else {
          setUploadedVideos([]);
          setSelectedVideoId(null);
        }
        resetSplitState();
        setPreviewShots([]);
        setShowAIMode(false);
      }
    } else {
      // shot 模式：视频列表始终从 initialVideos 初始化，但分割点等状态从缓存（按 shotId）恢复
      const videos = (initialVideos && initialVideos.length > 0) ? initialVideos : [];
      setUploadedVideos(videos);

      let restored = false;
      if (shotId != null) {
        const cacheKey = `videoSplitCache_shot_${shotId}`;
        try {
          const cached = sessionStorage.getItem(cacheKey);
          if (cached) {
            const data = JSON.parse(cached);
            // 恢复选中的视频（用 url 匹配，因为 id 是稳定的 shot_media id）
            const cachedSelectedUrl = data.selectedVideoUrl;
            const matchedVideo = cachedSelectedUrl
              ? videos.find(v => v.url === cachedSelectedUrl)
              : null;
            setSelectedVideoId(matchedVideo ? matchedVideo.id : (videos[0]?.id ?? null));
            if (data.splitPoints && Array.isArray(data.splitPoints)) setSplitPoints(data.splitPoints);
            else setSplitPoints([]);
            if (data.mode) setMode(data.mode);
            else setMode('manual');
            if (data.zoom !== undefined) {
              setZoom(data.zoom);
              initialZoomSetRef.current = true;
            } else {
              setZoom(1);
              initialZoomSetRef.current = false;
            }
            if (data.previewShots && Array.isArray(data.previewShots)) setPreviewShots(data.previewShots);
            else setPreviewShots([]);
            if (typeof data.showAIMode === 'boolean') setShowAIMode(data.showAIMode);
            else setShowAIMode(false);
            setState(data.previewShots && data.previewShots.length > 0 ? 'preview' : 'initial');
            restored = true;
          }
        } catch (_) { /* 忽略反序列化错误 */ }
      }

      if (!restored) {
        setSelectedVideoId(videos[0]?.id ?? null);
        resetSplitState();
        setPreviewShots([]);
        setShowAIMode(false);
      }
    }
  }, [isOpen, initialVideos, initialVideoUrl, projectId, sceneId, isShotMode, shotId]);

  // 状态变化时写入 sessionStorage
  useEffect(() => {
    if (!isOpen) return;
    if (!isShotMode) {
      // global 模式：缓存全部状态
      const cacheKey = `videoSplitCache_global_${projectId}_${sceneId ?? 'null'}`;
      try {
        const data = {
          uploadedVideos: uploadedVideos.map(v => ({
            id: v.id,
            url: v.url,
            name: v.name,
            isFromShot: v.isFromShot
          })),
          selectedVideoId,
          splitPoints,
          mode,
          zoom,
          previewShots,
          showAIMode
        };
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (_) { /* 忽略写入错误（可能存储空间已满） */ }
    } else if (shotId != null) {
      // shot 模式：缓存分割点等状态（不缓存 uploadedVideos，每次从分镜重新传入）
      const cacheKey = `videoSplitCache_shot_${shotId}`;
      const currentVideo = uploadedVideos.find(v => v.id === selectedVideoId);
      try {
        const data = {
          selectedVideoUrl: currentVideo?.url || null,
          splitPoints,
          mode,
          zoom,
          previewShots,
          showAIMode
        };
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (_) { /* 忽略写入错误 */ }
    }
  }, [isOpen, uploadedVideos, selectedVideoId, splitPoints, mode, zoom, previewShots, showAIMode, projectId, sceneId, isShotMode, shotId]);

  const clearSplitCache = useCallback(() => {
    if (!isShotMode) {
      const cacheKey = `videoSplitCache_global_${projectId}_${sceneId ?? 'null'}`;
      try {
        sessionStorage.removeItem(cacheKey);
      } catch (_) { /* 忽略 */ }
    } else if (shotId != null) {
      const cacheKey = `videoSplitCache_shot_${shotId}`;
      try {
        sessionStorage.removeItem(cacheKey);
      } catch (_) { /* 忽略 */ }
    }
  }, [projectId, sceneId, isShotMode, shotId]);

  // P2-11：对话框关闭时清理未被分割使用的孤儿视频（已被 shot_media 引用的不删）
  // 改进：仅在用户主动关闭（取消/应用）时清理；意外关闭（X/ESC/点遮罩）保留视频和缓存
  // shot 模式不涉及 OSS 清理（视频属于分镜）
  const userClosedRef = useRef(false);
  // 记录"应用"模式已引用的视频 URL，清理时排除以避免误删
  const appliedVideoUrlRef = useRef<string | null>(null);
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    // 对话框打开时重置已应用标记
    if (!prevIsOpenRef.current && isOpen) {
      appliedVideoUrlRef.current = null;
    }
    // 检测 isOpen 从 true → false 的变化
    if (prevIsOpenRef.current && !isOpen && uploadedVideos.length > 0 && userClosedRef.current && !isShotMode) {
      const urlsToClean = uploadedVideos
        .filter(v => !v.isFromShot)
        .map(v => v.url)
        .filter(u => u && u.startsWith('http'))
        .filter(u => u !== appliedVideoUrlRef.current);
      // 使用 keepalive 确保页面卸载/导航时也能发请求
      urlsToClean.forEach(url => {
        try {
          fetch('/api/upload/orphan', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            keepalive: true
          }).catch(() => {});
        } catch { /* 忽略，避免关闭流程被阻塞 */ }
      });
      // 清空本地 state（下次打开会重置）
      setUploadedVideos([]);
      setSelectedVideoId(null);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, uploadedVideos, isShotMode]);

  // 重写 handleUserCancel 以标记主动关闭
  const handleUserCancelMarked = () => {
    userClosedRef.current = true;
    clearSplitCache();
    onClose();
  };

  // 重写 handleConfirm 以标记主动关闭
  const handleConfirmMarked = () => {
    // 进入预览状态：弹出确认对话框
    setConfirmDialog(true);
  };

  // 确认创建分镜：使用 previewShots 而非 splitPoints
  const confirmCreate = () => {
    userClosedRef.current = true;
    if (onSplit && currentVideoRawUrl) {
      // 标记已应用的视频 URL，关闭清理时排除以避免误删（onSplit 异步创建 shot_media，清理可能先于引用完成）
      appliedVideoUrlRef.current = currentVideoRawUrl;
      // 重新计算索引，防止用户删除后索引不连续
      const shotsToCreate = previewShots.map((s, i) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        index: i
      }));
      onSplit(shotsToCreate, currentVideoRawUrl);
    }
    setConfirmDialog(false);
    clearSplitCache();
    onClose();
  };

  // 从预览列表中删除指定镜头
  const removePreviewShot = (index: number) => {
    if (playingPreviewIndex === index) {
      setPlayingPreviewIndex(null);
    } else if (playingPreviewIndex !== null && playingPreviewIndex > index) {
      setPlayingPreviewIndex(playingPreviewIndex - 1);
    }
    setPreviewShots(prev => prev.filter((_, i) => i !== index));
  };

  // 从预览状态返回手动调整（保留 splitPoints，丢弃 previewShots）
  const backToManualFromPreview = () => {
    setPlayingPreviewIndex(null);
    setState('initial');
    setPreviewShots([]);
  };

  const generateVideoThumbnail = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      const blobUrl = URL.createObjectURL(file);
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        // 延迟清理，避免浏览器报 ERR_ABORTED
        setTimeout(() => {
          try {
            video.removeAttribute('src');
            video.load();
          } catch { /* ignore */ }
          URL.revokeObjectURL(blobUrl);
        }, 100);
      };

      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('');
      };

      // 超时处理：5秒内没有生成缩略图则返回空
      timeoutId = setTimeout(() => {
        console.warn('[generateVideoThumbnail] 超时，无法生成缩略图');
        fail();
      }, 5000);

      video.onloadedmetadata = () => {
        // 确保有有效时长后再 seek
        if (video.duration > 0) {
          video.currentTime = Math.min(0.5, video.duration * 0.1);
        } else {
          fail();
        }
      };

      video.onseeked = () => {
        if (settled) return;
        settled = true;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, 160, 90);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          } else {
            resolve('');
          }
        } catch (e) {
          console.warn('[generateVideoThumbnail] canvas 绘制失败:', e);
          resolve('');
        } finally {
          cleanup();
        }
      };

      video.onerror = (e) => {
        console.warn('[generateVideoThumbnail] 视频加载失败:', e);
        fail();
      };

      video.src = blobUrl;
    });
  };

  const generateVideoThumbnailFromUrl = (videoUrl: string): Promise<string> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        try {
          video.removeAttribute('src');
          video.load();
        } catch { /* ignore */ }
      };

      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('');
      };

      timeoutId = setTimeout(() => {
        console.warn('[generateVideoThumbnailFromUrl] 超时，无法生成缩略图');
        fail();
      }, 8000);

      video.onloadedmetadata = () => {
        if (video.duration > 0) {
          video.currentTime = Math.min(0.5, video.duration * 0.1);
        } else {
          fail();
        }
      };

      video.onseeked = () => {
        if (settled) return;
        settled = true;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, 160, 90);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          } else {
            resolve('');
          }
        } catch (e) {
          console.warn('[generateVideoThumbnailFromUrl] canvas 绘制失败:', e);
          resolve('');
        } finally {
          cleanup();
        }
      };

      video.onerror = (e) => {
        console.warn('[generateVideoThumbnailFromUrl] 视频加载失败:', e);
        fail();
      };

      video.src = videoUrl;
    });
  };

  const handleUploadClick = async () => {
    const remainingSlots = maxUploads - uploadedVideos.length;
    if (remainingSlots <= 0) {
      setError(`最多只能上传 ${maxUploads} 个视频`);
      return;
    }

    setError(null);

    const results = await startUpload({
      projectId,
      sceneId,
      usage: 'shot-reference',
      accept: 'video/*',
      multiple: true,
      maxFiles: Math.min(10, remainingSlots),
      createShot: false,
    });

    if (results.length > 0) {
      const newVideos: UploadedVideo[] = [];
      for (const r of results) {
        let thumbnail = '';
        try {
          thumbnail = getVideoThumbnail(r.url);
          if (!thumbnail) {
            thumbnail = await generateVideoThumbnailFromUrl(r.url);
          }
        } catch (e) {
          console.warn('[handleUploadClick] 缩略图生成失败:', e);
        }
        newVideos.push({
          id: generateId(),
          url: r.url,
          name: r.filename,
          thumbnail,
        });
      }
      setUploadedVideos(prev => [...prev, ...newVideos]);
      if (!selectedVideoId && newVideos.length > 0) {
        setSelectedVideoId(newVideos[0].id);
      }
    }
  };

  const handleSelectVideo = (videoId: string) => {
    if (videoId === selectedVideoId) return;
    if (videoRef.current) {
      videoRef.current.pause();
    }
    if (thumbVideoRef.current) {
      thumbVideoRef.current.pause();
      thumbVideoRef.current.removeAttribute('src');
      thumbVideoRef.current.load();
    }
    setSelectedVideoId(videoId);
    resetSplitState();
  };

  // 删除已上传视频（仅 global 模式）：调用后端删除 OSS 文件并从列表移除
  const handleDeleteVideo = (videoId: string) => {
    const video = uploadedVideos.find(v => v.id === videoId);
    if (!video) return;
    // 调用后端删除 OSS 孤儿文件
    if (video.url && video.url.startsWith('http')) {
      try {
        fetch('/api/upload/orphan', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: video.url }),
          keepalive: true
        }).catch(() => {});
      } catch { /* 忽略 */ }
    }
    const remaining = uploadedVideos.filter(v => v.id !== videoId);
    setUploadedVideos(remaining);
    // 若删除的是当前选中视频，切换到第一个
    if (selectedVideoId === videoId) {
      if (remaining.length > 0) {
        setSelectedVideoId(remaining[0].id);
        resetSplitState();
      } else {
        setSelectedVideoId(null);
        resetSplitState();
      }
    }
  };

  const resetSplitState = useCallback(() => {
    setMode('manual');
    setState('initial');
    setProgress(0);
    setCurrentPhase('');
    setDetectedShots(0);
    setSplitPoints([]);
    setEstimatedCost(0);
    setError(null);
    setTaskId(null);
    setShotThumbnails({});
    setVideoDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const duration = videoRef.current.duration;
      setVideoDuration(duration);
      requestAnimationFrame(() => tryFitZoomWithRetries(15));
    }
  };

  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
    }
  };

  const togglePreviewPlay = (index: number) => {
    if (playingPreviewIndex === index) {
      setPlayingPreviewIndex(null);
    } else {
      setPlayingPreviewIndex(index);
    }
  };

  const seekTo = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const addSplitPoint = () => {
    if (videoDuration === 0) return;

    const tooClose = splitPoints.some(p => Math.abs(p.time - currentTime) < 0.1);
    if (tooClose) {
      setError('分割点距离太近');
      return;
    }

    setError(null);
    const newPoint: SplitPoint = {
      id: generateId(),
      time: currentTime
    };
    setSplitPoints(prev => [...prev, newPoint].sort((a, b) => a.time - b.time));
  };

  const removeSplitPoint = (id: string) => {
    setSplitPoints(prev => prev.filter(p => p.id !== id));
  };

  const clearAllSplitPoints = () => {
    setSplitPoints([]);
  };

  const handleTimelineMouseDown = (e: React.MouseEvent, pointId: string) => {
    e.preventDefault();
    const point = splitPoints.find(p => p.id === pointId);
    if (point) {
      dragStartPointRef.current = point.time;
    }
    setDraggingPoint(pointId);
  };

  const handleTimelineTouchStart = (e: React.TouchEvent, pointId: string) => {
    e.stopPropagation();
    const point = splitPoints.find(p => p.id === pointId);
    if (point) {
      dragStartPointRef.current = point.time;
    }
    setDraggingPoint(pointId);
  };

  const handleTimelineMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingPoint || !timelineRef.current || !videoDuration) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let newTime = percentage * videoDuration;

    newTime = Math.max(0, Math.min(videoDuration, newTime));

    setSplitPoints(prev =>
      prev.map(p => (p.id === draggingPoint ? { ...p, time: newTime } : p))
    );

    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  }, [draggingPoint, videoDuration, splitPoints]);

  const handleTimelineTouchMove = useCallback((e: TouchEvent) => {
    if (!draggingPoint || !timelineRef.current || !videoDuration) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    let newTime = percentage * videoDuration;

    newTime = Math.max(0, Math.min(videoDuration, newTime));

    setSplitPoints(prev =>
      prev.map(p => (p.id === draggingPoint ? { ...p, time: newTime } : p))
    );

    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  }, [draggingPoint, videoDuration, splitPoints]);

  const handleTimelineMouseUp = useCallback(() => {
    if (draggingPoint && videoDuration > 0) {
      setError(null);
    }
    setDraggingPoint(null);
  }, [draggingPoint, splitPoints, videoDuration]);

  const handleTimelineTouchEnd = useCallback(() => {
    if (draggingPoint && videoDuration > 0) {
      setError(null);
    }
    setDraggingPoint(null);
  }, [draggingPoint, splitPoints, videoDuration]);

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startZoom: number;
    startCenterX: number;
  }>({ active: false, startDist: 0, startZoom: 1, startCenterX: 0 });

  const handlePinchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();

    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const centerX = (t1.clientX + t2.clientX) / 2;

    pinchRef.current = {
      active: true,
      startDist: dist,
      startZoom: zoom,
      startCenterX: centerX
    };
  }, [zoom]);

  const handlePinchMove = useCallback((e: TouchEvent) => {
    if (!pinchRef.current.active || e.touches.length !== 2) return;
    if (!timelineScrollRef.current || !videoDuration) return;
    e.preventDefault();

    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const scale = dist / pinchRef.current.startDist;
    const newZoom = Math.max(getMinZoom(), Math.min(getMaxZoom(), pinchRef.current.startZoom * scale));

    if (newZoom === zoom) return;

    initialZoomSetRef.current = true;

    const scrollRect = timelineScrollRef.current.getBoundingClientRect();
    const mouseX = pinchRef.current.startCenterX - scrollRect.left;
    const scrollLeft = timelineScrollRef.current.scrollLeft;
    const mouseTime = (scrollLeft + mouseX) / (PIXELS_PER_SECOND * pinchRef.current.startZoom);

    setZoom(newZoom);

    requestAnimationFrame(() => {
      if (timelineScrollRef.current) {
        const newScrollLeft = mouseTime * PIXELS_PER_SECOND * newZoom - mouseX;
        timelineScrollRef.current.scrollLeft = Math.max(0, newScrollLeft);
      }
    });
  }, [zoom, videoDuration, getMinZoom, getMaxZoom]);

  const handlePinchEnd = useCallback(() => {
    pinchRef.current.active = false;
  }, []);

  useEffect(() => {
    if (draggingPoint) {
      document.addEventListener('mousemove', handleTimelineMouseMove);
      document.addEventListener('mouseup', handleTimelineMouseUp);
      document.addEventListener('touchmove', handleTimelineTouchMove, { passive: false });
      document.addEventListener('touchend', handleTimelineTouchEnd);
      return () => {
        document.removeEventListener('mousemove', handleTimelineMouseMove);
        document.removeEventListener('mouseup', handleTimelineMouseUp);
        document.removeEventListener('touchmove', handleTimelineTouchMove);
        document.removeEventListener('touchend', handleTimelineTouchEnd);
      };
    }
  }, [draggingPoint, handleTimelineMouseMove, handleTimelineMouseUp, handleTimelineTouchMove, handleTimelineTouchEnd]);

  const [isPanDragging, setIsPanDragging] = useState(false);
  const panStartXRef = useRef(0);
  const panStartScrollLeftRef = useRef(0);

  useEffect(() => {
    const scrollEl = timelineScrollRef.current;
    if (!scrollEl) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        handlePinchStart(e);
        setIsPanDragging(false);
      } else if (e.touches.length === 1 && !draggingPoint) {
        const touch = e.touches[0];
        const target = e.target as HTMLElement;
        if (target.closest('[data-split-point]')) return;
        panStartXRef.current = touch.clientX;
        panStartScrollLeftRef.current = scrollEl.scrollLeft;
        setIsPanDragging(true);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        handlePinchMove(e);
      } else if (e.touches.length === 1 && isPanDragging) {
        e.preventDefault();
        const touch = e.touches[0];
        const deltaX = touch.clientX - panStartXRef.current;
        scrollEl.scrollLeft = panStartScrollLeftRef.current - deltaX;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        handlePinchEnd();
      }
      if (isPanDragging) {
        setIsPanDragging(false);
      }
    };

    scrollEl.addEventListener('touchstart', onTouchStart, { passive: false });
    scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
    scrollEl.addEventListener('touchend', onTouchEnd);
    scrollEl.addEventListener('touchcancel', onTouchEnd);

    return () => {
      scrollEl.removeEventListener('touchstart', onTouchStart);
      scrollEl.removeEventListener('touchmove', onTouchMove);
      scrollEl.removeEventListener('touchend', onTouchEnd);
      scrollEl.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [handlePinchStart, handlePinchMove, handlePinchEnd, isPanDragging, draggingPoint]);

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (draggingPoint || isPanDragging || !timelineRef.current || !videoDuration) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    const clickTime = Math.max(0, Math.min(videoDuration, percentage * videoDuration));

    const clickedPoint = splitPoints.find(p => Math.abs(p.time - clickTime) < 0.5);
    if (clickedPoint) {
      setSelectedSplitPoint(clickedPoint.id);
    } else {
      setSelectedSplitPoint(null);
    }

    seekTo(clickTime);
  };

  const handleSplitPointClick = (e: React.MouseEvent, pointId: string) => {
    e.stopPropagation();
    setSelectedSplitPoint(pointId);
    const point = splitPoints.find(p => p.id === pointId);
    if (point) {
      seekTo(point.time);
    }
  };

  const pollTaskStatus = useCallback((tid: string) => {
    let sseFailed = false;
    let sseClosed = false;

    try {
      const eventSource = new EventSource(`/api/ai/task/${tid}/stream`);

      const handleTaskUpdate = (data: AiTaskUpdate) => {
        if (sseClosed) return;

        if (data.status === 'processing' || data.status === 'pending') {
          setProgress(data.progress || 0);
          setCurrentPhase(getPhaseText(data.output));
          if (data.output?.shots) {
            setDetectedShots(data.output.shots.length);
          }
        } else if (data.status === 'done' || data.status === 'completed') {
          sseClosed = true;
          eventSource.close();
          setProgress(100);
          setDetectedShots(data.output?.shots?.length || 0);
          setEstimatedCost(data.output?.estimatedCost || 0);

          // 阿里云拆条返回空结果时，给出明确提示
          if (!data.output?.shots || data.output.shots.length === 0) {
            setError('阿里云分析完成，但未检测到镜头切换点。请尝试手动添加分割点，或调整视频后重试。');
            setState('initial');
            setMode('manual');
            setShowAIMode(false);
            return;
          }

          // AI 完成: 提取分割点时间，设置为 splitPoints，回到手动模式
          const shots = data.output.shots as Array<{ startTime?: number; endTime?: number; media?: Array<{ startTime?: number; duration?: number }> }>;
          // 不再假设第一个 shot 从 0 开始；将所有 startTime > 0.5 的作为分割点
          // （阿里云拆条返回的可能是主题段落，第一个 beginTime 不一定是 0）
          const newSplitPoints: SplitPoint[] = shots
            .map(shot => ({
              id: generateId(),
              time: shot.startTime ?? shot.media?.[0]?.startTime ?? 0
            }))
            .filter(p => p.time > 0.5);
          setSplitPoints(newSplitPoints);

          setMode('manual');
          setShowAIMode(false);
          setState('initial');  // 回到手动模式，用户可调整后点击“开始分割”
        } else if (data.status === 'error' || data.status === 'failed') {
          sseClosed = true;
          eventSource.close();
          setAiError(data.error || '分割失败，请重试');
          setState('initial');
        }
      };

      eventSource.addEventListener('update', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          handleTaskUpdate(data);
        } catch (e) {
          console.error('解析 SSE 消息失败:', e);
        }
      });

      eventSource.addEventListener('error', (event: MessageEvent) => {
        if (sseClosed) return;
        sseFailed = true;
        eventSource.close();
        startPolling();
      });

      eventSource.onerror = () => {
        if (sseClosed) return;
        if (!sseFailed) {
          sseFailed = true;
          eventSource.close();
          startPolling();
        }
      };

      const startPolling = () => {
        pollIntervalRef.current = setInterval(async () => {
          try {
            const res = await fetch(`/api/ai/task/${tid}`);
            const data: TaskResult = await res.json();

            if (data.status === 'processing' || data.status === 'pending') {
              setProgress(data.progress || 0);
              setCurrentPhase(getPhaseText(data.output));
              if (data.output?.shots) {
                setDetectedShots(data.output.shots.length);
              }
            } else if (data.status === 'done') {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setProgress(100);
              setDetectedShots(data.output?.shots?.length || 0);
              setEstimatedCost(data.output?.estimatedCost || 0);

              if (!data.output?.shots || data.output.shots.length === 0) {
                setError('阿里云分析完成，但未检测到镜头切换点。请尝试手动添加分割点，或调整视频后重试。');
                setState('initial');
                setMode('manual');
                setShowAIMode(false);
                return;
              }

              const shots = data.output.shots as Array<{ startTime?: number; media?: Array<{ startTime?: number }> }>;
              const newSplitPoints: SplitPoint[] = shots
                .map(shot => ({
                  id: generateId(),
                  time: shot.startTime ?? shot.media?.[0]?.startTime ?? 0
                }))
                .filter(p => p.time > 0.5);
              setSplitPoints(newSplitPoints);

              setMode('manual');
              setShowAIMode(false);
              setState('initial');
            } else if (data.status === 'error') {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setAiError(data.error || '分割失败，请重试');
              setState('initial');
            }
          } catch (e) {
            console.error('轮询任务状态失败:', e);
          }
        }, 2000);
      };
    } catch (e) {
      console.warn('SSE 不可用，使用轮询:', e);
      pollIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/ai/task/${tid}`);
          const data: TaskResult = await res.json();

          if (data.status === 'processing' || data.status === 'pending') {
            setProgress(data.progress || 0);
            setCurrentPhase(getPhaseText(data.output));
            if (data.output?.shots) {
              setDetectedShots(data.output.shots.length);
            }
          } else if (data.status === 'done') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setProgress(100);
            setDetectedShots(data.output?.shots?.length || 0);
            setEstimatedCost(data.output?.estimatedCost || 0);

            if (data.output?.shots) {
              const shots = data.output.shots as Array<{ startTime?: number; media?: Array<{ startTime?: number }> }>;
              const newSplitPoints: SplitPoint[] = shots
                .slice(1)
                .map(shot => ({
                  id: generateId(),
                  time: shot.startTime ?? shot.media?.[0]?.startTime ?? 0
                }))
                .filter(p => p.time > 0);
              setSplitPoints(newSplitPoints);
            }

            setMode('manual');
            setShowAIMode(false);
            setState('initial');  // 回到手动模式
          } else if (data.status === 'error') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setAiError(data.error || '分割失败，请重试');
            setState('initial');
          }
        } catch (e) {
          console.error('轮询任务状态失败:', e);
        }
      }, 2000);
    }
  }, []);

  const handleStartSplit = async (overrideMode?: SplitMode) => {
    const effectiveMode = overrideMode || mode;
    if (!currentVideoUrl) return;

    // 手动模式：直接基于当前分割点生成分割结果预览，不调用后端 API
    if (effectiveMode === 'manual') {
      const shots: SplitShot[] = splitPoints.length > 0
        ? (() => {
            const result: SplitShot[] = [];
            const times = [0, ...splitPoints.map(p => p.time), videoDuration].sort((a, b) => a - b);
            for (let i = 0; i < times.length - 1; i++) {
              const startTime = times[i];
              const endTime = times[i + 1];
              if (endTime - startTime >= MIN_SHOT_DURATION) {
                result.push({
                  startTime,
                  endTime,
                  index: result.length
                });
              }
            }
            if (result.length === 0) {
              result.push({ startTime: 0, endTime: videoDuration, index: 0 });
            }
            return result;
          })()
        : [{ startTime: 0, endTime: videoDuration, index: 0 }];
      setShotThumbnails({});
      setPreviewShots(shots);
      setState('preview');
      return;
    }

    // AI 模式：调用后端 API
    setError(null);
    setAiError(null);
    setState('processing');
    setProgress(5);
    const actualMode = effectiveMode === 'aliyun' ? 'aliyun' : 'ai_frame';
    setCurrentPhase(actualMode === 'aliyun' ? '正在上传视频到阿里云分析服务...' : '正在服务器端分析镜头切换点...');

    try {
      
      const body: {
        videoUrl: string;
        projectId: number;
        mode: string;
        sceneId?: number | null;
      } = {
        videoUrl: currentVideoRawUrl,
        projectId,
        mode: actualMode
      };

      if (sceneId !== undefined && sceneId !== null) {
        body.sceneId = sceneId;
      }

      const res = await fetch('/api/ai/split-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`服务器返回错误: ${res.status}`);
      }

      const data = await res.json();

      if (data.taskId) {
        setTaskId(data.taskId);
        pollTaskStatus(data.taskId);
      } else if (data.error || data.message) {
        setAiError(data.error || data.message);
        setState('initial');
      } else {
        throw new Error('服务器未返回任务ID');
      }
    } catch (e) {
      console.error('提交分割任务失败:', e);
      setAiError('网络错误，请重试');
      setState('initial');
    }
  };

  const generateThumbnail = (time: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const video = thumbVideoRef.current;
      const canvas = thumbCanvasRef.current;
      if (!video || !canvas) {
        reject(new Error('video or canvas not available'));
        return;
      }

      const handleSeeked = () => {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas context not available'));
            return;
          }
          canvas.width = 160;
          canvas.height = 90;
          ctx.drawImage(video, 0, 0, 160, 90);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          video.removeEventListener('seeked', handleSeeked);
          resolve(dataUrl);
        } catch (e) {
          video.removeEventListener('seeked', handleSeeked);
          reject(e);
        }
      };

      video.addEventListener('seeked', handleSeeked);
      video.currentTime = Math.min(time, video.duration - 0.1);
    });
  };

  const generateAllThumbnails = useCallback(async () => {
    if (!thumbVideoRef.current) return;
    // 有 previewShots 时用 previewShots 的 startTime，否则用 splitPoints
    const times = previewShots.length > 0
      ? previewShots.map(s => s.startTime)
      : [0, ...splitPoints.map(p => p.time)];
    if (times.length === 0) return;

    setGeneratingThumbs(true);
    const thumbs: Record<string, string> = {};

    try {
      for (let i = 0; i < times.length; i++) {
        try {
          const thumb = await generateThumbnail(times[i]);
          thumbs[`shot_${i}`] = thumb;
        } catch (e) {
          console.warn('生成缩略图失败:', times[i], e);
        }
      }
      setShotThumbnails(thumbs);
    } finally {
      setGeneratingThumbs(false);
    }
  }, [splitPoints, previewShots]);

  useEffect(() => {
    if (videoDuration > 0 && currentVideoUrl &&
        (state === 'completed' || state === 'preview') &&
        (splitPoints.length > 0 || previewShots.length > 0)) {
      generateAllThumbnails();
    }
  }, [state, videoDuration, splitPoints, previewShots, generateAllThumbnails, currentVideoUrl]);

  const handleCancel = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setAiError(null);
    setState('initial');
    setProgress(0);
  };

  const getShotCount = () => {
    if (splitPoints.length === 0) return 1;
    return splitPoints.length + 1;
  };

  if (!isOpen) return null;

  const sceneCount = getShotCount();

  return (
    <div
      className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] ${isMobile ? 'p-0' : 'p-8 sm:p-4'}`}
      onClick={onClose}
    >
      <div
        className={`absolute ${isMobile ? 'inset-0 rounded-none max-h-none' : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[90vh] min-h-[700px] h-[85vh] rounded-3xl'} w-full border border-white/10 bg-slate-900 flex flex-col shadow-2xl`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between ${isMobile ? 'px-4 py-3' : 'px-6 py-4'} border-b border-white/10`}>
          <h2 className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold`}>视频分割为分镜</h2>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={`flex-1 ${isMobile ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'} flex ${isMobile ? 'flex-col' : 'flex-row'}`}>
          <div className={`${isMobile ? 'w-full border-b border-r-0 px-3 py-2 grid grid-cols-2 gap-3' : 'w-36 border-r border-white/10 p-3 space-y-2 overflow-y-auto custom-scrollbar flex-shrink-0'}`}>
            {isMobile ? (
              <>
                {uploadedVideos.map(video => (
                  <div
                    key={video.id}
                    onClick={() => handleSelectVideo(video.id)}
                    className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all relative ${
                      selectedVideoId === video.id
                        ? 'border-violet-500 ring-1 ring-violet-500/30'
                        : 'border-white/10'
                    }`}
                  >
                    <div className="aspect-video bg-black relative">
                      {video.thumbnail ? (
                        <img src={video.thumbnail} alt={video.name} className="w-full h-full object-cover" />
                      ) : (
                        <img
                          src={getVideoThumbnail(video.url) || ''}
                          alt={video.name}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                          }}
                        />
                      )}
                    </div>
                    {!isShotMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteVideo(video.id); }}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white/80 hover:text-white transition"
                        title="删除视频"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
                {!isShotMode && uploadedVideos.length < maxUploads && (
                  <button
                    onClick={handleUploadClick}
                    className="aspect-video rounded-lg border-2 border-dashed border-white/15 hover:border-violet-500/50 hover:bg-violet-500/10 transition-all flex flex-col items-center justify-center"
                  >
                    <Upload className="w-4 h-4 text-slate-400 mb-1" />
                    <div className="text-[10px] text-slate-400">上传</div>
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="text-xs text-slate-400 mb-2">
                  {isShotMode
                    ? `参考视频 (${uploadedVideos.length})`
                    : `已上传 (${uploadedVideos.length}/${maxUploads})`
                  }
                </div>
                <div className="space-y-2">
                  {uploadedVideos.map(video => (
                    <div
                      key={video.id}
                      onClick={() => handleSelectVideo(video.id)}
                      className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all relative ${
                        selectedVideoId === video.id
                          ? 'border-violet-500 ring-1 ring-violet-500/30'
                          : 'border-white/10 hover:border-white/20'
                      }`}
                    >
                      <div className="aspect-video bg-black relative">
                        {video.thumbnail ? (
                          <img src={video.thumbnail} alt={video.name} className="w-full h-full object-cover" />
                        ) : (
                          <img
                            src={getVideoThumbnail(video.url) || ''}
                            alt={video.name}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                            }}
                          />
                        )}
                        {!isShotMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteVideo(video.id); }}
                            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-red-500 flex items-center justify-center text-white/80 hover:text-white transition"
                            title="删除视频"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div className="px-2 py-1 text-xs text-slate-400 truncate bg-white/5">
                        {video.name}
                      </div>
                    </div>
                  ))}
                </div>

                {!isShotMode && uploadedVideos.length < maxUploads && (
                  <button
                    onClick={handleUploadClick}
                    className="w-full p-3 rounded-lg border-2 border-dashed border-white/15 hover:border-violet-500/50 hover:bg-violet-500/10 transition-all"
                  >
                    <Upload className="w-4 h-4 mx-auto text-slate-400 mb-1" />
                    <div className="text-xs text-slate-400">上传视频</div>
                  </button>
                )}
              </>
            )}
          </div>

          <div className={`${isMobile ? '' : 'flex-1 overflow-y-auto custom-scrollbar'} ${isMobile ? 'p-3 space-y-3' : 'p-6 space-y-5'}`}>
            {error && (
              <AiErrorGuide
                error={error}
                onOpenSettings={onOpenSettings}
              />
            )}

            {!currentVideoUrl && (
              <div className="text-center py-12 text-slate-500">
                <Video className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">请从左侧上传视频，或选择已上传的视频</p>
              </div>
            )}

            {currentVideoUrl && (
              <>
                <div className="space-y-5">
                  <div className="relative rounded-2xl overflow-hidden bg-black aspect-video">
                    <video
                      ref={videoRef}
                      src={currentVideoUrl}
                      poster={currentVideoRawUrl ? getVideoPoster(currentVideoRawUrl) : undefined}
                      className="w-full h-full object-contain"
                      onTimeUpdate={handleTimeUpdate}
                      onLoadedMetadata={handleLoadedMetadata}
                      onPlay={handlePlay}
                      onPause={handlePause}
                    />
                    {state !== 'processing' && !isPlaying && (
                      <button
                        onClick={togglePlay}
                        className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition"
                      >
                        <Play className="w-12 h-12 text-white/80" />
                      </button>
                    )}
                    {state !== 'processing' && isPlaying && (
                      <button
                        onClick={togglePlay}
                        className="absolute inset-0"
                        aria-label="暂停"
                      />
                    )}
                    {state === 'processing' && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="w-8 h-8 text-violet-400 animate-spin mx-auto mb-2" />
                          <div className="text-sm text-white">正在分析视频... {progress}%</div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-slate-300">时间轴：</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-400">
                          {formatTime(currentTime)} / {formatTime(videoDuration)}
                        </span>
                        <div className="flex items-center gap-1 ml-2">
                          <button
                            onClick={handleZoomOut}
                            disabled={zoom <= getMinZoom() + 0.001 || !videoDuration}
                            className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-300 transition disabled:opacity-30 disabled:cursor-not-allowed"
                            title="缩小"
                          >
                            <ZoomOut className="w-4 h-4" />
                          </button>
                          <span className="text-xs text-slate-400 w-12 text-center">
                            {zoom.toFixed(1)}x
                          </span>
                          <button
                            onClick={handleZoomIn}
                            disabled={zoom >= getMaxZoom() - 0.001 || !videoDuration}
                            className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-300 transition disabled:opacity-30 disabled:cursor-not-allowed"
                            title="放大"
                          >
                            <ZoomIn className="w-4 h-4" />
                          </button>
                          <button
                            onClick={handleZoomReset}
                            disabled={Math.abs(zoom - getMinZoom()) < 0.001 || !videoDuration}
                            className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-300 transition disabled:opacity-30 disabled:cursor-not-allowed"
                            title="重置缩放"
                          >
                            <Maximize2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div
                      ref={timelineScrollRef}
                      className={`relative overflow-x-scroll overflow-y-hidden rounded-none bg-white/5 custom-scrollbar ${state === 'processing' ? 'cursor-not-allowed opacity-60' : ''}`}
                      style={{ height: 96 }}
                    >
                      {/* 刻度：在时间轴上方 */}
                      <div
                        className="absolute top-0 left-0 pointer-events-none"
                        style={{ width: timelineWidth, height: 36 }}
                      >
                        {ticks.map((tick, idx) => (
                          <div
                            key={idx}
                            className="absolute bottom-0"
                            style={{ left: (tick.time / videoDuration) * 100 + '%' }}
                          >
                            {tick.label && (
                              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-slate-500 whitespace-nowrap">
                                {tick.label}
                              </div>
                            )}
                            <div
                              className={`border-l ${tick.isMajor ? 'border-slate-500 h-2.5' : 'border-slate-600/60 h-1.5'}`}
                              style={{ marginLeft: -0.5 }}
                            />
                          </div>
                        ))}
                      </div>

                      {/* 时间轴：在刻度下方，顶部对齐 */}
                      <div
                        ref={timelineRef}
                        className={`absolute top-9 left-0 h-12 ${state === 'processing' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        style={{ width: timelineWidth }}
                        onClick={state === 'processing' ? undefined : handleTimelineClick}
                      >
                        <div className="absolute inset-0 bg-white/10 rounded-lg" />

                        <div
                          className="absolute top-0 left-0 h-full bg-violet-500/20 rounded-l-lg pointer-events-none"
                          style={{ width: `${(currentTime / videoDuration) * 100}%` }}
                        />

                        {splitPoints.map(point => (
                          <div
                            key={point.id}
                            data-split-point="true"
                            className={`absolute top-0 ${isMobile ? 'w-8 -ml-4' : 'w-1'} h-full cursor-ew-resize z-10 ${state === 'processing' ? 'pointer-events-none' : ''}`}
                            style={{ left: `${(point.time / videoDuration) * 100}%` }}
                            onMouseDown={state === 'processing' ? undefined : (e => handleTimelineMouseDown(e, point.id))}
                            onTouchStart={state === 'processing' ? undefined : (e => handleTimelineTouchStart(e, point.id))}
                            onClick={state === 'processing' ? undefined : (e => handleSplitPointClick(e, point.id))}
                          >
                            <div className={`absolute top-0 left-1/2 -translate-x-1/2 ${isMobile ? 'w-0.5' : 'w-full'} h-full ${selectedSplitPoint === point.id ? 'bg-yellow-400' : 'bg-violet-500'}`} />
                            <div className={`absolute -top-1 left-1/2 -translate-x-1/2 ${isMobile ? 'w-6 h-6' : 'w-4 h-4'} rounded-full border-2 border-white shadow-lg ${selectedSplitPoint === point.id ? 'bg-yellow-400' : 'bg-violet-500'}`} />
                          </div>
                        ))}

                        <div
                          className="absolute top-0 w-0.5 h-full bg-white z-20 pointer-events-none"
                          style={{ left: `${(currentTime / videoDuration) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {state === 'initial' && (
                    <>
                      <div className={`flex ${isMobile ? 'flex-col gap-2' : 'items-center gap-3'}`}>
                        <button
                          onClick={addSplitPoint}
                          disabled={!currentVideoUrl}
                          className={`flex items-center justify-center gap-2 ${isMobile ? 'w-full py-3 text-base' : 'px-4 py-2 text-sm'} rounded-xl bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 transition disabled:opacity-40`}
                        >
                          <Plus className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                          {isMobile ? '添加分割点' : '添加分割点'}
                        </button>
                        <button
                          onClick={clearAllSplitPoints}
                          disabled={splitPoints.length === 0}
                          className={`flex items-center justify-center gap-2 ${isMobile ? 'w-full py-3 text-base' : 'px-4 py-2 text-sm'} rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 transition disabled:opacity-40 disabled:cursor-not-allowed`}
                        >
                          <Trash2 className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                          {isMobile ? '清除全部' : '清除全部'}
                        </button>
                        {mode === 'manual' && (
                          <button
                            onClick={handleStartSplit}
                            disabled={splitPoints.length === 0}
                            className={`flex items-center justify-center gap-2 ${isMobile ? 'w-full py-3 text-base' : 'px-4 py-2 text-sm'} rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-medium transition disabled:opacity-50 disabled:cursor-not-allowed`}
                          >
                            <Scissors className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                            开始分割
                          </button>
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="text-sm text-slate-400">
                          已标记 <span className="text-violet-400 font-medium">{splitPoints.length}</span> 个分割点，将生成{' '}
                          <span className="text-violet-400 font-medium">{sceneCount}</span> 个分镜
                        </div>
                        <div className="text-xs text-slate-500">
                          时长小于 0.5 秒的片段将被自动过滤
                        </div>
                      </div>

                      {splitPoints.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {splitPoints.map((point, idx) => (
                            <div
                              key={point.id}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition ${selectedSplitPoint === point.id ? 'bg-yellow-500/10 border-yellow-500/50' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                              onClick={() => {
                                setSelectedSplitPoint(point.id);
                                seekTo(point.time);
                              }}
                            >
                              <span className="text-slate-400">#{idx + 1}</span>
                              <span className="text-white">{formatTime(point.time)}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); removeSplitPoint(point.id); }}
                                className="text-slate-500 hover:text-red-400 transition"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {state === 'preview' && previewShots.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-slate-300">
                          分割结果：共 <span className="text-violet-400 font-medium">{previewShots.length}</span> 个镜头（可删除不需要的）
                        </div>
                        <button
                          onClick={backToManualFromPreview}
                          className="text-xs text-slate-400 hover:text-violet-400 transition flex items-center gap-1"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          返回调整
                        </button>
                      </div>
                      <div className={`grid gap-3 ${isMobile ? 'grid-cols-2 max-h-72' : 'grid-cols-3 max-h-80'} overflow-y-auto custom-scrollbar pr-1`}>
                        {previewShots.map((shot, idx) => {
                          // 优先使用 canvas 生成的精确缩略图，回退到 OSS 截图
                          const thumbKey = `shot_${idx}`;
                          const posterUrl = shotThumbnails[thumbKey]
                            || getVideoPoster(currentVideoRawUrl || '', shot.startTime);
                          const isPlaying = playingPreviewIndex === idx;

                          return (
                            <div
                              key={idx}
                              className="relative rounded-xl overflow-hidden bg-slate-800/50 border border-white/10 group"
                            >
                              <div className="aspect-video bg-black relative">
                                {posterUrl && !isPlaying && (
                                  <img
                                    src={posterUrl}
                                    alt={`分镜 ${idx + 1}`}
                                    className="w-full h-full object-cover"
                                  />
                                )}
                                {isPlaying && currentVideoUrl && (
                                  <video
                                    className="w-full h-full object-contain"
                                    src={currentVideoUrl}
                                    autoPlay
                                    muted
                                    playsInline
                                    onLoadedMetadata={(e) => {
                                      const v = e.currentTarget;
                                      v.currentTime = shot.startTime;
                                    }}
                                    onTimeUpdate={(e) => {
                                      const v = e.currentTarget;
                                      if (v.currentTime >= shot.endTime) {
                                        v.currentTime = shot.startTime;
                                      }
                                    }}
                                  />
                                )}
                                <button
                                  onClick={() => togglePreviewPlay(idx)}
                                  className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition group-hover:bg-black/30"
                                >
                                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPlaying ? 'bg-white/90' : 'bg-white/80'}`}>
                                    {isPlaying ? (
                                      <Pause className="w-5 h-5 text-slate-800" />
                                    ) : (
                                      <Play className="w-5 h-5 text-slate-800 ml-0.5" />
                                    )}
                                  </div>
                                </button>
                                <div className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-black/60 text-xs font-medium text-white">
                                  #{idx + 1}
                                </div>
                              </div>
                              <div className="p-2.5">
                                <div className="text-xs text-white">
                                  {formatTime(shot.startTime)} - {formatTime(shot.endTime)}
                                </div>
                                <div className="flex items-center justify-between mt-1">
                                  <div className="text-[10px] text-slate-500">
                                    时长：{(shot.endTime - shot.startTime).toFixed(1)}秒
                                  </div>
                                  <button
                                    onClick={() => removePreviewShot(idx)}
                                    className="w-6 h-6 rounded-md flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition"
                                    title="删除该镜头"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {state === 'processing' && (
                    <div className="text-center">
                      <div className="h-2 rounded-full bg-white/10 overflow-hidden mb-3">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="text-sm text-slate-300 mb-1 font-medium">{currentPhase}</p>
                      <p className="text-xs text-slate-500 mb-3">
                        {mode === 'aliyun' ? '阿里云智能拆条' : '快速镜头检测'}
                        {detectedShots > 0 && ` · 已识别 ${detectedShots} 个镜头`}
                      </p>
                      <button
                        onClick={handleCancel}
                        className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
                      >
                        取消处理
                      </button>
                    </div>
                  )}
                </div>

                {state === 'initial' && (
                  <div className={`${isMobile ? 'mt-4 space-y-2' : 'mt-6 space-y-3'}`}>
                    <button
                      onClick={() => setShowAIMode(!showAIMode)}
                      className={`w-full flex items-center justify-between ${isMobile ? 'p-3' : 'p-4'} rounded-xl border-2 transition-all ${
                        showAIMode
                          ? 'border-violet-500 bg-violet-500/10'
                          : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-center gap-3 text-left">
                        <Sparkles className={`${isMobile ? 'w-5 h-5' : 'w-5 h-5'} text-violet-400`} />
                        <div>
                          <div className="text-sm font-medium text-white">智能拆条</div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            自动识别镜头切换点，生成后可手动微调
                          </div>
                        </div>
                      </div>
                      <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${showAIMode ? 'rotate-180' : ''}`} />
                    </button>

                    {showAIMode && (
                      <>
                        <div className="space-y-3 p-4 rounded-xl bg-slate-800/50 border border-slate-700">
                          <div className="text-sm font-medium text-white">选择拆条模式：</div>
                          <div className="space-y-2">
                            {[
                              {
                                id: 'ai_frame' as const,
                                name: '快速镜头检测（免费）',
                                description: '基于 FFmpeg 场景变化检测算法，在服务器端分析画面切换点',
                                cost: '免费',
                                accuracy: '良好',
                                speed: '约 5-15 秒',
                                available: true
                              },
                              {
                                id: 'aliyun' as const,
                                name: '阿里云智能拆条',
                                description: '基于阿里云视频理解能力进行专业级镜头拆分',
                                cost: '按实际调用量计费',
                                accuracy: '精准',
                                speed: '约 1-3 分钟',
                                available: aliyunConfigured
                              }
                            ].map(option => (
                              <label
                                key={option.id}
                                className={`block p-3 rounded-lg border-2 cursor-pointer transition-all ${
                                  !option.available
                                    ? 'border-slate-800 bg-slate-900/50 opacity-50 cursor-not-allowed'
                                    : aiMode === option.id
                                      ? 'border-violet-500 bg-violet-500/10'
                                      : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="aiMode"
                                  value={option.id}
                                  checked={aiMode === option.id}
                                  onChange={() => option.available && setAiMode(option.id)}
                                  disabled={!option.available || state === 'processing'}
                                  className="hidden"
                                />
                                <div className="flex items-start gap-3">
                                  <div className="flex-1">
                                    <div className="text-sm font-medium text-white">{option.name}</div>
                                    <div className="text-xs text-slate-400 mt-1">{option.description}</div>
                                    <div className="flex gap-4 mt-2 text-xs">
                                      <span className="text-amber-400">费用：{option.cost}</span>
                                      <span className="text-emerald-400">精度：{option.accuracy}</span>
                                      <span className="text-sky-400">速度：{option.speed}</span>
                                    </div>
                                    {option.id === 'aliyun' && !option.available && (
                                      <div className="mt-2 text-xs text-amber-400">
                                        请先在设置中配置阿里云 AccessKey
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>

                        </div>
                        {splitPoints.length > 0 && (
                          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/20 mt-3">
                            <p className="text-xs text-amber-200">
                              注意：AI 拆条将覆盖当前已手动添加的 {splitPoints.length} 个分割点
                            </p>
                          </div>
                        )}
                        {aiError && (
                          <div className="mt-3">
                            <AiErrorGuide
                              error={aiError}
                              onOpenSettings={onOpenSettings}
                            />
                          </div>
                        )}
                        <button
                          onClick={() => {
                            const targetMode: SplitMode = aiMode;
                            setMode(targetMode);
                            handleStartSplit(targetMode);
                          }}
                          disabled={state === 'processing'}
                          className={`w-full flex items-center justify-center gap-2 ${isMobile ? 'py-3 text-base' : 'py-2.5 text-sm'} rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-medium transition disabled:opacity-50 disabled:cursor-not-allowed mt-3`}
                        >
                          <Sparkles className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
                          开始智能分析
                        </button>
                      </>
                    )}
                  </div>
                )}

                <div className="hidden">
                  <video
                    ref={thumbVideoRef}
                    src={currentVideoUrl}
                    crossOrigin="anonymous"
                    muted
                    playsInline
                  />
                  <canvas ref={thumbCanvasRef} />
                </div>
              </>
            )}
          </div>
        </div>

        <div className={`${isMobile ? 'px-4 py-3' : 'px-6 py-4'} border-t border-white/10 flex justify-end gap-3`}>
          <button
            onClick={handleUserCancelMarked}
            className={`${isMobile ? 'flex-1 py-3 text-base' : 'px-5 py-2.5 text-sm'} rounded-xl border border-white/15 hover:bg-white/10 transition`}
          >
            取消
          </button>
          {state === 'initial' && currentVideoUrl && (
            <button
              onClick={handleStartSplit}
              disabled={mode === 'manual' && splitPoints.length === 0}
              className={`${isMobile ? 'flex-1 py-3 text-base' : 'px-5 py-2.5 text-sm'} rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 font-medium transition disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              开始分割
            </button>
          )}
          {state === 'preview' && currentVideoUrl && (
            <button
              onClick={handleConfirmMarked}
              disabled={previewShots.length === 0}
              className={`${isMobile ? 'flex-1 py-3 text-base' : 'px-5 py-2.5 text-sm'} rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 font-medium transition disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              应用
            </button>
          )}
        </div>

        {/* 确认创建分镜对话框 */}
        {confirmDialog && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setConfirmDialog(false)}
          >
            <div
              className="bg-slate-900 rounded-2xl p-6 max-w-sm w-full mx-4 border border-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-white mb-2">确认创建分镜</h3>
              <p className="text-sm text-slate-300 mb-6">
                即将创建 <span className="text-violet-400 font-medium">{previewShots.length}</span> 个分镜，是否继续？
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setConfirmDialog(false)}
                  className="px-4 py-2 rounded-xl border border-white/15 hover:bg-white/10 text-sm text-slate-300 transition"
                >
                  取消
                </button>
                <button
                  onClick={confirmCreate}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition"
                >
                  确认创建
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
