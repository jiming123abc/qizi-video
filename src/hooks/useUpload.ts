import { useState, useRef, useEffect, useCallback } from 'react';
import {
  uploadImage,
  uploadVideo,
  detectFileType,
  checkVideoBitrate,
} from '../lib/ossUtils';
import type { UploadDecision } from '../lib/ossUtils';

export interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled' | 'pending' | 'detecting' | 'retrying';
  message?: string;
  retryCount: number;
}

export interface FileCompressionInfo {
  file: File;
  index: number;
  decision: UploadDecision;
}

export interface UseUploadOptions {
  projectId: number;
  currentSceneId: number | null;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onUploadComplete?: () => void;
  loadShots?: () => void | Promise<void>;
  loadStats?: () => void | Promise<void>;
  loadProject?: () => void | Promise<void>;
}

export function useUpload(options: UseUploadOptions) {
  const { projectId, currentSceneId, showToast, onUploadComplete, loadShots, loadStats, loadProject } = options;

  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);

  const [pendingCompressionFiles, setPendingCompressionFiles] = useState<FileCompressionInfo[]>([]);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const [pendingUploadIndex, setPendingUploadIndex] = useState<number>(-1);
  const pendingValidFilesRef = useRef<File[]>([]);
  const pendingCompressionMethodRef = useRef<'server' | 'browser' | 'aliyun' | null>(null);
  const pendingCompressionIndicesRef = useRef<Set<number>>(new Set());
  const compressionDecisionPendingRef = useRef(false);
  const runUploadQueueRef = useRef<() => void>(() => {});
  const uploadCancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const concurrentCountRef = useRef(0);
  const maxConcurrent = 5;
  const maxRetries = 2;
  // P3-1：完成检测 interval 的 ref，用于 unmount 时清理
  const completionCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // P3-1：重试 setTimeout 的 ref 集合，用于 unmount 时清理
  const retryTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  // P3-1：unmount 时清理所有 timer，防止内存泄漏与对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (completionCheckRef.current) {
        clearInterval(completionCheckRef.current);
        completionCheckRef.current = null;
      }
      retryTimeoutsRef.current.forEach(t => clearTimeout(t));
      retryTimeoutsRef.current.clear();
    };
  }, []);

  const refreshAfterUpload = useCallback(async () => {
    if (loadShots) await loadShots();
    if (loadStats) await loadStats();
    if (loadProject) await loadProject();
    onUploadComplete?.();
  }, [loadShots, loadStats, loadProject, onUploadComplete]);

  const uploadSingleFile = useCallback(async (file: File, index: number, retry: number = 0, compressionMethod: 'none' | 'server' | 'browser' | 'aliyun' = 'none') => {
    if (uploadCancelledRef.current) {
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
      return;
    }

    const detected = detectFileType(file);

    try {
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'uploading', progress: 5 } : uf));

      if (detected.type === 'image') {
        await uploadImage(file, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          usage: 'shot-reference',
          title: file.name,
          createShot: true,
          signal: uploadAbortControllerRef.current?.signal
        });
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
      } else {
        await uploadVideo(file, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          usage: 'shot-reference',
          title: file.name,
          createShot: true,
          compressionMethod,
          skipBitrateCheck: true,
          signal: uploadAbortControllerRef.current?.signal,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
      }
    } catch (e) {
      if (uploadCancelledRef.current) {
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
        return;
      }
      console.error('上传失败:', file.name, e);
      
      if (retry < maxRetries) {
        const nextRetry = retry + 1;
        // 使用 'retrying' 状态，避免被 runUploadQueue 重复扫描启动
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, retryCount: nextRetry, progress: 0, status: 'retrying', message: `准备重试 ${nextRetry}/${maxRetries}` } : uf));
        const retryTimer = setTimeout(() => {
          // 延迟结束后，改为 'pending' 并触发队列，由队列统一启动
          retryTimeoutsRef.current.delete(retryTimer);
          setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'pending', message: `重试 ${nextRetry}/${maxRetries}` } : uf));
          runUploadQueueRef.current();
        }, 1000 * nextRetry);
        retryTimeoutsRef.current.add(retryTimer);
        return;
      }
      
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'error', message: (e as Error).message } : uf));
    }
  }, [projectId, currentSceneId]);

  const runUploadQueue = useCallback(() => {
    if (uploadCancelledRef.current) return;

    setUploadingFiles(current => {
      const pendingFiles = pendingValidFilesRef.current.map((f, i) => ({ file: f, index: i }))
        .filter((_, i) => {
          const uf = current[i];
          return uf && uf.status === 'pending';
        });

      const canStart = maxConcurrent - concurrentCountRef.current;
      if (canStart <= 0 || pendingFiles.length === 0) return current;

      const toStart = pendingFiles.slice(0, canStart);
      toStart.forEach(({ file, index }) => {
        concurrentCountRef.current++;
        const needsCompression = pendingCompressionIndicesRef.current.has(index);
        const method = needsCompression ? (pendingCompressionMethodRef.current || 'server') : 'none';
        const uf = current[index];
        const retryCount = uf ? uf.retryCount : 0;
        uploadSingleFile(file, index, retryCount, method).then(() => {
          concurrentCountRef.current--;
          runUploadQueueRef.current();
        });
      });

      return current.map((uf, idx) => {
        if (toStart.some(p => p.index === idx)) {
          return { ...uf, status: 'uploading' as const, progress: 5 };
        }
        return uf;
      });
    });
  }, [uploadSingleFile]);

  // 保持 ref 始终指向最新的 runUploadQueue
  runUploadQueueRef.current = runUploadQueue;

  const setupCompletionCheck = useCallback(() => {
    // P3-1：清理上一次未完成的 interval，防止多个 interval 同时运行
    if (completionCheckRef.current) {
      clearInterval(completionCheckRef.current);
    }
    const checkComplete = setInterval(() => {
      setUploadingFiles(current => {
        const isAllDone = current.every(f => f.status === 'done' || f.status === 'error' || f.status === 'cancelled');
        if (isAllDone && !compressionDecisionPendingRef.current && concurrentCountRef.current === 0) {
          if (completionCheckRef.current) {
            clearInterval(completionCheckRef.current);
            completionCheckRef.current = null;
          }
          setTimeout(() => {
            refreshAfterUpload();
            const successCount = current.filter(f => f.status === 'done').length;
            const errorCount = current.filter(f => f.status === 'error').length;
            if (errorCount === 0) {
              showToast(`上传完成（${successCount} 项）`);
            } else {
              showToast(`上传完成（成功 ${successCount} 项，失败 ${errorCount} 项）`);
            }
          }, 0);
        }
        return current;
      });
    }, 500);
    completionCheckRef.current = checkComplete;
  }, [refreshAfterUpload, showToast]);

  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    const valid = list.filter(f => {
      const d = detectFileType(f);
      if (!d.supported) {
        showToast(`忽略不支持的文件：${f.name}`);
      }
      return d.supported;
    });
    if (valid.length === 0) return;

    const initial: UploadingFile[] = valid.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
      name: f.name, size: f.size, progress: 0, status: 'pending',
      retryCount: 0
    }));
    setUploadingFiles(initial);
    pendingValidFilesRef.current = valid;
    uploadCancelledRef.current = false;
    uploadAbortControllerRef.current = new AbortController();
    concurrentCountRef.current = 0;
    pendingCompressionMethodRef.current = null;
    pendingCompressionIndicesRef.current = new Set();
    compressionDecisionPendingRef.current = false;

    // 完成检测定时器（无论是否需要压缩都需设置，压缩场景下由 handleCompressionDecision 启动上传）
    setupCompletionCheck();

    const videos = valid.map((f, i) => ({ file: f, index: i }))
      .filter(({ file }) => detectFileType(file).type === 'video');

    if (videos.length > 0) {
      setUploadingFiles(prev => prev.map((uf, idx) => {
        const isVideo = videos.some(v => v.index === idx);
        return isVideo ? { ...uf, status: 'detecting' as const, progress: 10, message: '检测视频信息...' } : uf;
      }));

      const decisions = await Promise.all(
        videos.map(async ({ file, index }) => {
          try {
            const decision = await checkVideoBitrate(file);
            return { file, index, decision };
          } catch (e) {
            console.error('检测视频失败:', file.name, e);
            return { file, index, decision: null };
          }
        })
      );

      const needCompression = decisions.filter(d => d.decision?.decision === 'must_compress');

      if (needCompression.length > 0) {
        setPendingCompressionFiles(needCompression as FileCompressionInfo[]);
        setPendingCompressionDecision(needCompression[0].decision!);
        compressionDecisionPendingRef.current = true;
        setUploadingFiles(prev => prev.map((uf, idx) => {
          const needsCompress = needCompression.some(c => c.index === idx);
          if (needsCompress) {
            return { ...uf, status: 'pending', progress: 0, message: '等待压缩方式选择' };
          }
          return { ...uf, status: 'pending', progress: 0, message: '等待中' };
        }));
        // 不启动上传，等待用户选择压缩方式；checkComplete 已在上方设置
        uploadAbortControllerRef.current = null;
        return;
      }
    }

    // 由队列统一调度上传，避免重复启动
    runUploadQueueRef.current();
    // 不清除 uploadAbortControllerRef，保留 AbortController 以便用户取消时能 abort 在途 fetch
  }, [projectId, currentSceneId, showToast, refreshAfterUpload, uploadSingleFile, setupCompletionCheck]);

  const cancelUpload = useCallback(() => {
    uploadCancelledRef.current = true;
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
      uploadAbortControllerRef.current = null;
    }
    setPendingCompressionFiles([]);
    setPendingCompressionDecision(null);
    setPendingUploadIndex(-1);
    compressionDecisionPendingRef.current = false;
    pendingCompressionMethodRef.current = null;
    pendingCompressionIndicesRef.current = new Set();
  }, []);

  const handleCompressionDecision = useCallback(async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    if (method === 'cancel') {
      setPendingCompressionFiles([]);
      setPendingCompressionDecision(null);
      setPendingUploadIndex(-1);
      compressionDecisionPendingRef.current = false;
      pendingCompressionMethodRef.current = null;
      pendingCompressionIndicesRef.current = new Set();
      return;
    }

    pendingCompressionMethodRef.current = method;
    // 在清空 pendingCompressionFiles 之前，记录需要压缩的索引到 ref，供 runUploadQueue 使用
    pendingCompressionIndicesRef.current = new Set(pendingCompressionFiles.map(c => c.index));
    // 用户已做出选择，清除压缩等待标志，让 checkComplete 可检测完成
    compressionDecisionPendingRef.current = false;

    setUploadingFiles(prev => prev.map((uf, idx) => {
      const needsCompress = pendingCompressionFiles.some(c => c.index === idx);
      if (needsCompress) {
        return { ...uf, status: 'pending', progress: 0, message: '准备上传...' };
      }
      return uf;
    }));

    setPendingCompressionFiles([]);
    setPendingCompressionDecision(null);
    setPendingUploadIndex(-1);

    // 创建新的 AbortController，以便用户取消时能 abort 在途 fetch
    uploadAbortControllerRef.current = new AbortController();
    // 由队列统一调度上传，避免与队列逻辑重复启动导致重复上传
    runUploadQueueRef.current();
  }, [pendingCompressionFiles]);

  const clearUploadingFiles = useCallback(() => {
    setUploadingFiles([]);
    setPendingCompressionFiles([]);
    setPendingCompressionDecision(null);
    setPendingUploadIndex(-1);
    compressionDecisionPendingRef.current = false;
    pendingCompressionMethodRef.current = null;
    pendingCompressionIndicesRef.current = new Set();
    uploadAbortControllerRef.current = null;
  }, []);

  const retryFailedFiles = useCallback(() => {
    setUploadingFiles(current => {
      const hasFailed = current.some(uf => uf.status === 'error');
      if (!hasFailed) return current;

      return current.map(uf => {
        if (uf.status === 'error') {
          return { ...uf, status: 'pending' as const, progress: 0, retryCount: 0, message: '等待重试...' };
        }
        return uf;
      });
    });

    uploadCancelledRef.current = false;
    // 由队列统一调度重试，避免绕过并发限制
    runUploadQueueRef.current();
    // 重新设置完成检测
    setupCompletionCheck();
  }, [setupCompletionCheck]);

  return {
    uploadingFiles,
    setUploadingFiles,
    pendingCompressionVideo: pendingCompressionFiles.length > 0 ? pendingCompressionFiles[0].file : null,
    pendingCompressionDecision,
    pendingCompressionFiles,
    handleUploadFiles,
    cancelUpload,
    handleCompressionDecision,
    aliyunConfigured,
    clearUploadingFiles,
    retryFailedFiles,
  };
}
