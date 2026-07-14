import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Play, Pause, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle, Info, Upload, Video } from 'lucide-react';
import { checkVideoBitrate, uploadVideo } from '../../lib/ossUtils';
import type { UploadDecision } from '../../lib/ossUtils';
import { VideoCompressionDialog } from './VideoCompressionDialog';
import type { SplitShot } from '../../lib/types';
import type { AiTaskUpdate } from '../../lib/taskStream';

interface UploadedVideo {
  id: string;
  url: string;
  name: string;
  thumbnail?: string;
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
}

type SplitMode = 'manual' | 'ai_frame' | 'aliyun';
type DialogState = 'initial' | 'processing' | 'completed';

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

export default function VideoSplitDialog({
  isOpen,
  onClose,
  videoUrl: initialVideoUrl,
  initialVideos,
  projectId,
  sceneId,
  onSplit,
  onVideoUpload,
  maxUploads = 5
}: VideoSplitDialogProps) {
  const [mode, setMode] = useState<SplitMode>('manual');
  const [state, setState] = useState<DialogState>('initial');
  const [progress, setProgress] = useState(0);
  const [currentPhase, setCurrentPhase] = useState('');
  const [detectedShots, setDetectedShots] = useState(0);
  const [splitPoints, setSplitPoints] = useState<SplitPoint[]>([]);
  const [estimatedCost, setEstimatedCost] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [shotThumbnails, setShotThumbnails] = useState<Record<string, string>>({});
  const [generatingThumbs, setGeneratingThumbs] = useState(false);

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
  const [aliyunConfigured, setAliyunConfigured] = useState(false);
  const [aiMode, setAiMode] = useState<'ai_frame' | 'aliyun'>('ai_frame');

  const [uploadedVideos, setUploadedVideos] = useState<UploadedVideo[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState('');
  const [currentUploadIndex, setCurrentUploadIndex] = useState(0);
  const [totalUploadCount, setTotalUploadCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const pendingUploadRef = useRef<{ file: File; queue?: File[] } | null>(null);
  const pendingCompressionVideoRef = useRef<File | null>(null);

  // 视频分割增强选项
  const [filterNonShots, setFilterNonShots] = useState(true);
  const [autoAssignScenes, setAutoAssignScenes] = useState(true);

  const currentVideo = uploadedVideos.find(v => v.id === selectedVideoId);
  const currentVideoUrl = currentVideo?.url || '';

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
  }, [isOpen, initialVideos, initialVideoUrl]);

  // P2-11：对话框关闭时清理未被分割使用的孤儿视频（已被 shot_media 引用的不删）
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    // 检测 isOpen 从 true → false 的变化
    if (prevIsOpenRef.current && !isOpen && uploadedVideos.length > 0) {
      const urlsToClean = uploadedVideos
        .map(v => v.url)
        .filter(u => u && u.startsWith('http'));
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
  }, [isOpen, uploadedVideos]);

  const generateVideoThumbnail = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = URL.createObjectURL(file);
      video.onloadeddata = () => {
        video.currentTime = 0.1;
      };
      video.onseeked = () => {
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
        } catch {
          resolve('');
        } finally {
          URL.revokeObjectURL(video.src);
        }
      };
      video.onerror = () => {
        resolve('');
      };
    });
  };

  const uploadSingleVideo = async (file: File): Promise<UploadedVideo | null> => {
    setError(null);

    try {
      const decision = await checkVideoBitrate(file);

      if (decision.decision === 'must_compress') {
        return new Promise((resolve) => {
          pendingUploadRef.current = { file };
          pendingCompressionVideoRef.current = file;
          setPendingCompressionVideo(file);
          setPendingCompressionDecision(decision);
          setIsUploading(false);
          const checkInterval = setInterval(() => {
            if (!pendingCompressionVideoRef.current && !pendingUploadRef.current) {
              clearInterval(checkInterval);
              resolve(null);
            }
          }, 200);
          setTimeout(() => {
            clearInterval(checkInterval);
            resolve(null);
          }, 60000);
        });
      }

      setUploadMessage(`正在上传：${file.name}`);
      const videoUrlResult = await uploadVideo(file, {
        projectId,
        sceneId,
        usage: 'shot-reference',
        compressionMethod: 'none',
        skipBitrateCheck: true,
        onProgress: (p) => {
          setUploadProgress(p.progress);
          setUploadMessage(p.message);
        }
      });

      const thumbnail = await generateVideoThumbnail(file);

      return {
        id: generateId(),
        url: videoUrlResult.url,
        name: file.name,
        thumbnail
      };
    } catch (err) {
      console.error('上传视频失败:', err);
      setError(err instanceof Error ? err.message : '上传失败');
      return null;
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files) as File[];
    const remainingSlots = maxUploads - uploadedVideos.length;
    if (remainingSlots <= 0) {
      setError(`最多只能上传 ${maxUploads} 个视频`);
      e.target.value = '';
      return;
    }

    const filesToUpload = fileList.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      setError(`最多只能上传 ${maxUploads} 个视频，已自动截取前 ${remainingSlots} 个`);
    }

    e.target.value = '';
    uploadMultipleVideos(filesToUpload);
  };

  const uploadMultipleVideos = async (files: File[]) => {
    setIsUploading(true);
    setUploadProgress(0);
    setTotalUploadCount(files.length);
    setCurrentUploadIndex(0);
    setError(null);

    const newVideos: UploadedVideo[] = [];

    for (let i = 0; i < files.length; i++) {
      setCurrentUploadIndex(i + 1);
      const result = await uploadSingleVideo(files[i]);
      if (result) {
        newVideos.push(result);
      }
    }

    if (newVideos.length > 0) {
      setUploadedVideos(prev => {
        const updated = [...prev, ...newVideos];
        return updated;
      });
      if (!selectedVideoId && newVideos.length > 0) {
        setSelectedVideoId(newVideos[0].id);
      }
    }

    setIsUploading(false);
    setUploadProgress(0);
    setUploadMessage('');
    setCurrentUploadIndex(0);
    setTotalUploadCount(0);
  };

  const handleCompressionSelect = async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    const pending = pendingUploadRef.current;
    const file = pendingCompressionVideo;

    pendingCompressionVideoRef.current = null;
    setPendingCompressionVideo(null);
    setPendingCompressionDecision(null);
    pendingUploadRef.current = null;

    if (method === 'cancel' || !pending || !file) {
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadMessage('正在压缩并上传视频...');

    try {
      const videoUrlResult = await uploadVideo(file, {
        projectId,
        sceneId,
        usage: 'shot-reference',
        compressionMethod: method,
        skipBitrateCheck: true,
        onProgress: (p) => {
          setUploadProgress(p.progress);
          setUploadMessage(p.message);
        }
      });

      const thumbnail = await generateVideoThumbnail(file);
      const newVideo: UploadedVideo = {
        id: generateId(),
        url: videoUrlResult.url,
        name: file.name,
        thumbnail
      };

      setUploadedVideos(prev => [...prev, newVideo]);
      if (!selectedVideoId) {
        setSelectedVideoId(newVideo.id);
      }
    } catch (err) {
      console.error('上传视频失败:', err);
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage('');
    }
  };

  const handleUploadClick = () => {
    const remainingSlots = maxUploads - uploadedVideos.length;
    if (remainingSlots <= 0) {
      setError(`最多只能上传 ${maxUploads} 个视频`);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleSelectVideo = (videoId: string) => {
    if (videoId === selectedVideoId) return;
    setSelectedVideoId(videoId);
    resetSplitState();
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
      setVideoDuration(videoRef.current.duration);
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

  const seekTo = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const addSplitPoint = () => {
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
    setDraggingPoint(pointId);
  };

  const handleTimelineMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingPoint || !timelineRef.current || !videoDuration) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = percentage * videoDuration;

    setSplitPoints(prev =>
      prev.map(p => (p.id === draggingPoint ? { ...p, time: newTime } : p))
    );
  }, [draggingPoint, videoDuration]);

  const handleTimelineMouseUp = useCallback(() => {
    setDraggingPoint(null);
  }, []);

  useEffect(() => {
    if (draggingPoint) {
      document.addEventListener('mousemove', handleTimelineMouseMove);
      document.addEventListener('mouseup', handleTimelineMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleTimelineMouseMove);
        document.removeEventListener('mouseup', handleTimelineMouseUp);
      };
    }
  }, [draggingPoint, handleTimelineMouseMove, handleTimelineMouseUp]);

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (draggingPoint || !timelineRef.current || !videoDuration) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    const clickTime = percentage * videoDuration;

    const existingPoint = splitPoints.find(p => Math.abs(p.time - clickTime) < 0.5);
    if (existingPoint) return;

    const newPoint: SplitPoint = {
      id: generateId(),
      time: clickTime
    };
    setSplitPoints(prev => [...prev, newPoint].sort((a, b) => a.time - b.time));
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
          setCurrentPhase(data.output?.shots ? '正在识别镜头边界' : '正在分析视频关键帧');
          if (data.output?.shots) {
            setDetectedShots(data.output.shots.length);
          }
        } else if (data.status === 'done' || data.status === 'completed') {
          sseClosed = true;
          eventSource.close();
          setProgress(100);
          setDetectedShots(data.output?.shots?.length || 0);
          setEstimatedCost(data.output?.estimatedCost || 0);

          if (data.output?.shots) {
            const splitShots = data.output.shots as Array<{ startTime: number; endTime: number; thumbnail?: string }>;
            const newSplitPoints: SplitPoint[] = splitShots.slice(1).map((shot, idx: number) => ({
              id: generateId(),
              time: shot.startTime
            }));
            setSplitPoints(newSplitPoints);
          }

          setState('completed');
        } else if (data.status === 'error' || data.status === 'failed') {
          sseClosed = true;
          eventSource.close();
          setError(data.error || '分割失败，请重试');
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
              setCurrentPhase(data.output?.shots ? '正在识别镜头边界' : '正在分析视频关键帧');
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
                const newSplitPoints: SplitPoint[] = data.output.shots.slice(1).map((shot, idx) => ({
                  id: generateId(),
                  time: shot.startTime
                }));
                setSplitPoints(newSplitPoints);
              }

              setState('completed');
            } else if (data.status === 'error') {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setError(data.error || '分割失败，请重试');
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
            setCurrentPhase(data.output?.shots ? '正在识别镜头边界' : '正在分析视频关键帧');
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
              const newSplitPoints: SplitPoint[] = data.output.shots.slice(1).map((shot, idx) => ({
                id: generateId(),
                time: shot.startTime
              }));
              setSplitPoints(newSplitPoints);
            }

            setState('completed');
          } else if (data.status === 'error') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setError(data.error || '分割失败，请重试');
            setState('initial');
          }
        } catch (e) {
          console.error('轮询任务状态失败:', e);
        }
      }, 2000);
    }
  }, []);

  const handleStartSplit = async () => {
    if (!currentVideoUrl) return;

    setError(null);
    setState('processing');
    setProgress(5);
    setCurrentPhase('正在准备分割任务...');

    try {
      const actualMode = mode === 'manual' ? 'manual' : aiMode;
      
      const body: {
        videoUrl: string;
        projectId: number;
        mode: string;
        filterNonShots: boolean;
        autoAssignScenes: boolean;
        sceneId?: number | null;
        splitPoints?: number[];
      } = {
        videoUrl: currentVideoUrl,
        projectId,
        mode: actualMode,
        filterNonShots: actualMode !== 'manual' ? filterNonShots : false,
        autoAssignScenes
      };

      if (sceneId !== undefined && sceneId !== null) {
        body.sceneId = sceneId;
      }

      if (mode === 'manual' && splitPoints.length > 0) {
        body.splitPoints = splitPoints.map(p => p.time);
      }

      const res = await fetch('/api/ai/split-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();

      if (data.taskId) {
        setTaskId(data.taskId);
        pollTaskStatus(data.taskId);
      } else if (data.error) {
        setError(data.error);
        setState('initial');
      }
    } catch (e) {
      console.error('提交分割任务失败:', e);
      setError('网络错误，请重试');
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
    if (splitPoints.length === 0 || !thumbVideoRef.current) return;

    setGeneratingThumbs(true);
    const thumbs: Record<string, string> = {};

    try {
      const times = [0, ...splitPoints.map(p => p.time)];
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
  }, [splitPoints]);

  useEffect(() => {
    if (state === 'completed' && videoDuration > 0 && splitPoints.length > 0) {
      generateAllThumbnails();
    }
  }, [state, videoDuration, splitPoints, generateAllThumbnails]);

  const handleCancel = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setState('initial');
    setProgress(0);
  };

  const handleConfirm = () => {
    if (onSplit && currentVideoUrl) {
      const shots = splitPoints.length > 0
        ? (() => {
            const result: SplitShot[] = [];
            const times = [0, ...splitPoints.map(p => p.time), videoDuration];
            for (let i = 0; i < times.length - 1; i++) {
              result.push({
                startTime: times[i],
                endTime: times[i + 1],
                index: i
              });
            }
            return result;
          })()
        : [{ startTime: 0, endTime: videoDuration, index: 0 }];
      onSplit(shots, currentVideoUrl);
    }
    onClose();
  };

  const getShotCount = () => {
    if (splitPoints.length === 0) return 1;
    return splitPoints.length + 1;
  };

  if (!isOpen) return null;

  const sceneCount = getShotCount();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-8 sm:p-4"
      onClick={onClose}
    >
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[90vh] rounded-3xl border border-white/10 bg-slate-900 flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">视频分割为分镜</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex">
          <div className="w-36 border-r border-white/10 p-3 space-y-2 overflow-y-auto flex-shrink-0">
            <div className="text-xs text-slate-400 mb-2">
              已上传 ({uploadedVideos.length}/{maxUploads})
            </div>
            <div className="space-y-2">
              {uploadedVideos.map(video => (
                <div
                  key={video.id}
                  onClick={() => handleSelectVideo(video.id)}
                  className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                    selectedVideoId === video.id
                      ? 'border-violet-500 ring-1 ring-violet-500/30'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <div className="aspect-video bg-black relative">
                    {video.thumbnail ? (
                      <img src={video.thumbnail} alt={video.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Video className="w-6 h-6 text-slate-600" />
                      </div>
                    )}
                  </div>
                  <div className="px-2 py-1 text-xs text-slate-400 truncate bg-white/5">
                    {video.name}
                  </div>
                </div>
              ))}
            </div>

            {uploadedVideos.length < maxUploads && (
              <button
                onClick={handleUploadClick}
                disabled={isUploading}
                className="w-full p-3 rounded-lg border-2 border-dashed border-white/15 hover:border-violet-500/50 hover:bg-violet-500/10 transition-all disabled:opacity-50"
              >
                <Upload className="w-4 h-4 mx-auto text-slate-400 mb-1" />
                <div className="text-xs text-slate-400">上传视频</div>
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {isUploading && (
              <div className="space-y-2 p-4 rounded-xl bg-violet-500/10 border border-violet-500/30">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                  <span className="text-sm text-slate-300">
                    {totalUploadCount > 1 ? `上传中 (${currentUploadIndex}/${totalUploadCount})：` : ''}
                    {uploadMessage}
                  </span>
                  <span className="text-sm text-violet-400 font-medium ml-auto">{uploadProgress}%</span>
                </div>
                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {!currentVideoUrl && !isUploading && (
              <div className="text-center py-12 text-slate-500">
                <Video className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">请从左侧上传视频，或选择已上传的视频</p>
              </div>
            )}

            {currentVideoUrl && (
              <>
                <div className="space-y-3">
                  <div className="text-sm text-slate-300">选择分割方式：</div>
                  <div className="flex gap-3">
                    <label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                      mode === 'manual' 
                        ? 'border-violet-500 bg-violet-500/10' 
                        : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                    }`}>
                      <input
                        type="radio"
                        name="splitMode"
                        value="manual"
                        checked={mode === 'manual'}
                        onChange={() => setMode('manual')}
                        disabled={state === 'processing' || state === 'completed'}
                        className="hidden"
                      />
                      <div className="text-sm font-medium text-white mb-1">手动标记分割</div>
                      <div className="text-xs text-slate-400">自己播放视频，在时间轴上标记分割点</div>
                    </label>
                    <label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                      mode !== 'manual' 
                        ? 'border-violet-500 bg-violet-500/10' 
                        : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                    }`}>
                      <input
                        type="radio"
                        name="splitMode"
                        value="ai"
                        checked={mode !== 'manual'}
                        onChange={() => setMode(aliyunConfigured ? 'aliyun' : 'ai_frame')}
                        disabled={state === 'processing' || state === 'completed'}
                        className="hidden"
                      />
                      <div className="text-sm font-medium text-white mb-1">AI 自动分割</div>
                      <div className="text-xs text-slate-400">人工智能自动识别镜头切换点</div>
                    </label>
                  </div>
                </div>

                {mode !== 'manual' && state === 'initial' && (
                  <div className="space-y-3 p-4 rounded-xl bg-slate-800/50 border border-slate-700">
                    <div className="text-sm font-medium text-white">选择 AI 分析方式：</div>
                    <div className="space-y-2">
                      {[
                        {
                          id: 'ai_frame' as const,
                          name: 'AI 抽帧分析',
                          description: '抽取视频关键帧，通过多模态大模型分析镜头切换点',
                          cost: '约 ¥0.3-0.8 / 5分钟',
                          accuracy: '⭐⭐⭐⭐ 较好',
                          speed: '约 30秒-2分钟',
                          available: true
                        },
                        {
                          id: 'aliyun' as const,
                          name: '阿里云视频拆条',
                          description: '阿里云视觉智能平台专业视频分析',
                          cost: '约 ¥0.5-2.5 / 5分钟',
                          accuracy: '⭐⭐⭐⭐⭐ 精准',
                          speed: '约 1-3分钟',
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
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'manual' && state === 'initial' && (
                  <div className="space-y-5">
                    <div className="relative rounded-2xl overflow-hidden bg-black aspect-video">
                      <video
                        ref={videoRef}
                        src={currentVideoUrl}
                        className="w-full h-full object-contain"
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={handleLoadedMetadata}
                        onPlay={handlePlay}
                        onPause={handlePause}
                      />
                      <button
                        onClick={togglePlay}
                        className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition"
                      >
                        {isPlaying ? (
                          <Pause className="w-12 h-12 text-white/80" />
                        ) : (
                          <Play className="w-12 h-12 text-white/80" />
                        )}
                      </button>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-slate-300">时间轴：</span>
                        <span className="text-sm text-slate-400">
                          {formatTime(currentTime)} / {formatTime(videoDuration)}
                        </span>
                      </div>
                      <div
                        ref={timelineRef}
                        className="relative h-12 bg-white/10 rounded-lg cursor-pointer"
                        onClick={handleTimelineClick}
                      >
                        <div
                          className="absolute top-0 left-0 h-full bg-violet-500/20 rounded-lg"
                          style={{ width: `${(currentTime / videoDuration) * 100}%` }}
                        />
                        {splitPoints.map(point => (
                          <div
                            key={point.id}
                            className="absolute top-0 w-1 h-full bg-violet-500 cursor-ew-resize z-10"
                            style={{ left: `${(point.time / videoDuration) * 100}%` }}
                            onMouseDown={e => handleTimelineMouseDown(e, point.id)}
                          >
                            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-4 bg-violet-500 rounded-full border-2 border-white shadow-lg" />
                          </div>
                        ))}
                        <div
                          className="absolute top-0 w-0.5 h-full bg-white z-20"
                          style={{ left: `${(currentTime / videoDuration) * 100}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        onClick={addSplitPoint}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 text-sm transition"
                      >
                        <Plus className="w-4 h-4" />
                        添加分割点
                      </button>
                      <button
                        onClick={clearAllSplitPoints}
                        disabled={splitPoints.length === 0}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-4 h-4" />
                        清除全部
                      </button>
                    </div>

                    <div className="text-sm text-slate-400">
                      已标记 <span className="text-violet-400 font-medium">{splitPoints.length}</span> 个分割点，将生成{' '}
                      <span className="text-violet-400 font-medium">{sceneCount}</span> 个分镜
                    </div>

                    {splitPoints.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {splitPoints.map((point, idx) => (
                          <div
                            key={point.id}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm"
                          >
                            <span className="text-slate-400">#{idx + 1}</span>
                            <span className="text-white">{formatTime(point.time)}</span>
                            <button
                              onClick={() => removeSplitPoint(point.id)}
                              className="text-slate-500 hover:text-red-400 transition"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {mode !== 'manual' && state === 'initial' && (
                  <div className="py-4">
                    <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-3">
                      <div className="flex items-center gap-2 text-amber-300 font-medium">
                        <AlertTriangle className="w-5 h-5" />
                        <span>AI自动分割提示</span>
                      </div>
                      <ul className="space-y-2 text-sm text-amber-200/80 list-disc list-inside">
                        <li>处理时间根据视频时长约 30秒 ~ 5分钟</li>
                        <li>根据选择的模型不同，费用有所差异</li>
                        <li>分割结果可能需要手动调整</li>
                      </ul>
                    </div>
                  </div>
                )}

                {state === 'processing' && (
                  <div className="py-8 text-center">
                    <div className="flex items-center justify-center gap-3 mb-6">
                      <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                      <span className="text-base text-slate-200">正在分割视频...</span>
                      <span className="text-base text-violet-400 font-medium">{progress}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden mb-4">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-sm text-slate-400 mb-2">当前阶段：{currentPhase}</p>
                    {detectedShots > 0 && (
                      <p className="text-sm text-slate-400 mb-6">已识别 {detectedShots} 个镜头</p>
                    )}
                    <button
                      onClick={handleCancel}
                      className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
                    >
                      取消处理
                    </button>
                  </div>
                )}

                {state === 'completed' && (
                  <div className="py-4 space-y-5">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="w-6 h-6 text-green-400" />
                      <div>
                        <h3 className="text-base font-semibold text-white">分割完成！</h3>
                        <p className="text-sm text-slate-400">
                          已生成 {sceneCount} 个分镜片段
                        </p>
                      </div>
                    </div>

                    {estimatedCost > 0 && (
                      <div className="flex items-center justify-between p-4 rounded-xl bg-white/[0.03] border border-white/10">
                        <span className="text-sm text-slate-300">预估费用：</span>
                        <span className="text-base font-semibold text-green-400">¥{estimatedCost.toFixed(2)}</span>
                      </div>
                    )}

                    {videoDuration > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400">分镜预览</span>
                          {generatingThumbs && (
                            <span className="text-slate-500 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              生成缩略图中...
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-2">
                          {(() => {
                            const shotTimes = [0, ...splitPoints.map(p => p.time)];
                            return shotTimes.map((time, idx) => {
                              const endTime = idx < splitPoints.length ? splitPoints[idx].time : videoDuration;
                              const thumbKey = `shot_${idx}`;
                              return (
                                <div
                                  key={idx}
                                  className="shrink-0 w-36 space-y-1 cursor-pointer group"
                                  onClick={() => {
                                    if (videoRef.current) {
                                      videoRef.current.currentTime = time;
                                    }
                                  }}
                                >
                                  <div className="relative aspect-video rounded-lg overflow-hidden bg-white/5 border border-white/10 group-hover:border-violet-400/50 transition">
                                    {shotThumbnails[thumbKey] ? (
                                      <img
                                        src={shotThumbnails[thumbKey]}
                                        alt={`分镜 ${idx + 1}`}
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center">
                                        <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
                                      </div>
                                    )}
                                    <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">
                                      #{idx + 1}
                                    </div>
                                  </div>
                                  <div className="text-xs text-slate-400 text-center">
                                    {formatTime(time)} - {formatTime(endTime)}
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {currentVideoUrl && (
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
                )}
              </>
            )}
          </div>
        </div>

        {/* 分割增强选项 */}
        {state === 'initial' && currentVideoUrl && (
          <div className="px-6 py-3 border-t border-white/10 flex flex-wrap items-center gap-4">
            <label className={`flex items-center gap-2 text-sm transition ${
              mode === 'manual' ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer text-slate-300 hover:text-white'
            }`}>
              <input
                type="checkbox"
                checked={mode === 'manual' ? false : filterNonShots}
                onChange={(e) => setFilterNonShots(e.target.checked)}
                disabled={mode === 'manual'}
                className="w-4 h-4 rounded accent-violet-500"
              />
              滤除非实拍分镜
              <span className="text-xs text-slate-500">（如标题卡、黑屏过渡等）</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer text-slate-300 hover:text-white transition">
              <input
                type="checkbox"
                checked={autoAssignScenes}
                onChange={(e) => setAutoAssignScenes(e.target.checked)}
                className="w-4 h-4 rounded accent-violet-500"
              />
              自动划分场次
            </label>
          </div>
        )}

        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            取消
          </button>
          {state === 'initial' && currentVideoUrl && (
            <button
              onClick={handleStartSplit}
              disabled={!currentVideoUrl || (mode === 'manual' && splitPoints.length === 0)}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              开始分割
            </button>
          )}
          {state === 'completed' && (
            <button
              onClick={handleConfirm}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-sm font-medium transition"
            >
              确认并添加
            </button>
          )}
        </div>
      </div>

      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => {
          pendingCompressionVideoRef.current = null;
          setPendingCompressionVideo(null);
          setPendingCompressionDecision(null);
          pendingUploadRef.current = null;
        }}
        file={pendingCompressionVideo}
        decision={pendingCompressionDecision}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionSelect}
      />
    </div>
  );
}
