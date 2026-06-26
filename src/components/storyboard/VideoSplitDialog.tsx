import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Play, Pause, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle, Info, Upload } from 'lucide-react';
import { checkVideoBitrate, uploadVideo2Video } from '../../lib/ossUtils';
import type { UploadDecision } from '../../lib/ossUtils';
import { VideoCompressionDialog } from '../VideoCompressionDialog';

interface VideoSplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  projectId: number;
  sceneId?: number | null;
  onSplit?: (shots: any[]) => void;
  onVideoUpload?: (file: File) => Promise<string>;
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
  projectId,
  sceneId,
  onSplit,
  onVideoUpload
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [draggingPoint, setDraggingPoint] = useState<string | null>(null);
  const [aliyunConfigured, setAliyunConfigured] = useState(false);
  const [aiMode, setAiMode] = useState<'ai_frame' | 'aliyun'>('ai_frame');

  // 本地视频上传相关状态
  const [videoUrl, setVideoUrl] = useState(initialVideoUrl);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 压缩选择对话框状态
  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const pendingUploadRef = useRef<{ file: File } | null>(null);
  
  useEffect(() => {
    fetch('/api/video2/aliyun/status')
      .then(res => res.json())
      .then(data => {
        if (data.configured) {
          setAliyunConfigured(true);
        }
      })
      .catch(() => {});
  }, []);

  // 同步 videoUrl
  useEffect(() => {
    setVideoUrl(initialVideoUrl);
  }, [initialVideoUrl]);

  // 处理本地视频上传
  const handleLocalVideoUpload = async (file: File) => {
    if (!file.type.startsWith('video/')) {
      setError('请选择视频文件');
      return;
    }

    setError(null);
    setIsUploading(true);
    setUploadProgress(0);
    setUploadMessage('正在检测视频信息...');

    try {
      // 检测码率
      const decision = await checkVideoBitrate(file);

      if (decision.decision === 'must_compress') {
        // 显示压缩选择对话框
        pendingUploadRef.current = { file };
        setPendingCompressionVideo(file);
        setPendingCompressionDecision(decision);
        setIsUploading(false);
        return;
      }

      // 低码率视频，直接上传
      setUploadMessage('正在上传视频...');
      const videoUrlResult = await uploadVideo2Video(file, {
        projectId,
        sceneId,
        compressionMethod: 'none',
        skipBitrateCheck: true,
        onProgress: (p) => {
          setUploadProgress(p.progress);
          setUploadMessage(p.message);
        }
      });

      setVideoUrl(videoUrlResult.url);
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage('');
    } catch (err) {
      console.error('上传视频失败:', err);
      setError(err instanceof Error ? err.message : '上传失败');
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage('');
    }
  };

  // 处理压缩方式选择
  const handleCompressionSelect = async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    const pending = pendingUploadRef.current;
    const file = pendingCompressionVideo;

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
      const videoUrlResult = await uploadVideo2Video(file, {
        projectId,
        sceneId,
        compressionMethod: method,
        skipBitrateCheck: true,
        onProgress: (p) => {
          setUploadProgress(p.progress);
          setUploadMessage(p.message);
        }
      });

      setVideoUrl(videoUrlResult.url);
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage('');
    } catch (err) {
      console.error('上传视频失败:', err);
      setError(err instanceof Error ? err.message : '上传失败');
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage('');
    }
  };

  // 触发文件选择
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // 文件选择变化
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleLocalVideoUpload(file);
    }
    // 重置 input，允许重复选择同一文件
    e.target.value = '';
  };
  
  const aiModeOptions: AIModeOption[] = [
    {
      id: 'ai_frame',
      name: 'AI 抽帧分析',
      description: '抽取视频关键帧，通过多模态大模型分析镜头切换点',
      cost: '约 ¥0.3-0.8 / 5分钟',
      accuracy: '⭐⭐⭐⭐ 较好',
      speed: '约 30秒-2分钟',
      available: true
    },
    {
      id: 'aliyun',
      name: '阿里云视频拆条',
      description: '阿里云视觉智能平台专业视频分析，支持镜头转场和主题双维度拆分',
      cost: '约 ¥0.5-2.5 / 5分钟',
      accuracy: '⭐⭐⭐⭐⭐ 精准',
      speed: '约 1-3分钟',
      available: aliyunConfigured
    }
  ];

  // 重置状态
  const resetState = useCallback(() => {
    setMode('manual');
    setState('initial');
    setProgress(0);
    setCurrentPhase('');
    setDetectedShots(0);
    setSplitPoints([]);
    setEstimatedCost(0);
    setError(null);
    setTaskId(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // 关闭弹窗时重置
  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 视频事件处理
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

  // 添加分割点
  const addSplitPoint = () => {
    const newPoint: SplitPoint = {
      id: generateId(),
      time: currentTime
    };
    setSplitPoints(prev => [...prev, newPoint].sort((a, b) => a.time - b.time));
  };

  // 删除分割点
  const removeSplitPoint = (id: string) => {
    setSplitPoints(prev => prev.filter(p => p.id !== id));
  };

  // 清除所有分割点
  const clearAllSplitPoints = () => {
    setSplitPoints([]);
  };

  // 拖动分割点
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

  // 点击时间轴添加分割点
  const handleTimelineClick = (e: React.MouseEvent) => {
    if (draggingPoint || !timelineRef.current || !videoDuration) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    const clickTime = percentage * videoDuration;

    // 检查是否点击了现有分割点附近
    const existingPoint = splitPoints.find(p => Math.abs(p.time - clickTime) < 0.5);
    if (existingPoint) return;

    const newPoint: SplitPoint = {
      id: generateId(),
      time: clickTime
    };
    setSplitPoints(prev => [...prev, newPoint].sort((a, b) => a.time - b.time));
  };

  // 轮询任务状态
  const pollTaskStatus = useCallback((tid: string) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video2/ai/task/${tid}`);
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

          // 将 AI 检测结果转换为分割点
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
  }, []);

  // 开始分割
  const handleStartSplit = async () => {
    setError(null);
    setState('processing');
    setProgress(5);
    setCurrentPhase('正在准备分割任务...');

    try {
      const actualMode = mode === 'manual' ? 'manual' : aiMode;
      
      const body: Record<string, any> = {
        videoUrl,
        projectId,
        mode: actualMode
      };

      if (sceneId !== undefined && sceneId !== null) {
        body.sceneId = sceneId;
      }

      if (mode === 'manual' && splitPoints.length > 0) {
        body.splitPoints = splitPoints.map(p => p.time);
      }

      const res = await fetch('/api/video2/ai/split-video', {
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

  // 取消处理
  const handleCancel = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    resetState();
  };

  // 确认并添加
  const handleConfirm = () => {
    if (onSplit && splitPoints.length > 0) {
      const shots = splitPoints.map((point, idx) => ({
        startTime: idx === 0 ? 0 : splitPoints[idx - 1].time,
        endTime: point.time,
        index: idx
      }));
      // 添加最后一个分镜到视频结尾
      shots.push({
        startTime: splitPoints[splitPoints.length - 1].time,
        endTime: videoDuration,
        index: splitPoints.length
      });
      onSplit(shots);
    }
    onClose();
  };

  // 计算将生成的分镜数量
  const getShotCount = () => {
    if (splitPoints.length === 0) return 1;
    return splitPoints.length + 1;
  };

  if (!isOpen) return null;

  const sceneCount = getShotCount();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">视频分割为分镜</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 本地视频上传区域 */}
          {!videoUrl && state === 'initial' && (
            <div className="space-y-3">
              <div className="text-sm text-slate-300">上传视频：</div>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                onClick={handleUploadClick}
                disabled={isUploading}
                className="w-full p-4 rounded-xl border-2 border-slate-700 bg-slate-800/50 hover:border-violet-500 hover:bg-violet-500/10 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center justify-center gap-3">
                  <Upload className="w-5 h-5 text-violet-400" />
                  <span className="text-sm font-medium text-white">
                    {isUploading ? '正在上传...' : '上传本地视频'}
                  </span>
                </div>
                <div className="text-xs text-slate-400 mt-2 text-center">
                  支持 MP4、WebM、MOV 等格式，将自动检测码率
                </div>
              </button>

              {/* 上传进度 */}
              {isUploading && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                    <span className="text-sm text-slate-300">{uploadMessage}</span>
                    <span className="text-sm text-violet-400 font-medium">{uploadProgress}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 已上传视频预览 */}
          {videoUrl && state === 'initial' && (
            <div className="space-y-2">
              <div className="text-sm text-slate-300">已上传视频：</div>
              <div className="relative rounded-xl overflow-hidden bg-black aspect-video max-h-[200px]">
                <video
                  src={videoUrl}
                  className="w-full h-full object-contain"
                  controls
                />
              </div>
            </div>
          )}

          {/* 模式选择 */}
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
          
          {/* AI 模式子选项 */}
          {mode !== 'manual' && state === 'initial' && (
            <div className="space-y-3 p-4 rounded-xl bg-slate-800/50 border border-slate-700">
              <div className="text-sm font-medium text-white">选择 AI 分析方式：</div>
              <div className="space-y-2">
                {aiModeOptions.map(option => (
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
                        {!option.available && (
                          <div className="text-xs text-orange-400 mt-2">
                            ⚠️ 未配置阿里云 AccessKey，请在设置中配置
                          </div>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* 手动标记模式 */}
          {mode === 'manual' && state === 'initial' && (
            <div className="space-y-5">
              {/* 视频播放器 */}
              <div className="relative rounded-2xl overflow-hidden bg-black aspect-video">
                <video
                  ref={videoRef}
                  src={videoUrl}
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

              {/* 时间轴 */}
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
                  {/* 进度条 */}
                  <div
                    className="absolute top-0 left-0 h-full bg-violet-500/20 rounded-lg"
                    style={{ width: `${(currentTime / videoDuration) * 100}%` }}
                  />
                  {/* 分割点 */}
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
                  {/* 当前播放位置 */}
                  <div
                    className="absolute top-0 w-0.5 h-full bg-white z-20"
                    style={{ left: `${(currentTime / videoDuration) * 100}%` }}
                  />
                </div>
              </div>

              {/* 操作按钮 */}
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

              {/* 分割点信息 */}
              <div className="text-sm text-slate-400">
                已标记 <span className="text-violet-400 font-medium">{splitPoints.length}</span> 个分割点，将生成{' '}
                <span className="text-violet-400 font-medium">{sceneCount}</span> 个分镜
              </div>

              {/* 分割点列表 */}
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

          {/* AI 自动分割模式 - 初始状态 */}
          {mode !== 'manual' && state === 'initial' && (
            <div className="py-4">
              {/* 警告提示 */}
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-3">
                <div className="flex items-center gap-2 text-amber-300 font-medium">
                  <AlertTriangle className="w-5 h-5" />
                  <span>AI自动分割提示</span>
                </div>
                <ul className="space-y-2 text-sm text-amber-200/80 list-disc list-inside">
                  <li>处理时间根据视频时长约 30秒 ~ 5分钟</li>
                  <li>根据选择的模型不同，费用有所差异</li>
                  <li>分割结果可能需要手动调整</li>
                  <li className="text-amber-100">
                    <span className="font-medium">建议</span>先使用 AI 自动分割获得初步结果，再手动微调以提高效率
                  </li>
                </ul>
              </div>

              {/* 附加信息 */}
              <div className="flex items-start gap-2 mt-4 text-xs text-slate-500">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <span>AI会自动分析视频的关键帧和场景转换，识别可能的镜头边界</span>
              </div>
            </div>
          )}

          {/* 处理中状态 */}
          {state === 'processing' && (
            <div className="py-8 text-center">
              <div className="flex items-center justify-center gap-3 mb-6">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                <span className="text-base text-slate-200">正在分割视频...</span>
                <span className="text-base text-violet-400 font-medium">{progress}%</span>
              </div>

              {/* 进度条 */}
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

              <p className="text-xs text-slate-500 mb-8">请勿关闭页面</p>

              <button
                onClick={handleCancel}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                取消处理
              </button>
            </div>
          )}

          {/* 完成状态 */}
          {state === 'completed' && (
            <div className="py-4 space-y-5">
              {/* 成功提示 */}
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-green-400" />
                <div>
                  <h3 className="text-base font-semibold text-white">分割完成！</h3>
                  <p className="text-sm text-slate-400">
                    已生成 {sceneCount} 个分镜片段
                  </p>
                </div>
              </div>

              {/* 费用信息 */}
              {estimatedCost > 0 && (
                <div className="flex items-center justify-between p-4 rounded-xl bg-white/[0.03] border border-white/10">
                  <span className="text-sm text-slate-300">预估费用：</span>
                  <span className="text-base font-semibold text-green-400">¥{estimatedCost.toFixed(2)}</span>
                </div>
              )}

              {/* 提示 */}
              <p className="text-sm text-slate-400">可拖动调整分割点</p>

              {/* 时间轴预览 */}
              {videoDuration > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">时间轴预览</span>
                    <span className="text-slate-500">{formatTime(videoDuration)}</span>
                  </div>
                  <div className="relative h-8 bg-white/10 rounded-lg">
                    {/* 分割点 */}
                    {splitPoints.map(point => (
                      <div
                        key={point.id}
                        className="absolute top-0 w-1 h-full bg-violet-500 cursor-ew-resize z-10"
                        style={{ left: `${(point.time / videoDuration) * 100}%` }}
                        onMouseDown={e => handleTimelineMouseDown(e, point.id)}
                      >
                        <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-violet-500 rounded-full border-2 border-white shadow-lg" />
                      </div>
                    ))}
                  </div>

                  {/* 分割点列表（可删除） */}
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
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            取消
          </button>
          {state === 'initial' && (
            <button
              onClick={handleStartSplit}
              disabled={!videoUrl || (mode === 'manual' && splitPoints.length === 0)}
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

      {/* 压缩选择对话框 */}
      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => {
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
